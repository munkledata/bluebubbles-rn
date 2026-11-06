/**
 * Realtime lifecycle, driven for real (coverage plan I-4): start → pause → resume → retry.
 *
 * `realtimeStartupOptional.test.ts` mocks the whole lifecycle; here it runs. realtimeControl, the
 * real SocketService, the transport-health/session/lock/feature stores, EventRouter plus the sink
 * chain, the durable dispatcher/drain, the repositories, the reachability and device-network
 * watches and the HttpClient all execute against a schema-migrated better-sqlite3 database. Only
 * boundaries that cannot exist in Node are faked (each jest.mock below names its boundary), plus
 * two separate subsystems whose work is out of scope here: HTTP sync and Firebase registration.
 *
 * The `it` blocks are one staged scenario and run in order; each stage asserts what the previous
 * one left behind, exactly as the app does across a foreground/background cycle.
 */
import { ServerInfo } from '@core/models';
import { encodeIncomingEvent, normalizeRealtimeEvent } from '@core/realtime';
import { logger } from '@core/secure';
import { enqueueIncomingEvent } from '@db/repositories';
import type { TestDb } from '@db/types';
import { useSessionStore } from '@state/sessionStore';
import { useTransportHealthStore } from '@state/transportHealthStore';
import { expoDigestBackend } from '@/services/realtime/expoDigestBackend';
import {
  getSocket,
  pauseRealtime,
  resumeRealtime,
  retryRealtimeConnection,
  setSocket,
  startRealtime,
  type RealtimeStartupIssue,
} from '@/services/realtimeControl';
import { probeReachabilityNow } from '@/services/reachability';
import { nextEventLoopTurn, waitForCondition } from '../support/async';
import { createTestDb } from '../support/testDb';

type Handler = (...args: unknown[]) => void;

/** The socket.io-client Socket surface SocketService touches, plus test controls. */
interface FakeIoSocket {
  readonly url: string;
  readonly opts: Record<string, unknown>;
  connected: boolean;
  active: boolean;
  disconnectCalls: number;
  on(event: string, handler: Handler): FakeIoSocket;
  off(event: string, handler: Handler): FakeIoSocket;
  emit(event: string, payload?: unknown): FakeIoSocket;
  disconnect(): FakeIoSocket;
  timeout(ms: number): { emitWithAck: (event: string, payload?: unknown) => Promise<unknown> };
  readonly io: {
    on(event: string, handler: Handler): void;
    off(event: string, handler: Handler): void;
  };
  /** Test control: deliver a native socket event ('connect', 'disconnect', a server event…). */
  fire(event: string, ...args: unknown[]): void;
}

// Mock state lives in `mock`-prefixed variables that the hoisted factories only read lazily.
const mockDbState: { db: TestDb | null } = { db: null };
const mockVault = new Map<string, string>();
const mockMarkerFiles = new Set<string>();
const mockNetwork = {
  listeners: [] as ((event: unknown) => void)[],
  removedSubscriptions: 0,
  snapshot: { type: 'WIFI', isConnected: true, isInternetReachable: true } as unknown,
};
const mockFcm = { registrations: 0 };
const mockSync = { resumeCalls: 0 };
const mockSockets: FakeIoSocket[] = [];

// Boundary: ky is ESM-only and cannot load under ts-jest/CJS. The stand-in forwards every request
// to the fetch the real HttpClient injects, so requests still reach the fake server below.
jest.mock('ky', () => ({
  __esModule: true,
  default: (
    url: string,
    options: {
      method: string;
      headers: Record<string, string>;
      searchParams: URLSearchParams;
      json?: unknown;
      signal?: AbortSignal;
      fetch: typeof fetch;
    },
  ) => {
    const search = options.searchParams.toString();
    return options.fetch(search ? `${url}?${search}` : url, {
      method: options.method,
      headers: options.headers,
      signal: options.signal,
      body: options.json === undefined ? undefined : JSON.stringify(options.json),
    });
  },
}));
// Boundary: the op-sqlite native driver. The one shared handle is the better-sqlite3 test DB.
jest.mock('@db/database', () => ({
  getDatabase: () => {
    if (!mockDbState.db) throw new Error('Database not initialized — call initDatabase() first.');
    return mockDbState.db;
  },
}));
// Boundary: Android Keystore (expo-secure-store is ESM + native). An in-memory vault.
jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED: 'whenUnlocked',
  getItemAsync: async (key: string) => mockVault.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    mockVault.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    mockVault.delete(key);
  },
}));
// Boundary: the native filesystem (expo-file-system is ESM + native); only the two zero-byte
// marker files (account revocation, DB write wedge) are touched here.
jest.mock('expo-file-system', () => ({
  Paths: { document: '/documents' },
  File: class {
    private readonly path: string;
    constructor(directory: string, name: string) {
      this.path = `${directory}/${name}`;
    }
    info(): { exists: boolean } {
      return { exists: mockMarkerFiles.has(this.path) };
    }
    create(): void {
      mockMarkerFiles.add(this.path);
    }
    delete(): void {
      mockMarkerFiles.delete(this.path);
    }
  },
}));
// Boundary: native connectivity (expo-network is ESM + native). Records the listener so the test
// can prove the device-network watch is attached on start and removed on pause.
jest.mock('expo-network', () => ({
  NetworkStateType: { NONE: 'NONE', UNKNOWN: 'UNKNOWN', WIFI: 'WIFI' },
  addNetworkStateListener: (listener: (event: unknown) => void) => {
    mockNetwork.listeners.push(listener);
    return {
      remove: () => {
        mockNetwork.removedSubscriptions += 1;
      },
    };
  },
  getNetworkStateAsync: async () => mockNetwork.snapshot,
}));
// Boundary: React Native itself (Flow source, not parseable here). credentialUpgrade reads only
// Platform.Version for its device name.
jest.mock('react-native', () => ({ Platform: { OS: 'android', Version: 36 } }));
// Boundary: Expo's native-module registry (the `expo` root is ESM). Nothing native is linked in
// Node, so the owned Direct Share shortcut module (loaded by message notifications) runs its
// "module unavailable" path for real.
jest.mock('expo', () => ({ requireOptionalNativeModule: () => null }));
// Boundary: the socket.io-client websocket driver. The REAL SocketService runs on top of this fake
// Socket, which records opens/disconnects and lets the test fire native events.
jest.mock('socket.io-client', () => ({
  io: (url: string, opts: Record<string, unknown>): FakeIoSocket => {
    const handlers = new Map<string, Handler[]>();
    const managerHandlers = new Map<string, Handler[]>();
    const add = (target: Map<string, Handler[]>, event: string, handler: Handler): void => {
      target.set(event, [...(target.get(event) ?? []), handler]);
    };
    const remove = (target: Map<string, Handler[]>, event: string, handler: Handler): void => {
      target.set(
        event,
        (target.get(event) ?? []).filter((candidate) => candidate !== handler),
      );
    };
    const socket: FakeIoSocket = {
      url,
      opts,
      connected: false,
      active: false,
      disconnectCalls: 0,
      on(event, handler) {
        add(handlers, event, handler);
        return socket;
      },
      off(event, handler) {
        remove(handlers, event, handler);
        return socket;
      },
      emit() {
        return socket;
      },
      disconnect() {
        socket.disconnectCalls += 1;
        const wasConnected = socket.connected;
        socket.connected = false;
        // socket.io-client reports a manual close synchronously, like the real driver does.
        if (wasConnected) socket.fire('disconnect', 'io client disconnect');
        return socket;
      },
      timeout() {
        return {
          emitWithAck: async () => {
            throw new Error('the fake socket never acknowledges');
          },
        };
      },
      io: {
        on(event, handler) {
          add(managerHandlers, event, handler);
        },
        off(event, handler) {
          remove(managerHandlers, event, handler);
        },
      },
      fire(event, ...args) {
        if (event === 'connect') socket.connected = true;
        for (const handler of [...(handlers.get(event) ?? [])]) handler(...args);
      },
    };
    mockSockets.push(socket);
    return socket;
  },
}));
// Subsystem boundary: Firebase token registration (native Firebase; out of scope here).
jest.mock('../../src/services/notifications/fcmMessaging', () => ({
  registerFcmToken: async () => {
    mockFcm.registrations += 1;
    return 'skipped';
  },
}));
// Subsystem boundary: the HTTP sync pipeline; the lifecycle only needs to prove it asked for it.
jest.mock('../../src/services/syncControl', () => ({
  maybeResumeSync: () => {
    mockSync.resumeCalls += 1;
  },
}));

const ORIGIN = 'https://gator.example.test';
const PASSWORD = 'correct-horse-battery-staple';
const SENDER = 'bob@example.com';
const WAIT_TURNS = 400;

// ── Fake Gator server behind the real HttpClient ───────────────────────────────────────────────
interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
}

const fakeServer = {
  requests: [] as RecordedRequest[],
  get pings(): number {
    return this.requests.filter((request) => new URL(request.url).pathname === '/api/v1/ping')
      .length;
  },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const fakeFetch: typeof fetch = async (input, init) => {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const headers = new Headers(init?.headers);
  const authorization = headers.get('authorization');
  fakeServer.requests.push({ method: init?.method ?? 'GET', url, authorization });
  if (authorization !== `Bearer ${PASSWORD}`) {
    return jsonResponse(401, { status: 401, message: 'Unauthorized' });
  }
  if (new URL(url).pathname === '/api/v1/ping') {
    return jsonResponse(200, { status: 200, message: 'Success', data: { pong: true } });
  }
  return jsonResponse(404, { status: 404, message: 'Not Found' });
};

// ── Real-timer recorder (the reachability interval is 30 s, far beyond a test's patience) ──────
interface RecordedTimer {
  readonly delay: number;
  readonly handle: ReturnType<typeof setTimeout>;
  cleared: boolean;
}

const recordedTimers: RecordedTimer[] = [];
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

function installTimerRecorder(): void {
  const recordingSetTimeout = (
    handler: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ): ReturnType<typeof setTimeout> => {
    const handle = realSetTimeout(handler, delay, ...args);
    recordedTimers.push({ delay: delay ?? 0, handle, cleared: false });
    return handle;
  };
  const recordingClearTimeout = (handle: ReturnType<typeof setTimeout> | undefined): void => {
    for (const timer of recordedTimers) if (timer.handle === handle) timer.cleared = true;
    realClearTimeout(handle);
  };
  globalThis.setTimeout = recordingSetTimeout as unknown as typeof setTimeout;
  globalThis.clearTimeout = recordingClearTimeout as unknown as typeof clearTimeout;
}

function restoreTimers(): void {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
}

// ── Fixtures and DB probes ─────────────────────────────────────────────────────────────────────
let fixtureSequence = 0;

/** A received iMessage with its chat embedded, as the server serializes a `new-message` event. */
function newMessagePayload(guid: string, text: string, chatGuid: string): Record<string, unknown> {
  fixtureSequence += 1;
  return {
    guid,
    text,
    dateCreated: 1_700_000_000_000 + fixtureSequence,
    originalROWID: fixtureSequence,
    isFromMe: false,
    handle: { address: SENDER },
    chats: [{ guid: chatGuid, displayName: 'Bob', participants: [{ address: SENDER }] }],
  };
}

/** Persist a pending durable queue row the way intake does, without draining it. */
async function seedPendingQueueRow(
  db: TestDb,
  payload: Record<string, unknown>,
  transportOccurrenceId: string,
): Promise<string> {
  const normalized = normalizeRealtimeEvent('new-message', payload);
  if (!normalized) throw new Error('the seeded fixture did not normalize');
  const encoded = await encodeIncomingEvent(
    normalized,
    { source: 'socket', receivedAt: Date.now(), transportOccurrenceId },
    expoDigestBackend,
  );
  const result = await enqueueIncomingEvent(db, encoded.envelope, () => true);
  if (result.status !== 'enqueued') throw new Error(`seed was not enqueued: ${result.status}`);
  return encoded.envelope.eventKey;
}

let raw: Awaited<ReturnType<typeof createTestDb>>['raw'];

function queueState(eventKey: string): string | undefined {
  const row = raw
    .prepare('SELECT state FROM incoming_event_queue WHERE event_key = ?')
    .get(eventKey) as { state: string } | undefined;
  return row?.state;
}

function queueStates(): string[] {
  const rows = raw.prepare('SELECT state FROM incoming_event_queue ORDER BY id').all() as {
    state: string;
  }[];
  return rows.map((row) => row.state);
}

function storedMessageText(guid: string): string | null | undefined {
  const row = raw.prepare('SELECT text FROM messages WHERE guid = ?').get(guid) as
    { text: string | null } | undefined;
  return row?.text;
}

function health(): ReturnType<typeof useTransportHealthStore.getState> {
  return useTransportHealthStore.getState();
}

function latestSocket(): FakeIoSocket {
  const socket = mockSockets[mockSockets.length - 1];
  if (!socket) throw new Error('no fake socket has been opened');
  return socket;
}

const loggedErrors: unknown[][] = [];
const realFetch = globalThis.fetch;
let seededStartupEventKey: string;

describe('realtime lifecycle against a real DB and a fake socket', () => {
  beforeAll(async () => {
    const created = await createTestDb();
    mockDbState.db = created.db;
    raw = created.raw;
    globalThis.fetch = fakeFetch;
    installTimerRecorder();
    jest.spyOn(logger, 'error').mockImplementation((...args: unknown[]) => {
      loggedErrors.push(args);
    });
    useSessionStore.getState().connected(ORIGIN, PASSWORD, ServerInfo.parse({}));
    // A row left pending by a "prior process": startup must drain it before any new callback.
    seededStartupEventKey = await seedPendingQueueRow(
      created.db,
      newMessagePayload('msg-seeded-before-start', 'left pending by the last process', 'chat-bob'),
      'socket:prior-process:1',
    );
  });

  afterAll(async () => {
    pauseRealtime();
    setSocket(null);
    useTransportHealthStore.getState().reset();
    useSessionStore.getState().reset();
    globalThis.fetch = realFetch;
    restoreTimers();
    jest.restoreAllMocks();
    await nextEventLoopTurn();
    raw.close();
  });

  it('start: opens the socket with the session transport and publishes connected health for the current generation', async () => {
    const issues: RealtimeStartupIssue[] = [];
    await startRealtime({ reportIssue: (issue) => issues.push(issue) });

    expect(mockSockets).toHaveLength(1);
    const socket = latestSocket();
    expect(socket.url).toBe(ORIGIN);
    expect(socket.opts.auth).toEqual({ password: PASSWORD });
    expect((socket.opts.extraHeaders as Record<string, string>).Authorization).toBe(
      `Bearer ${PASSWORD}`,
    );
    expect(getSocket()?.connected).toBe(false);
    expect(health()).toMatchObject({
      generation: 1,
      active: true,
      socket: 'connecting',
      status: 'connecting',
    });

    socket.fire('connect');

    expect(getSocket()?.connected).toBe(true);
    expect(health()).toMatchObject({
      generation: 1,
      socket: 'connected',
      status: 'connected',
      hasConnected: true,
    });
    // The reachability watch pinged the fake server through the real HttpClient with the
    // session credential, and the device-network watch attached and read the native snapshot.
    await waitForCondition(() => health().server === 'reachable', 'server reachable', WAIT_TURNS);
    expect(fakeServer.pings).toBe(1);
    expect(fakeServer.requests[0]).toMatchObject({
      method: 'GET',
      url: `${ORIGIN}/api/v1/ping`,
      authorization: `Bearer ${PASSWORD}`,
    });
    await waitForCondition(() => health().network === 'online', 'network online', WAIT_TURNS);
    expect(mockNetwork.listeners).toHaveLength(1);
    // FCM registration runs on every (re)connect; 'skipped' and a granted notification permission
    // are not degradations, so nothing is reported.
    await waitForCondition(() => mockFcm.registrations === 1, 'FCM registration', WAIT_TURNS);
    expect(issues).toEqual([]);
    expect(mockSync.resumeCalls).toBe(0);
  });

  it('start: the startup drain applies the queue row left pending before startRealtime', async () => {
    await waitForCondition(
      () => queueState(seededStartupEventKey) === 'completed',
      'startup drain completion',
      WAIT_TURNS,
    );
    expect(storedMessageText('msg-seeded-before-start')).toBe('left pending by the last process');
    expect(loggedErrors).toEqual([]);
  });

  it('start: a new-message event fired on the socket is persisted through the durable queue', async () => {
    latestSocket().fire(
      'new-message',
      newMessagePayload('msg-live-1', 'hello from the socket', 'chat-bob'),
    );

    await waitForCondition(
      () => storedMessageText('msg-live-1') === 'hello from the socket',
      'live message persisted',
      WAIT_TURNS,
    );
    await waitForCondition(
      () => queueStates().every((state) => state === 'completed'),
      'live queue row completed',
      WAIT_TURNS,
    );
    expect(queueStates()).toEqual(['completed', 'completed']);
    expect(loggedErrors).toEqual([]);
  });

  it('pause: disconnects the socket, pauses transport health and stops both watches', async () => {
    const socket = latestSocket();
    const pingsBefore = fakeServer.pings;
    // The only pending 30 s timer in a healthy lifecycle is the reachability interval.
    const reachabilityTimers = recordedTimers.filter(
      (timer) => timer.delay === 30_000 && !timer.cleared,
    );
    expect(reachabilityTimers).toHaveLength(1);

    pauseRealtime();

    expect(socket.disconnectCalls).toBe(1);
    expect(socket.connected).toBe(false);
    expect(getSocket()).toBeNull();
    expect(health()).toMatchObject({
      generation: 2,
      active: false,
      socket: 'idle',
      server: 'unknown',
      status: 'idle',
      hasConnected: true,
    });
    expect(reachabilityTimers[0]?.cleared).toBe(true);
    expect(mockNetwork.removedSubscriptions).toBe(1);
    // No watch is left to probe, and a retired socket cannot enter durable intake.
    probeReachabilityNow();
    socket.fire('new-message', newMessagePayload('msg-after-pause', 'too late', 'chat-bob'));
    for (let turn = 0; turn < 5; turn += 1) await nextEventLoopTurn();
    expect(fakeServer.pings).toBe(pingsBefore);
    expect(storedMessageText('msg-after-pause')).toBeUndefined();
    expect(retryRealtimeConnection()).toBe(false);
  });

  it('resume: reconnects on a fresh socket, drains the durable queue and asks sync to catch up', async () => {
    const db = mockDbState.db;
    if (!db) throw new Error('test DB missing');
    // Arrived while the app was backgrounded (a locked V3 push persists this way).
    const pendingWhilePaused = await seedPendingQueueRow(
      db,
      newMessagePayload('msg-while-paused', 'queued while backgrounded', 'chat-bob'),
      'socket:prior-process:2',
    );
    const pingsBefore = fakeServer.pings;

    await resumeRealtime();

    expect(mockSockets).toHaveLength(2);
    const socket = latestSocket();
    expect(socket.url).toBe(ORIGIN);
    expect(socket.opts.auth).toEqual({ password: PASSWORD });
    expect(health()).toMatchObject({
      generation: 3,
      active: true,
      socket: 'reconnecting',
      status: 'reconnecting',
    });
    expect(mockSync.resumeCalls).toBe(1);
    await waitForCondition(
      () => queueState(pendingWhilePaused) === 'completed',
      'resume drain completion',
      WAIT_TURNS,
    );
    expect(storedMessageText('msg-while-paused')).toBe('queued while backgrounded');

    socket.fire('connect');

    expect(health()).toMatchObject({ generation: 3, socket: 'connected', status: 'connected' });
    await waitForCondition(() => health().server === 'reachable', 'server reachable', WAIT_TURNS);
    expect(fakeServer.pings).toBe(pingsBefore + 1);
    await waitForCondition(() => mockFcm.registrations === 2, 'FCM re-registration', WAIT_TURNS);
    // A fresh SocketService's first connect is not a recovery, so sync is not asked twice.
    expect(mockSync.resumeCalls).toBe(1);
    expect(loggedErrors).toEqual([]);
  });

  it('retry: refuses without a connected session, otherwise replaces the socket and re-probes the server', async () => {
    const retiring = latestSocket();
    const pingsBefore = fakeServer.pings;
    const generation = health().generation;

    useSessionStore.setState({ status: 'error' });
    expect(retryRealtimeConnection()).toBe(false);
    useSessionStore.setState({ status: 'connected' });
    expect(mockSockets).toHaveLength(2);

    expect(retryRealtimeConnection()).toBe(true);

    expect(retiring.disconnectCalls).toBe(1);
    expect(mockSockets).toHaveLength(3);
    const replacement = latestSocket();
    expect(replacement.url).toBe(ORIGIN);
    expect(replacement.opts.auth).toEqual({ password: PASSWORD });
    expect(getSocket()?.connected).toBe(false);
    // `retry(generation)` keeps the owner and discards the prior server result.
    expect(health()).toMatchObject({
      generation,
      active: true,
      socket: 'reconnecting',
      server: 'unknown',
      status: 'reconnecting',
    });
    // The retry re-probes the server through the real HttpClient at once. Known gap, deliberately
    // not asserted either way: the watch dedups its result against its own last state
    // (reachability.ts `publish`), so this unchanged 'reachable' answer never reaches the store,
    // which keeps `server: 'unknown'` until the socket reconnects or the answer changes.
    await waitForCondition(
      () => fakeServer.pings === pingsBefore + 1,
      'server re-probed after retry',
      WAIT_TURNS,
    );
    expect(fakeServer.requests[fakeServer.requests.length - 1]).toMatchObject({
      url: `${ORIGIN}/api/v1/ping`,
      authorization: `Bearer ${PASSWORD}`,
    });

    replacement.fire('connect');

    // The replacement reconnected a service that had been live before: a recovery, so sync is
    // asked to catch up.
    expect(getSocket()?.connected).toBe(true);
    expect(health()).toMatchObject({ generation, socket: 'connected', status: 'connected' });
    expect(mockSync.resumeCalls).toBe(2);
    expect(fakeServer.requests.every((request) => request.url === `${ORIGIN}/api/v1/ping`)).toBe(
      true,
    );
    expect(loggedErrors).toEqual([]);
  });
});
