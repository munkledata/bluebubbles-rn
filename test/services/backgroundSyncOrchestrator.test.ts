import { InMemoryVault, SERVER_SESSION_STATE } from '@core/secure';
import { useSessionStore } from '@state/sessionStore';
import {
  runBackgroundSync,
  type BackgroundAccountScope,
  type BackgroundSyncDependencies,
} from '@/services/background/backgroundSyncOrchestrator';

interface TestDb {
  readonly name: 'db';
}

interface TestClient {
  readonly origin: string;
  readonly password: string;
}

interface TestServerInfo {
  readonly serverVersion: string;
}

class TestRevocationMarker {
  revoked = false;
  unavailable = false;

  isRevoked(): boolean {
    if (this.unavailable) throw new Error('marker unavailable');
    return this.revoked;
  }
}

function makeDependencies(
  vault: InMemoryVault,
  marker: TestRevocationMarker,
  events: string[] = [],
): BackgroundSyncDependencies<TestDb, TestClient, TestServerInfo> {
  const scope: BackgroundAccountScope = { generation: 7, isCurrent: () => true };
  return {
    wakeBudgetMs: 240_000,
    vault,
    revocationMarker: marker,
    captureAccountScope: () => scope,
    runTrackedSync: async (run) => {
      events.push('tracked');
      await run();
    },
    createClient: (session) => {
      events.push('client');
      return session;
    },
    openDatabase: async () => {
      events.push('db');
      return { name: 'db' };
    },
    fetchServerInfo: async () => {
      events.push('server-info');
      return { serverVersion: '1.9.0' };
    },
    serverVersion: (info) => info.serverVersion,
    synchronize: async (_db, _client, version) => {
      events.push(`sync:${version}`);
    },
    recoverAndDrainSchedules: async () => {
      events.push('schedules');
    },
    drainOutgoing: async () => {
      events.push('outgoing');
    },
    flushDiagnostics: async () => {
      events.push('diagnostics');
    },
  };
}

async function setValidSession(vault: InMemoryVault): Promise<void> {
  await vault.set('serverSessionState', SERVER_SESSION_STATE.active);
  await vault.set('serverAddress', 'https://server.example');
  await vault.set('serverPassword', 'vault-password');
  await vault.set('appLockEnabled', 'false');
}

beforeEach(() => {
  // A killed TaskManager process starts here: no foreground hydration and no in-memory creds.
  useSessionStore.setState({
    status: 'loading',
    origin: null,
    password: null,
    serverInfo: null,
    error: null,
    epoch: 0,
  });
});

describe('headless background bootstrap', () => {
  it('treats an empty vault as a successful no-op without opening the database', async () => {
    const events: string[] = [];
    const deps = makeDependencies(new InMemoryVault(), new TestRevocationMarker(), events);

    await expect(runBackgroundSync(deps)).resolves.toEqual({
      result: 'success',
      reason: 'no-session',
    });

    expect(events).toEqual(['tracked']);
    expect(useSessionStore.getState()).toMatchObject({
      status: 'loading',
      origin: null,
      password: null,
    });
  });

  it('uses one vault credential snapshot from true store defaults and runs each bounded phase in order', async () => {
    const vault = new InMemoryVault();
    await setValidSession(vault);
    const events: string[] = [];
    const deps = makeDependencies(vault, new TestRevocationMarker(), events);
    const clients: TestClient[] = [];
    deps.createClient = (session) => {
      events.push('client');
      const client = { ...session };
      clients.push(client);
      return client;
    };

    await expect(runBackgroundSync(deps)).resolves.toEqual({
      result: 'success',
      reason: 'completed',
    });

    expect(clients).toEqual([{ origin: 'https://server.example', password: 'vault-password' }]);
    expect(events).toEqual([
      'tracked',
      'client',
      'db',
      'server-info',
      'sync:1.9.0',
      'schedules',
      'outgoing',
      'diagnostics',
    ]);
    expect(useSessionStore.getState()).toMatchObject({ origin: null, password: null });
  });

  it('fails closed on a persisted app lock before opening the database', async () => {
    const vault = new InMemoryVault();
    await setValidSession(vault);
    await vault.set('appLockEnabled', 'true');
    const events: string[] = [];

    await expect(
      runBackgroundSync(makeDependencies(vault, new TestRevocationMarker(), events)),
    ).resolves.toEqual({ result: 'success', reason: 'app-locked' });

    expect(events).toEqual(['tracked']);
  });

  it.each([
    ['a partial credential tuple', false] as const,
    ['a durable revocation', true] as const,
  ])('fails closed on %s without opening the database', async (_label, revoked) => {
    const vault = new InMemoryVault();
    await vault.set('serverSessionState', SERVER_SESSION_STATE.active);
    await vault.set('serverAddress', 'https://server.example');
    const marker = new TestRevocationMarker();
    marker.revoked = revoked;
    const events: string[] = [];

    const outcome = await runBackgroundSync(makeDependencies(vault, marker, events));

    expect(outcome).toEqual({
      result: 'success',
      reason: revoked ? 'revoked' : 'unsafe-session',
    });
    expect(events).toEqual(revoked ? [] : ['tracked']);
  });

  it('asks WorkManager to retry when durable state cannot be read', async () => {
    const vault = new InMemoryVault();
    await setValidSession(vault);
    const marker = new TestRevocationMarker();
    marker.unavailable = true;
    const events: string[] = [];

    await expect(runBackgroundSync(makeDependencies(vault, marker, events))).resolves.toEqual({
      result: 'retry',
      reason: 'durable-state-unavailable',
    });

    expect(events).toEqual([]);
  });

  it('classifies transient sync/bootstrap failures as retryable work', async () => {
    const vault = new InMemoryVault();
    await setValidSession(vault);
    const deps = makeDependencies(vault, new TestRevocationMarker());
    deps.fetchServerInfo = async () => {
      throw new Error('temporary network failure');
    };

    await expect(runBackgroundSync(deps)).resolves.toEqual({
      result: 'retry',
      reason: 'work-failed',
    });
  });

  it('hands due schedules to their queue before draining that outgoing queue', async () => {
    const vault = new InMemoryVault();
    await setValidSession(vault);
    const marker = new TestRevocationMarker();
    const events: string[] = [];
    const deps = makeDependencies(vault, marker, events);
    let scheduledClient: TestClient | undefined;
    let outgoingClient: TestClient | undefined;
    let scheduledScope: BackgroundAccountScope | undefined;
    deps.recoverAndDrainSchedules = async (_db, client, scope) => {
      scheduledClient = client;
      scheduledScope = scope;
      events.push('schedule-handoff');
    };
    deps.drainOutgoing = async (_db, client, scope) => {
      outgoingClient = client;
      expect(scope.generation).toBe(scheduledScope?.generation);
      expect(scope.isCurrent()).toBe(true);
      expect(scheduledScope?.isCurrent()).toBe(true);
      events.push('outgoing-after-handoff');
    };

    await expect(runBackgroundSync(deps)).resolves.toMatchObject({ result: 'success' });

    expect(scheduledClient).toBe(outgoingClient);
    expect(events.indexOf('schedule-handoff')).toBeLessThan(
      events.indexOf('outgoing-after-handoff'),
    );
  });

  it('lets the bounded schedule phase settle, then expires shared admission for later work', async () => {
    const vault = new InMemoryVault();
    await setValidSession(vault);
    const events: string[] = [];
    const deps = makeDependencies(vault, new TestRevocationMarker(), events);
    let now = 1_000;
    deps.wakeBudgetMs = 400;
    deps.now = () => now;
    let syncScope: BackgroundAccountScope | undefined;
    deps.synchronize = async (_db, _client, version, scope) => {
      syncScope = scope;
      events.push(`sync:${version}`);
    };
    deps.recoverAndDrainSchedules = async (_db, _client, scope) => {
      events.push(`schedule-scope-before:${String(scope.isCurrent())}`);
      now = 1_400;
      events.push(`schedule-scope-at-deadline:${String(scope.isCurrent())}`);
      events.push(`admission-scope-at-deadline:${String(syncScope?.isCurrent())}`);
    };

    await expect(runBackgroundSync(deps)).resolves.toEqual({
      result: 'retry',
      reason: 'wake-budget-exhausted',
    });

    expect(events).toEqual([
      'tracked',
      'client',
      'db',
      'server-info',
      'sync:1.9.0',
      'schedule-scope-before:true',
      'schedule-scope-at-deadline:true',
      'admission-scope-at-deadline:false',
    ]);
  });

  it('reports a genuine schedule failure even when its bounded phase crosses the cutoff', async () => {
    const vault = new InMemoryVault();
    await setValidSession(vault);
    const deps = makeDependencies(vault, new TestRevocationMarker());
    const failure = new Error('scheduled handoff database failure');
    const onWorkError = jest.fn();
    let now = 1_000;
    deps.wakeBudgetMs = 400;
    deps.now = () => now;
    deps.onWorkError = onWorkError;
    deps.recoverAndDrainSchedules = async () => {
      now = 1_400;
      throw failure;
    };

    await expect(runBackgroundSync(deps)).resolves.toEqual({
      result: 'retry',
      reason: 'work-failed',
    });
    expect(onWorkError).toHaveBeenCalledWith(failure);
  });

  it('classifies an error caused by the deadline-aware scope as budget exhaustion', async () => {
    const vault = new InMemoryVault();
    await setValidSession(vault);
    const deps = makeDependencies(vault, new TestRevocationMarker());
    const onWorkError = jest.fn();
    let now = 1_000;
    deps.wakeBudgetMs = 400;
    deps.now = () => now;
    deps.onWorkError = onWorkError;
    deps.synchronize = async (_db, _client, _version, scope) => {
      now = 1_400;
      expect(scope.isCurrent()).toBe(false);
      throw new Error('deadline commit guard rejected');
    };

    await expect(runBackgroundSync(deps)).resolves.toEqual({
      result: 'retry',
      reason: 'wake-budget-exhausted',
    });
    expect(onWorkError).not.toHaveBeenCalled();
  });

  it('rejects a missing or nonsensical wake budget before touching durable state', async () => {
    const events: string[] = [];
    const deps = makeDependencies(new InMemoryVault(), new TestRevocationMarker(), events);
    deps.wakeBudgetMs = 0;

    await expect(runBackgroundSync(deps)).rejects.toThrow(
      'Background wake budget must be a positive finite number',
    );
    expect(events).toEqual([]);
  });

  it('retires quietly when revocation lands during a cold database open', async () => {
    const vault = new InMemoryVault();
    await setValidSession(vault);
    const marker = new TestRevocationMarker();
    const events: string[] = [];
    const deps = makeDependencies(vault, marker, events);
    let releaseDb!: () => void;
    const dbOpened = new Promise<void>((resolve) => {
      releaseDb = resolve;
    });
    let enteredDb!: () => void;
    const dbEntered = new Promise<void>((resolve) => {
      enteredDb = resolve;
    });
    deps.openDatabase = async () => {
      events.push('db');
      enteredDb();
      await dbOpened;
      return { name: 'db' };
    };

    const run = runBackgroundSync(deps);
    await dbEntered;
    marker.revoked = true;
    releaseDb();

    await expect(run).resolves.toEqual({ result: 'success', reason: 'revoked' });
    expect(events).toEqual(['tracked', 'client', 'db']);
  });

  it('keeps diagnostics best-effort after the message work completed', async () => {
    const vault = new InMemoryVault();
    await setValidSession(vault);
    const deps = makeDependencies(vault, new TestRevocationMarker());
    deps.flushDiagnostics = async () => {
      throw new Error('diagnostic endpoint unavailable');
    };

    await expect(runBackgroundSync(deps)).resolves.toEqual({
      result: 'success',
      reason: 'completed',
    });
  });
});
