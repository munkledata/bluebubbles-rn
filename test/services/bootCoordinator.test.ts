import {
  BOOT_CLASSIFIER_FAILURE_CODE,
  BOOT_CLASSIFIER_FAILURE_MESSAGE,
  BootStageTimeoutError,
  createBootCoordinator,
  type BootCoordinator,
  type BootFailureClassification,
  type BootStageAdapters,
  type BootStageContext,
} from '@/services/boot/bootCoordinator';
import type { CoreBootStage } from '@/services/boot/bootStateMachine';

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(count = 8): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

interface TestBootSession {
  readonly runId: number;
  readonly secret: string;
}

type TestBootAdapters = BootStageAdapters<TestBootSession>;

function defaultAdapters(events: string[] = []): TestBootAdapters {
  return {
    lock: async ({ runId }) => {
      events.push(`lock:${runId}`);
      return 'unlocked';
    },
    session: async ({ runId }) => {
      events.push(`session:${runId}`);
      return { kind: 'connected', session: { runId, secret: `secret-${runId}` } };
    },
    database: async ({ runId }) => {
      events.push(`database:${runId}`);
    },
    settings: async ({ runId }) => {
      events.push(`settings:${runId}`);
    },
    activate: async ({ runId }) => {
      events.push(`activate:${runId}`);
    },
  };
}

const retryable = (): BootFailureClassification => ({
  kind: 'retryable',
  failClosed: true,
  code: 'temporary-boot-failure',
  userMessage: 'Startup could not finish. Try again.',
});

function isTestBootSession(value: unknown): value is TestBootSession {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<TestBootSession>;
  return (
    typeof candidate.runId === 'number' &&
    Number.isSafeInteger(candidate.runId) &&
    typeof candidate.secret === 'string' &&
    candidate.secret.length > 0
  );
}

function coordinator(
  adapters: TestBootAdapters = defaultAdapters(),
  classifyFailure: (stage: CoreBootStage, error: unknown) => BootFailureClassification = retryable,
  onListenerError?: (error: unknown) => void | Promise<void>,
  validateSession: (value: unknown) => value is TestBootSession = isTestBootSession,
): BootCoordinator {
  return createBootCoordinator({
    adapters,
    validateSession,
    classifyFailure,
    onListenerError,
  });
}

describe('boot coordinator', () => {
  it('runs every connected adapter once in strict core-gate order', async () => {
    const events: string[] = [];
    const boot = coordinator(defaultAdapters(events));
    const states: string[] = [];
    boot.subscribe((state) => {
      states.push(state.status === 'loading' ? `loading:${state.stage}` : state.status);
    });

    await expect(boot.start()).resolves.toMatchObject({
      status: 'ready',
      mode: 'connected',
      runId: 1,
    });

    expect(events).toEqual(['lock:1', 'session:1', 'database:1', 'settings:1', 'activate:1']);
    expect(states).toEqual([
      'loading:lock',
      'loading:session',
      'loading:database',
      'loading:settings',
      'loading:activate',
      'ready',
    ]);
  });

  it('aborts a timed-out stage, publishes a classified failure, and retries cleanly', async () => {
    jest.useFakeTimers();
    try {
      const firstDatabase = deferred<void>();
      const signals: AbortSignal[] = [];
      let databaseCalls = 0;
      const adapters = defaultAdapters();
      adapters.database = async ({ stageSignal }) => {
        signals.push(stageSignal);
        databaseCalls += 1;
        if (databaseCalls === 1) await firstDatabase.promise;
      };
      const classify = jest.fn(
        (stage: CoreBootStage, error: unknown): BootFailureClassification => ({
          kind: 'retryable',
          failClosed: true,
          code: error instanceof BootStageTimeoutError ? 'boot-stage-timeout' : 'unexpected',
          userMessage: `Could not finish ${stage}. Try again.`,
        }),
      );
      const boot = createBootCoordinator({
        adapters,
        validateSession: isTestBootSession,
        classifyFailure: classify,
        stageTimeoutMs: { database: 25 },
      });

      const first = boot.start();
      await flushMicrotasks(20);
      expect(boot.getState()).toMatchObject({ status: 'loading', stage: 'database' });
      expect(signals[0]?.aborted).toBe(false);

      jest.advanceTimersByTime(25);
      await expect(first).resolves.toMatchObject({
        status: 'failed',
        failure: { stage: 'database', kind: 'retryable', code: 'boot-stage-timeout' },
      });
      expect(signals[0]?.aborted).toBe(true);
      expect(classify).toHaveBeenCalledWith('database', expect.any(BootStageTimeoutError));

      const retry = boot.retry(1);
      await expect(retry).resolves.toMatchObject({
        status: 'ready',
        mode: 'connected',
        runId: 2,
      });
      expect(signals[1]?.aborted).toBe(false);

      firstDatabase.resolve(undefined);
      await flushMicrotasks();
      expect(boot.getState()).toMatchObject({ status: 'ready', runId: 2 });
    } finally {
      jest.useRealTimers();
    }
  });

  it('validates configured stage deadlines before a run can start', () => {
    expect(() =>
      createBootCoordinator({
        adapters: defaultAdapters(),
        validateSession: isTestBootSession,
        classifyFailure: retryable,
        stageTimeoutMs: { session: 0 },
      }),
    ).toThrow('Boot stage session timeout must be a positive safe integer');
  });

  it('runs registered failure cleanup once in reverse acquisition order', async () => {
    const cleanupEvents: string[] = [];
    const cleanupErrors: unknown[] = [];
    const adapters = defaultAdapters();
    adapters.activate = async ({ registerDisposer }) => {
      registerDisposer(() => {
        cleanupEvents.push('first');
      });
      registerDisposer(async () => {
        cleanupEvents.push('second');
        throw new Error('cleanup failed');
      });
      throw new Error('activation failed');
    };
    const boot = createBootCoordinator({
      adapters,
      validateSession: isTestBootSession,
      classifyFailure: retryable,
      onCleanupError: (error) => {
        cleanupErrors.push(error);
      },
    });

    await expect(boot.start()).resolves.toMatchObject({
      status: 'failed',
      failure: { stage: 'activate' },
    });
    expect(cleanupEvents).toEqual(['second', 'first']);
    expect(cleanupErrors).toEqual([expect.objectContaining({ message: 'cleanup failed' })]);
    boot.invalidate(1);
    await flushMicrotasks();
    expect(cleanupEvents).toEqual(['second', 'first']);
  });

  it('lets an adapter report only an allow-listed issue for its exact run', async () => {
    const adapters = defaultAdapters();
    adapters.activate = async ({ reportIssue }) => {
      reportIssue({
        stage: 'realtime',
        level: 'degraded',
        code: 'socket-unavailable',
        userMessage: 'Live updates will retry later.',
      });
    };
    const boot = coordinator(adapters);

    await expect(boot.start()).resolves.toMatchObject({
      status: 'ready',
      issues: [
        {
          stage: 'realtime',
          level: 'degraded',
          code: 'socket-unavailable',
          userMessage: 'Live updates will retry later.',
        },
      ],
    });
  });

  it('waits for invalidated-run cleanup before a successor invokes its first adapter', async () => {
    const cleanup = deferred<void>();
    const lockRuns: number[] = [];
    const adapters = defaultAdapters();
    adapters.lock = async ({ runId }) => {
      lockRuns.push(runId);
      return 'unlocked';
    };
    adapters.activate = async ({ runId, registerDisposer }) => {
      if (runId === 1) registerDisposer(() => cleanup.promise);
    };
    const boot = coordinator(adapters);

    await expect(boot.start()).resolves.toMatchObject({ status: 'ready', runId: 1 });
    boot.invalidate(1);
    const successor = boot.start();
    await flushMicrotasks(20);
    expect(boot.getState()).toMatchObject({ status: 'loading', stage: 'lock', runId: 2 });
    expect(lockRuns).toEqual([1]);

    cleanup.resolve(undefined);
    await expect(successor).resolves.toMatchObject({ status: 'ready', runId: 2 });
    expect(lockRuns).toEqual([1, 2]);
  });

  it('immediately disposes a resource registered after its run was invalidated', async () => {
    const database = deferred<void>();
    const disposed = jest.fn();
    const adapters = defaultAdapters();
    adapters.database = async ({ registerDisposer }) => {
      await database.promise;
      registerDisposer(disposed);
    };
    const boot = coordinator(adapters);
    const run = boot.start();
    await flushMicrotasks(20);
    expect(boot.getState()).toMatchObject({ status: 'loading', stage: 'database' });

    boot.invalidate(1);
    await expect(run).resolves.toMatchObject({ status: 'idle', runId: 1 });
    database.resolve(undefined);
    await flushMicrotasks(20);
    expect(disposed).toHaveBeenCalledTimes(1);
  });

  it('hands the exact authorized session through private run state without publishing it', async () => {
    const authorizedSession: TestBootSession = { runId: 1, secret: 'private-password' };
    const received: TestBootSession[] = [];
    const adapters = defaultAdapters();
    adapters.session = async () => ({ kind: 'connected', session: authorizedSession });
    adapters.database = async (_context, session) => {
      received.push(session);
    };
    adapters.settings = async (_context, session) => {
      received.push(session);
    };
    adapters.activate = async (_context, session) => {
      received.push(session);
    };
    const boot = coordinator(adapters);

    const ready = await boot.start();

    expect(received).toEqual([authorizedSession, authorizedSession, authorizedSession]);
    expect(received.every((session) => session === authorizedSession)).toBe(true);
    expect(ready).toMatchObject({ status: 'ready', mode: 'connected', runId: 1 });
    expect(JSON.stringify(ready)).not.toContain('private-password');
    expect(JSON.stringify(boot.getState())).not.toContain('private-password');
  });

  it('does not expose a password-bearing active run through runtime object inspection', async () => {
    const database = deferred<void>();
    const adapters = defaultAdapters();
    adapters.session = async () => ({
      kind: 'connected',
      session: { runId: 1, secret: 'private-active-password' },
    });
    adapters.database = async () => database.promise;
    const boot = coordinator(adapters);
    const run = boot.start();
    await flushMicrotasks(20);
    expect(boot.getState()).toMatchObject({ status: 'loading', stage: 'database', runId: 1 });

    expect(boot).not.toHaveProperty('activeRun');
    expect(Object.keys(boot)).not.toContain('activeRun');
    expect(JSON.stringify(boot)).not.toContain('private-active-password');

    boot.invalidate(1);
    await expect(run).resolves.toMatchObject({ status: 'idle', runId: 1 });
    database.resolve(undefined);
  });

  it('publishes exact Promise ownership before listeners or duplicate starts can re-enter', async () => {
    const lock = deferred<'unlocked' | 'locked'>();
    const adapters = defaultAdapters();
    const lockSpy = jest.fn(() => lock.promise);
    adapters.lock = lockSpy;
    const boot = coordinator(adapters);
    let listenerStart: Promise<ReturnType<BootCoordinator['getState']>> | undefined;
    boot.subscribe((state) => {
      if (state.status === 'loading' && state.stage === 'lock') listenerStart = boot.start();
    });

    const first = boot.start();
    const second = boot.start();
    expect(second).toBe(first);
    expect(listenerStart).toBe(first);
    await flushMicrotasks();
    expect(lockSpy).toHaveBeenCalledTimes(1);

    lock.resolve('unlocked');
    await expect(first).resolves.toMatchObject({ status: 'ready', mode: 'connected' });
  });

  it('keeps a locked start pending and resumes that exact run and Promise once', async () => {
    const events: string[] = [];
    const adapters = defaultAdapters(events);
    adapters.lock = async ({ runId }) => {
      events.push(`lock:${runId}`);
      return 'locked';
    };
    const boot = coordinator(adapters);
    const run = boot.start();
    let settled = false;
    void run.then(() => {
      settled = true;
    });
    await flushMicrotasks();

    expect(boot.getState()).toEqual({ status: 'locked', runId: 1, issues: [] });
    expect(settled).toBe(false);
    expect(boot.unlock(0)).not.toBe(run); // stale lock-screen callback
    expect(boot.getState().status).toBe('locked');

    const resumed = boot.unlock(1);
    const duplicate = boot.unlock(1);
    expect(resumed).toBe(run);
    expect(duplicate).toBe(run);
    await expect(run).resolves.toMatchObject({ status: 'ready', mode: 'connected', runId: 1 });
    expect(events).toEqual(['lock:1', 'session:1', 'database:1', 'settings:1', 'activate:1']);
  });

  it('takes the setup branch without opening the database or later stages', async () => {
    const events: string[] = [];
    const adapters = defaultAdapters(events);
    adapters.session = async ({ runId }) => {
      events.push(`session:${runId}`);
      return { kind: 'setup' };
    };
    const boot = coordinator(adapters);

    await expect(boot.start()).resolves.toMatchObject({ status: 'ready', mode: 'setup' });
    expect(events).toEqual(['lock:1', 'session:1']);
  });

  it.each(['lock', 'session', 'database', 'settings', 'activate'] as const)(
    'classifies a rejected %s stage and never starts a later adapter',
    async (failedStage) => {
      const events: string[] = [];
      const adapters = defaultAdapters(events);
      const boom = new Error(`${failedStage} exploded`);
      const fail = async (): Promise<never> => {
        events.push(`failed:${failedStage}`);
        throw boom;
      };
      if (failedStage === 'lock') adapters.lock = fail;
      else if (failedStage === 'session') adapters.session = fail;
      else adapters[failedStage] = fail;
      const classify = jest.fn(retryable);
      const boot = coordinator(adapters, classify);

      await expect(boot.start()).resolves.toMatchObject({
        status: 'failed',
        failure: { stage: failedStage, kind: 'retryable', code: 'temporary-boot-failure' },
      });
      expect(classify).toHaveBeenCalledWith(failedStage, boom);
      expect(events.at(-1)).toBe(`failed:${failedStage}`);
    },
  );

  it('retries only a matching retryable failure under a fresh run id', async () => {
    const events: string[] = [];
    const adapters = defaultAdapters(events);
    let attempts = 0;
    adapters.lock = async ({ runId }) => {
      events.push(`lock:${runId}`);
      attempts += 1;
      if (attempts === 1) throw new Error('temporary lock read');
      return 'unlocked';
    };
    const boot = coordinator(adapters);
    const issue = {
      stage: 'device-integrity',
      level: 'diagnostic',
      code: 'check-unavailable',
    } as const;

    const first = boot.start();
    boot.reportIssue(1, issue);
    await expect(first).resolves.toMatchObject({ status: 'failed', runId: 1, issues: [issue] });
    expect(boot.retry(0)).not.toBe(first);

    const retry = boot.retry(1);
    const duplicate = boot.retry(1);
    expect(duplicate).toBe(retry);
    await expect(retry).resolves.toMatchObject({
      status: 'ready',
      mode: 'connected',
      runId: 2,
      issues: [],
    });
    expect(events.filter((event) => event.startsWith('lock:'))).toEqual(['lock:1', 'lock:2']);
  });

  it('installs retry ownership before abort callbacks can re-enter retry', async () => {
    const adapters = defaultAdapters();
    let attempts = 0;
    let nestedRetry: Promise<ReturnType<BootCoordinator['getState']>> | undefined;
    let boot!: BootCoordinator;
    adapters.lock = async ({ signal }) => {
      attempts += 1;
      if (attempts === 1) {
        signal.addEventListener('abort', () => {
          nestedRetry = boot.retry(1);
        });
        throw new Error('retryable lock failure');
      }
      return 'unlocked';
    };
    boot = coordinator(adapters);

    await expect(boot.start()).resolves.toMatchObject({ status: 'failed', runId: 1 });
    const outerRetry = boot.retry(1);

    expect(nestedRetry).toBe(outerRetry);
    await expect(outerRetry).resolves.toMatchObject({ status: 'ready', runId: 2 });
    expect(attempts).toBe(2);
  });

  it('keeps a fatal failure terminal and falls back safely when classification throws', async () => {
    const adapters = defaultAdapters();
    adapters.database = async () => {
      throw new Error('database unavailable');
    };
    const boot = coordinator(adapters, () => {
      throw new Error('classifier bug');
    });

    const failed = await boot.start();
    expect(failed).toMatchObject({
      status: 'failed',
      failure: {
        stage: 'database',
        kind: 'fatal',
        failClosed: true,
        code: BOOT_CLASSIFIER_FAILURE_CODE,
        userMessage: BOOT_CLASSIFIER_FAILURE_MESSAGE,
      },
    });
    await expect(boot.retry(1)).resolves.toBe(failed);
    expect(boot.getState()).toBe(failed);
  });

  it('uses the fatal fallback for malformed classifier or adapter-contract output', async () => {
    const malformedClassifierAdapters = defaultAdapters();
    malformedClassifierAdapters.database = async () => {
      throw new Error('database unavailable');
    };
    const malformedClassifier = coordinator(
      malformedClassifierAdapters,
      () =>
        ({
          kind: 'unexpected',
          failClosed: false,
          code: 'bad-policy',
          userMessage: 'Bad policy',
        }) as unknown as BootFailureClassification,
    );
    await expect(malformedClassifier.start()).resolves.toMatchObject({
      status: 'failed',
      failure: { kind: 'fatal', failClosed: true, code: BOOT_CLASSIFIER_FAILURE_CODE },
    });

    const contractAdapters = defaultAdapters();
    contractAdapters.lock = async () => 'invalid' as 'unlocked';
    const classify = jest.fn(retryable);
    const invalidContract = coordinator(contractAdapters, classify);
    await expect(invalidContract.start()).resolves.toMatchObject({
      status: 'failed',
      failure: { stage: 'lock', kind: 'fatal', code: BOOT_CLASSIFIER_FAILURE_CODE },
    });
    expect(classify).not.toHaveBeenCalled();

    const invalidSessionAdapters = defaultAdapters();
    invalidSessionAdapters.session = async () =>
      ({ kind: 'connected', session: undefined }) as never;
    const invalidSessionClassify = jest.fn(retryable);
    const invalidSession = coordinator(invalidSessionAdapters, invalidSessionClassify);
    await expect(invalidSession.start()).resolves.toMatchObject({
      status: 'failed',
      failure: { stage: 'session', kind: 'fatal', code: BOOT_CLASSIFIER_FAILURE_CODE },
    });
    expect(invalidSessionClassify).not.toHaveBeenCalled();
  });

  it('reads a connected session outcome kind exactly once', async () => {
    const readKind = jest.fn(() => 'connected' as const);
    const adapters = defaultAdapters();
    adapters.session = async () => ({
      get kind(): 'connected' {
        return readKind();
      },
      session: { runId: 1, secret: 'private-password' },
    });

    await expect(coordinator(adapters).start()).resolves.toMatchObject({ status: 'ready' });
    expect(readKind).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'kind getter',
      () => ({
        get kind(): never {
          throw new Error('hostile kind getter');
        },
      }),
    ],
    [
      'session descriptor trap',
      () =>
        new Proxy(
          {
            kind: 'connected',
            session: { runId: 1, secret: 'private-password' },
          },
          {
            getOwnPropertyDescriptor(target, property) {
              if (property === 'session') throw new Error('hostile descriptor trap');
              return Reflect.getOwnPropertyDescriptor(target, property);
            },
          },
        ),
    ],
    [
      'session getter',
      () => ({
        kind: 'connected',
        get session(): never {
          throw new Error('hostile session getter');
        },
      }),
    ],
  ] as const)('treats a throwing %s as a fatal adapter contract error', async (_label, outcome) => {
    const adapters = defaultAdapters();
    const database = jest.fn(async () => undefined);
    adapters.session = async () => outcome() as never;
    adapters.database = database;
    const classify = jest.fn(retryable);

    await expect(coordinator(adapters, classify).start()).resolves.toMatchObject({
      status: 'failed',
      failure: { stage: 'session', kind: 'fatal', code: BOOT_CLASSIFIER_FAILURE_CODE },
    });
    expect(classify).not.toHaveBeenCalled();
    expect(database).not.toHaveBeenCalled();
  });

  it.each([
    [
      'truthy non-boolean result',
      (() => 'yes') as unknown as (value: unknown) => value is TestBootSession,
    ],
    [
      'throw',
      (() => {
        throw new Error('hostile session validator');
      }) as unknown as (value: unknown) => value is TestBootSession,
    ],
  ])(
    'rejects a runtime session validator %s as a fatal contract error',
    async (_label, validate) => {
      const adapters = defaultAdapters();
      const database = jest.fn(async () => undefined);
      adapters.database = database;
      const classify = jest.fn(retryable);

      await expect(
        coordinator(adapters, classify, undefined, validate).start(),
      ).resolves.toMatchObject({
        status: 'failed',
        failure: { stage: 'session', kind: 'fatal', code: BOOT_CLASSIFIER_FAILURE_CODE },
      });
      expect(classify).not.toHaveBeenCalled();
      expect(database).not.toHaveBeenCalled();
    },
  );

  it.each(['kind', 'descriptor'] as const)(
    'does not read a credential after %s inspection invalidates the run',
    async (trap) => {
      const readSession = jest.fn((): TestBootSession => ({
        runId: 1,
        secret: 'must-not-be-read',
      }));
      const database = jest.fn(async () => undefined);
      let boot!: BootCoordinator;
      const target = {
        kind: 'connected' as const,
        get session(): TestBootSession {
          return readSession();
        },
      };
      const outcome =
        trap === 'kind'
          ? {
              get kind(): 'connected' {
                boot.invalidate(1);
                return 'connected';
              },
              get session(): TestBootSession {
                return readSession();
              },
            }
          : new Proxy(target, {
              getOwnPropertyDescriptor(object, property) {
                if (property === 'session') boot.invalidate(1);
                return Reflect.getOwnPropertyDescriptor(object, property);
              },
            });
      const adapters = defaultAdapters();
      adapters.session = async () => outcome;
      adapters.database = database;
      boot = coordinator(adapters);

      await expect(boot.start()).resolves.toMatchObject({ status: 'idle', runId: 1 });
      expect(readSession).not.toHaveBeenCalled();
      expect(database).not.toHaveBeenCalled();
    },
  );

  it('does not validate or retain a session whose getter invalidates the run', async () => {
    let boot!: BootCoordinator;
    const validateCall = jest.fn();
    const validate = (value: unknown): value is TestBootSession => {
      validateCall(value);
      return isTestBootSession(value);
    };
    const database = jest.fn(async () => undefined);
    const adapters = defaultAdapters();
    adapters.session = async () => ({
      kind: 'connected',
      get session(): TestBootSession {
        boot.invalidate(1);
        return { runId: 1, secret: 'must-not-be-retained' };
      },
    });
    adapters.database = database;
    boot = coordinator(adapters, retryable, undefined, validate);

    await expect(boot.start()).resolves.toMatchObject({ status: 'idle', runId: 1 });
    expect(validateCall).not.toHaveBeenCalled();
    expect(database).not.toHaveBeenCalled();
    expect(JSON.stringify(boot)).not.toContain('must-not-be-retained');
  });

  it('does not retain or pass a session after its validator invalidates the run', async () => {
    let boot!: BootCoordinator;
    const database = jest.fn(async () => undefined);
    const validateCall = jest.fn();
    const validate = (value: unknown): value is TestBootSession => {
      validateCall(value);
      boot.invalidate(1);
      return isTestBootSession(value);
    };
    const adapters = defaultAdapters();
    adapters.database = database;
    boot = coordinator(adapters, retryable, undefined, validate);

    await expect(boot.start()).resolves.toMatchObject({ status: 'idle', runId: 1 });
    expect(validateCall).toHaveBeenCalledTimes(1);
    expect(database).not.toHaveBeenCalled();
  });

  it('copies only safe classifier fields into public failure state', async () => {
    const rawError = new Error('private database details');
    const adapters = defaultAdapters();
    adapters.database = async () => {
      throw rawError;
    };
    const boot = coordinator(adapters, () => {
      const classification = {
        ...retryable(),
        rawError,
        internalContext: { databasePath: '/private/example.db' },
      };
      return classification;
    });

    const failed = await boot.start();
    expect(failed).toMatchObject({
      status: 'failed',
      failure: {
        stage: 'database',
        kind: 'retryable',
        failClosed: true,
        code: 'temporary-boot-failure',
        userMessage: 'Startup could not finish. Try again.',
      },
    });
    if (failed.status !== 'failed') throw new Error('expected failed boot state');
    expect(Object.keys(failed.failure).sort()).toEqual([
      'code',
      'failClosed',
      'kind',
      'stage',
      'userMessage',
    ]);
    expect(failed.failure).not.toHaveProperty('rawError');
    expect(failed.failure).not.toHaveProperty('internalContext');
  });

  it('validates, copies, and allow-lists reported issues before storing them', async () => {
    const adapters = defaultAdapters();
    adapters.lock = async () => 'locked';
    const boot = coordinator(adapters);
    const run = boot.start();
    await flushMicrotasks();
    expect(boot.getState()).toMatchObject({ status: 'locked', runId: 1 });

    const rawError = new Error('private notification detail');
    const issue = {
      stage: 'fcm' as const,
      level: 'diagnostic' as const,
      code: 'push-unavailable',
      userMessage: 'Push is temporarily unavailable.',
      rawError,
      internalContext: { token: 'private-token' },
    };
    boot.reportIssue(1, issue);

    const stored = boot.getState().issues[0];
    expect(stored).toEqual({
      stage: 'fcm',
      level: 'diagnostic',
      code: 'push-unavailable',
      userMessage: 'Push is temporarily unavailable.',
    });
    expect(Object.keys(stored ?? {}).sort()).toEqual(['code', 'level', 'stage', 'userMessage']);
    expect(stored).not.toHaveProperty('rawError');
    expect(stored).not.toHaveProperty('internalContext');

    issue.code = 'mutated-after-report';
    issue.userMessage = 'Mutated after report.';
    expect(boot.getState().issues[0]).toEqual({
      stage: 'fcm',
      level: 'diagnostic',
      code: 'push-unavailable',
      userMessage: 'Push is temporarily unavailable.',
    });

    const retained = boot.getState();
    const malformed = [
      { stage: 'unknown', level: 'diagnostic', code: 'bad-stage' },
      { stage: 'fcm', level: 'warning', code: 'bad-level' },
      { stage: 'fcm', level: 'diagnostic', code: '   ' },
      { stage: 'fcm', level: 'diagnostic', code: 'bad-message', userMessage: 42 },
      new Proxy(
        {},
        {
          get() {
            throw new Error('hostile issue getter');
          },
        },
      ),
    ];
    for (const candidate of malformed) {
      expect(boot.reportIssue(1, candidate as never)).toBe(retained);
    }
    expect(boot.getState()).toBe(retained);

    boot.invalidate(1);
    await expect(run).resolves.toMatchObject({ status: 'idle', runId: 1 });
  });

  it.each<[string, () => TestBootAdapters]>([
    ['connected ready', () => defaultAdapters()],
    [
      'setup ready',
      () => {
        const adapters = defaultAdapters();
        adapters.session = async () => ({ kind: 'setup' });
        return adapters;
      },
    ],
  ])('aborts the retained generation when invalidating %s state', async (_, makeAdapters) => {
    const adapters = makeAdapters();
    let signal: AbortSignal | undefined;
    const originalLock = adapters.lock;
    adapters.lock = async (context: BootStageContext) => {
      signal = context.signal;
      return originalLock(context);
    };
    const boot = coordinator(adapters);

    const settled = await boot.start();
    expect(settled.status).toBe('ready');
    expect(signal?.aborted).toBe(false);

    expect(boot.invalidate(settled.runId)).toMatchObject({ status: 'idle', runId: settled.runId });
    expect(signal?.aborted).toBe(true);
  });

  it('aborts a settled failed generation before a later retry starts', async () => {
    const signals: AbortSignal[] = [];
    let attempts = 0;
    const adapters = defaultAdapters();
    adapters.lock = async ({ signal }) => {
      signals.push(signal);
      attempts += 1;
      if (attempts === 1) throw new Error('try again');
      return 'unlocked';
    };
    const boot = coordinator(adapters);

    await expect(boot.start()).resolves.toMatchObject({ status: 'failed', runId: 1 });
    expect(signals[0]?.aborted).toBe(false);

    const retried = boot.retry(1);
    expect(signals[0]?.aborted).toBe(true);
    await expect(retried).resolves.toMatchObject({ status: 'ready', runId: 2 });
    expect(signals[1]).toBeDefined();
    expect(signals[1]).not.toBe(signals[0]);
    expect(signals[1]?.aborted).toBe(false);
  });

  it('invalidates before abort, settles promptly, and ignores an adapter that finishes late', async () => {
    const oldLock = deferred<'unlocked' | 'locked'>();
    const newLock = deferred<'unlocked' | 'locked'>();
    let oldContext: BootStageContext | undefined;
    let calls = 0;
    const adapters = defaultAdapters();
    adapters.lock = async (context) => {
      calls += 1;
      if (calls === 1) {
        oldContext = context;
        return oldLock.promise;
      }
      return newLock.promise;
    };
    const classify = jest.fn(retryable);
    const boot = coordinator(adapters, classify);
    const oldRun = boot.start();
    await flushMicrotasks();
    expect(oldContext?.signal.aborted).toBe(false);

    const invalidated = boot.invalidate(1);
    expect(invalidated).toEqual({ status: 'idle', runId: 1, issues: [] });
    expect(oldContext?.signal.aborted).toBe(true);
    await expect(oldRun).resolves.toBe(invalidated);

    const newRun = boot.start();
    await flushMicrotasks();
    expect(boot.getState()).toMatchObject({ status: 'loading', stage: 'lock', runId: 2 });

    oldLock.reject(new Error('late old adapter rejection'));
    await flushMicrotasks();
    expect(boot.start()).toBe(newRun); // old finally did not clear the successor's slot
    expect(classify).not.toHaveBeenCalled();

    newLock.resolve('unlocked');
    await expect(newRun).resolves.toMatchObject({ status: 'ready', runId: 2 });
    const newState = boot.getState();
    expect(boot.reportIssue(1, { stage: 'fcm', level: 'degraded', code: 'late' })).toBe(newState);
    expect(boot.invalidate(1)).toBe(newState);
  });

  it('never reads a password-bearing session result that resolves after invalidation', async () => {
    const pending = deferred<Awaited<ReturnType<TestBootAdapters['session']>>>();
    const readSession = jest.fn((): TestBootSession => ({
      runId: 1,
      secret: 'late-private-password',
    }));
    const lateOutcome = {
      kind: 'connected' as const,
      get session(): TestBootSession {
        return readSession();
      },
    };
    const adapters = defaultAdapters();
    adapters.session = async () => pending.promise;
    const boot = coordinator(adapters);
    const run = boot.start();
    await flushMicrotasks(20);
    expect(boot.getState()).toMatchObject({ status: 'loading', stage: 'session', runId: 1 });

    const invalidated = boot.invalidate(1);
    await expect(run).resolves.toBe(invalidated);
    pending.resolve(lateOutcome);
    await flushMicrotasks(20);

    expect(readSession).not.toHaveBeenCalled();
    expect(boot.getState()).toBe(invalidated);
    expect(JSON.stringify(boot.getState())).not.toContain('late-private-password');
  });

  it.each([
    ['lock', 'resolve'],
    ['lock', 'reject'],
    ['session', 'resolve'],
    ['session', 'reject'],
    ['database', 'resolve'],
    ['database', 'reject'],
    ['settings', 'resolve'],
    ['settings', 'reject'],
    ['activate', 'resolve'],
    ['activate', 'reject'],
  ] as const)(
    'invalidates a pending %s stage and ignores its late %s settlement',
    async (stage, lateSettlement) => {
      const pending = deferred<void>();
      const entered: CoreBootStage[] = [];
      let targetSignal: AbortSignal | undefined;
      const waitAtStage = async (
        candidate: CoreBootStage,
        context: BootStageContext,
      ): Promise<void> => {
        entered.push(candidate);
        if (candidate !== stage) return;
        targetSignal = context.signal;
        await pending.promise;
      };
      const adapters: TestBootAdapters = {
        lock: async (context) => {
          await waitAtStage('lock', context);
          return 'unlocked';
        },
        session: async (context) => {
          await waitAtStage('session', context);
          return {
            kind: 'connected',
            session: { runId: context.runId, secret: `secret-${context.runId}` },
          };
        },
        database: async (context) => waitAtStage('database', context),
        settings: async (context) => waitAtStage('settings', context),
        activate: async (context) => waitAtStage('activate', context),
      };
      const classify = jest.fn(retryable);
      const boot = coordinator(adapters, classify);
      const run = boot.start();
      await flushMicrotasks(40);

      expect(boot.getState()).toMatchObject({ status: 'loading', stage, runId: 1 });
      expect(targetSignal?.aborted).toBe(false);
      const enteredBeforeSettlement = [...entered];

      const invalidated = boot.invalidate(1);
      expect(targetSignal?.aborted).toBe(true);
      await expect(run).resolves.toBe(invalidated);

      if (lateSettlement === 'resolve') pending.resolve(undefined);
      else pending.reject(new Error(`late ${stage} rejection`));
      await flushMicrotasks(20);

      expect(boot.getState()).toBe(invalidated);
      expect(entered).toEqual(enteredBeforeSettlement);
      expect(classify).not.toHaveBeenCalled();
    },
  );

  it('uses one signal within a generation and a fresh signal after invalidation', async () => {
    const observed: Array<{
      readonly runId: number;
      readonly stage: CoreBootStage;
      readonly signal: AbortSignal;
      readonly abortedAtEntry: boolean;
    }> = [];
    const capture = (stage: CoreBootStage, context: BootStageContext): void => {
      observed.push({
        runId: context.runId,
        stage,
        signal: context.signal,
        abortedAtEntry: context.signal.aborted,
      });
    };
    const adapters: TestBootAdapters = {
      lock: async (context) => {
        capture('lock', context);
        return 'unlocked';
      },
      session: async (context) => {
        capture('session', context);
        return {
          kind: 'connected',
          session: { runId: context.runId, secret: `secret-${context.runId}` },
        };
      },
      database: async (context) => capture('database', context),
      settings: async (context) => capture('settings', context),
      activate: async (context) => capture('activate', context),
    };
    const boot = coordinator(adapters);

    await expect(boot.start()).resolves.toMatchObject({ status: 'ready', runId: 1 });
    const firstSignal = observed[0]?.signal;
    expect(firstSignal).toBeDefined();
    expect(observed.filter(({ runId }) => runId === 1)).toHaveLength(5);
    expect(
      observed.filter(({ runId }) => runId === 1).every(({ signal }) => signal === firstSignal),
    ).toBe(true);

    boot.invalidate(1);
    expect(firstSignal?.aborted).toBe(true);
    await expect(boot.start()).resolves.toMatchObject({ status: 'ready', runId: 2 });

    const secondRun = observed.filter(({ runId }) => runId === 2);
    const secondSignal = secondRun[0]?.signal;
    expect(secondRun).toHaveLength(5);
    expect(secondRun.every(({ signal }) => signal === secondSignal)).toBe(true);
    expect(secondRun.every(({ abortedAtEntry }) => !abortedAtEntry)).toBe(true);
    expect(secondSignal).not.toBe(firstSignal);
  });

  it('releases a pending locked run promptly when invalidated', async () => {
    const adapters = defaultAdapters();
    adapters.lock = async () => 'locked';
    const boot = coordinator(adapters);
    const run = boot.start();
    await flushMicrotasks();
    expect(boot.getState()).toMatchObject({ status: 'locked', runId: 1 });

    const invalidated = boot.invalidate(1);
    await expect(run).resolves.toBe(invalidated);
    await expect(boot.unlock(1)).resolves.toBe(invalidated);
  });

  it('ignores a stale unlock after a new generation reaches its own lock screen', async () => {
    const signals: AbortSignal[] = [];
    const adapters = defaultAdapters();
    adapters.lock = async ({ signal }) => {
      signals.push(signal);
      return 'locked';
    };
    const boot = coordinator(adapters);

    const first = boot.start();
    await flushMicrotasks();
    expect(boot.getState()).toMatchObject({ status: 'locked', runId: 1 });
    boot.invalidate(1);
    await expect(first).resolves.toMatchObject({ status: 'idle', runId: 1 });

    const second = boot.start();
    await flushMicrotasks();
    expect(boot.getState()).toMatchObject({ status: 'locked', runId: 2 });
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);

    const staleUnlock = boot.unlock(1);
    expect(staleUnlock).not.toBe(second);
    await expect(staleUnlock).resolves.toMatchObject({ status: 'locked', runId: 2 });
    expect(boot.getState()).toMatchObject({ status: 'locked', runId: 2 });

    expect(boot.unlock(2)).toBe(second);
    await expect(second).resolves.toMatchObject({ status: 'ready', runId: 2 });
  });

  it('isolates throwing and reentrant listeners and supports idempotent unsubscribe', async () => {
    const listenerErrors: unknown[] = [];
    const events: string[] = [];
    const boot = coordinator(defaultAdapters(events), retryable, (error) => {
      listenerErrors.push(error);
    });
    const listener = jest.fn(() => {
      throw new Error('listener failed');
    });
    const unsubscribe = boot.subscribe(listener);
    boot.subscribe(async () => {
      throw new Error('async listener failed');
    });
    let reentrant: Promise<ReturnType<BootCoordinator['getState']>> | undefined;
    boot.subscribe((state) => {
      if (state.status === 'loading' && state.stage === 'lock') reentrant = boot.start();
    });

    const run = boot.start();
    expect(reentrant).toBe(run);
    await expect(run).resolves.toMatchObject({ status: 'ready' });
    await flushMicrotasks();
    expect(listenerErrors.length).toBeGreaterThan(0);
    expect(events).toHaveLength(5);

    unsubscribe();
    unsubscribe();
    const calls = listener.mock.calls.length;
    boot.invalidate(1);
    expect(listener).toHaveBeenCalledTimes(calls);
  });

  it('never resumes an older notification after a listener synchronously invalidates it', async () => {
    const boot = coordinator();
    const observed: string[] = [];
    boot.subscribe((state) => {
      if (state.status === 'ready') boot.invalidate(state.runId);
    });
    boot.subscribe((state) => {
      observed.push(`${state.runId}:${state.status}`);
    });

    await expect(boot.start()).resolves.toMatchObject({ status: 'idle', runId: 1 });
    expect(boot.getState()).toMatchObject({ status: 'idle', runId: 1 });
    expect(observed.at(-1)).toBe('1:idle');
    expect(observed).not.toContain('1:ready');
  });

  it('consumes a rejected async listener-error hook', async () => {
    const boot = coordinator(defaultAdapters(), retryable, async () => {
      throw new Error('async error hook failed');
    });
    boot.subscribe(async () => {
      throw new Error('async listener failed');
    });

    await expect(boot.start()).resolves.toMatchObject({ status: 'ready' });
    await flushMicrotasks();
  });

  it('keeps coordinator instances completely independent', async () => {
    const first = coordinator();
    const second = coordinator();

    await first.start();

    expect(first.getState()).toMatchObject({ status: 'ready', runId: 1 });
    expect(second.getState()).toEqual({ status: 'idle', runId: 0, issues: [] });
  });
});
