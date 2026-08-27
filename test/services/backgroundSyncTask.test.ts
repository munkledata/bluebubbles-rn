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

let task: (() => Promise<unknown>) | undefined;

jest.mock('expo-task-manager', () => ({
  defineTask: (_name: string, fn: () => Promise<unknown>) => {
    task = fn;
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
  kvGet: jest.fn(async () => null),
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
  runErrorReportQueue: jest.fn(async () => ({ eligible: 0, uploaded: 0 })),
}));
jest.mock('@/services/logging/fileLogSink', () => ({
  flushPersistentLogsForHeadlessCompletion: mockFlushPersistentLogs,
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
import {
  BACKGROUND_ATTACHMENT_UPLOAD_TIMEOUT_MS,
  BACKGROUND_OUTGOING_MAX_ROWS,
  BACKGROUND_SCHEDULE_MAX_ROWS,
  BACKGROUND_SYNC_MAX_PAGES,
  BACKGROUND_WAKE_ADMISSION_BUDGET_MS,
  BG_SYNC_TASK,
  registerBackgroundSync,
} from '@/services/background/backgroundSync';

beforeEach(() => {
  jest.clearAllMocks();
  mockIsTaskRegisteredAsync.mockResolvedValue(true);
  mockGetStatusAsync.mockResolvedValue('available');
  mockFlushPersistentLogs.mockResolvedValue(true);
  mockRunBackgroundSync.mockResolvedValue({ result: 'success', reason: 'completed' });
  mockRunTrackedRealtimeWork.mockImplementation(async (_scope, run) => {
    await run();
    return 'delivered';
  });
});

describe('the Expo background task adapter', () => {
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
    };
    expect(config.getOrigin()).toBe('https://vault.example');
    expect(config.getPassword()).toBe('vault-secret');
  });

  it('passes explicit page/row caps and a current-account guard to schedule recovery', async () => {
    const db = { name: 'db' };
    const client = { name: 'http' };
    const scope = { generation: 9, isCurrent: () => true };
    mockRunBackgroundSync.mockImplementationOnce(async (deps) => {
      await deps.synchronize(db, client, '1.9.0', scope);
      await deps.recoverAndDrainSchedules(db, client, scope);
      await deps.drainOutgoing(db, client, scope);
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
      }),
    );
    expect(mockRunDueScheduled).toHaveBeenCalledWith(
      db,
      client,
      expect.any(Number),
      undefined,
      scope,
      BACKGROUND_SCHEDULE_MAX_ROWS,
    );
    expect(mockRunOutgoingQueue).toHaveBeenCalledWith(
      db,
      client,
      expect.anything(),
      expect.any(Number),
      scope,
      BACKGROUND_OUTGOING_MAX_ROWS,
      BACKGROUND_ATTACHMENT_UPLOAD_TIMEOUT_MS,
    );
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
