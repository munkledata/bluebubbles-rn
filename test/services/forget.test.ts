/**
 * `forget()` — the Disconnect wipe. The user is told, in the confirmation dialog, that everything
 * this device holds for the server is destroyed, so the two properties under test here are the two
 * that make that promise true even when something below goes wrong.
 *
 * Nothing in `test/` exercised this function before, which is how both of the defects it now pins
 * survived: they are single un-guarded awaits in a function nothing could fail against.
 *
 * Everything around the wipe is mocked — `runForget` is orchestration, and its dependencies are the
 * Keystore, op-sqlite, the socket and the filesystem.
 */
const clearLocalCache = jest.fn(async () => undefined);
const localCacheDirty = jest.fn(async () => false);
const listReminders = jest.fn(async () => [] as unknown[]);
const clearShareShortcuts = jest.fn(() => true);
const vaultValues = new Map<string, string>();
const vaultGet = jest.fn(
  async (key: string): Promise<string | null> => vaultValues.get(key) ?? null,
);
const vaultSet = jest.fn(async (key: string, value: string): Promise<void> => {
  vaultValues.set(key, value);
});
const vaultDelete = jest.fn(async (key: string): Promise<void> => {
  vaultValues.delete(key);
});
let accountRevoked = false;
const markerIsRevoked = jest.fn(() => accountRevoked);
const markerMarkRevoked = jest.fn(() => {
  accountRevoked = true;
});
const markerClear = jest.fn(() => {
  accountRevoked = false;
});
const awaitSyncIdle = jest.fn(async () => undefined);
const cancelAllNotifications = jest.fn(async () => undefined);
const cancelReminderNotification = jest.fn(async () => undefined);
const ensureDatabase = jest.fn(async (): Promise<unknown> => ({}));
const runSearchTextBackfillOnce = jest.fn<Promise<void>, [MockRecoveryLease]>(
  async () => undefined,
);
let mockDeliveryGeneration = 0;
let mockDeliveriesAccepting = true;
const pauseRealtimeDeliveries = jest.fn(async (): Promise<void> => {
  if (mockDeliveriesAccepting) {
    mockDeliveriesAccepting = false;
    mockDeliveryGeneration += 1;
  }
});
const resumeRealtimeDeliveries = jest.fn(() => {
  mockDeliveriesAccepting = true;
});
const captureRealtimeDeliveryLease = jest.fn(() => {
  const generation = mockDeliveryGeneration;
  return {
    generation,
    isCurrent: () => mockDeliveriesAccepting && generation === mockDeliveryGeneration,
  };
});
type MockRecoveryLease = ReturnType<typeof captureRealtimeDeliveryLease>;
type MockRecoveryResult = {
  status: 'ready' | 'stale';
  scannedFiles: number;
  adoptedFiles: number;
  deferredFiles: number;
  repairedMissingFiles: number;
  retiredFiles: number;
  withinQuota: boolean;
};
const recoverAttachmentCache = jest.fn<Promise<MockRecoveryResult>, [unknown, MockRecoveryLease]>(
  async () => ({
    status: 'ready' as const,
    scannedFiles: 0,
    adoptedFiles: 0,
    deferredFiles: 0,
    repairedMissingFiles: 0,
    retiredFiles: 0,
    withinQuota: true,
  }),
);
const invalidateAttachmentCacheRecoveryReadiness = jest.fn();
const resetErrorReportSession = jest.fn(async (): Promise<void> => undefined);
type MockHydrationOptions = { shouldCommit?: () => boolean; onError?: (error: unknown) => void };
const hydrateAllStores = jest.fn<Promise<void>, [MockHydrationOptions?]>(async () => undefined);
const areCriticalSettingsHydrated = jest.fn(() => true);
const deleteFcmToken = jest.fn(async (): Promise<void> => undefined);
const getMessaging = jest.fn(() => ({ app: 'messaging' }));
const clearFileLogs = jest.fn(async (): Promise<boolean> => true);
const serverInfo = jest.fn(async (): Promise<import('@core/models').ServerInfo> => ({
  server_version: undefined,
}));
type MockRealtimeIssue = {
  stage: 'notifications' | 'fcm';
  level: 'degraded';
  code: string;
  userMessage: string;
};
type MockRealtimeOptions = { reportIssue?: (issue: MockRealtimeIssue) => void };
const startRealtime = jest.fn<Promise<void>, [MockRealtimeOptions?]>();
const startSync = jest.fn<Promise<void>, []>();
const connectToServer = jest.fn();
const candidateClient = jest.fn();
const mockRunDbDriverSelfTest = jest.fn(async () => ({
  schema: 3 as const,
  suite: 'android-db-contract' as const,
  status: 'pass' as const,
  migrationCount: 38 as const,
  migrationHead: '0038_scrub_reaction_selected_message_text' as const,
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
}));
const mockDbDriverInternalFailure = {
  schema: 3 as const,
  suite: 'android-db-contract' as const,
  status: 'fail' as const,
  migrationCount: 38 as const,
  migrationHead: '0038_scrub_reaction_selected_message_text' as const,
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
  failureCode: 'internal' as const,
};
let mockFcmEnabled = true;
let mockCachedDirectoryExists = false;
let mockCachedDirectoryDeleteFailure = false;

// `@core/api` pulls `ky`, which ships ESM only and is not in the node project's transform set.
jest.mock('@core/api', () => ({ serverApi: { serverInfo } }));
jest.mock('@db/repositories', () => ({ clearLocalCache, localCacheDirty, listReminders }));
jest.mock('@core/realtime', () => ({
  get FCM_ENABLED(): boolean {
    return mockFcmEnabled;
  },
}));
jest.mock('@react-native-firebase/messaging', () => ({
  deleteToken: deleteFcmToken,
  getMessaging,
}));
// The stores bootstrap pulls in reach `@db/database`, which loads op-sqlite's native binding.
jest.mock('@db/database', () => ({
  DB_DRIVER_CONTRACT_INTERNAL_FAILURE: mockDbDriverInternalFailure,
  getDatabase: () => ({}),
  runDbDriverSelfTest: mockRunDbDriverSelfTest,
}));
jest.mock('@/services/clients', () => ({
  vault: { get: vaultGet, set: vaultSet, delete: vaultDelete },
  accountRevocationMarker: {
    isRevoked: markerIsRevoked,
    markRevoked: markerMarkRevoked,
    clear: markerClear,
  },
  http: {},
  candidateClient,
  runCryptoSelfTest: jest.fn(),
}));
jest.mock('@/services/databaseControl', () => ({
  ensureDatabase,
  runSearchTextBackfillOnce,
}));
jest.mock('@/services/realtimeControl', () => ({
  getSocket: () => null,
  setSocket: jest.fn(),
  startRealtime,
}));
jest.mock('@/services/reachability', () => ({ stopReachabilityWatch: jest.fn() }));
jest.mock('@/services/syncControl', () => ({ awaitSyncIdle, startSync }));
jest.mock('@/services/errors', () => ({ initErrorReporting: jest.fn() }));
jest.mock('@/services/errors/errorReportSink', () => ({
  errorReportSink: { resetSession: resetErrorReportSession },
}));
jest.mock('@/services/logging/fileLogSink', () => ({
  initPersistentLogs: jest.fn(),
  fileLogSink: { clear: clearFileLogs },
}));
jest.mock('@/services/connection', () => ({ connectToServer }));
jest.mock('@/services/lock', () => ({ hydrateLock: jest.fn() }));
jest.mock('@native/deviceIntegrity', () => ({ checkDeviceIntegrity: jest.fn() }));
jest.mock('@state/hydrateStores', () => ({ areCriticalSettingsHydrated, hydrateAllStores }));
jest.mock('@/services/shortcuts/shareShortcuts', () => ({ clearShareShortcuts }));
jest.mock('@/services/realtime/deliveryCoordinator', () => ({
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
}));
jest.mock('@/services/download/attachmentCacheRecovery', () => ({
  recoverAttachmentCache,
  invalidateAttachmentCacheRecoveryReadiness,
}));
// Mock the service boundary, not only its native dependency. Route-table deletion belongs to the
// notification service's own tests; letting the real wrapper load here with a `{}` fake DB made
// every ordinary Disconnect emit `db.run is not a function` and never actually verified cleanup.
jest.mock('@/services/notifications/notifeeService', () => ({
  cancelAllNotifications,
  cancelReminderNotification,
}));
jest.mock('expo-file-system', () => ({
  Paths: { document: '/doc' },
  Directory: class {
    get exists(): boolean {
      return mockCachedDirectoryExists;
    }
    delete(): void {
      if (mockCachedDirectoryDeleteFailure) throw new Error('directory delete failed');
      mockCachedDirectoryExists = false;
    }
  },
}));

// Jest needs these mock factories installed before the module under test is imported.
/* eslint-disable import/first */
import { useSessionStore } from '@state/sessionStore';
import { useDownloadStore } from '@state/downloadStore';
import { useUploadStore } from '@state/uploadStore';
import { logger, memoryLogSink, SERVER_SESSION_STATE } from '@core/secure';
import {
  activateForegroundBootSession,
  connect,
  forget,
  hydrateForegroundBootSettings,
  hydrateSession,
  inspectForegroundBootSession,
  openForegroundBootDatabase,
  type ForegroundBootAttempt,
} from '@/services/bootstrap';
import type { BootStageContext } from '@/services/boot/bootCoordinator';
import {
  installForegroundBootInvalidator,
  installForegroundBootIssueReporter,
  installForegroundBootRestarter,
} from '@/services/boot/foregroundBootInvalidation';
import { readFcmSessionState } from '@/services/notifications/fcmSessionGate';
import { uploadRegistry } from '@/services/send/uploadControl';
/* eslint-enable import/first */

beforeEach(() => {
  uploadRegistry.cancelAll();
  useDownloadStore.getState().reset();
  useUploadStore.getState().reset();
  vaultValues.clear();
  mockFcmEnabled = true;
  mockCachedDirectoryExists = false;
  mockCachedDirectoryDeleteFailure = false;
  accountRevoked = false;
  mockDeliveryGeneration = 0;
  mockDeliveriesAccepting = true;
  markerIsRevoked.mockImplementation(() => accountRevoked);
  markerMarkRevoked.mockImplementation(() => {
    accountRevoked = true;
  });
  markerClear.mockImplementation(() => {
    accountRevoked = false;
  });
  vaultGet.mockImplementation(async (key: string) => vaultValues.get(key) ?? null);
  vaultSet.mockImplementation(async (key: string, value: string) => {
    vaultValues.set(key, value);
  });
  vaultDelete.mockImplementation(async (key: string) => {
    vaultValues.delete(key);
  });
  clearLocalCache.mockResolvedValue(undefined);
  localCacheDirty.mockResolvedValue(false);
  listReminders.mockResolvedValue([]);
  awaitSyncIdle.mockResolvedValue(undefined);
  cancelAllNotifications.mockResolvedValue(undefined);
  cancelReminderNotification.mockResolvedValue(undefined);
  clearShareShortcuts.mockReturnValue(true);
  ensureDatabase.mockResolvedValue({});
  runSearchTextBackfillOnce.mockReset().mockResolvedValue(undefined);
  pauseRealtimeDeliveries.mockImplementation(async () => {
    if (mockDeliveriesAccepting) {
      mockDeliveriesAccepting = false;
      mockDeliveryGeneration += 1;
    }
  });
  resumeRealtimeDeliveries.mockImplementation(() => {
    mockDeliveriesAccepting = true;
  });
  recoverAttachmentCache.mockResolvedValue({
    status: 'ready',
    scannedFiles: 0,
    adoptedFiles: 0,
    deferredFiles: 0,
    repairedMissingFiles: 0,
    retiredFiles: 0,
    withinQuota: true,
  });
  resetErrorReportSession.mockReset().mockResolvedValue(undefined);
  hydrateAllStores.mockResolvedValue(undefined);
  areCriticalSettingsHydrated.mockReturnValue(true);
  deleteFcmToken.mockResolvedValue(undefined);
  getMessaging.mockReturnValue({ app: 'messaging' });
  clearFileLogs.mockResolvedValue(true);
  serverInfo.mockReset().mockResolvedValue({ server_version: undefined });
  startSync.mockReset().mockResolvedValue(undefined);
  startRealtime.mockReset().mockResolvedValue(undefined);
  connectToServer.mockReset();
  candidateClient.mockReset();
  useSessionStore.setState({
    status: 'connected',
    origin: 'https://old.example',
    password: 'hunter2',
    serverInfo: null,
    error: null,
    epoch: 0,
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

function productionBootContext(): {
  readonly context: BootStageContext;
  readonly reportIssue: jest.Mock;
  readonly disposers: Array<() => void | Promise<void>>;
} {
  const controller = new AbortController();
  const reportIssue = jest.fn();
  const disposers: Array<() => void | Promise<void>> = [];
  return {
    context: {
      runId: 41,
      signal: controller.signal,
      stageSignal: controller.signal,
      reportIssue,
      registerDisposer: (disposer) => {
        disposers.push(disposer);
        return jest.fn();
      },
    },
    reportIssue,
    disposers,
  };
}

async function flushMicrotasks(count = 30): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

async function productionBootAttempt(context: BootStageContext): Promise<ForegroundBootAttempt> {
  vaultValues.set('serverSessionState', SERVER_SESSION_STATE.active);
  vaultValues.set('serverAddress', 'https://old.example');
  vaultValues.set('serverPassword', 'hunter2');
  const outcome = await inspectForegroundBootSession(context);
  if (outcome.kind !== 'connected') throw new Error('expected a connected boot attempt');
  return outcome.session;
}

describe('foreground boot production adapters', () => {
  it('runs the real adapter chain with guarded critical settings, ordered admission, and one lease', async () => {
    const { context, disposers } = productionBootContext();
    const attempt = await productionBootAttempt(context);
    const database = { kind: 'production-adapter-test-db' };
    ensureDatabase.mockResolvedValueOnce(database);

    await openForegroundBootDatabase(context, attempt);
    await hydrateForegroundBootSettings(context, attempt);
    await activateForegroundBootSession(context, attempt);
    await Promise.resolve();

    expect(attempt.resources.db).toBe(database);
    const hydrationOptions = hydrateAllStores.mock.calls[0]?.[0];
    expect(hydrationOptions?.shouldCommit?.()).toBe(true);
    expect(hydrateAllStores).toHaveBeenCalledTimes(1);
    expect(hydrateAllStores.mock.invocationCallOrder[0]!).toBeLessThan(
      resumeRealtimeDeliveries.mock.invocationCallOrder[0]!,
    );
    expect(recoverAttachmentCache).toHaveBeenCalledTimes(1);
    const recoveryLease = recoverAttachmentCache.mock.calls[0]?.[1];
    const backfillLease = runSearchTextBackfillOnce.mock.calls[0]?.[0];
    expect(recoveryLease?.generation).toBe(backfillLease?.generation);
    expect(recoveryLease?.isCurrent()).toBe(true);
    expect(backfillLease?.isCurrent()).toBe(true);
    expect(useSessionStore.getState()).toMatchObject({
      status: 'connected',
      origin: 'https://old.example',
      password: 'hunter2',
    });
    expect(startSync).toHaveBeenCalledTimes(1);
    expect(startRealtime).toHaveBeenCalledWith(
      expect.objectContaining({ reportIssue: expect.any(Function) }),
    );
    expect(disposers).toHaveLength(1);

    disposers[0]?.();
    expect(recoveryLease?.isCurrent()).toBe(false);
  });

  it('maps real database and critical-settings failures to safe operational errors', async () => {
    const { context } = productionBootContext();
    const attempt = await productionBootAttempt(context);
    const databaseFailure = new Error('native database sentinel');
    const errorLog = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    ensureDatabase.mockRejectedValueOnce(databaseFailure);

    await expect(openForegroundBootDatabase(context, attempt)).rejects.toMatchObject({
      name: 'ForegroundBootOperationalError',
      code: 'database-open-failed',
    });
    expect(errorLog).toHaveBeenCalledWith('[db] initialization failed', databaseFailure);

    ensureDatabase.mockResolvedValueOnce({});
    await openForegroundBootDatabase(context, attempt);
    areCriticalSettingsHydrated.mockReturnValueOnce(false);
    await expect(hydrateForegroundBootSettings(context, attempt)).rejects.toMatchObject({
      name: 'ForegroundBootOperationalError',
      code: 'critical-settings-unavailable',
    });
  });

  it('keeps the inbox usable but reports safe degradation when native cache recovery fails', async () => {
    const { context, reportIssue } = productionBootContext();
    const attempt = await productionBootAttempt(context);
    await openForegroundBootDatabase(context, attempt);
    await hydrateForegroundBootSettings(context, attempt);
    const nativeFailure = new Error('native scanner sentinel');
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    recoverAttachmentCache.mockRejectedValueOnce(nativeFailure);

    await expect(activateForegroundBootSession(context, attempt)).resolves.toBeUndefined();

    expect(reportIssue).toHaveBeenCalledWith({
      stage: 'attachment-cache',
      level: 'degraded',
      code: 'attachment-cache-recovery-unavailable',
      userMessage: 'Downloaded attachments are temporarily unavailable until the next restart.',
    });
    expect(useSessionStore.getState().status).toBe('connected');
  });

  it('fails a retry within a deadline instead of reopening admission over an old pending drain', async () => {
    jest.useFakeTimers();
    let releaseDrain!: () => void;
    const pendingDrain = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });

    try {
      const first = productionBootContext();
      const attempt = await productionBootAttempt(first.context);
      await openForegroundBootDatabase(first.context, attempt);
      await hydrateForegroundBootSettings(first.context, attempt);
      await activateForegroundBootSession(first.context, attempt);
      expect(first.disposers).toHaveLength(1);

      pauseRealtimeDeliveries.mockImplementationOnce(() => {
        if (mockDeliveriesAccepting) {
          mockDeliveriesAccepting = false;
          mockDeliveryGeneration += 1;
        }
        return pendingDrain;
      });
      first.disposers[0]?.();

      const retry = activateForegroundBootSession(productionBootContext().context, attempt);
      const retryRejected = expect(retry).rejects.toMatchObject({
        name: 'ForegroundBootOperationalError',
        code: 'prior-realtime-drain-incomplete',
      });
      await jest.advanceTimersByTimeAsync(5_000);
      await retryRejected;
      expect(resumeRealtimeDeliveries).toHaveBeenCalledTimes(1);

      releaseDrain();
      await Promise.resolve();
      await expect(
        activateForegroundBootSession(productionBootContext().context, attempt),
      ).resolves.toBeUndefined();
      expect(resumeRealtimeDeliveries).toHaveBeenCalledTimes(2);
    } finally {
      releaseDrain();
      jest.useRealTimers();
    }
  });
});

describe('hydrateSession() — correlated SecureStore state', () => {
  it('lets a coordinator-owned residual cleanup reach setup without invalidating itself', async () => {
    vaultValues.set('serverSessionState', SERVER_SESSION_STATE.forgotten);
    vaultValues.set('serverAddress', 'https://old.example');
    vaultValues.set('serverPassword', 'hunter2');
    const invalidate = jest.fn();
    const uninstall = installForegroundBootInvalidator(invalidate);
    const controller = new AbortController();

    try {
      await expect(
        inspectForegroundBootSession({
          runId: 17,
          signal: controller.signal,
          stageSignal: controller.signal,
          reportIssue: jest.fn(),
          registerDisposer: jest.fn(() => jest.fn()),
        }),
      ).resolves.toEqual({ kind: 'setup' });

      expect(invalidate).not.toHaveBeenCalled();
      expect(clearLocalCache).toHaveBeenCalledTimes(1);
      expect(useSessionStore.getState().status).toBe('unauthenticated');
    } finally {
      uninstall();
    }
  });

  it('routes a complete empty vault to setup without opening a needless database', async () => {
    await hydrateSession();

    expect(useSessionStore.getState()).toMatchObject({
      status: 'unauthenticated',
      origin: null,
      password: null,
    });
    expect(ensureDatabase).not.toHaveBeenCalled();
    expect(hydrateAllStores).not.toHaveBeenCalled();
    expect(recoverAttachmentCache).not.toHaveBeenCalled();
    expect(markerMarkRevoked).not.toHaveBeenCalled();
    expect(clearLocalCache).not.toHaveBeenCalled();
  });

  it('does not reactivate old active credentials when the independent marker is present', async () => {
    accountRevoked = true;
    vaultValues.set('serverSessionState', SERVER_SESSION_STATE.active);
    vaultValues.set('serverAddress', 'https://old.example');
    vaultValues.set('serverPassword', 'hunter2');

    await hydrateSession();

    expect(useSessionStore.getState()).toMatchObject({
      status: 'unauthenticated',
      origin: null,
      password: null,
    });
    expect(vaultGet).not.toHaveBeenCalled();
    expect(startSync).not.toHaveBeenCalled();
    expect(startRealtime).not.toHaveBeenCalled();
  });

  it('fails closed without reading SecureStore when the independent marker is unreadable', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    markerIsRevoked.mockImplementation(() => {
      throw new Error('documents directory unavailable');
    });

    await hydrateSession();

    expect(useSessionStore.getState()).toMatchObject({
      status: 'error',
      origin: null,
      password: null,
      error: expect.stringMatching(/could not safely verify the saved connection/i),
    });
    expect(vaultGet).not.toHaveBeenCalled();
    expect(ensureDatabase).not.toHaveBeenCalled();
    expect(hydrateAllStores).not.toHaveBeenCalled();
    expect(clearLocalCache).not.toHaveBeenCalled();
    expect(markerMarkRevoked).not.toHaveBeenCalled();
    expect(startSync).not.toHaveBeenCalled();
    expect(startRealtime).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[boot] account revocation marker unreadable — session restore blocked',
    );
  });

  it.each([SERVER_SESSION_STATE.writing, SERVER_SESSION_STATE.forgotten])(
    'finishes residual cleanup without hydrating stale DB state while state is %s',
    async (state) => {
      vaultValues.set('serverSessionState', state);
      vaultValues.set('serverAddress', 'https://old.example');
      vaultValues.set('serverPassword', 'hunter2');

      await hydrateSession();

      expect(useSessionStore.getState()).toMatchObject({
        status: 'unauthenticated',
        origin: null,
        password: null,
      });
      expect(markerMarkRevoked).toHaveBeenCalledTimes(1);
      expect(clearLocalCache).toHaveBeenCalledTimes(1);
      expect(hydrateAllStores).not.toHaveBeenCalled();
      expect(startSync).not.toHaveBeenCalled();
      expect(startRealtime).not.toHaveBeenCalled();
    },
  );

  it.each([null, SERVER_SESSION_STATE.active])(
    'hydrates complete credentials with compatible state %s',
    async (state) => {
      if (state !== null) vaultValues.set('serverSessionState', state);
      vaultValues.set('serverAddress', 'https://old.example');
      vaultValues.set('serverPassword', 'hunter2');

      await hydrateSession();

      expect(useSessionStore.getState()).toMatchObject({
        status: 'connected',
        origin: 'https://old.example',
        password: 'hunter2',
      });
      expect(startSync).toHaveBeenCalledTimes(1);
      expect(startRealtime).toHaveBeenCalledTimes(1);
      expect(recoverAttachmentCache).toHaveBeenCalledTimes(1);
    },
  );

  it('revokes delayed saved-session settings hydration before it can activate the account', async () => {
    useSessionStore.setState({
      status: 'loading',
      origin: null,
      password: null,
      serverInfo: null,
      error: null,
    });
    vaultValues.set('serverSessionState', SERVER_SESSION_STATE.active);
    vaultValues.set('serverAddress', 'https://old.example');
    vaultValues.set('serverPassword', 'hunter2');
    let releaseHydration!: () => void;
    hydrateAllStores.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseHydration = resolve;
        }),
    );

    const hydration = hydrateSession();
    for (let i = 0; i < 100 && releaseHydration == null; i += 1) await Promise.resolve();
    expect(releaseHydration).toEqual(expect.any(Function));
    expect(startSync).not.toHaveBeenCalled();
    expect(startRealtime).not.toHaveBeenCalled();
    const options = hydrateAllStores.mock.calls[0]?.[0] as
      { shouldCommit?: () => boolean } | undefined;
    expect(options?.shouldCommit?.()).toBe(true);

    await forget();
    expect(options?.shouldCommit?.()).toBe(false);
    releaseHydration();
    await hydration;

    expect(useSessionStore.getState().status).toBe('unauthenticated');
    expect(startSync).not.toHaveBeenCalled();
    expect(startRealtime).not.toHaveBeenCalled();
  });

  it('does not activate an explicit connection until guarded critical settings finish loading', async () => {
    useSessionStore.getState().reset();
    connectToServer.mockResolvedValue({
      ok: true,
      serverInfo: { server_version: 'new-server' },
    });
    let releaseHydration!: () => void;
    hydrateAllStores.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseHydration = resolve;
        }),
    );

    const attempt = connect('https://new.example', 'new-secret');
    for (let i = 0; i < 500 && releaseHydration == null; i += 1) await Promise.resolve();
    expect(releaseHydration).toEqual(expect.any(Function));
    expect(useSessionStore.getState().status).toBe('connecting');
    expect(startSync).not.toHaveBeenCalled();
    expect(startRealtime).not.toHaveBeenCalled();
    const options = hydrateAllStores.mock.calls.at(-1)?.[0] as
      { shouldCommit?: () => boolean } | undefined;
    expect(options?.shouldCommit?.()).toBe(true);

    releaseHydration();
    await attempt;

    expect(useSessionStore.getState()).toMatchObject({
      status: 'connected',
      origin: 'https://new.example',
    });
    expect(startSync).toHaveBeenCalledTimes(1);
    expect(startRealtime).toHaveBeenCalledTimes(1);
  });

  it('does not activate a saved session until attachment cache recovery finishes', async () => {
    useSessionStore.setState({
      status: 'loading',
      origin: null,
      password: null,
      serverInfo: null,
      error: null,
    });
    vaultValues.set('serverSessionState', SERVER_SESSION_STATE.active);
    vaultValues.set('serverAddress', 'https://old.example');
    vaultValues.set('serverPassword', 'hunter2');
    let releaseRecovery!: () => void;
    recoverAttachmentCache.mockImplementationOnce(
      () =>
        new Promise<MockRecoveryResult>((resolve) => {
          releaseRecovery = () =>
            resolve({
              status: 'ready',
              scannedFiles: 0,
              adoptedFiles: 0,
              deferredFiles: 0,
              repairedMissingFiles: 0,
              retiredFiles: 0,
              withinQuota: true,
            });
        }),
    );

    const hydration = hydrateSession();
    for (let i = 0; i < 100 && releaseRecovery == null; i += 1) await Promise.resolve();

    expect(releaseRecovery).toEqual(expect.any(Function));
    expect(useSessionStore.getState().status).toBe('loading');
    expect(startSync).not.toHaveBeenCalled();
    expect(startRealtime).not.toHaveBeenCalled();

    releaseRecovery();
    await hydration;

    expect(useSessionStore.getState().status).toBe('connected');
    expect(startSync).toHaveBeenCalledTimes(1);
    expect(startRealtime).toHaveBeenCalledTimes(1);
  });

  it('does not activate an explicit connection until attachment cache recovery finishes', async () => {
    useSessionStore.getState().reset();
    connectToServer.mockResolvedValue({
      ok: true,
      serverInfo: { server_version: 'new-server' },
    });
    let releaseRecovery!: () => void;
    recoverAttachmentCache.mockImplementationOnce(
      () =>
        new Promise<MockRecoveryResult>((resolve) => {
          releaseRecovery = () =>
            resolve({
              status: 'ready',
              scannedFiles: 0,
              adoptedFiles: 0,
              deferredFiles: 0,
              repairedMissingFiles: 0,
              retiredFiles: 0,
              withinQuota: true,
            });
        }),
    );

    const attempt = connect('https://new.example', 'new-secret');
    for (let i = 0; i < 500 && releaseRecovery == null; i += 1) await Promise.resolve();

    expect(releaseRecovery).toEqual(expect.any(Function));
    expect(useSessionStore.getState().status).toBe('connecting');
    expect(startSync).not.toHaveBeenCalled();
    expect(startRealtime).not.toHaveBeenCalled();

    releaseRecovery();
    await attempt;

    expect(useSessionStore.getState()).toMatchObject({
      status: 'connected',
      origin: 'https://new.example',
    });
    expect(startSync).toHaveBeenCalledTimes(1);
    expect(startRealtime).toHaveBeenCalledTimes(1);
  });

  it('bounds explicit-connect cache recovery, revokes its late lease, and surfaces degradation', async () => {
    jest.useFakeTimers();
    const reportIssue = jest.fn();
    const uninstallReporter = installForegroundBootIssueReporter(reportIssue);
    let releaseRecovery: (() => void) | undefined;
    let recoveryLease: MockRecoveryLease | undefined;

    try {
      useSessionStore.getState().reset();
      connectToServer.mockResolvedValue({
        ok: true,
        serverInfo: { server_version: 'new-server' },
      });
      recoverAttachmentCache.mockImplementationOnce(
        (_db, lease) =>
          new Promise<MockRecoveryResult>((resolve) => {
            recoveryLease = lease;
            releaseRecovery = () =>
              resolve({
                status: lease.isCurrent() ? 'ready' : 'stale',
                scannedFiles: 0,
                adoptedFiles: 0,
                deferredFiles: 0,
                repairedMissingFiles: 0,
                retiredFiles: 0,
                withinQuota: true,
              });
          }),
      );

      const first = connect('https://new.example', 'new-secret');
      for (let i = 0; i < 500 && releaseRecovery == null; i += 1) await Promise.resolve();
      expect(releaseRecovery).toEqual(expect.any(Function));

      await jest.advanceTimersByTimeAsync(45_000);
      await first;

      expect(useSessionStore.getState()).toMatchObject({
        status: 'connected',
        origin: 'https://new.example',
      });
      expect(recoveryLease?.isCurrent()).toBe(false);
      expect(reportIssue).toHaveBeenCalledWith({
        stage: 'attachment-cache',
        level: 'degraded',
        code: 'attachment-cache-recovery-timeout',
        userMessage: 'Downloaded attachments are temporarily unavailable until the next restart.',
      });
      expect(startSync).toHaveBeenCalledTimes(1);
      expect(startRealtime).toHaveBeenCalledTimes(1);

      releaseRecovery?.();
      await Promise.resolve();

      // The first attempt's single-flight slot was released even though its native scan settled late.
      await connect('https://new.example', 'new-secret');
      expect(connectToServer).toHaveBeenCalledTimes(2);
    } finally {
      releaseRecovery?.();
      uninstallReporter();
      jest.useRealTimers();
    }
  });

  it('forwards first-connect notification degradation to the foreground boot issue surface', async () => {
    const reportIssue = jest.fn();
    const uninstallReporter = installForegroundBootIssueReporter(reportIssue);
    useSessionStore.getState().reset();
    connectToServer.mockResolvedValue({
      ok: true,
      serverInfo: { server_version: 'new-server' },
    });
    startRealtime.mockImplementationOnce(async (options) => {
      options?.reportIssue?.({
        stage: 'notifications',
        level: 'degraded',
        code: 'notification-permission-denied',
        userMessage: 'Notifications are disabled; open Gator to see new messages.',
      });
    });

    try {
      await connect('https://new.example', 'new-secret');
      await Promise.resolve();

      expect(reportIssue).toHaveBeenCalledWith({
        stage: 'notifications',
        level: 'degraded',
        code: 'notification-permission-denied',
        userMessage: 'Notifications are disabled; open Gator to see new messages.',
      });
    } finally {
      uninstallReporter();
    }
  });

  it('keeps deferred first-connect issue reporting alive until Disconnect revokes its lease', async () => {
    const reportIssue = jest.fn();
    const uninstallReporter = installForegroundBootIssueReporter(reportIssue);
    let realtimeOptions: MockRealtimeOptions | undefined;
    let releaseRealtime: (() => void) | undefined;
    const realtimePending = new Promise<void>((resolve) => {
      releaseRealtime = resolve;
    });
    useSessionStore.getState().reset();
    connectToServer.mockResolvedValue({
      ok: true,
      serverInfo: { server_version: 'new-server' },
    });
    startRealtime.mockImplementationOnce((options) => {
      realtimeOptions = options;
      return realtimePending;
    });

    try {
      await connect('https://new.example', 'new-secret');
      expect(realtimeOptions?.reportIssue).toEqual(expect.any(Function));

      realtimeOptions?.reportIssue?.({
        stage: 'notifications',
        level: 'degraded',
        code: 'late-notification-degradation',
        userMessage: 'Notifications became unavailable after startup.',
      });
      expect(reportIssue).toHaveBeenCalledTimes(1);

      await forget();
      realtimeOptions?.reportIssue?.({
        stage: 'fcm',
        level: 'degraded',
        code: 'stale-fcm-degradation',
        userMessage: 'This stale account issue must stay hidden.',
      });
      expect(reportIssue).toHaveBeenCalledTimes(1);
    } finally {
      releaseRealtime?.();
      uninstallReporter();
    }
  });

  it('quarantines a timed-out credential candidate until its last native mutation settles', async () => {
    jest.useFakeTimers();
    let releaseCandidate!: (value: { ok: false; kind: 'cancelled'; message: string }) => void;
    let candidateIsCurrent!: () => boolean;

    try {
      useSessionStore.getState().reset();
      connectToServer
        .mockImplementationOnce(
          (_origin: string, _password: string, deps: { isAttemptCurrent?: () => boolean }) =>
            new Promise((resolve) => {
              candidateIsCurrent = deps.isAttemptCurrent ?? (() => true);
              releaseCandidate = resolve;
            }),
        )
        .mockResolvedValueOnce({
          ok: true,
          serverInfo: { server_version: 'replacement' },
        });

      const first = connect('https://slow.example', 'slow-secret');
      for (let i = 0; i < 500 && releaseCandidate == null; i += 1) await Promise.resolve();
      expect(releaseCandidate).toEqual(expect.any(Function));
      await jest.advanceTimersByTimeAsync(45_000);
      await first;

      expect(candidateIsCurrent()).toBe(false);
      expect(useSessionStore.getState()).toMatchObject({
        status: 'error',
        error: 'The connection attempt took too long. Check the server and try again.',
      });

      await connect('https://replacement.example', 'replacement-secret');
      expect(connectToServer).toHaveBeenCalledTimes(1);
      expect(useSessionStore.getState().error).toBe(
        'The previous connection attempt is still stopping. Try again in a moment.',
      );

      releaseCandidate({
        ok: false,
        kind: 'cancelled',
        message: 'Connection attempt was cancelled.',
      });
      await Promise.resolve();
      await Promise.resolve();

      await connect('https://replacement.example', 'replacement-secret');
      expect(connectToServer).toHaveBeenCalledTimes(2);
      expect(useSessionStore.getState().status).toBe('connected');
    } finally {
      releaseCandidate?.({
        ok: false,
        kind: 'cancelled',
        message: 'Connection attempt was cancelled.',
      });
      jest.useRealTimers();
    }
  });

  it('revokes a timed-out account gate before its late read can wipe a newer connection', async () => {
    jest.useFakeTimers();
    let releaseOldRead: ((value: string | null) => void) | undefined;
    let holdFirstSessionStateRead = true;
    try {
      useSessionStore.getState().reset();
      vaultGet.mockImplementation((key: string) => {
        if (key === 'serverSessionState' && holdFirstSessionStateRead) {
          holdFirstSessionStateRead = false;
          return new Promise<string | null>((resolve) => {
            releaseOldRead = resolve;
          });
        }
        return Promise.resolve(vaultValues.get(key) ?? null);
      });
      connectToServer.mockResolvedValue({
        ok: true,
        serverInfo: { server_version: 'replacement' },
      });

      const staleAttempt = connect('https://slow-gate.example', 'slow-secret');
      for (let i = 0; i < 500 && releaseOldRead == null; i += 1) await Promise.resolve();
      expect(releaseOldRead).toEqual(expect.any(Function));
      await jest.advanceTimersByTimeAsync(10_000);
      await staleAttempt;
      expect(useSessionStore.getState().error).toBe(
        'Gator is still checking previous account state. Try again in a moment.',
      );

      await connect('https://replacement.example', 'replacement-secret');
      expect(useSessionStore.getState()).toMatchObject({
        status: 'connected',
        origin: 'https://replacement.example',
      });
      const wipeCount = clearLocalCache.mock.calls.length;
      const revocationCount = markerMarkRevoked.mock.calls.length;

      releaseOldRead?.(null);
      await Promise.resolve();
      await Promise.resolve();

      expect(clearLocalCache).toHaveBeenCalledTimes(wipeCount);
      expect(markerMarkRevoked).toHaveBeenCalledTimes(revocationCount);
      expect(useSessionStore.getState()).toMatchObject({
        status: 'connected',
        origin: 'https://replacement.example',
      });
    } finally {
      releaseOldRead?.(null);
      jest.useRealTimers();
    }
  });

  it('quarantines a timed-out database open and requires restart while it remains pending', async () => {
    jest.useFakeTimers();
    let releaseDatabase: ((database: unknown) => void) | undefined;
    try {
      useSessionStore.getState().reset();
      vaultValues.set('serverSessionState', SERVER_SESSION_STATE.active);
      vaultValues.set('serverAddress', 'https://new.example');
      vaultValues.set('serverPassword', 'new-secret');
      connectToServer
        .mockResolvedValueOnce({
          ok: true,
          serverInfo: { server_version: 'new-server' },
        })
        .mockResolvedValueOnce({
          ok: true,
          serverInfo: { server_version: 'replacement' },
        });
      ensureDatabase.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseDatabase = resolve;
          }),
      );

      const attempt = connect('https://new.example', 'new-secret');
      for (let i = 0; i < 500 && releaseDatabase == null; i += 1) {
        await Promise.resolve();
      }
      expect(releaseDatabase).toEqual(expect.any(Function));
      await jest.advanceTimersByTimeAsync(30_000);
      await attempt;

      expect(useSessionStore.getState()).toMatchObject({
        status: 'error',
        error:
          'Gator could not finish opening your encrypted messages. Fully close and reopen Gator to try again.',
      });
      await connect('https://new.example', 'new-secret');
      expect(connectToServer).toHaveBeenCalledTimes(1);
      expect(useSessionStore.getState().error).toBe(
        'Database startup is still pending. Fully close and reopen Gator before trying again.',
      );

      releaseDatabase?.({});
      await Promise.resolve();
      await Promise.resolve();

      await connect('https://new.example', 'new-secret');
      expect(connectToServer).toHaveBeenCalledTimes(2);
      expect(useSessionStore.getState()).toMatchObject({
        status: 'connected',
        origin: 'https://new.example',
      });
    } finally {
      releaseDatabase?.({});
      jest.useRealTimers();
    }
  });

  it('revokes a late settings hydration after the explicit-connect deadline', async () => {
    jest.useFakeTimers();
    let releaseHydration!: () => void;
    try {
      useSessionStore.getState().reset();
      connectToServer.mockResolvedValue({
        ok: true,
        serverInfo: { server_version: 'new-server' },
      });
      hydrateAllStores.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseHydration = resolve;
          }),
      );

      const attempt = connect('https://new.example', 'new-secret');
      for (let i = 0; i < 500 && releaseHydration == null; i += 1) await Promise.resolve();
      expect(releaseHydration).toEqual(expect.any(Function));
      const options = hydrateAllStores.mock.calls.at(-1)?.[0];
      expect(options?.shouldCommit?.()).toBe(true);

      await jest.advanceTimersByTimeAsync(15_000);
      await attempt;

      expect(options?.shouldCommit?.()).toBe(false);
      expect(useSessionStore.getState()).toMatchObject({
        status: 'error',
        error: expect.stringMatching(/Settings loading took too long/),
      });
      releaseHydration();
      await Promise.resolve();
      expect(useSessionStore.getState().status).toBe('error');
    } finally {
      releaseHydration?.();
      jest.useRealTimers();
    }
  });

  it('keeps the offline inbox usable when native cache recovery is unavailable', async () => {
    useSessionStore.setState({
      status: 'loading',
      origin: null,
      password: null,
      serverInfo: null,
      error: null,
    });
    vaultValues.set('serverSessionState', SERVER_SESSION_STATE.active);
    vaultValues.set('serverAddress', 'https://old.example');
    vaultValues.set('serverPassword', 'hunter2');
    const failure = new Error('bounded scanner unavailable');
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    recoverAttachmentCache.mockRejectedValueOnce(failure);

    await hydrateSession();

    expect(useSessionStore.getState().status).toBe('connected');
    expect(startSync).toHaveBeenCalledTimes(1);
    expect(startRealtime).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[boot] attachment cache recovery failed; persistent downloads remain disabled',
      failure,
    );
  });

  it('abandons saved-session activation when Disconnect revokes cache recovery', async () => {
    useSessionStore.setState({
      status: 'loading',
      origin: null,
      password: null,
      serverInfo: null,
      error: null,
    });
    vaultValues.set('serverSessionState', SERVER_SESSION_STATE.active);
    vaultValues.set('serverAddress', 'https://old.example');
    vaultValues.set('serverPassword', 'hunter2');
    let releaseRecovery!: () => void;
    recoverAttachmentCache.mockImplementationOnce(
      (_db, lease) =>
        new Promise<MockRecoveryResult>((resolve) => {
          releaseRecovery = () =>
            resolve({
              status: lease.isCurrent() ? ('ready' as const) : ('stale' as const),
              scannedFiles: 0,
              adoptedFiles: 0,
              deferredFiles: 0,
              repairedMissingFiles: 0,
              retiredFiles: 0,
              withinQuota: false,
            });
        }),
    );

    const hydration = hydrateSession();
    for (let i = 0; i < 100 && releaseRecovery == null; i += 1) await Promise.resolve();
    expect(releaseRecovery).toEqual(expect.any(Function));

    const disconnect = forget();
    releaseRecovery();
    await Promise.all([hydration, disconnect]);

    expect(invalidateAttachmentCacheRecoveryReadiness).toHaveBeenCalled();
    expect(useSessionStore.getState().status).toBe('unauthenticated');
    expect(startSync).not.toHaveBeenCalled();
    expect(startRealtime).not.toHaveBeenCalled();
  });

  it('revokes explicit-connect settings hydration when Disconnect starts', async () => {
    useSessionStore.getState().reset();
    connectToServer.mockResolvedValue({
      ok: true,
      serverInfo: { server_version: 'new-server' },
    });
    let releaseHydration!: () => void;
    hydrateAllStores.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseHydration = resolve;
        }),
    );

    const attempt = connect('https://new.example', 'new-secret');
    for (let i = 0; i < 500 && releaseHydration == null; i += 1) await Promise.resolve();
    expect(releaseHydration).toEqual(expect.any(Function));
    const options = hydrateAllStores.mock.calls.at(-1)?.[0] as
      { shouldCommit?: () => boolean } | undefined;
    expect(options?.shouldCommit?.()).toBe(true);

    const disconnect = forget();
    expect(options?.shouldCommit?.()).toBe(false);
    releaseHydration();
    await Promise.all([attempt, disconnect]);

    expect(useSessionStore.getState().status).toBe('unauthenticated');
    expect(resumeRealtimeDeliveries).not.toHaveBeenCalled();
    expect(startSync).not.toHaveBeenCalled();
    expect(startRealtime).not.toHaveBeenCalled();
  });

  it('keeps a saved session closed when critical settings could not be confirmed', async () => {
    useSessionStore.setState({
      status: 'loading',
      origin: null,
      password: null,
      serverInfo: null,
      error: null,
    });
    vaultValues.set('serverSessionState', SERVER_SESSION_STATE.active);
    vaultValues.set('serverAddress', 'https://old.example');
    vaultValues.set('serverPassword', 'hunter2');
    areCriticalSettingsHydrated.mockReturnValue(false);

    await hydrateSession();

    expect(hydrateAllStores).toHaveBeenCalledTimes(1);
    expect(resumeRealtimeDeliveries).not.toHaveBeenCalled();
    expect(startSync).not.toHaveBeenCalled();
    expect(startRealtime).not.toHaveBeenCalled();
    expect(useSessionStore.getState()).toMatchObject({
      status: 'error',
      origin: null,
      password: null,
      error: expect.stringMatching(/could not safely load local settings/i),
    });
  });

  it('keeps a successful explicit connection closed when critical settings could not be confirmed', async () => {
    useSessionStore.getState().reset();
    connectToServer.mockResolvedValue({
      ok: true,
      serverInfo: { server_version: 'new-server' },
    });
    areCriticalSettingsHydrated.mockReturnValue(false);

    await connect('https://new.example', 'new-secret');

    expect(hydrateAllStores).toHaveBeenCalledTimes(1);
    expect(resumeRealtimeDeliveries).not.toHaveBeenCalled();
    expect(startSync).not.toHaveBeenCalled();
    expect(startRealtime).not.toHaveBeenCalled();
    expect(useSessionStore.getState()).toMatchObject({
      status: 'error',
      origin: null,
      password: null,
      error: expect.stringMatching(/could not safely load local settings/i),
    });
  });

  it('publishes a recoverable error when the saved-session hydration registry rejects unexpectedly', async () => {
    useSessionStore.setState({
      status: 'loading',
      origin: null,
      password: null,
      serverInfo: null,
      error: null,
    });
    vaultValues.set('serverSessionState', SERVER_SESSION_STATE.active);
    vaultValues.set('serverAddress', 'https://old.example');
    vaultValues.set('serverPassword', 'hunter2');
    const failure = new Error('unexpected store regression');
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    hydrateAllStores.mockRejectedValueOnce(failure);

    await expect(hydrateSession()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith('[boot] settings hydration registry failed', failure);
    expect(resumeRealtimeDeliveries).not.toHaveBeenCalled();
    expect(startSync).not.toHaveBeenCalled();
    expect(startRealtime).not.toHaveBeenCalled();
    expect(useSessionStore.getState()).toMatchObject({
      status: 'error',
      error: expect.stringMatching(/could not safely load local settings/i),
    });
  });

  it('publishes a recoverable error when explicit-connect hydration rejects unexpectedly', async () => {
    useSessionStore.getState().reset();
    connectToServer.mockResolvedValue({
      ok: true,
      serverInfo: { server_version: 'new-server' },
    });
    const failure = new Error('unexpected store regression');
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    hydrateAllStores.mockRejectedValueOnce(failure);

    await expect(connect('https://new.example', 'new-secret')).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith('[connect] settings hydration registry failed', failure);
    expect(resumeRealtimeDeliveries).not.toHaveBeenCalled();
    expect(startSync).not.toHaveBeenCalled();
    expect(startRealtime).not.toHaveBeenCalled();
    expect(useSessionStore.getState()).toMatchObject({
      status: 'error',
      error: expect.stringMatching(/could not safely load local settings/i),
    });
  });

  it('does not activate a different durable identity discovered after settings hydration', async () => {
    useSessionStore.setState({
      status: 'loading',
      origin: null,
      password: null,
      serverInfo: null,
      error: null,
    });
    const sessions = [
      {
        serverSessionState: SERVER_SESSION_STATE.active,
        serverAddress: 'https://old.example',
        serverPassword: 'old-secret',
      },
      {
        serverSessionState: SERVER_SESSION_STATE.active,
        serverAddress: 'https://different.example',
        serverPassword: 'different-secret',
      },
    ];
    let readCount = 0;
    vaultGet.mockImplementation(async (key: string) => {
      const inspection = Math.min(Math.floor(readCount / 3), sessions.length - 1);
      readCount += 1;
      return sessions[inspection]?.[key as keyof (typeof sessions)[number]] ?? null;
    });

    await hydrateSession();

    expect(vaultGet).toHaveBeenCalledTimes(6);
    expect(resumeRealtimeDeliveries).not.toHaveBeenCalled();
    expect(startSync).not.toHaveBeenCalled();
    expect(startRealtime).not.toHaveBeenCalled();
    expect(useSessionStore.getState()).toMatchObject({
      status: 'error',
      origin: null,
      password: null,
      error: expect.stringMatching(/could not safely verify the saved connection/i),
    });
  });

  it('discards a stale boot server-info response after Disconnect and account B activation', async () => {
    vaultValues.set('serverSessionState', SERVER_SESSION_STATE.active);
    vaultValues.set('serverAddress', 'https://old.example');
    vaultValues.set('serverPassword', 'hunter2');
    let resolveOldInfo!: (info: import('@core/models').ServerInfo) => void;
    serverInfo.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOldInfo = resolve;
        }),
    );

    await hydrateSession();
    expect(serverInfo).toHaveBeenCalledTimes(1);
    expect(captureRealtimeDeliveryLease).toHaveBeenCalledTimes(2);

    await forget();
    const accountBInfo = { server_version: 'B-2.0', supports_send_contact: true };
    connectToServer.mockResolvedValue({ ok: true, serverInfo: accountBInfo });
    await connect('https://new.example', 'new-secret');
    expect(useSessionStore.getState()).toMatchObject({
      status: 'connected',
      origin: 'https://new.example',
      serverInfo: accountBInfo,
    });

    resolveOldInfo({ server_version: 'A-1.0', supports_send_contact: false });
    await Promise.resolve();
    await Promise.resolve();

    expect(useSessionStore.getState()).toMatchObject({
      status: 'connected',
      origin: 'https://new.example',
      serverInfo: accountBInfo,
    });
  });

  it('finishes a revoked restart wipe before a new account can connect', async () => {
    const order: string[] = [];
    let releaseWipe!: () => void;
    accountRevoked = true;
    vaultValues.set('serverSessionState', SERVER_SESSION_STATE.active);
    vaultValues.set('serverAddress', 'https://old.example');
    vaultValues.set('serverPassword', 'hunter2');
    clearLocalCache.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          order.push('old-account-wipe-started');
          releaseWipe = () => {
            order.push('old-account-wipe-finished');
            resolve(undefined);
          };
        }),
    );
    connectToServer.mockImplementation(async () => {
      order.push('new-account-connect');
      return { ok: false, kind: 'unknown', message: 'test stop' };
    });

    const hydration = hydrateSession();
    // Disconnect deliberately crosses several bounded cleanup barriers before it opens the DB.
    // Poll the observable callback instead of depending on an exact microtask count.
    for (let i = 0; i < 100 && releaseWipe == null; i += 1) await Promise.resolve();
    expect(clearLocalCache).toHaveBeenCalledTimes(1);

    const reconnect = connect('https://new.example', 'new-secret');
    await Promise.resolve();
    expect(connectToServer).not.toHaveBeenCalled();

    releaseWipe();
    await hydration;
    await reconnect;

    expect(order).toEqual([
      'old-account-wipe-started',
      'old-account-wipe-finished',
      'new-account-connect',
    ]);
  });

  it('quarantines a SecureStore read failure before opening or wiping the database', async () => {
    const readError = new Error('Android Keystore temporarily unavailable');
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vaultGet.mockRejectedValueOnce(readError);

    await expect(hydrateSession()).resolves.toBeUndefined();

    expect(useSessionStore.getState()).toMatchObject({
      status: 'error',
      origin: null,
      password: null,
      error: expect.stringMatching(/could not safely verify the saved connection/i),
    });
    expect(ensureDatabase).not.toHaveBeenCalled();
    expect(hydrateAllStores).not.toHaveBeenCalled();
    expect(markerMarkRevoked).not.toHaveBeenCalled();
    expect(clearLocalCache).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[boot] secure session state unreadable — session restore blocked',
      readError,
    );
  });

  it('finishes a durable forgotten-state wipe before account B validation starts', async () => {
    const order: string[] = [];
    let releaseWipe!: () => void;
    vaultValues.set('serverSessionState', SERVER_SESSION_STATE.forgotten);
    vaultValues.set('serverAddress', 'https://old.example');
    vaultValues.set('serverPassword', 'hunter2');
    clearLocalCache.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          order.push('old-account-wipe-started');
          releaseWipe = () => {
            order.push('old-account-wipe-finished');
            resolve(undefined);
          };
        }),
    );
    connectToServer.mockImplementation(async () => {
      order.push('new-account-connect');
      return { ok: false, kind: 'unknown', message: 'test stop' };
    });

    const hydration = hydrateSession();
    for (let i = 0; i < 100 && releaseWipe == null; i += 1) await Promise.resolve();
    expect(clearLocalCache).toHaveBeenCalledTimes(1);
    expect(hydrateAllStores).not.toHaveBeenCalled();

    const reconnect = connect('https://new.example', 'new-secret');
    await Promise.resolve();
    expect(connectToServer).not.toHaveBeenCalled();

    releaseWipe();
    await hydration;
    await reconnect;

    expect(order).toEqual([
      'old-account-wipe-started',
      'old-account-wipe-finished',
      'new-account-connect',
    ]);
  });

  it('rechecks an unreadable-at-boot marker and wipes it when it is readable/revoked at connect', async () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    let markerReadable = false;
    markerIsRevoked.mockImplementation(() => {
      if (!markerReadable) throw new Error('documents directory unavailable');
      return accountRevoked;
    });

    await hydrateSession();
    expect(useSessionStore.getState().status).toBe('error');
    expect(clearLocalCache).not.toHaveBeenCalled();

    markerReadable = true;
    accountRevoked = true;
    let releaseWipe!: () => void;
    clearLocalCache.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          releaseWipe = () => resolve(undefined);
        }),
    );
    connectToServer.mockResolvedValue({
      ok: false,
      kind: 'unknown',
      message: 'test stop',
    });

    const reconnect = connect('https://new.example', 'new-secret');
    for (let i = 0; i < 100 && releaseWipe == null; i += 1) await Promise.resolve();

    expect(clearLocalCache).toHaveBeenCalledTimes(1);
    expect(connectToServer).not.toHaveBeenCalled();

    releaseWipe();
    await reconnect;
    expect(connectToServer).toHaveBeenCalledTimes(1);
  });

  it('blocks account B when marker recovery reveals a retained active account A tuple', async () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    markerIsRevoked.mockImplementationOnce(() => {
      throw new Error('documents directory unavailable');
    });
    vaultValues.set('serverSessionState', SERVER_SESSION_STATE.active);
    vaultValues.set('serverAddress', 'https://old.example');
    vaultValues.set('serverPassword', 'hunter2');

    await hydrateSession();
    markerIsRevoked.mockImplementation(() => false);
    await connect('https://new.example', 'new-secret');

    expect(connectToServer).not.toHaveBeenCalled();
    expect(clearLocalCache).not.toHaveBeenCalled();
    expect(useSessionStore.getState()).toMatchObject({
      status: 'error',
      error: expect.stringMatching(/restore it, then use Disconnect/i),
    });
  });

  it('allows the exact retained active tuple to recover after marker availability returns', async () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    markerIsRevoked.mockImplementationOnce(() => {
      throw new Error('documents directory unavailable');
    });
    vaultValues.set('serverSessionState', SERVER_SESSION_STATE.active);
    vaultValues.set('serverAddress', 'https://old.example/');
    vaultValues.set('serverPassword', 'hunter2');
    connectToServer.mockResolvedValue({
      ok: false,
      kind: 'unknown',
      message: 'test stop',
    });

    await hydrateSession();
    markerIsRevoked.mockImplementation(() => false);
    await connect('https://old.example', 'hunter2');

    expect(clearLocalCache).not.toHaveBeenCalled();
    expect(connectToServer).toHaveBeenCalledTimes(1);
    expect(connectToServer).toHaveBeenCalledWith(
      'https://old.example',
      'hunter2',
      expect.any(Object),
    );
  });

  it('blocks an explicit connection while the independent marker remains unreadable', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    markerIsRevoked.mockImplementation(() => {
      throw new Error('documents directory unavailable');
    });

    await connect('https://new.example', 'new-secret');

    expect(connectToServer).not.toHaveBeenCalled();
    expect(vaultGet).not.toHaveBeenCalled();
    expect(clearLocalCache).not.toHaveBeenCalled();
    expect(useSessionStore.getState()).toMatchObject({
      status: 'error',
      error: expect.stringMatching(/could not safely verify the saved connection/i),
    });
    expect(warn).toHaveBeenCalledWith(
      '[connect] account revocation marker unreadable — candidate blocked',
    );
  });

  it('blocks an explicit connection when SecureStore cannot read prior account state', async () => {
    const readError = new Error('Android Keystore temporarily unavailable');
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vaultGet.mockRejectedValueOnce(readError);

    await connect('https://new.example', 'new-secret');

    expect(connectToServer).not.toHaveBeenCalled();
    expect(clearLocalCache).not.toHaveBeenCalled();
    expect(useSessionStore.getState()).toMatchObject({
      status: 'error',
      error: expect.stringMatching(/could not safely verify the saved connection/i),
    });
    expect(warn).toHaveBeenCalledWith(
      '[connect] secure session state unreadable — candidate blocked',
      readError,
    );
  });

  it.each([
    {
      label: 'an active tuple missing its password',
      state: SERVER_SESSION_STATE.active as string | null,
      origin: 'https://old.example' as string | null,
      password: null as string | null,
    },
    {
      label: 'a legacy tuple with only one credential',
      state: null as string | null,
      origin: 'https://old.example' as string | null,
      password: null as string | null,
    },
    {
      label: 'an unknown state with a complete credential pair',
      state: 'future-or-corrupt-state' as string | null,
      origin: 'https://old.example' as string | null,
      password: 'hunter2' as string | null,
    },
  ])(
    'wipes $label before validating account B',
    async ({ state, origin, password: savedPassword }) => {
      if (state !== null) vaultValues.set('serverSessionState', state);
      if (origin !== null) vaultValues.set('serverAddress', origin);
      if (savedPassword !== null) vaultValues.set('serverPassword', savedPassword);
      let releaseWipe!: () => void;
      clearLocalCache.mockImplementationOnce(
        () =>
          new Promise<undefined>((resolve) => {
            releaseWipe = () => resolve(undefined);
          }),
      );
      connectToServer.mockResolvedValue({
        ok: false,
        kind: 'unknown',
        message: 'test stop',
      });

      const attempt = connect('https://new.example', 'new-secret');
      for (let i = 0; i < 100 && releaseWipe == null; i += 1) await Promise.resolve();

      expect(markerMarkRevoked).toHaveBeenCalledTimes(1);
      expect(clearLocalCache).toHaveBeenCalledTimes(1);
      expect(connectToServer).not.toHaveBeenCalled();

      releaseWipe();
      await attempt;
      expect(connectToServer).toHaveBeenCalledTimes(1);
    },
  );

  it('wipes a dirty database behind an empty vault before validating the first candidate', async () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    let releaseFirstPass!: () => void;
    clearLocalCache.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          releaseFirstPass = () => resolve(undefined);
        }),
    );
    // Simulate an isolated old-account row surviving the first pass. Candidate admission must wait
    // for the confirmed second pass even though the vault itself looked like a fresh install.
    localCacheDirty.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    connectToServer.mockResolvedValue({
      ok: false,
      kind: 'unknown',
      message: 'test stop',
    });

    const attempt = connect('https://new.example', 'new-secret');
    for (let i = 0; i < 100 && releaseFirstPass == null; i += 1) await Promise.resolve();

    expect(clearLocalCache).toHaveBeenCalledTimes(1);
    expect(connectToServer).not.toHaveBeenCalled();

    releaseFirstPass();
    await attempt;
    expect(clearLocalCache).toHaveBeenCalledTimes(2);
    expect(deleteFcmToken).toHaveBeenCalledTimes(1);
    expect(connectToServer).toHaveBeenCalledTimes(1);
  });

  it('rejects a second connection while the first candidate credential commit is in flight', async () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    let releaseFirst!: () => void;
    connectToServer.mockImplementationOnce(
      async (
        origin: string,
        password: string,
        deps: {
          vault: { set: (key: string, value: string) => Promise<void> };
          revocationMarker: { clear: () => void };
        },
      ) => {
        await deps.vault.set('serverSessionState', SERVER_SESSION_STATE.writing);
        await deps.vault.set('serverAddress', origin);
        // Suspend at the exact unsafe point: without bootstrap's synchronous single-flight claim,
        // candidate B could now replace the address before A writes its password + active marker.
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        await deps.vault.set('serverPassword', password);
        await deps.vault.set('serverSessionState', SERVER_SESSION_STATE.active);
        deps.revocationMarker.clear();
        return { ok: true, serverInfo: {} };
      },
    );

    const first = connect('https://first.example', 'first-secret');
    // The claim and Connecting state are synchronous, before SecureStore can yield.
    expect(useSessionStore.getState().status).toBe('connecting');
    const second = connect('https://second.example', 'second-secret');
    await second;
    for (let i = 0; i < 100 && releaseFirst == null; i += 1) await Promise.resolve();

    expect(candidateClient).toHaveBeenCalledTimes(1);
    expect(candidateClient).toHaveBeenCalledWith('https://first.example', 'first-secret');
    expect(connectToServer).toHaveBeenCalledTimes(1);

    releaseFirst();
    await first;
    expect(candidateClient).not.toHaveBeenCalledWith('https://second.example', 'second-secret');
    expect(vaultValues.get('serverSessionState')).toBe(SERVER_SESSION_STATE.active);
    expect(vaultValues.get('serverAddress')).toBe('https://first.example');
    expect(vaultValues.get('serverPassword')).toBe('first-secret');
    expect(useSessionStore.getState()).toMatchObject({
      status: 'connected',
      origin: 'https://first.example',
      password: 'first-secret',
    });
  });

  it('revokes a candidate suspended in server validation before it can clear the marker or start', async () => {
    let releaseCandidateFetch!: () => void;
    connectToServer.mockImplementationOnce(
      async (
        _origin: string,
        _password: string,
        deps: {
          isAttemptCurrent?: () => boolean;
          revocationMarker: { clear: () => void };
        },
      ) => {
        await new Promise<void>((resolve) => {
          releaseCandidateFetch = resolve;
        });
        if (deps.isAttemptCurrent?.() === false) {
          return { ok: false, kind: 'cancelled', message: 'Connection attempt was cancelled.' };
        }
        deps.revocationMarker.clear();
        return { ok: true, serverInfo: { server_version: 'candidate' } };
      },
    );

    const candidate = connect('https://candidate.example', 'candidate-secret');
    for (let i = 0; i < 200 && releaseCandidateFetch == null; i += 1) await Promise.resolve();
    expect(connectToServer).toHaveBeenCalledTimes(1);

    const wipe = forget();
    expect(accountRevoked).toBe(true);
    expect(useSessionStore.getState()).toMatchObject({
      status: 'unauthenticated',
      origin: null,
      password: null,
    });

    releaseCandidateFetch();
    await Promise.all([candidate, wipe]);

    expect(markerClear).not.toHaveBeenCalled();
    expect(accountRevoked).toBe(true);
    expect(useSessionStore.getState().status).toBe('unauthenticated');
    expect(startSync).not.toHaveBeenCalled();
    expect(startRealtime).not.toHaveBeenCalled();
  });

  it('keeps revocation authoritative when a candidate vault write lands after the wipe', async () => {
    let releaseAddressWrite!: () => void;
    vaultSet.mockImplementation(async (key: string, value: string) => {
      if (key === 'serverAddress' && value === 'https://candidate.example') {
        await new Promise<void>((resolve) => {
          releaseAddressWrite = resolve;
        });
      }
      vaultValues.set(key, value);
    });
    connectToServer.mockImplementationOnce(
      async (
        origin: string,
        password: string,
        deps: {
          isAttemptCurrent?: () => boolean;
          vault: { set: (key: string, value: string) => Promise<void> };
          revocationMarker: { clear: () => void };
        },
      ) => {
        const cancelled = () => deps.isAttemptCurrent?.() === false;
        await deps.vault.set('serverSessionState', SERVER_SESSION_STATE.writing);
        if (cancelled())
          return { ok: false, kind: 'cancelled', message: 'Connection attempt was cancelled.' };
        await deps.vault.set('serverAddress', origin);
        if (cancelled())
          return { ok: false, kind: 'cancelled', message: 'Connection attempt was cancelled.' };
        await deps.vault.set('serverPassword', password);
        if (cancelled())
          return { ok: false, kind: 'cancelled', message: 'Connection attempt was cancelled.' };
        await deps.vault.set('serverSessionState', SERVER_SESSION_STATE.active);
        if (cancelled())
          return { ok: false, kind: 'cancelled', message: 'Connection attempt was cancelled.' };
        deps.revocationMarker.clear();
        return { ok: true, serverInfo: { server_version: 'candidate' } };
      },
    );

    const candidate = connect('https://candidate.example', 'candidate-secret');
    for (let i = 0; i < 200 && releaseAddressWrite == null; i += 1) await Promise.resolve();
    expect(releaseAddressWrite).toEqual(expect.any(Function));

    // The candidate's address write is still suspended. Teardown is allowed to finish, but its
    // synchronous marker/epoch remain authoritative if the already-started native write lands late.
    await forget();
    expect(accountRevoked).toBe(true);
    expect(vaultValues.get('serverSessionState')).toBe(SERVER_SESSION_STATE.forgotten);

    releaseAddressWrite();
    await candidate;

    expect(vaultValues.get('serverAddress')).toBe('https://candidate.example');
    expect(vaultValues.get('serverPassword')).toBeUndefined();
    expect(vaultValues.get('serverSessionState')).toBe(SERVER_SESSION_STATE.forgotten);
    expect(markerClear).not.toHaveBeenCalled();
    expect(accountRevoked).toBe(true);
    expect(useSessionStore.getState().status).toBe('unauthenticated');
    expect(startSync).not.toHaveBeenCalled();
    expect(startRealtime).not.toHaveBeenCalled();

    // A restart sees the marker first and re-runs the idempotent wipe rather than restoring the
    // late address as a session.
    await hydrateSession();
    expect(vaultValues.get('serverAddress')).toBeUndefined();
    expect(useSessionStore.getState().status).toBe('unauthenticated');
  });

  it('joins a second Disconnect that starts during the final durable candidate inspection', async () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    // A successful tombstone is enough for teardown when the independent marker filesystem is
    // unavailable. That makes the post-cleanup inspection take the asynchronous vault path.
    markerMarkRevoked.mockImplementation(() => {
      throw new Error('documents directory unavailable');
    });
    let releaseFirstWipe!: () => void;
    let releaseSecondWipe!: () => void;
    clearLocalCache
      .mockImplementationOnce(
        () =>
          new Promise<undefined>((resolve) => {
            releaseFirstWipe = () => resolve(undefined);
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<undefined>((resolve) => {
            releaseSecondWipe = () => resolve(undefined);
          }),
      );
    let holdVaultReads = false;
    let releaseVaultReads!: () => void;
    const vaultReadGate = new Promise<void>((resolve) => {
      releaseVaultReads = resolve;
    });
    vaultGet.mockImplementation(async (key: string) => {
      if (holdVaultReads) await vaultReadGate;
      return vaultValues.get(key) ?? null;
    });
    connectToServer.mockResolvedValue({
      ok: false,
      kind: 'unknown',
      message: 'test stop',
    });

    const firstWipe = forget();
    const candidate = connect('https://candidate.example', 'candidate-secret');
    for (let i = 0; i < 200 && releaseFirstWipe == null; i += 1) await Promise.resolve();
    holdVaultReads = true;
    releaseFirstWipe();
    for (let i = 0; i < 500 && vaultGet.mock.calls.length < 3; i += 1) await Promise.resolve();
    expect(vaultGet).toHaveBeenCalledTimes(3);

    const secondWipe = forget();
    for (let i = 0; i < 200 && releaseSecondWipe == null; i += 1) await Promise.resolve();
    expect(releaseSecondWipe).toEqual(expect.any(Function));

    releaseVaultReads();
    await Promise.resolve();
    await Promise.resolve();
    expect(connectToServer).not.toHaveBeenCalled();

    releaseSecondWipe();
    await Promise.all([firstWipe, secondWipe, candidate]);
    expect(connectToServer).not.toHaveBeenCalled();
    expect(useSessionStore.getState()).toMatchObject({
      status: 'unauthenticated',
      origin: null,
      password: null,
    });
  });

  it('cancels Connect when public Disconnect lands during its first durable inspection', async () => {
    let releaseSessionStateRead: (() => void) | undefined;
    let holdFirstSessionStateRead = true;
    vaultGet.mockImplementation(async (key: string) => {
      if (key === 'serverSessionState' && holdFirstSessionStateRead) {
        holdFirstSessionStateRead = false;
        await new Promise<void>((resolve) => {
          releaseSessionStateRead = resolve;
        });
      }
      return vaultValues.get(key) ?? null;
    });

    const candidate = connect('https://candidate.example', 'candidate-secret');
    for (let i = 0; i < 200 && releaseSessionStateRead == null; i += 1) await Promise.resolve();
    expect(releaseSessionStateRead).toEqual(expect.any(Function));

    const wipe = forget();
    expect(useSessionStore.getState()).toMatchObject({
      status: 'unauthenticated',
      origin: null,
      password: null,
    });
    releaseSessionStateRead?.();
    await Promise.all([candidate, wipe]);

    expect(connectToServer).not.toHaveBeenCalled();
    expect(accountRevoked).toBe(true);
    expect(useSessionStore.getState()).toMatchObject({
      status: 'unauthenticated',
      origin: null,
      password: null,
    });
  });
});

describe('forget() — a vault failure must not abort the Disconnect', () => {
  it('publishes the singleflight promise before synchronous cancellation can re-enter', async () => {
    let reentered: Promise<void> | undefined;
    uploadRegistry.add('reentrant-disconnect', {
      cancel: () => {
        reentered = forget();
      },
    });

    const first = forget();

    expect(reentered).toBe(first);
    await first;
    expect(markerMarkRevoked).toHaveBeenCalledTimes(1);
    expect(clearLocalCache).toHaveBeenCalledTimes(1);
  });

  it('coalesces two rapid Disconnect calls so account B waits for one underlying wipe', async () => {
    const order: string[] = [];
    let releaseWipe!: () => void;
    clearLocalCache.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          order.push('old-account-wipe-started');
          releaseWipe = () => {
            order.push('old-account-wipe-finished');
            resolve(undefined);
          };
        }),
    );
    connectToServer.mockImplementation(async () => {
      order.push('new-account-connect');
      return { ok: false, kind: 'unknown', message: 'test stop' };
    });

    const first = forget();
    const second = forget();
    expect(second).toBe(first);
    for (let i = 0; i < 100 && releaseWipe == null; i += 1) await Promise.resolve();
    expect(clearLocalCache).toHaveBeenCalledTimes(1);
    expect(markerMarkRevoked).toHaveBeenCalledTimes(1);
    expect(deleteFcmToken).toHaveBeenCalledTimes(1);

    const reconnect = connect('https://new.example', 'new-secret');
    await Promise.resolve();
    expect(connectToServer).not.toHaveBeenCalled();

    releaseWipe();
    await Promise.all([first, second, reconnect]);

    expect(clearLocalCache).toHaveBeenCalledTimes(1);
    expect(markerMarkRevoked).toHaveBeenCalledTimes(1);
    expect(order).toEqual([
      'old-account-wipe-started',
      'old-account-wipe-finished',
      'new-account-connect',
    ]);
  });

  it('skips native token retirement when the build has FCM disabled', async () => {
    mockFcmEnabled = false;

    await forget();

    expect(deleteFcmToken).not.toHaveBeenCalled();
    expect(clearLocalCache).toHaveBeenCalledTimes(1);
  });

  it('blocks account B while old-token retirement is deferred/failing, then retries successfully', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    accountRevoked = true;
    vaultValues.set('serverSessionState', SERVER_SESSION_STATE.forgotten);
    let rejectRetirement!: (reason: unknown) => void;
    deleteFcmToken.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectRetirement = reject;
        }),
    );
    connectToServer.mockResolvedValue({
      ok: false,
      kind: 'unknown',
      message: 'test stop',
    });

    const firstAttempt = connect('https://new.example', 'new-secret');
    for (let i = 0; i < 100 && rejectRetirement == null; i += 1) await Promise.resolve();
    expect(deleteFcmToken).toHaveBeenCalledTimes(1);
    expect(connectToServer).not.toHaveBeenCalled();

    rejectRetirement(new Error('Firebase installation unavailable'));
    await firstAttempt;
    expect(connectToServer).not.toHaveBeenCalled();
    expect(accountRevoked).toBe(true);
    expect(useSessionStore.getState()).toMatchObject({
      status: 'error',
      error: expect.stringMatching(/could not safely finish clearing/i),
    });

    await connect('https://new.example', 'new-secret');
    expect(deleteFcmToken).toHaveBeenCalledTimes(2);
    expect(connectToServer).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[forget] previous FCM token retirement failed',
      expect.any(Error),
    );
  });

  it('clears persistent and in-memory logs after the other account cleanup steps', async () => {
    memoryLogSink.write('info', 'old account diagnostic');
    const clearMemoryLogs = jest.spyOn(memoryLogSink, 'clear');

    await forget();

    expect(clearFileLogs).toHaveBeenCalledTimes(1);
    expect(clearMemoryLogs).toHaveBeenCalledTimes(1);
    expect(memoryLogSink.entries()).toEqual([]);
    expect(clearFileLogs.mock.invocationCallOrder[0]).toBeGreaterThan(
      clearShareShortcuts.mock.invocationCallOrder[0]!,
    );
    expect(clearMemoryLogs.mock.invocationCallOrder[0]).toBeGreaterThan(
      clearFileLogs.mock.invocationCallOrder[0]!,
    );
  });

  it('keeps account B blocked until a failed persistent-log clear succeeds on retry', async () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    clearFileLogs.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    connectToServer.mockResolvedValue({
      ok: false,
      kind: 'unknown',
      message: 'test stop',
    });

    await connect('https://new.example', 'new-secret');
    expect(connectToServer).not.toHaveBeenCalled();
    expect(accountRevoked).toBe(true);

    await connect('https://new.example', 'new-secret');
    expect(clearFileLogs).toHaveBeenCalledTimes(2);
    expect(connectToServer).toHaveBeenCalledTimes(1);
  });

  it('keeps account B blocked until an undeleted cached-media directory is removed', async () => {
    // This proves fail-closed deletion/verification for the sweep itself. It intentionally does NOT
    // close REL-005A/B: an attachment/avatar/background transfer outside the idle registry can
    // recreate an old-generation file later, so cancellation or account-namespaced paths remain.
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    mockCachedDirectoryExists = true;
    mockCachedDirectoryDeleteFailure = true;
    connectToServer.mockResolvedValue({
      ok: false,
      kind: 'unknown',
      message: 'test stop',
    });

    await connect('https://new.example', 'new-secret');
    expect(connectToServer).not.toHaveBeenCalled();
    expect(mockCachedDirectoryExists).toBe(true);
    expect(accountRevoked).toBe(true);

    mockCachedDirectoryDeleteFailure = false;
    await connect('https://new.example', 'new-secret');
    expect(mockCachedDirectoryExists).toBe(false);
    expect(connectToServer).toHaveBeenCalledTimes(1);
  });

  it('keeps account B blocked until persistent Direct Share shortcuts are cleared', async () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    clearShareShortcuts.mockReturnValueOnce(false).mockReturnValueOnce(true);
    connectToServer.mockResolvedValue({
      ok: false,
      kind: 'unknown',
      message: 'test stop',
    });

    await connect('https://new.example', 'new-secret');
    expect(connectToServer).not.toHaveBeenCalled();
    expect(accountRevoked).toBe(true);

    await connect('https://new.example', 'new-secret');
    expect(clearShareShortcuts).toHaveBeenCalledTimes(2);
    expect(connectToServer).toHaveBeenCalledTimes(1);
  });

  /**
   * `Promise.all` over the two credential deletes used to be the only un-guarded await in the whole
   * function. One Android Keystore rejection (a key-invalidation event, say) therefore skipped
   * EVERYTHING below it: the session was never reset — the app still believed it was connected,
   * with its socket already torn down — the DB was never wiped, the cached media stayed on disk and
   * the previous account's names and photos stayed in the system share sheet. The next launch then
   * routed to setup on the missing credential, so the user could not even retry.
   */
  it('resets the session and completes the wipe when a credential delete rejects', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vaultDelete.mockImplementation(async (key: string) => {
      if (key === 'serverPassword') throw new Error('keystore unavailable');
    });

    await expect(forget()).resolves.toBeUndefined();

    expect(vaultDelete).toHaveBeenCalledWith('serverAddress');
    expect(vaultDelete).toHaveBeenCalledWith('serverPassword');
    // The in-memory reset closes the authorization window even though the on-disk delete did not.
    expect(useSessionStore.getState().origin).toBeNull();
    expect(useSessionStore.getState().password).toBeNull();
    expect(clearLocalCache).toHaveBeenCalledTimes(1);
    expect(clearShareShortcuts).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[forget] credential delete failed — it is still in the vault',
      expect.any(Error),
    );
  });

  it('still does all of it on the ordinary path', async () => {
    await forget();

    expect(useSessionStore.getState().origin).toBeNull();
    expect(clearLocalCache).toHaveBeenCalledTimes(1);
    expect(clearShareShortcuts).toHaveBeenCalledTimes(1);
  });

  it('attempts the independent marker before the first SecureStore retirement write', async () => {
    const order: string[] = [];
    markerMarkRevoked.mockImplementation(() => {
      order.push('filesystem-marker');
      accountRevoked = true;
    });
    vaultSet.mockImplementation(async (key: string, value: string) => {
      order.push(`vault-${key}`);
      vaultValues.set(key, value);
    });

    await forget();

    expect(order.slice(0, 2)).toEqual(['filesystem-marker', 'vault-serverSessionState']);
  });

  it('revokes the live in-memory credentials before a slow SecureStore write can suspend', async () => {
    let releaseTombstone!: () => void;
    vaultSet.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseTombstone = resolve;
        }),
    );

    const run = forget();

    // `runForget` has reached its first await, but no asynchronous cleanup has been released yet.
    // A hung Keystore must not leave HttpClient able to read the previous account's password.
    expect(useSessionStore.getState().origin).toBeNull();
    expect(useSessionStore.getState().password).toBeNull();
    expect(clearLocalCache).not.toHaveBeenCalled();

    releaseTombstone();
    await expect(run).resolves.toBeUndefined();
    expect(clearLocalCache).toHaveBeenCalledTimes(1);
  });

  it('bounds and quarantines late SecureStore retirement before allowing a full retry sweep', async () => {
    jest.useFakeTimers();
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    let releaseTombstone: (() => void) | undefined;
    try {
      vaultSet.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseTombstone = resolve;
          }),
      );
      connectToServer.mockResolvedValue({
        ok: false,
        kind: 'unknown',
        message: 'test stop',
      });

      const run = forget();
      for (let i = 0; i < 200 && releaseTombstone == null; i += 1) await Promise.resolve();
      expect(releaseTombstone).toEqual(expect.any(Function));
      const rejected = expect(run).rejects.toThrow(
        'Secure credential retirement did not finish in time.',
      );
      await jest.advanceTimersByTimeAsync(5_000);
      await rejected;

      expect(clearLocalCache).toHaveBeenCalledTimes(1);
      await connect('https://new.example', 'new-secret');
      expect(connectToServer).not.toHaveBeenCalled();
      expect(useSessionStore.getState().error).toBe(
        'Previous account cleanup is still pending. Fully close and reopen Gator before connecting again.',
      );

      releaseTombstone?.();
      await flushMicrotasks();
      await connect('https://new.example', 'new-secret');

      expect(clearLocalCache).toHaveBeenCalledTimes(2);
      expect(connectToServer).toHaveBeenCalledTimes(1);
    } finally {
      releaseTombstone?.();
      await flushMicrotasks();
      jest.useRealTimers();
    }
  });

  it('does not time out the only durable revocation proof when the filesystem marker failed', async () => {
    jest.useFakeTimers();
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    let releaseTombstone: (() => void) | undefined;
    let settled = false;
    try {
      markerMarkRevoked.mockImplementationOnce(() => {
        throw new Error('filesystem marker unavailable');
      });
      vaultSet.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseTombstone = resolve;
          }),
      );

      const run = forget();
      void run.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      for (let i = 0; i < 200 && releaseTombstone == null; i += 1) await Promise.resolve();
      expect(releaseTombstone).toEqual(expect.any(Function));

      await jest.advanceTimersByTimeAsync(60_000);
      expect(settled).toBe(false);
      expect(clearLocalCache).not.toHaveBeenCalled();

      releaseTombstone?.();
      await expect(run).resolves.toBeUndefined();
      expect(clearLocalCache).toHaveBeenCalledTimes(1);
    } finally {
      releaseTombstone?.();
      await flushMicrotasks();
      jest.useRealTimers();
    }
  });

  it('bounds and quarantines a late FCM token retirement before account B', async () => {
    jest.useFakeTimers();
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    let releaseTokenRetirement: (() => void) | undefined;
    try {
      deleteFcmToken.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseTokenRetirement = resolve;
          }),
      );
      connectToServer.mockResolvedValue({
        ok: false,
        kind: 'unknown',
        message: 'test stop',
      });

      const run = forget();
      for (let i = 0; i < 200 && releaseTokenRetirement == null; i += 1) await Promise.resolve();
      expect(releaseTokenRetirement).toEqual(expect.any(Function));
      const rejected = expect(run).rejects.toThrow(
        'Push notification retirement for the previous connection could not be confirmed.',
      );
      await jest.advanceTimersByTimeAsync(5_000);
      await rejected;

      expect(clearLocalCache).toHaveBeenCalledTimes(1);
      await connect('https://new.example', 'new-secret');
      expect(connectToServer).not.toHaveBeenCalled();
      expect(useSessionStore.getState().error).toBe(
        'Previous account cleanup is still pending. Fully close and reopen Gator before connecting again.',
      );

      releaseTokenRetirement?.();
      await flushMicrotasks();
      await connect('https://new.example', 'new-secret');

      expect(deleteFcmToken).toHaveBeenCalledTimes(2);
      expect(clearLocalCache).toHaveBeenCalledTimes(2);
      expect(connectToServer).toHaveBeenCalledTimes(1);
    } finally {
      releaseTokenRetirement?.();
      await flushMicrotasks();
      jest.useRealTimers();
    }
  });

  it('bounds and quarantines a late database cleanup before account B', async () => {
    jest.useFakeTimers();
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    let releaseDatabase: ((database: unknown) => void) | undefined;
    try {
      ensureDatabase.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseDatabase = resolve;
          }),
      );
      connectToServer.mockResolvedValue({
        ok: false,
        kind: 'unknown',
        message: 'test stop',
      });

      const run = forget();
      for (let i = 0; i < 200 && releaseDatabase == null; i += 1) await Promise.resolve();
      expect(releaseDatabase).toEqual(expect.any(Function));
      const rejected = expect(run).rejects.toThrow(
        'Local data from the previous connection could not be fully removed.',
      );
      await jest.advanceTimersByTimeAsync(30_000);
      await rejected;

      expect(clearLocalCache).not.toHaveBeenCalled();
      await connect('https://new.example', 'new-secret');
      expect(connectToServer).not.toHaveBeenCalled();
      expect(useSessionStore.getState().error).toBe(
        'Previous account cleanup is still pending. Fully close and reopen Gator before connecting again.',
      );

      releaseDatabase?.({});
      await flushMicrotasks(60);
      await connect('https://new.example', 'new-secret');

      expect(clearLocalCache).toHaveBeenCalledTimes(2);
      expect(connectToServer).toHaveBeenCalledTimes(1);
    } finally {
      releaseDatabase?.({});
      await flushMicrotasks(60);
      jest.useRealTimers();
    }
  });

  it('blocks account B when tracked realtime work misses its drain deadline, then retries', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    let releaseRealtime!: () => void;
    pauseRealtimeDeliveries.mockImplementationOnce(() => {
      if (mockDeliveriesAccepting) {
        mockDeliveriesAccepting = false;
        mockDeliveryGeneration += 1;
      }
      return new Promise<void>((resolve) => {
        releaseRealtime = resolve;
      });
    });
    connectToServer.mockResolvedValue({
      ok: false,
      kind: 'unknown',
      message: 'test stop',
    });

    try {
      const firstAttempt = connect('https://new.example', 'new-secret');
      for (let i = 0; i < 500 && releaseRealtime == null; i += 1) await Promise.resolve();
      expect(releaseRealtime).toEqual(expect.any(Function));

      await jest.advanceTimersByTimeAsync(5_000);
      await firstAttempt;

      expect(clearLocalCache).toHaveBeenCalledTimes(1);
      expect(connectToServer).not.toHaveBeenCalled();
      expect(accountRevoked).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        '[forget] realtime delivery drain timed out — next connection remains blocked',
      );

      releaseRealtime();
      await connect('https://new.example', 'new-secret');
      expect(clearLocalCache).toHaveBeenCalledTimes(2);
      expect(connectToServer).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('blocks account B when the old sync misses its drain deadline, then wipes again', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    let releaseOldSync!: () => void;
    awaitSyncIdle.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          releaseOldSync = () => resolve(undefined);
        }),
    );
    connectToServer.mockResolvedValue({
      ok: false,
      kind: 'unknown',
      message: 'test stop',
    });

    try {
      const firstAttempt = connect('https://new.example', 'new-secret');
      for (let i = 0; i < 500 && awaitSyncIdle.mock.calls.length === 0; i += 1) {
        await Promise.resolve();
      }
      expect(awaitSyncIdle).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(20_000);
      await firstAttempt;

      expect(clearLocalCache).toHaveBeenCalledTimes(1);
      expect(connectToServer).not.toHaveBeenCalled();
      expect(accountRevoked).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        '[forget] sync drain timed out — next connection remains blocked',
      );

      releaseOldSync();
      await connect('https://new.example', 'new-secret');
      expect(clearLocalCache).toHaveBeenCalledTimes(2);
      expect(connectToServer).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('waits for an already-running error-report drain before wiping the database', async () => {
    let releaseDrain!: () => void;
    resetErrorReportSession.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseDrain = resolve;
      }),
    );

    const run = forget();
    for (let i = 0; i < 20 && awaitSyncIdle.mock.calls.length === 0; i += 1) {
      await Promise.resolve();
    }
    await Promise.resolve();

    expect(awaitSyncIdle).toHaveBeenCalledTimes(1);
    expect(clearLocalCache).not.toHaveBeenCalled();

    releaseDrain();
    await expect(run).resolves.toBeUndefined();
    expect(clearLocalCache).toHaveBeenCalledTimes(1);
  });

  it('bounds an error-report drain wait while its revoked generation stays safe', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    resetErrorReportSession.mockReturnValueOnce(new Promise<void>(() => undefined));

    try {
      const run = forget();
      for (let i = 0; i < 20 && awaitSyncIdle.mock.calls.length === 0; i += 1) {
        await Promise.resolve();
      }
      await jest.advanceTimersByTimeAsync(5_000);
      await expect(run).resolves.toBeUndefined();

      expect(clearLocalCache).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        '[forget] error-report drain timed out — continuing with generation revoked',
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('persists forgotten before deletes so two delete failures cannot reopen FCM delivery', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vaultValues.set('serverSessionState', SERVER_SESSION_STATE.active);
    vaultValues.set('serverAddress', 'https://old.example');
    vaultValues.set('serverPassword', 'hunter2');
    vaultDelete.mockRejectedValue(new Error('Keystore delete unavailable'));

    await expect(forget()).resolves.toBeUndefined();

    expect(vaultSet).toHaveBeenNthCalledWith(
      1,
      'serverSessionState',
      SERVER_SESSION_STATE.forgotten,
    );
    expect(vaultDelete).toHaveBeenCalledTimes(2);
    expect(vaultValues.get('serverAddress')).toBe('https://old.example');
    expect(vaultValues.get('serverPassword')).toBe('hunter2');
    await expect(
      readFcmSessionState({ get: vaultGet }, { isRevoked: markerIsRevoked }),
    ).resolves.toBe('forgotten');
    expect(clearLocalCache).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[forget] credential delete failed — it is still in the vault',
      expect.any(Error),
    );
  });

  it('uses the independent marker when every SecureStore retirement operation fails', async () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vaultValues.set('serverSessionState', SERVER_SESSION_STATE.active);
    vaultValues.set('serverAddress', 'https://old.example');
    vaultValues.set('serverPassword', 'hunter2');
    vaultSet.mockRejectedValue(new Error('Keystore write unavailable'));
    vaultDelete.mockRejectedValue(new Error('Keystore delete unavailable'));

    await expect(forget()).resolves.toBeUndefined();

    expect(accountRevoked).toBe(true);
    expect(clearLocalCache).toHaveBeenCalledTimes(1);
    expect(clearShareShortcuts).toHaveBeenCalledTimes(1);
    // Simulate a fresh killed-app/restart policy read: the old active tuple is still physically in
    // SecureStore, but the independent file wins and delivery/session restore remain closed.
    await expect(
      readFcmSessionState({ get: vaultGet }, { isRevoked: markerIsRevoked }),
    ).resolves.toBe('forgotten');
    await hydrateSession();
    expect(useSessionStore.getState().status).toBe('unauthenticated');
  });

  it('finishes the local wipe then rejects clearly when every independent and vault retirement fails', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    markerMarkRevoked.mockImplementation(() => {
      throw new Error('filesystem unavailable');
    });
    vaultSet.mockRejectedValue(new Error('Keystore write unavailable'));
    vaultDelete.mockRejectedValue(new Error('Keystore delete unavailable'));

    const run = forget();
    // Even the independent filesystem call failed synchronously; live credentials are still
    // revoked in memory before any rejected SecureStore promise gets a turn on the microtask queue.
    expect(useSessionStore.getState()).toMatchObject({ origin: null, password: null });

    await expect(run).rejects.toThrow(
      "Secure credential removal could not be confirmed. Clear Gator's app data in Android Settings before handing off this device.",
    );

    expect(clearLocalCache).toHaveBeenCalledTimes(1);
    expect(clearShareShortcuts).toHaveBeenCalledTimes(1);
    expect(vaultSet).toHaveBeenCalledWith('serverSessionState', SERVER_SESSION_STATE.forgotten);
    expect(vaultSet).toHaveBeenCalledWith('serverAddress', '');
    expect(vaultSet).toHaveBeenCalledWith('serverPassword', '');
    expect(markerMarkRevoked).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[forget] Secure credential removal could not be confirmed. Clear Gator's app data in Android Settings before handing off this device. Local wipe will continue.",
    );
    expect(warn).toHaveBeenCalledWith(
      '[forget] independent account revocation marker write failed',
      expect.any(Error),
    );
  });
});

/**
 * A displayed notification is system state that outlives every row the wipe deletes, and a message
 * notification carries the sender's name, avatar and body. Leaving them up meant the previous
 * account's content stayed on the lock screen of whoever used the device next — through the
 * Disconnect and through connecting to a different server — while the confirmation dialog promised
 * conversations and messages were deleted from the device.
 */
describe('forget() — the tray is cleared with the rest of the account', () => {
  it('cancels the displayed notifications', async () => {
    await forget();

    expect(cancelAllNotifications).toHaveBeenCalledTimes(1);
  });

  it('keeps account B blocked when the DB cannot be opened, then retries the wipe', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    // The tray cancel must not sit behind `ensureDatabase()`. Enumerating which notifications to
    // cancel is precisely the work that would need the DB — which is why nothing is enumerated,
    // and why this runs ahead of the block that opens it.
    ensureDatabase
      .mockRejectedValueOnce(new Error('database not initialized'))
      .mockResolvedValueOnce({});
    connectToServer.mockResolvedValue({
      ok: false,
      kind: 'unknown',
      message: 'test stop',
    });

    await connect('https://new.example', 'new-secret');

    expect(cancelAllNotifications).toHaveBeenCalledTimes(1);
    expect(clearShareShortcuts).toHaveBeenCalledTimes(1);
    expect(connectToServer).not.toHaveBeenCalled();
    expect(accountRevoked).toBe(true);
    expect(warn).toHaveBeenCalledWith('[forget] local cache wipe could not run', expect.any(Error));

    await connect('https://new.example', 'new-secret');
    expect(ensureDatabase).toHaveBeenCalledTimes(2);
    expect(connectToServer).toHaveBeenCalledTimes(1);
  });

  it('keeps account B blocked when notification cleanup rejects, then retries it', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    cancelAllNotifications
      .mockRejectedValueOnce(new Error('notifee module not linked'))
      .mockResolvedValueOnce(undefined);
    connectToServer.mockResolvedValue({
      ok: false,
      kind: 'unknown',
      message: 'test stop',
    });

    await connect('https://new.example', 'new-secret');

    expect(clearLocalCache).toHaveBeenCalledTimes(1);
    expect(clearShareShortcuts).toHaveBeenCalledTimes(1);
    expect(connectToServer).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[forget] could not clear displayed notifications',
      expect.any(Error),
    );

    await connect('https://new.example', 'new-secret');
    expect(cancelAllNotifications).toHaveBeenCalledTimes(2);
    expect(connectToServer).toHaveBeenCalledTimes(1);
  });

  it('continues the local wipe but blocks account B when notification cleanup never settles', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    cancelAllNotifications.mockImplementationOnce(() => new Promise<undefined>(() => undefined));

    try {
      const run = connect('https://new.example', 'new-secret');
      for (let i = 0; i < 500 && cancelAllNotifications.mock.calls.length === 0; i += 1) {
        await Promise.resolve();
      }
      expect(cancelAllNotifications).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(5_000);
      await expect(run).resolves.toBeUndefined();

      expect(clearLocalCache).toHaveBeenCalledTimes(1);
      expect(clearShareShortcuts).toHaveBeenCalledTimes(1);
      expect(connectToServer).not.toHaveBeenCalled();
      expect(accountRevoked).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        '[forget] notification cleanup timed out — continuing; queued cleanup remains ordered',
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps account B blocked when a reminder trigger cannot be removed, then retries it', async () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    listReminders.mockResolvedValue([{ notificationId: 'old-reminder-trigger' } as never]);
    cancelReminderNotification
      .mockRejectedValueOnce(new Error('trigger bridge unavailable'))
      .mockResolvedValueOnce(undefined);
    connectToServer.mockResolvedValue({
      ok: false,
      kind: 'unknown',
      message: 'test stop',
    });

    await connect('https://new.example', 'new-secret');
    expect(connectToServer).not.toHaveBeenCalled();
    expect(clearLocalCache).toHaveBeenCalledTimes(1);

    await connect('https://new.example', 'new-secret');
    expect(cancelReminderNotification).toHaveBeenCalledTimes(2);
    expect(connectToServer).toHaveBeenCalledTimes(1);
  });
});

/**
 * The wipe is a dozen independent statements — it cannot be one transaction without holding the
 * process-wide write lock for the seconds it takes to delete every message on the device. So a
 * partial wipe is reachable and silent (a statement swept into a neighbour's rolled-back
 * transaction throws nothing; an FK error from a concurrent sync slice is caught and logged at
 * `warn`), and the residue is the previous account's conversations.
 */
describe('forget() — the wipe is confirmed, not trusted', () => {
  it('runs the wipe again when rows survived the first pass', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    localCacheDirty.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await forget();

    expect(clearLocalCache).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith('[forget] local cache still populated after wipe attempt 1');
  });

  it('re-runs after a wipe that THREW, instead of leaving the rows behind', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    clearLocalCache.mockRejectedValueOnce(new Error('FOREIGN KEY constraint failed'));
    localCacheDirty.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(forget()).resolves.toBeUndefined();

    expect(clearLocalCache).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      '[forget] local cache wipe attempt 1 failed',
      expect.any(Error),
    );
    expect(warn).toHaveBeenCalledWith('[forget] local cache still populated after wipe attempt 1');
  });

  it('keeps account B blocked when the cache stays dirty, then retries the bounded wipe', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    localCacheDirty.mockResolvedValue(true);
    connectToServer.mockResolvedValue({
      ok: false,
      kind: 'unknown',
      message: 'test stop',
    });

    await connect('https://new.example', 'new-secret');

    expect(clearLocalCache).toHaveBeenCalledTimes(2);
    // The steps after the wipe must still run — durable session retirement was attempted first.
    expect(clearShareShortcuts).toHaveBeenCalledTimes(1);
    expect(connectToServer).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[forget] local cache still populated after wipe attempt 1');
    expect(warn).toHaveBeenCalledWith('[forget] local cache still populated after wipe attempt 2');

    localCacheDirty.mockResolvedValue(false);
    await connect('https://new.example', 'new-secret');
    expect(clearLocalCache).toHaveBeenCalledTimes(3);
    expect(connectToServer).toHaveBeenCalledTimes(1);
  });
});

describe('forget() — in-flight realtime delivery is drained before private state is erased', () => {
  it('keeps revocation and the wipe authoritative when a session subscriber throws', async () => {
    const subscriberFailure = new Error('session subscriber sentinel');
    const unsubscribe = useSessionStore.subscribe(() => {
      throw subscriberFailure;
    });

    try {
      await expect(forget()).rejects.toThrow(/in-memory state/i);

      expect(markerMarkRevoked).toHaveBeenCalledTimes(1);
      expect(useSessionStore.getState()).toMatchObject({
        status: 'unauthenticated',
        origin: null,
        password: null,
        serverInfo: null,
      });
      expect(clearLocalCache).toHaveBeenCalledTimes(1);
      expect(localCacheDirty).toHaveBeenCalledTimes(1);
      expect(cancelAllNotifications).toHaveBeenCalledTimes(1);
      expect(clearShareShortcuts).toHaveBeenCalledTimes(1);
      expect(clearFileLogs).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it('synchronously cancels every upload and clears progress after closing realtime admission', async () => {
    let releaseRealtime!: () => void;
    const order: string[] = [];
    pauseRealtimeDeliveries.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          order.push('realtime-paused');
          releaseRealtime = resolve;
        }),
    );
    const first = jest.fn(() => {
      order.push('first-cancelled');
      throw new Error('native upload already released');
    });
    const second = jest.fn(() => order.push('second-cancelled'));
    uploadRegistry.add('temp-first', { cancel: first });
    uploadRegistry.add('temp-second', { cancel: second });
    useUploadStore.getState().start('attachment-first', {
      chatGuid: 'chat-old-account',
      name: 'private.jpg',
      total: 100,
    });
    useDownloadStore.getState().start('download-old-account');

    const run = forget();

    // No microtask has run yet: cancellation and presentation reset are part of the synchronous
    // account-boundary closure, before SecureStore, drain, DB, or native cleanup can suspend.
    expect(order).toEqual(['realtime-paused', 'first-cancelled', 'second-cancelled']);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(uploadRegistry.size).toBe(0);
    expect(useUploadStore.getState().byGuid).toEqual({});
    expect(useDownloadStore.getState().status).toEqual({});
    expect(useDownloadStore.getState().progress).toEqual({});

    releaseRealtime();
    await expect(run).resolves.toBeUndefined();
  });

  it('does not cancel or wipe until a delivery admitted before Disconnect has stopped', async () => {
    let releaseRealtime!: () => void;
    pauseRealtimeDeliveries.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseRealtime = resolve;
        }),
    );

    const run = forget();
    for (let i = 0; i < 10 && releaseRealtime == null; i += 1) await Promise.resolve();
    await Promise.resolve();

    expect(cancelAllNotifications).not.toHaveBeenCalled();
    expect(clearLocalCache).not.toHaveBeenCalled();

    releaseRealtime();
    await run;

    expect(cancelAllNotifications).toHaveBeenCalledTimes(1);
    expect(clearLocalCache).toHaveBeenCalledTimes(1);
  });
});

describe('forget() — foreground boot handoff', () => {
  it('starts a successor immediately and makes its session stage join the published cleanup', async () => {
    let releaseWipe!: () => void;
    clearLocalCache.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          releaseWipe = () => resolve(undefined);
        }),
    );
    const controller = new AbortController();
    let successor!: ReturnType<typeof inspectForegroundBootSession>;
    const restart = jest.fn(() => {
      successor = inspectForegroundBootSession({
        runId: 99,
        signal: controller.signal,
        stageSignal: controller.signal,
        reportIssue: jest.fn(),
        registerDisposer: jest.fn(() => jest.fn()),
      });
    });
    const uninstall = installForegroundBootRestarter(restart);

    try {
      const run = forget();
      expect(restart).toHaveBeenCalledTimes(1);
      let successorSettled = false;
      void successor.then(() => {
        successorSettled = true;
      });
      for (let i = 0; i < 100 && releaseWipe == null; i += 1) await Promise.resolve();
      expect(releaseWipe).toEqual(expect.any(Function));
      expect(successorSettled).toBe(false);

      releaseWipe();
      await run;
      await expect(successor).resolves.toEqual({ kind: 'setup' });

      expect(restart).toHaveBeenCalledTimes(1);
    } finally {
      uninstall();
    }
  });
});
