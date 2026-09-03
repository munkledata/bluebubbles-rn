/**
 * Targeted chat repair has a separate serialized/coalesced slot from global sync. Everything below
 * that orchestration boundary is mocked so this suite proves ownership, retry, restore, and idle
 * behavior without claiming real HTTP, SQLite, or device cancellation.
 */
const mockSyncSingleChat = jest.fn();
const mockSyncChatMessageRange = jest.fn();
const mockRestoreDeletedChatWithinTransaction = jest.fn();
const mockChatExistsAndIsVisible = jest.fn();
const mockGetSyncMarker = jest.fn();
const mockSetSyncMarkerWithinTransaction = jest.fn();
const mockCaptureFullRepairPruneExposure = jest.fn();
const mockReconcileFullRepairPruneExposure = jest.fn();
const mockEnsureDatabase = jest.fn();
const mockWithDbTransaction = jest.fn();
const mockCaptureRealtimeDeliveryLease = jest.fn();
const mockSubscribeRealtimeGenerationInvalidation = jest.fn();
const mockHttpSyncApi = jest.fn();
const mockDb = { testId: 'targeted-repair-db' };
const mockApi = { testId: 'targeted-repair-api' };
const mockTransactionContext = { testId: 'targeted-repair-transaction' };
const mockLease = {
  generation: 907,
  current: true,
  isCurrent(): boolean {
    return this.current;
  },
};
const mockInvalidationListeners: (() => void)[] = [];
const mockInvalidationReleases: jest.Mock[] = [];

jest.mock('@core/secure', () => ({ logger: { debug: jest.fn() } }));
jest.mock('@db/database', () => ({ getDatabase: () => ({}) }));
jest.mock('@db/repositories', () => ({
  captureFullRepairPruneExposure: mockCaptureFullRepairPruneExposure,
  chatExistsAndIsVisible: mockChatExistsAndIsVisible,
  getSyncMarker: mockGetSyncMarker,
  reconcileFullRepairPruneExposure: mockReconcileFullRepairPruneExposure,
  restoreDeletedChatWithinTransaction: mockRestoreDeletedChatWithinTransaction,
  setSyncMarkerWithinTransaction: mockSetSyncMarkerWithinTransaction,
}));
jest.mock('@db/transaction', () => ({ withDbTransaction: mockWithDbTransaction }));
jest.mock('@/services/clients', () => ({ http: { testId: 'http-client' } }));
jest.mock('@/services/databaseControl', () => ({ ensureDatabase: mockEnsureDatabase }));
jest.mock('@/services/contacts/contactsService', () => ({ syncContacts: jest.fn() }));
jest.mock('@/services/download/attachmentCacheAccountScope', () => ({
  createAttachmentCacheAccountScope: jest.fn(() => ({ testId: 'attachment-scope' })),
}));
jest.mock('@/services/download/attachmentCacheCoordinator', () => ({
  attachmentCacheCoordinator: {
    retireInactiveEntries: jest.fn(async () => undefined),
    drainDueRetirements: jest.fn(async () => undefined),
  },
}));
jest.mock('@/services/realtime/deliveryCoordinator', () => ({
  captureRealtimeDeliveryLease: mockCaptureRealtimeDeliveryLease,
  subscribeRealtimeGenerationInvalidation: mockSubscribeRealtimeGenerationInvalidation,
}));
jest.mock('@/services/sync', () => ({
  fullSync: jest.fn(),
  httpSyncApi: mockHttpSyncApi,
  incrementalSync: jest.fn(),
  sameFullSyncServerView: jest.fn(),
  syncAllChats: jest.fn(),
  syncChatMessageRange: mockSyncChatMessageRange,
  syncChatMessages: jest.fn(),
  syncDeletedMessages: jest.fn(),
  syncSingleChat: mockSyncSingleChat,
}));

// eslint-disable-next-line import/first
import type { ServerInfo } from '@core/models';
// eslint-disable-next-line import/first
import { useSessionStore } from '@state/sessionStore';
// eslint-disable-next-line import/first
import {
  awaitSyncIdle,
  restoreDeletedChat,
  startChatRepair,
  type ChatRepairResult,
} from '@/services/syncControl';

const SERVER_INFO: ServerInfo = { server_version: '1.9.0' };

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function lastInvalidationListener(): () => void {
  const listener = mockInvalidationListeners.at(-1);
  if (!listener) throw new Error('Expected a targeted-repair invalidation listener');
  return listener;
}

beforeEach(async () => {
  await awaitSyncIdle();
  jest.clearAllMocks();
  mockInvalidationListeners.length = 0;
  mockInvalidationReleases.length = 0;
  mockLease.current = true;
  useSessionStore.getState().reset();
  useSessionStore
    .getState()
    .connected('https://targeted-repair.example.test', 'synthetic-password', SERVER_INFO);

  mockEnsureDatabase.mockResolvedValue(mockDb);
  mockHttpSyncApi.mockReturnValue(mockApi);
  mockCaptureRealtimeDeliveryLease.mockReturnValue(mockLease);
  mockSubscribeRealtimeGenerationInvalidation.mockImplementation(
    (generation: number, listener: () => void) => {
      if (generation !== mockLease.generation)
        throw new Error('Subscribed to the wrong generation');
      const release = jest.fn();
      mockInvalidationListeners.push(listener);
      mockInvalidationReleases.push(release);
      return release;
    },
  );
  mockSyncSingleChat.mockResolvedValue(true);
  mockSyncChatMessageRange.mockResolvedValue({
    messages: 12,
    exhausted: true,
    readFloorCandidate: null,
  });
  mockRestoreDeletedChatWithinTransaction.mockResolvedValue(true);
  mockChatExistsAndIsVisible.mockResolvedValue(false);
  mockWithDbTransaction.mockImplementation(
    async (
      _db: unknown,
      work: (context: typeof mockTransactionContext) => Promise<unknown>,
      canCommit?: () => boolean,
    ): Promise<unknown> => {
      if (canCommit && !canCommit()) throw new Error('Synthetic transaction guard rejected');
      const value = await work(mockTransactionContext);
      if (canCommit && !canCommit()) throw new Error('Synthetic transaction guard rejected');
      return value;
    },
  );
});

it('validates before publishing work and runs one exact bounded repair for concurrent callers', async () => {
  await expect(startChatRepair('   ')).rejects.toThrow('A conversation is required for repair.');
  await expect(restoreDeletedChat('chat-invalid', -1)).rejects.toThrow(
    'The deleted-conversation marker is invalid.',
  );
  expect(mockCaptureRealtimeDeliveryLease).not.toHaveBeenCalled();

  const metadata = deferred<boolean>();
  mockSyncSingleChat.mockReturnValueOnce(metadata.promise);
  const first = startChatRepair('  iMessage;-;synthetic-a  ');
  let coalesced: Promise<ChatRepairResult> | undefined;
  try {
    await flushMicrotasks();
    coalesced = startChatRepair('iMessage;-;synthetic-a');
  } finally {
    metadata.resolve(true);
  }

  if (!coalesced) throw new Error('Expected the concurrent repair to enter the coalescing path');
  expect(coalesced).toBe(first);
  expect(mockSyncSingleChat).toHaveBeenCalledTimes(1);
  await expect(first).resolves.toEqual({ messages: 12, historyExhausted: true, restored: false });
  expect(mockSyncSingleChat).toHaveBeenCalledWith(
    mockDb,
    mockApi,
    'iMessage;-;synthetic-a',
    expect.objectContaining({
      shouldAbort: expect.any(Function),
      signal: expect.any(AbortSignal),
    }),
  );
  expect(mockSyncChatMessageRange).toHaveBeenCalledWith(
    mockDb,
    mockApi,
    'iMessage;-;synthetic-a',
    expect.objectContaining({
      maxMessages: 500,
      probeExhaustion: false,
      readFloorAtOrBefore: undefined,
      shouldAbort: expect.any(Function),
      signal: expect.any(AbortSignal),
    }),
  );
  expect(mockGetSyncMarker).not.toHaveBeenCalled();
  expect(mockSetSyncMarkerWithinTransaction).not.toHaveBeenCalled();
  await awaitSyncIdle();
  expect(mockInvalidationReleases[0]).toHaveBeenCalledTimes(1);
});

it('passes restore proof through one guarded transaction and fails closed after a false fallback', async () => {
  const deletedAt = 1_726_000_000_000;
  const readFloor = { guid: 'synthetic-floor-message', dateCreated: deletedAt - 1 };
  mockSyncChatMessageRange.mockResolvedValue({
    messages: 23,
    exhausted: false,
    readFloorCandidate: readFloor,
  });
  mockRestoreDeletedChatWithinTransaction.mockResolvedValueOnce(false);
  mockChatExistsAndIsVisible.mockResolvedValueOnce(true);

  await expect(restoreDeletedChat('  deleted-chat-a  ', deletedAt)).resolves.toEqual({
    messages: 23,
    historyExhausted: false,
    restored: true,
  });
  expect(mockSyncChatMessageRange).toHaveBeenCalledWith(
    mockDb,
    mockApi,
    'deleted-chat-a',
    expect.objectContaining({
      maxMessages: 500,
      probeExhaustion: true,
      readFloorAtOrBefore: deletedAt,
    }),
  );
  expect(mockWithDbTransaction).toHaveBeenCalledWith(
    mockDb,
    expect.any(Function),
    expect.any(Function),
  );
  expect(mockRestoreDeletedChatWithinTransaction).toHaveBeenCalledWith(mockTransactionContext, {
    guid: 'deleted-chat-a',
    expectedDeletedAt: deletedAt,
    historyExhausted: false,
    repairedReadFloor: readFloor,
  });
  expect(mockChatExistsAndIsVisible).toHaveBeenCalledWith(mockDb, 'deleted-chat-a');

  mockRestoreDeletedChatWithinTransaction.mockResolvedValueOnce(false);
  mockChatExistsAndIsVisible.mockResolvedValueOnce(false);
  await expect(restoreDeletedChat('deleted-chat-b', deletedAt + 1)).rejects.toThrow(
    'could not be restored safely',
  );
  await awaitSyncIdle();
});

it('serializes distinct repairs and keeps the idle barrier closed through the successor', async () => {
  const firstMetadata = deferred<boolean>();
  const secondMetadata = deferred<boolean>();
  const started: string[] = [];
  mockSyncSingleChat.mockImplementation(
    async (_db: unknown, _api: unknown, guid: string): Promise<boolean> => {
      started.push(guid);
      if (guid === 'chat-first') return firstMetadata.promise;
      return secondMetadata.promise;
    },
  );

  const first = startChatRepair('chat-first');
  await flushMicrotasks();
  const second = startChatRepair('chat-second');
  let idle = false;
  const idleWait = awaitSyncIdle().then(() => {
    idle = true;
  });
  try {
    await flushMicrotasks();
    expect(started).toEqual(['chat-first']);
    expect(idle).toBe(false);

    firstMetadata.resolve(true);
    await first;
    await flushMicrotasks();
    expect(started).toEqual(['chat-first', 'chat-second']);
    expect(idle).toBe(false);
  } finally {
    firstMetadata.resolve(true);
    secondMetadata.resolve(true);
  }

  await second;
  await idleWait;
  expect(started).toEqual(['chat-first', 'chat-second']);
  expect(idle).toBe(true);
});

it('generation invalidation aborts the request and prevents history or restore work', async () => {
  const metadata = deferred<boolean>();
  mockSyncSingleChat.mockImplementation(
    async (
      _db: unknown,
      _api: unknown,
      _guid: string,
      options: { shouldAbort: () => boolean; signal: AbortSignal },
    ): Promise<boolean> => {
      await metadata.promise;
      return !options.shouldAbort() && !options.signal.aborted;
    },
  );

  const repair = restoreDeletedChat('deleted-chat-abort', 1_726_000_000_010);
  let options: { shouldAbort: () => boolean; signal: AbortSignal } | undefined;
  try {
    await flushMicrotasks();
    lastInvalidationListener()();
    options = mockSyncSingleChat.mock.calls[0]?.[3] as typeof options;
  } finally {
    metadata.resolve(true);
  }

  expect(options?.signal.aborted).toBe(true);
  expect(options?.shouldAbort()).toBe(true);
  await expect(repair).rejects.toThrow('stopped before the chat was refreshed');
  expect(mockSyncChatMessageRange).not.toHaveBeenCalled();
  expect(mockWithDbTransaction).not.toHaveBeenCalled();
  expect(mockRestoreDeletedChatWithinTransaction).not.toHaveBeenCalled();
  await awaitSyncIdle();
  expect(mockInvalidationReleases[0]).toHaveBeenCalledTimes(1);
});

it('starts fresh work when the same operation retries immediately after awaited success', async () => {
  const first = startChatRepair('retry-after-success');
  const firstResult = await first;
  const retry = startChatRepair('retry-after-success');

  expect(firstResult).toEqual({ messages: 12, historyExhausted: true, restored: false });
  expect(retry).not.toBe(first);
  await expect(retry).resolves.toEqual(firstResult);
  expect(mockSyncSingleChat).toHaveBeenCalledTimes(2);
  await awaitSyncIdle();
});

it('starts fresh work when the same operation retries immediately after caught failure', async () => {
  const failure = new Error('synthetic targeted repair failure');
  mockSyncSingleChat.mockRejectedValueOnce(failure).mockResolvedValueOnce(true);
  const first = startChatRepair('retry-after-failure');
  let caught: unknown;
  let retry: Promise<ChatRepairResult> | undefined;

  try {
    await first;
  } catch (cause) {
    caught = cause;
    // This call must stay directly in the rejected promise's continuation. A derived `.catch()` or
    // Jest `.rejects` chain can give the old downstream cleanup time to run and false-pass the race.
    retry = startChatRepair('retry-after-failure');
  }

  expect(caught).toBe(failure);
  if (!retry) throw new Error('Expected the failed repair to enter the immediate retry path');
  expect(retry).not.toBe(first);
  await expect(retry).resolves.toEqual({
    messages: 12,
    historyExhausted: true,
    restored: false,
  });
  expect(mockSyncSingleChat).toHaveBeenCalledTimes(2);
  await awaitSyncIdle();
});
