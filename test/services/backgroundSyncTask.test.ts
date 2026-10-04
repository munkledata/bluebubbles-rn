const mockRunBackgroundSync = jest.fn();
const mockIncrementalSync = jest.fn(async () => ({ chats: 0, messages: 0 }));
const mockRunDueScheduled = jest.fn(async () => 0);
const mockRunOutgoingQueue = jest.fn(async () => ({ eligible: 0, sent: 0 }));
const mockRunTrackedRealtimeWork = jest.fn(async (_scope, run: () => Promise<void>) => {
  await run();
  return 'delivered';
});
const mockHttpClient = jest.fn((config: unknown) => ({ config }));
const mockServerInfo = jest.fn(async () => ({ server_version: '1.9.0' }));
const mockRegisterTaskAsync = jest.fn(async () => undefined);
const mockIsTaskRegisteredAsync = jest.fn(async () => true);
const mockGetStatusAsync = jest.fn(async () => 'available');
const mockFlushPersistentLogs = jest.fn(async () => true);
const mockKvGet = jest.fn<Promise<string | null>, [unknown, string]>(async () => null);
const mockRunErrorReportQueue = jest.fn(async () => ({ eligible: 0, uploaded: 0 }));
const mockReconcileMessageNotifications = jest.fn(async () => undefined);
const mockRetainExecution = jest.fn();

jest.mock('@/native/backgroundTaskExecution', () => ({
  retainBackgroundTaskExecution: mockRetainExecution,
}));

let task: (() => Promise<unknown>) | undefined;

jest.mock('expo-task-manager', () => ({
  defineTask: (_name: string, fn: (body: unknown) => Promise<unknown>) => {
    task = () =>
      fn({
        executionInfo: { eventId: '00000000-0000-0000-0000-000000000001' },
        data: { gatorExecutionId: '00000000-0000-0000-0000-000000000002' },
      });
  },
  isTaskRegisteredAsync: mockIsTaskRegisteredAsync,
}));
jest.mock('expo-background-task', () => ({
  BackgroundTaskResult: { Success: 'success', Failed: 'failed' },
  BackgroundTaskStatus: { Available: 'available' },
  getStatusAsync: mockGetStatusAsync,
  registerTaskAsync: mockRegisterTaskAsync,
}));
jest.mock('@core/api/http', () => ({ HttpClient: mockHttpClient }));
jest.mock('@core/api/endpoints/server', () => ({ serverInfo: mockServerInfo }));
jest.mock('@core/secure', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));
jest.mock('@db/repositories', () => ({
  kvGet: mockKvGet,
}));
jest.mock('@state/featureSettingsStore', () => ({
  ERROR_REPORTING_CONSENT_KEY: 'diagnostics.errorReportingConsent.v1',
  LEGACY_ERROR_REPORTING_KEY: 'diagnostics.errorReporting',
  useFeatureSettingsStore: {
    subscribe: jest.fn(() => jest.fn()),
    getState: jest.fn(() => ({ hydrated: false, errorReportingEnabled: false })),
  },
}));
jest.mock('@/services/clients', () => ({
  vault: {},
  accountRevocationMarker: {},
}));
jest.mock('@/services/databaseControl', () => ({ ensureDatabase: jest.fn() }));
jest.mock('@/services/errors/errorReportQueueService', () => ({
  runErrorReportQueue: mockRunErrorReportQueue,
}));
jest.mock('@/services/logging/fileLogSink', () => ({
  flushPersistentLogsForHeadlessCompletion: mockFlushPersistentLogs,
}));
jest.mock('@/services/notifications/notifeeService', () => ({
  reconcileMessageNotificationsWithDatabase: mockReconcileMessageNotifications,
}));
jest.mock('@/services/realtime/deliveryCoordinator', () => ({
  captureRealtimeDeliveryLease: jest.fn(() => ({ generation: 1, isCurrent: () => true })),
  runTrackedRealtimeWork: mockRunTrackedRealtimeWork,
}));
jest.mock('@/services/send/attachmentUpload', () => ({
  expoAttachmentUploader: jest.fn(),
  expoFileExists: jest.fn(),
}));
jest.mock('@/services/send/outgoingQueueService', () => ({
  runOutgoingQueue: mockRunOutgoingQueue,
}));
jest.mock('@/services/send/scheduleService', () => ({
  runDueScheduled: mockRunDueScheduled,
}));
jest.mock('@/services/sync', () => ({
  httpSyncApi: jest.fn(() => ({ fetchMessagesAfter: jest.fn() })),
  incrementalSync: mockIncrementalSync,
}));
jest.mock('@/services/syncControl', () => ({ runTrackedSync: jest.fn() }));
jest.mock('@/services/background/backgroundSyncOrchestrator', () => ({
  runBackgroundSync: mockRunBackgroundSync,
}));

// eslint-disable-next-line import/first -- native/task dependencies above must be mocked first
import '@/services/background/registerBackgroundSyncHeadlessTask';
// eslint-disable-next-line import/first -- native/task dependencies above must be mocked first
import {
  BACKGROUND_ATTACHMENT_UPLOAD_TIMEOUT_MS,
  BACKGROUND_CALLBACK_FINALIZATION_WINDOW_MS,
  BACKGROUND_CALLBACK_WORK_WINDOW_MS,
  BACKGROUND_OUTGOING_MAX_ROWS,
  BACKGROUND_SCHEDULE_MAX_ROWS,
  BACKGROUND_SYNC_MAX_PAGES,
  BACKGROUND_WAKE_ADMISSION_BUDGET_MS,
  BG_SYNC_TASK,
  registerBackgroundSync,
} from '@/services/background/backgroundSync';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function settleMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRetainExecution.mockImplementation(() => ({
    signal: new AbortController().signal,
    release: jest.fn(() => true),
  }));
  mockIsTaskRegisteredAsync.mockResolvedValue(true);
  mockGetStatusAsync.mockResolvedValue('available');
  mockFlushPersistentLogs.mockResolvedValue(true);
  mockKvGet.mockResolvedValue(null);
  mockRunBackgroundSync.mockResolvedValue({ result: 'success', reason: 'completed' });
  mockRunTrackedRealtimeWork.mockImplementation(async (_scope, run) => {
    await run();
    return 'delivered';
  });
});

describe('the Expo background task adapter', () => {
  it('rejects missing native ownership before bootstrap, database, or network work', async () => {
    mockRetainExecution.mockReturnValueOnce(null);
    await expect(task?.()).resolves.toBe('failed');
    expect(mockRunBackgroundSync).not.toHaveBeenCalled();
    expect(mockHttpClient).not.toHaveBeenCalled();
    expect(mockRetainExecution).toHaveBeenCalledWith(
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
    );
  });

  it('rejects an already cancelled native execution before bootstrap and releases its retention', async () => {
    const controller = new AbortController();
    controller.abort();
    const release = jest.fn(() => true);
    mockRetainExecution.mockReturnValueOnce({ signal: controller.signal, release });
    await expect(task?.()).resolves.toBe('failed');
    expect(mockRunBackgroundSync).not.toHaveBeenCalled();
    expect(mockHttpClient).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('retains failed-admission cleanup and refuses another claim until its exact release succeeds', async () => {
    const controller = new AbortController();
    controller.abort();
    const release = jest
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    mockRetainExecution.mockReturnValueOnce({ signal: controller.signal, release });
    await expect(task?.()).resolves.toBe('failed');
    await expect(task?.()).resolves.toBe('failed');
    expect(mockRetainExecution).toHaveBeenCalledTimes(1);
    expect(mockRunBackgroundSync).not.toHaveBeenCalled();
    await expect(task?.()).resolves.toBe('success');
    expect(mockRetainExecution).toHaveBeenCalledTimes(2);
    expect(mockRunBackgroundSync).toHaveBeenCalledTimes(1);
  });

  it('revokes native-cancelled work promptly but retains the keeper and replacement fence until real settlement', async () => {
    const controller = new AbortController();
    const release = jest.fn(() => true);
    const lateRun = deferred<{ result: 'success'; reason: 'completed' }>();
    let scope: { isCurrent(): boolean } | undefined;
    let requestSignal: AbortSignal | undefined;
    mockRetainExecution.mockReturnValueOnce({ signal: controller.signal, release });
    mockRunBackgroundSync.mockImplementationOnce(async (deps) => {
      scope = deps.captureAccountScope();
      deps.createClient({ origin: 'https://vault.example', password: 'vault-secret' });
      requestSignal = (mockHttpClient.mock.calls.at(-1)![0] as { lifetimeSignal: AbortSignal })
        .lifetimeSignal;
      return lateRun.promise;
    });
    const first = Promise.resolve(task?.());
    await settleMicrotasks();
    controller.abort();
    await expect(first).resolves.toBe('failed');
    expect(scope?.isCurrent()).toBe(false);
    expect(requestSignal?.aborted).toBe(true);
    expect(release).not.toHaveBeenCalled();
    await expect(task?.()).resolves.toBe('failed');
    expect(mockRunBackgroundSync).toHaveBeenCalledTimes(1);
    lateRun.resolve({ result: 'success', reason: 'completed' });
    await settleMicrotasks();
    expect(release).toHaveBeenCalledTimes(1);
    await expect(task?.()).resolves.toBe('success');
  });

  it('keeps native ownership through final logging even after the real continuation settles', async () => {
    const finalization = deferred<boolean>();
    const release = jest.fn(() => true);
    mockRetainExecution.mockReturnValueOnce({ signal: new AbortController().signal, release });
    mockFlushPersistentLogs.mockReturnValueOnce(finalization.promise);
    const first = Promise.resolve(task?.());
    await settleMicrotasks();
    expect(release).not.toHaveBeenCalled();
    await expect(task?.()).resolves.toBe('failed');
    expect(mockRunBackgroundSync).toHaveBeenCalledTimes(1);
    finalization.resolve(true);
    await expect(first).resolves.toBe('success');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('does not publish a new owner when native retention release fails', async () => {
    const release = jest
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    mockRetainExecution.mockReturnValueOnce({ signal: new AbortController().signal, release });
    await expect(task?.()).resolves.toBe('success');
    await expect(task?.()).resolves.toBe('failed');
    expect(mockRunBackgroundSync).toHaveBeenCalledTimes(1);
    await expect(task?.()).resolves.toBe('success');
    expect(mockRunBackgroundSync).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(3);
  });

  it('maps deterministic orchestrator success/retry outcomes onto Expo task results', async () => {
    await expect(task?.()).resolves.toBe('success');
    expect(mockFlushPersistentLogs).toHaveBeenCalledTimes(1);

    mockRunBackgroundSync.mockResolvedValueOnce({ result: 'retry', reason: 'work-failed' });
    await expect(task?.()).resolves.toBe('failed');
    expect(mockFlushPersistentLogs).toHaveBeenCalledTimes(2);
  });

  it('flushes the persistent sink even when the task adapter rejects unexpectedly', async () => {
    mockRunBackgroundSync.mockRejectedValueOnce(new Error('private task adapter failure'));

    await expect(task?.()).rejects.toThrow('private task adapter failure');

    expect(mockFlushPersistentLogs).toHaveBeenCalledTimes(1);
  });

  it('constructs a task-local HttpClient from the orchestrator credential snapshot', async () => {
    mockRunBackgroundSync.mockImplementationOnce(async (deps) => {
      deps.createClient({ origin: 'https://vault.example', password: 'vault-secret' });
      return { result: 'success', reason: 'completed' };
    });

    await task?.();

    const config = mockHttpClient.mock.calls[0]![0] as {
      getOrigin: () => string;
      getPassword: () => string;
      lifetimeSignal: AbortSignal;
    };
    expect(config.getOrigin()).toBe('https://vault.example');
    expect(config.getPassword()).toBe('vault-secret');
    expect(config.lifetimeSignal).toEqual(expect.any(AbortSignal));
    expect(config.lifetimeSignal.aborted).toBe(false);
  });

  it('revokes work at 50 seconds, returns Failed, and fences a replacement until late work settles', async () => {
    jest.useFakeTimers({ now: 20_000 });
    const lateRun = deferred<{ result: 'success'; reason: 'completed' }>();
    let capturedScope: { isCurrent(): boolean } | undefined;
    let lifetimeSignal: AbortSignal | undefined;
    const release = jest.fn(() => true);
    mockRetainExecution.mockReturnValueOnce({ signal: new AbortController().signal, release });
    mockRunBackgroundSync.mockImplementationOnce(async (deps) => {
      capturedScope = deps.captureAccountScope();
      deps.createClient({ origin: 'https://vault.example', password: 'vault-secret' });
      lifetimeSignal = (mockHttpClient.mock.calls.at(-1)?.[0] as { lifetimeSignal: AbortSignal })
        .lifetimeSignal;
      return lateRun.promise;
    });

    try {
      const first = Promise.resolve(task?.());
      await settleMicrotasks();
      expect(capturedScope?.isCurrent()).toBe(true);
      expect(lifetimeSignal?.aborted).toBe(false);

      jest.advanceTimersByTime(BACKGROUND_CALLBACK_WORK_WINDOW_MS);
      await settleMicrotasks();

      await expect(first).resolves.toBe('failed');
      expect(release).not.toHaveBeenCalled();
      expect(capturedScope?.isCurrent()).toBe(false);
      expect(lifetimeSignal?.aborted).toBe(true);
      expect(mockFlushPersistentLogs).toHaveBeenNthCalledWith(
        1,
        20_000 + BACKGROUND_CALLBACK_FINALIZATION_WINDOW_MS,
      );

      await expect(task?.()).resolves.toBe('failed');
      expect(mockRunBackgroundSync).toHaveBeenCalledTimes(1);

      lateRun.resolve({ result: 'success', reason: 'completed' });
      await settleMicrotasks();
      expect(release).toHaveBeenCalledTimes(1);
      await expect(task?.()).resolves.toBe('success');
      expect(mockRunBackgroundSync).toHaveBeenCalledTimes(2);
    } finally {
      lateRun.resolve({ result: 'success', reason: 'completed' });
      jest.useRealTimers();
    }
  });

  it('does not let the retired legacy toggle authorize a background diagnostic upload', async () => {
    const db = { name: 'db' };
    const client = { name: 'http' };
    const scope = { generation: 9, isCurrent: () => true };
    mockKvGet.mockImplementation(async (_db, key) =>
      key === 'diagnostics.errorReporting' ? '1' : null,
    );
    mockRunBackgroundSync.mockImplementationOnce(async (deps) => {
      await deps.flushDiagnostics(db, client, { supports_error_log_upload: true }, scope);
      return { result: 'success', reason: 'completed' };
    });

    await task?.();

    expect(mockKvGet).toHaveBeenCalledTimes(1);
    expect(mockKvGet).toHaveBeenCalledWith(db, 'diagnostics.errorReportingConsent.v1');
    expect(mockRunErrorReportQueue).not.toHaveBeenCalled();
  });

  it('allows a background diagnostic upload only with an explicit versioned grant', async () => {
    const db = { name: 'db' };
    const client = { name: 'http' };
    const scope = { generation: 9, isCurrent: () => true };
    mockKvGet.mockResolvedValueOnce('granted');
    mockRunBackgroundSync.mockImplementationOnce(async (deps) => {
      await deps.flushDiagnostics(db, client, { supports_error_log_upload: true }, scope);
      return { result: 'success', reason: 'completed' };
    });

    await task?.();

    expect(mockRunErrorReportQueue).toHaveBeenCalledTimes(1);
    expect(mockRunErrorReportQueue).toHaveBeenCalledWith(
      db,
      client,
      expect.any(Number),
      {},
      scope,
      expect.objectContaining({
        isUploadAllowed: expect.any(Function),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('passes explicit page/row caps and a current-account guard to schedule recovery', async () => {
    const db = { name: 'db' };
    const client = { name: 'http' };
    const providerEpoch = `gpe1_${'A'.repeat(43)}`;
    const serverInfo = {
      server_version: '1.9.0',
      private_api: true,
      rcs: true,
      supports_rcs_epoch_qualified_ids: true,
      rcs_provider_epoch: providerEpoch,
      supports_imessage_plain_text: true,
    };
    let scopeCurrent = true;
    const scope = { generation: 9, isCurrent: () => scopeCurrent };
    mockRunBackgroundSync.mockImplementationOnce(async (deps) => {
      await deps.synchronize(db, client, '1.9.0', scope);
      await deps.recoverAndDrainSchedules(db, client, scope, serverInfo);
      await deps.drainOutgoing(db, client, scope, serverInfo);
      return { result: 'success', reason: 'completed' };
    });

    await task?.();

    expect(mockRunBackgroundSync).toHaveBeenCalledWith(
      expect.objectContaining({ wakeBudgetMs: BACKGROUND_WAKE_ADMISSION_BUDGET_MS }),
    );

    expect(mockIncrementalSync).toHaveBeenCalledWith(
      db,
      expect.anything(),
      expect.objectContaining({
        serverVersion: '1.9.0',
        maxPages: BACKGROUND_SYNC_MAX_PAGES,
        shouldAbort: expect.any(Function),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(mockReconcileMessageNotifications).toHaveBeenCalledWith(db, scope);
    expect(mockRunDueScheduled).toHaveBeenCalledWith(
      db,
      client,
      expect.any(Number),
      undefined,
      scope,
      BACKGROUND_SCHEDULE_MAX_ROWS,
      expect.any(Function),
    );
    const capabilitySourceFactory = (
      mockRunDueScheduled.mock.calls[0] as unknown[] | undefined
    )?.[6] as (() => unknown) | undefined;
    expect(capabilitySourceFactory?.()).toEqual({
      kind: 'fixed',
      serverInfo: {
        ...serverInfo,
        private_api: false,
        supports_imessage_text_with_attachment: false,
        supports_icloud_account: false,
      },
    });
    expect(mockRunOutgoingQueue).toHaveBeenCalledWith(
      db,
      client,
      expect.anything(),
      expect.any(Number),
      scope,
      BACKGROUND_OUTGOING_MAX_ROWS,
      expect.any(Number),
      expect.objectContaining({
        allowsLegacyPartZero: true,
        isCurrent: expect.any(Function),
      }),
      expect.any(Function),
      expect.any(AbortSignal),
      expect.any(Function),
      providerEpoch,
      expect.any(Function),
    );
    const attachmentTimeout = (mockRunOutgoingQueue.mock.calls[0] as unknown[] | undefined)?.[6] as
      number | undefined;
    expect(attachmentTimeout).toBeGreaterThan(0);
    expect(attachmentTimeout).toBeLessThanOrEqual(BACKGROUND_CALLBACK_WORK_WINDOW_MS);
    expect(attachmentTimeout).toBeLessThan(BACKGROUND_ATTACHMENT_UPLOAD_TIMEOUT_MS);
    const rcsAvailable = (mockRunOutgoingQueue.mock.calls[0] as unknown[] | undefined)?.[8] as
      ((chatGuid?: string) => boolean) | undefined;
    expect(rcsAvailable?.()).toBe(true);
    expect(rcsAvailable?.(`RCS;-;g1.${providerEpoch}.YQ`)).toBe(true);
    expect(rcsAvailable?.(`RCS;-;g1.gpe1_${'B'.repeat(43)}.YQ`)).toBe(false);
    const locationAvailable = (
      mockRunOutgoingQueue.mock.calls[0] as unknown[] | undefined
    )?.[10] as (() => boolean) | undefined;
    expect(locationAvailable?.()).toBe(false);
    const plainTextAvailable = (
      mockRunOutgoingQueue.mock.calls[0] as unknown[] | undefined
    )?.[12] as ((chatGuid?: string) => boolean) | undefined;
    expect(plainTextAvailable).toEqual(expect.any(Function));
    expect(plainTextAvailable?.()).toBe(true);
    expect(plainTextAvailable?.('iMessage;-;fixture')).toBe(true);
    expect(plainTextAvailable?.('any;-;fixture')).toBe(true);
    expect(plainTextAvailable?.('iMessage;+;group')).toBe(false);
    expect(plainTextAvailable?.('iMessage;-;')).toBe(false);
    expect(plainTextAvailable?.(`RCS;-;g1.${providerEpoch}.YQ`)).toBe(false);
    serverInfo.supports_imessage_plain_text = false;
    expect(plainTextAvailable?.()).toBe(false);
    expect(plainTextAvailable?.('iMessage;-;fixture')).toBe(false);
    serverInfo.supports_imessage_plain_text = true;
    scopeCurrent = false;
    expect(plainTextAvailable?.()).toBe(false);
    expect(plainTextAvailable?.('iMessage;-;fixture')).toBe(false);
  });

  it('keeps task registration idempotent', async () => {
    await expect(registerBackgroundSync()).resolves.toBe('registered');
    expect(mockRegisterTaskAsync).not.toHaveBeenCalled();

    mockIsTaskRegisteredAsync.mockResolvedValueOnce(false);
    await expect(registerBackgroundSync()).resolves.toBe('registered');
    expect(mockRegisterTaskAsync).toHaveBeenCalledWith(BG_SYNC_TASK, { minimumInterval: 15 });
  });

  it('returns an observable unavailable or failed registration status', async () => {
    mockGetStatusAsync.mockResolvedValueOnce('restricted');
    await expect(registerBackgroundSync()).resolves.toBe('unavailable');

    mockGetStatusAsync.mockRejectedValueOnce(new Error('native registration unavailable'));
    await expect(registerBackgroundSync()).resolves.toBe('failed');
  });
});
