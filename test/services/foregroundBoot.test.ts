import type { BootState } from '@/services/boot/bootStateMachine';

const mockLockState = { locked: false };
const mockHydrateLock = jest.fn();
const mockInspectForegroundBootSession = jest.fn();
const mockOpenForegroundBootDatabase = jest.fn();
const mockHydrateForegroundBootSettings = jest.fn();
const mockActivateForegroundBootSession = jest.fn();
const mockIsForegroundBootAttempt = jest.fn();
const mockRunCryptoSelfTest = jest.fn();
const mockRunDbDriverSelfTest = jest.fn();
const mockStartDevDbRelaunchContractIfRequested = jest.fn();
const mockCheckDeviceIntegrity = jest.fn();
const mockRegisterBackgroundSync = jest.fn();
const mockInitErrorReporting = jest.fn();
const mockInitPersistentLogs = jest.fn();
const mockHasConfirmedPersistentLogCleanup = jest.fn();
const mockStartFcm = jest.fn();
const mockClearShareShortcuts = jest.fn();

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

const mockDbDriverPass = {
  schema: 3,
  suite: 'android-db-contract',
  status: 'pass',
  migrationCount: 39,
  migrationHead: '0039_message_error_message',
  checks: {
    encryptedOpen: true,
    wrongKeyRejected: true,
    migrationRollback: true,
    migrationRetry: true,
    migrationLedger: true,
    migrationData: true,
    fts5: true,
    integrity: true,
    idempotent: true,
    rollback: true,
    syncReactive: true,
    asyncReactive: true,
    rawReactive: true,
    rekey: true,
    newKeyReopen: true,
    oldKeyRejected: true,
    historicalProvenance: true,
    historical0024: true,
    historical0027: true,
    historical0029: true,
    historicalReadOnly: true,
    historicalWrongKeyRejected: true,
    historicalData: true,
    historicalFts5: true,
    historicalIntegrity: true,
    historicalIdempotent: true,
    historicalCleanup: true,
    cleanup: true,
  },
} as const;
const mockDbDriverInternalFailure = {
  schema: 3,
  suite: 'android-db-contract',
  status: 'fail',
  migrationCount: 39,
  migrationHead: '0039_message_error_message',
  checks: {
    encryptedOpen: false,
    wrongKeyRejected: false,
    migrationRollback: false,
    migrationRetry: false,
    migrationLedger: false,
    migrationData: false,
    fts5: false,
    integrity: false,
    idempotent: false,
    rollback: false,
    syncReactive: false,
    asyncReactive: false,
    rawReactive: false,
    rekey: false,
    newKeyReopen: false,
    oldKeyRejected: false,
    historicalProvenance: false,
    historical0024: false,
    historical0027: false,
    historical0029: false,
    historicalReadOnly: false,
    historicalWrongKeyRejected: false,
    historicalData: false,
    historicalFts5: false,
    historicalIntegrity: false,
    historicalIdempotent: false,
    historicalCleanup: false,
    cleanup: false,
  },
  failureCode: 'internal',
} as const;

jest.mock('@core/realtime', () => ({ FCM_ENABLED: false }));
jest.mock('@core/secure', () => ({ logger: mockLogger }));
jest.mock('@db/database', () => ({
  DB_DRIVER_CONTRACT_INTERNAL_FAILURE: mockDbDriverInternalFailure,
  runDbDriverSelfTest: mockRunDbDriverSelfTest,
}));
jest.mock('@native/deviceIntegrity', () => ({ checkDeviceIntegrity: mockCheckDeviceIntegrity }));
jest.mock('@state/lockStore', () => ({
  useLockStore: { getState: () => ({ locked: mockLockState.locked }) },
}));
jest.mock('@/services/background/backgroundSync', () => ({
  registerBackgroundSync: mockRegisterBackgroundSync,
}));
jest.mock('@/services/bootstrap', () => {
  class ForegroundBootOperationalError extends Error {
    constructor(
      readonly code: string,
      readonly userMessage: string,
    ) {
      super(userMessage);
      this.name = 'ForegroundBootOperationalError';
    }
  }

  class ForegroundBootSupersededError extends Error {
    constructor() {
      super('Foreground boot ownership was superseded.');
      this.name = 'ForegroundBootSupersededError';
    }
  }

  return {
    activateForegroundBootSession: mockActivateForegroundBootSession,
    ForegroundBootOperationalError,
    ForegroundBootSupersededError,
    hydrateForegroundBootSettings: mockHydrateForegroundBootSettings,
    inspectForegroundBootSession: mockInspectForegroundBootSession,
    isForegroundBootAttempt: mockIsForegroundBootAttempt,
    openForegroundBootDatabase: mockOpenForegroundBootDatabase,
  };
});
jest.mock('@/services/clients', () => ({ runCryptoSelfTest: mockRunCryptoSelfTest }));
jest.mock('@/services/errors', () => ({ initErrorReporting: mockInitErrorReporting }));
jest.mock('@/services/lock', () => {
  class InvalidAppLockSettingError extends Error {
    constructor() {
      super('The persisted App Lock value is invalid.');
      this.name = 'InvalidAppLockSettingError';
    }
  }

  return { InvalidAppLockSettingError, hydrateLock: mockHydrateLock };
});
jest.mock('@/services/logging/fileLogSink', () => ({
  fileLogSink: { hasConfirmedCleanup: mockHasConfirmedPersistentLogCleanup },
  initPersistentLogs: mockInitPersistentLogs,
}));
jest.mock('@/services/notifications/fcmMessaging', () => ({ startFcm: mockStartFcm }));
jest.mock('@/services/shortcuts/shareShortcuts', () => ({
  clearShareShortcuts: mockClearShareShortcuts,
}));
jest.mock('@/services/boot/devDbRelaunchContract', () => ({
  startDevDbRelaunchContractIfRequested: mockStartDevDbRelaunchContractIfRequested,
}));

interface PrivateAttempt {
  readonly activationEpoch: number;
  readonly snapshot: {
    readonly sessionState: 'active';
    readonly origin: string;
    readonly password: string;
  };
  readonly resources: { db: null };
}

const PRIVATE_ORIGIN = 'https://private-origin-sentinel.example';
const PRIVATE_PASSWORD = 'private-password-sentinel';
const originalDevDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__DEV__');

function setDevMode(enabled: boolean): void {
  Object.defineProperty(globalThis, '__DEV__', {
    configurable: true,
    writable: true,
    value: enabled,
  });
}

function privateAttempt(): PrivateAttempt {
  return Object.freeze({
    activationEpoch: 7,
    snapshot: Object.freeze({
      sessionState: 'active' as const,
      origin: PRIVATE_ORIGIN,
      password: PRIVATE_PASSWORD,
    }),
    resources: { db: null },
  });
}

function connected(attempt: PrivateAttempt): {
  readonly kind: 'connected';
  readonly session: PrivateAttempt;
} {
  return { kind: 'connected', session: attempt };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function loadForegroundBoot(): {
  foreground: typeof import('@/services/boot/foregroundBoot');
  transition: typeof import('@/services/boot/foregroundBootInvalidation');
} {
  return {
    foreground:
      // Fresh module evaluation is the behavior under test; static imports cannot follow resetModules.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('@/services/boot/foregroundBoot') as typeof import('@/services/boot/foregroundBoot'),
    transition:
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('@/services/boot/foregroundBootInvalidation') as typeof import('@/services/boot/foregroundBootInvalidation'),
  };
}

async function waitForBootState(
  read: () => BootState,
  predicate: (state: BootState) => boolean,
): Promise<BootState> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = read();
    if (predicate(state)) return state;
    await Promise.resolve();
  }
  throw new Error(`boot state did not settle: ${JSON.stringify(read())}`);
}

async function flushMicrotasks(count = 12): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  setDevMode(false);
  mockLockState.locked = false;

  const attempt = privateAttempt();
  mockHydrateLock.mockResolvedValue(undefined);
  mockInspectForegroundBootSession.mockResolvedValue(connected(attempt));
  mockOpenForegroundBootDatabase.mockResolvedValue(undefined);
  mockHydrateForegroundBootSettings.mockResolvedValue(undefined);
  mockActivateForegroundBootSession.mockResolvedValue(undefined);
  mockIsForegroundBootAttempt.mockImplementation((value: unknown) => value === attempt);

  mockRunCryptoSelfTest.mockResolvedValue({ ok: true });
  mockRunDbDriverSelfTest.mockResolvedValue(mockDbDriverPass);
  mockStartDevDbRelaunchContractIfRequested.mockReturnValue(undefined);
  mockCheckDeviceIntegrity.mockResolvedValue({ compromised: false });
  mockRegisterBackgroundSync.mockResolvedValue('registered');
  mockInitErrorReporting.mockReturnValue(undefined);
  mockInitPersistentLogs.mockResolvedValue(undefined);
  mockHasConfirmedPersistentLogCleanup.mockReturnValue(false);
  mockStartFcm.mockResolvedValue('started');
  mockClearShareShortcuts.mockReturnValue(true);
});

afterEach(async () => {
  await flushMicrotasks();
});

afterAll(() => {
  if (originalDevDescriptor) {
    Object.defineProperty(globalThis, '__DEV__', originalDevDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, '__DEV__');
  }
});

describe('production foreground boot singleton', () => {
  it('gives a requested DEV relaunch contract exclusive ownership before production boot', () => {
    setDevMode(true);
    const contractRun = new Promise<never>(() => undefined);
    mockStartDevDbRelaunchContractIfRequested.mockReturnValue(contractRun);
    const { foreground } = loadForegroundBoot();

    expect(foreground.startForegroundBoot()).toBe(contractRun);
    expect(foreground.startForegroundBoot()).toBe(contractRun);
    expect(mockStartDevDbRelaunchContractIfRequested).toHaveBeenCalledTimes(2);
    expect(foreground.getForegroundBootSnapshot()).toMatchObject({ status: 'idle' });
    expect(mockHydrateLock).not.toHaveBeenCalled();
    expect(mockInspectForegroundBootSession).not.toHaveBeenCalled();
    expect(mockOpenForegroundBootDatabase).not.toHaveBeenCalled();
    expect(mockClearShareShortcuts).not.toHaveBeenCalled();
    expect(mockInitErrorReporting).not.toHaveBeenCalled();
    expect(mockInitPersistentLogs).not.toHaveBeenCalled();
    expect(mockCheckDeviceIntegrity).not.toHaveBeenCalled();
    expect(mockRegisterBackgroundSync).not.toHaveBeenCalled();
    expect(mockRunCryptoSelfTest).not.toHaveBeenCalled();
    expect(mockRunDbDriverSelfTest).not.toHaveBeenCalled();
  });

  it('never inspects a DEV relaunch request during a production boot', async () => {
    setDevMode(false);
    const contractRun = new Promise<never>(() => undefined);
    mockStartDevDbRelaunchContractIfRequested.mockReturnValue(contractRun);
    const { foreground } = loadForegroundBoot();

    const productionRun = foreground.startForegroundBoot();
    expect(productionRun).not.toBe(contractRun);
    await expect(productionRun).resolves.toMatchObject({
      status: 'ready',
      mode: 'connected',
    });
    expect(mockStartDevDbRelaunchContractIfRequested).not.toHaveBeenCalled();
  });

  it('owns one exact Promise, runs the production stages in order, and keeps secrets private', async () => {
    const { foreground } = loadForegroundBoot();

    const first = foreground.startForegroundBoot();
    const second = foreground.startForegroundBoot();

    expect(second).toBe(first);
    await expect(first).resolves.toMatchObject({
      status: 'ready',
      mode: 'connected',
      runId: 1,
    });

    expect(mockHydrateLock).toHaveBeenCalledTimes(1);
    expect(mockInspectForegroundBootSession).toHaveBeenCalledTimes(1);
    expect(mockOpenForegroundBootDatabase).toHaveBeenCalledTimes(1);
    expect(mockHydrateForegroundBootSettings).toHaveBeenCalledTimes(1);
    expect(mockActivateForegroundBootSession).toHaveBeenCalledTimes(1);

    const stageOrder = [
      mockHydrateLock,
      mockInspectForegroundBootSession,
      mockOpenForegroundBootDatabase,
      mockHydrateForegroundBootSettings,
      mockActivateForegroundBootSession,
    ].map((stage) => stage.mock.invocationCallOrder[0]);
    expect(stageOrder).toEqual([...stageOrder].sort((a, b) => (a ?? 0) - (b ?? 0)));

    const privateSession = mockInspectForegroundBootSession.mock.results[0]?.value;
    await expect(privateSession).resolves.toEqual(expect.objectContaining({ kind: 'connected' }));
    const attempt = (await privateSession).session as PrivateAttempt;
    expect(mockOpenForegroundBootDatabase.mock.calls[0]?.[1]).toBe(attempt);
    expect(mockHydrateForegroundBootSettings.mock.calls[0]?.[1]).toBe(attempt);
    expect(mockActivateForegroundBootSession.mock.calls[0]?.[1]).toBe(attempt);
    expect(mockIsForegroundBootAttempt).toHaveBeenCalledWith(attempt);

    const publicState = JSON.stringify(foreground.getForegroundBootSnapshot());
    expect(publicState).not.toContain(PRIVATE_ORIGIN);
    expect(publicState).not.toContain(PRIVATE_PASSWORD);
    expect(foreground.startForegroundBoot).toEqual(expect.any(Function));
    expect(foreground.retryForegroundBoot).toEqual(expect.any(Function));
    expect(foreground.unlockForegroundBoot).toEqual(expect.any(Function));
    expect(foreground.invalidateForegroundBootRun).toEqual(expect.any(Function));
  });

  it('invalidates only the exact UI-owned run, even after that run reaches ready', async () => {
    const { foreground } = loadForegroundBoot();
    await expect(foreground.startForegroundBoot()).resolves.toMatchObject({
      status: 'ready',
      runId: 1,
    });
    const ready = foreground.getForegroundBootSnapshot();

    expect(foreground.invalidateForegroundBootRun(999)).toBe(ready);
    expect(foreground.getForegroundBootSnapshot()).toBe(ready);

    expect(foreground.invalidateForegroundBootRun(1)).toMatchObject({
      status: 'idle',
      runId: 1,
    });
    expect(foreground.getForegroundBootSnapshot()).toMatchObject({
      status: 'idle',
      runId: 1,
    });
  });

  it('keeps a locked run pending and resumes only its exact rendered run id', async () => {
    mockLockState.locked = true;
    const { foreground } = loadForegroundBoot();

    const run = foreground.startForegroundBoot();
    await waitForBootState(
      foreground.getForegroundBootSnapshot,
      (state) => state.status === 'locked',
    );

    expect(mockInspectForegroundBootSession).not.toHaveBeenCalled();
    const staleUnlock = foreground.unlockForegroundBoot(999);
    expect(staleUnlock).not.toBe(run);
    await expect(staleUnlock).resolves.toMatchObject({ status: 'locked', runId: 1 });
    expect(mockInspectForegroundBootSession).not.toHaveBeenCalled();

    const exactUnlock = foreground.unlockForegroundBoot(1);
    expect(exactUnlock).toBe(run);
    await expect(exactUnlock).resolves.toMatchObject({
      status: 'ready',
      mode: 'connected',
      runId: 1,
    });
    expect(mockInspectForegroundBootSession).toHaveBeenCalledTimes(1);
  });

  it('publishes safe failure copy, retries with a new run, and starts process work once', async () => {
    setDevMode(true);
    const rawFailure = new Error(
      `vault failed for ${PRIVATE_ORIGIN} with ${PRIVATE_PASSWORD} and raw-error-sentinel`,
    );
    const attempt = privateAttempt();
    mockInspectForegroundBootSession
      .mockRejectedValueOnce(rawFailure)
      .mockResolvedValueOnce(connected(attempt));
    mockIsForegroundBootAttempt.mockImplementation((value: unknown) => value === attempt);
    const { foreground } = loadForegroundBoot();

    const failed = await foreground.startForegroundBoot();
    expect(failed).toMatchObject({
      status: 'failed',
      runId: 1,
      failure: {
        stage: 'session',
        kind: 'retryable',
        failClosed: true,
        code: 'session-failed',
        userMessage: 'Gator could not safely read the saved connection. Try again.',
      },
    });
    const failedJson = JSON.stringify(failed);
    expect(failedJson).not.toContain(PRIVATE_ORIGIN);
    expect(failedJson).not.toContain(PRIVATE_PASSWORD);
    expect(failedJson).not.toContain('raw-error-sentinel');

    await expect(foreground.retryForegroundBoot(1)).resolves.toMatchObject({
      status: 'ready',
      mode: 'connected',
      runId: 2,
    });

    expect(mockHydrateLock).toHaveBeenCalledTimes(2);
    expect(mockInspectForegroundBootSession).toHaveBeenCalledTimes(2);
    expect(mockClearShareShortcuts).toHaveBeenCalledTimes(1);
    expect(mockInitErrorReporting).toHaveBeenCalledTimes(1);
    expect(mockInitPersistentLogs).toHaveBeenCalledTimes(1);
    expect(mockCheckDeviceIntegrity).toHaveBeenCalledTimes(1);
    expect(mockRegisterBackgroundSync).toHaveBeenCalledTimes(1);
    expect(mockStartFcm).not.toHaveBeenCalled();
    expect(mockRunCryptoSelfTest).toHaveBeenCalledTimes(1);
    expect(mockRunDbDriverSelfTest).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledWith(
      `GATOR_DB_CONTRACT_V3 ${JSON.stringify(mockDbDriverPass)}`,
    );
  });

  it('emits one finite marker for a rejected DEV driver self-test and never reruns it on retry', async () => {
    setDevMode(true);
    const driverFailure = new Error('private native driver failure');
    const attempt = privateAttempt();
    mockRunDbDriverSelfTest.mockRejectedValueOnce(driverFailure);
    mockInspectForegroundBootSession
      .mockRejectedValueOnce(new Error('first session read failed'))
      .mockResolvedValueOnce(connected(attempt));
    mockIsForegroundBootAttempt.mockImplementation((value: unknown) => value === attempt);
    const { foreground } = loadForegroundBoot();

    await expect(foreground.startForegroundBoot()).resolves.toMatchObject({
      status: 'failed',
      runId: 1,
    });
    await flushMicrotasks();
    await expect(foreground.retryForegroundBoot(1)).resolves.toMatchObject({
      status: 'ready',
      runId: 2,
    });
    await expect(foreground.startForegroundBoot()).resolves.toMatchObject({
      status: 'ready',
      runId: 2,
    });

    expect(mockRunDbDriverSelfTest).toHaveBeenCalledTimes(1);
    const contractLogs = mockLogger.info.mock.calls.filter(
      ([message]) => typeof message === 'string' && message.startsWith('GATOR_DB_CONTRACT_V3 '),
    );
    expect(contractLogs).toEqual([
      [`GATOR_DB_CONTRACT_V3 ${JSON.stringify(mockDbDriverInternalFailure)}`],
    ]);
    expect(
      JSON.stringify({ info: mockLogger.info.mock.calls, warn: mockLogger.warn.mock.calls }),
    ).not.toContain(driverFailure.message);
  });

  it('makes a non-settling database open fatal because a second native open is unsafe', async () => {
    jest.useFakeTimers();
    try {
      mockOpenForegroundBootDatabase.mockImplementationOnce(
        () => new Promise<void>(() => undefined),
      );
      const { foreground } = loadForegroundBoot();

      const first = foreground.startForegroundBoot();
      await waitForBootState(
        foreground.getForegroundBootSnapshot,
        (state) => state.status === 'loading' && state.stage === 'database',
      );
      jest.advanceTimersByTime(30_000);
      await flushMicrotasks();

      await expect(first).resolves.toMatchObject({
        status: 'failed',
        runId: 1,
        failure: {
          stage: 'database',
          kind: 'fatal',
          failClosed: true,
          code: 'database-timeout',
          userMessage:
            'Gator could not finish opening your encrypted messages. Fully close and reopen Gator to try again.',
        },
      });
      await expect(foreground.retryForegroundBoot(1)).resolves.toMatchObject({
        status: 'failed',
        runId: 1,
        failure: { kind: 'fatal', code: 'database-timeout' },
      });
      expect(mockOpenForegroundBootDatabase).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('still retries a database open that settled with an operational error', async () => {
    const { ForegroundBootOperationalError } =
      // The production module is mocked above; use its exact class so `instanceof` is meaningful.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('@/services/bootstrap') as typeof import('@/services/bootstrap');
    mockOpenForegroundBootDatabase
      .mockRejectedValueOnce(
        new ForegroundBootOperationalError(
          'database-open-failed',
          'Gator could not open your encrypted messages. Try again.',
        ),
      )
      .mockResolvedValueOnce(undefined);
    const { foreground } = loadForegroundBoot();

    await expect(foreground.startForegroundBoot()).resolves.toMatchObject({
      status: 'failed',
      runId: 1,
      failure: {
        stage: 'database',
        kind: 'retryable',
        code: 'database-open-failed',
      },
    });
    await expect(foreground.retryForegroundBoot(1)).resolves.toMatchObject({
      status: 'ready',
      mode: 'connected',
      runId: 2,
    });
    expect(mockOpenForegroundBootDatabase).toHaveBeenCalledTimes(2);
  });

  it('replays a delayed process-level degraded issue onto the retry generation', async () => {
    const backgroundRegistration = deferred<'unavailable'>();
    mockRegisterBackgroundSync.mockReturnValueOnce(backgroundRegistration.promise);
    const attempt = privateAttempt();
    mockInspectForegroundBootSession
      .mockRejectedValueOnce(new Error('first session read failed'))
      .mockResolvedValueOnce(connected(attempt));
    mockIsForegroundBootAttempt.mockImplementation((value: unknown) => value === attempt);
    const { foreground } = loadForegroundBoot();

    await expect(foreground.startForegroundBoot()).resolves.toMatchObject({
      status: 'failed',
      runId: 1,
    });
    backgroundRegistration.resolve('unavailable');
    await flushMicrotasks();
    expect(foreground.getForegroundBootSnapshot()).toMatchObject({ status: 'failed', runId: 1 });

    await expect(foreground.retryForegroundBoot(1)).resolves.toMatchObject({
      status: 'ready',
      mode: 'connected',
      runId: 2,
      issues: [
        {
          stage: 'background-task',
          level: 'degraded',
          code: 'background-task-unavailable',
          userMessage: 'Background catch-up is unavailable; open Gator to refresh messages.',
        },
      ],
    });
    expect(mockRegisterBackgroundSync).toHaveBeenCalledTimes(1);
  });

  it('retires a confirmed persistent-log cleanup issue without restarting the process', async () => {
    const initialization = Promise.withResolvers<void>();
    mockInitPersistentLogs.mockReturnValueOnce(initialization.promise);
    const { foreground } = loadForegroundBoot();

    await expect(foreground.startForegroundBoot()).resolves.toMatchObject({
      status: 'ready',
      runId: 1,
    });
    initialization.reject(new Error('private legacy log cleanup failure'));
    await flushMicrotasks();
    expect(foreground.getForegroundBootSnapshot().issues).toContainEqual({
      stage: 'persistent-logs',
      level: 'degraded',
      code: 'persistent-log-init-failed',
      userMessage:
        'Older App Logs could not be removed safely. Open Settings → App Logs and tap Clear.',
    });

    expect(foreground.resolvePersistentLogCleanupIssue()).toBe(false);
    expect(foreground.getForegroundBootSnapshot().issues).toHaveLength(1);

    mockHasConfirmedPersistentLogCleanup.mockReturnValue(true);
    expect(foreground.resolvePersistentLogCleanupIssue()).toBe(true);
    expect(foreground.getForegroundBootSnapshot().issues).toEqual([]);
  });

  it('does not recreate the cleanup issue when boot initialization rejects after confirmed Clear', async () => {
    const initialization = Promise.withResolvers<void>();
    mockInitPersistentLogs.mockReturnValueOnce(initialization.promise);
    const { foreground } = loadForegroundBoot();

    await expect(foreground.startForegroundBoot()).resolves.toMatchObject({
      status: 'ready',
      runId: 1,
    });
    mockHasConfirmedPersistentLogCleanup.mockReturnValue(true);
    expect(foreground.resolvePersistentLogCleanupIssue()).toBe(true);

    initialization.reject(new Error('late private legacy log cleanup failure'));
    await flushMicrotasks();
    expect(foreground.getForegroundBootSnapshot().issues).toEqual([]);
  });

  it('replays a process issue that settles while no foreground generation owns state', async () => {
    const backgroundRegistration = deferred<'unavailable'>();
    const firstSession = deferred<ReturnType<typeof connected>>();
    mockRegisterBackgroundSync.mockReturnValueOnce(backgroundRegistration.promise);
    mockInspectForegroundBootSession
      .mockReturnValueOnce(firstSession.promise)
      .mockResolvedValueOnce({ kind: 'setup' });
    const { foreground, transition } = loadForegroundBoot();

    const first = foreground.startForegroundBoot();
    await waitForBootState(
      foreground.getForegroundBootSnapshot,
      (state) => state.status === 'loading' && state.stage === 'session',
    );
    transition.invalidateForegroundBootForAccountTransition();
    await expect(first).resolves.toMatchObject({ status: 'idle', runId: 1 });

    backgroundRegistration.resolve('unavailable');
    await flushMicrotasks();
    expect(foreground.getForegroundBootSnapshot()).toMatchObject({ status: 'idle', runId: 1 });

    expect(transition.restartForegroundBootAfterAccountTransition()).toBe(true);
    await expect(foreground.startForegroundBoot()).resolves.toMatchObject({
      status: 'ready',
      mode: 'setup',
      runId: 2,
      issues: [
        {
          stage: 'background-task',
          level: 'degraded',
          code: 'background-task-unavailable',
          userMessage: 'Background catch-up is unavailable; open Gator to refresh messages.',
        },
      ],
    });

    firstSession.resolve(connected(privateAttempt()));
    await flushMicrotasks();
    expect(foreground.getForegroundBootSnapshot()).toMatchObject({
      status: 'ready',
      mode: 'setup',
      runId: 2,
    });
    expect(mockRegisterBackgroundSync).toHaveBeenCalledTimes(1);
  });

  it('restarts after an account transition and reaches setup instead of remaining idle', async () => {
    const { foreground, transition } = loadForegroundBoot();
    await expect(foreground.startForegroundBoot()).resolves.toMatchObject({
      status: 'ready',
      mode: 'connected',
      runId: 1,
    });

    mockInspectForegroundBootSession.mockResolvedValue({ kind: 'setup' });
    transition.invalidateForegroundBootForAccountTransition();
    expect(foreground.getForegroundBootSnapshot()).toMatchObject({ status: 'idle', runId: 1 });

    expect(transition.restartForegroundBootAfterAccountTransition()).toBe(true);
    const successor = foreground.startForegroundBoot();
    await expect(successor).resolves.toMatchObject({
      status: 'ready',
      mode: 'setup',
      runId: 2,
    });
    expect(foreground.getForegroundBootSnapshot()).toMatchObject({
      status: 'ready',
      mode: 'setup',
      runId: 2,
    });
    expect(mockInspectForegroundBootSession).toHaveBeenCalledTimes(2);
    expect(mockOpenForegroundBootDatabase).toHaveBeenCalledTimes(1);
    expect(mockHydrateForegroundBootSettings).toHaveBeenCalledTimes(1);
    expect(mockActivateForegroundBootSession).toHaveBeenCalledTimes(1);
  });
});
