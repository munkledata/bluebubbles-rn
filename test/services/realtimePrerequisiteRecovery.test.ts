/* eslint-disable import/first -- Jest mocks must be registered before importing their consumers. */
const mockServerInfo = jest.fn(async () => ({
  server_version: '1.9.0',
  supports_message_deleted: true,
}));
const mockRunTrackedSync = jest.fn((run: () => Promise<void>): Promise<void> => run());
let mockGenerationInvalidation: (() => void) | undefined;
const mockReleaseGenerationInvalidation = jest.fn();
const mockSubscribeGenerationInvalidation = jest.fn(
  (_generation: number, invalidate: () => void) => {
    mockGenerationInvalidation = invalidate;
    return mockReleaseGenerationInvalidation;
  },
);
const mockResolveTransport = jest.fn<Promise<unknown>, [number]>();
const mockHttpSyncApi = jest.fn(() => ({ name: 'sync-api' }));
const mockSyncSingleChat = jest.fn(async () => true);
const mockSyncChatMessages = jest.fn(async () => 0);
const mockSyncAllChats = jest.fn(async () => ({ chats: 0, messages: 0 }));
const mockIncrementalSync = jest.fn(async () => ({ chats: 0, messages: 0 }));
const mockSyncDeletedMessages = jest.fn(async () => ({ deleted: 0 }));

jest.mock('@core/api', () => ({ serverApi: { serverInfo: mockServerInfo } }));
jest.mock('@/services/syncControl', () => ({ runTrackedSync: mockRunTrackedSync }));
jest.mock('@/services/realtime/deliveryCoordinator', () => ({
  subscribeRealtimeGenerationInvalidation: mockSubscribeGenerationInvalidation,
}));
jest.mock('@/services/sync', () => ({
  httpSyncApi: mockHttpSyncApi,
  incrementalSync: mockIncrementalSync,
  syncAllChats: mockSyncAllChats,
  syncChatMessages: mockSyncChatMessages,
  syncDeletedMessages: mockSyncDeletedMessages,
  syncSingleChat: mockSyncSingleChat,
}));
jest.mock('@/services/background/authorizedRealtimeTransport', () => ({
  resolveAuthorizedRealtimeTransport: mockResolveTransport,
}));

import {
  REALTIME_PREREQUISITE_ACCOUNT_MAX_PAGES,
  REALTIME_PREREQUISITE_CHAT_MAX_MESSAGES,
  REALTIME_PREREQUISITE_CHAT_RECOVERY_BUDGET_MS,
  REALTIME_PREREQUISITE_DELETION_MAX_PAGES,
  REALTIME_PREREQUISITE_RECOVERY_BUDGET_MS,
  recoverRealtimePrerequisite,
} from '@/services/background/realtimePrerequisiteRecovery';

const db = { name: 'recovery-db' } as unknown as Parameters<typeof recoverRealtimePrerequisite>[0];
const http = { name: 'recovery-http' };
let current = true;

function transport(): unknown {
  return { http, lease: { isCurrent: () => current } };
}

function inertTimer(): {
  readonly scheduleTimeout: jest.Mock;
  readonly cancelTimeout: jest.Mock;
} {
  const handle = {} as ReturnType<typeof setTimeout>;
  return {
    scheduleTimeout: jest.fn(() => handle),
    cancelTimeout: jest.fn(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGenerationInvalidation = undefined;
  current = true;
  mockResolveTransport.mockResolvedValue(transport());
  mockSyncSingleChat.mockResolvedValue(true);
});

describe('task-local realtime prerequisite recovery', () => {
  it('refreshes one chat before its bounded message backfill', async () => {
    const timer = inertTimer();

    await expect(
      recoverRealtimePrerequisite(db, { kind: 'sync-chat', chatGuid: 'cTarget' }, 17, timer),
    ).resolves.toBe('recovered');

    expect(mockResolveTransport).toHaveBeenCalledWith(17);
    expect(mockSyncSingleChat).toHaveBeenCalledWith(
      db,
      expect.anything(),
      'cTarget',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        shouldAbort: expect.any(Function),
      }),
    );
    expect(mockSyncChatMessages).toHaveBeenCalledWith(
      db,
      expect.anything(),
      'cTarget',
      expect.objectContaining({
        maxMessages: REALTIME_PREREQUISITE_CHAT_MAX_MESSAGES,
        signal: expect.any(AbortSignal),
        shouldAbort: expect.any(Function),
      }),
    );
    expect(mockSyncSingleChat.mock.invocationCallOrder[0]).toBeLessThan(
      mockSyncChatMessages.mock.invocationCallOrder[0]!,
    );
    expect(timer.scheduleTimeout).toHaveBeenCalledWith(
      expect.any(Function),
      REALTIME_PREREQUISITE_CHAT_RECOVERY_BUDGET_MS,
    );
  });

  it('caps account catch-up before bounded deletion recovery', async () => {
    const timer = inertTimer();

    await expect(
      recoverRealtimePrerequisite(db, { kind: 'sync-account' }, 23, timer),
    ).resolves.toBe('recovered');

    expect(mockServerInfo).toHaveBeenCalledWith(http, expect.any(AbortSignal));
    expect(mockSyncAllChats).toHaveBeenCalledWith(
      db,
      expect.anything(),
      200,
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(mockIncrementalSync).toHaveBeenCalledWith(
      db,
      expect.anything(),
      expect.objectContaining({
        serverVersion: '1.9.0',
        maxPages: REALTIME_PREREQUISITE_ACCOUNT_MAX_PAGES,
      }),
    );
    expect(mockSyncDeletedMessages).toHaveBeenCalledWith(
      db,
      expect.anything(),
      expect.objectContaining({
        supported: true,
        maxPages: REALTIME_PREREQUISITE_DELETION_MAX_PAGES,
      }),
    );
    expect(timer.scheduleTimeout).toHaveBeenCalledWith(
      expect.any(Function),
      REALTIME_PREREQUISITE_RECOVERY_BUDGET_MS,
    );
  });

  it('returns at the headless deadline and aborts a transport that arrives late', async () => {
    let resolveTransport!: (value: unknown) => void;
    const delayedTransport = new Promise<unknown>((resolve) => {
      resolveTransport = resolve;
    });
    mockResolveTransport.mockReturnValueOnce(delayedTransport);
    let expire!: () => void;
    const handle = {} as ReturnType<typeof setTimeout>;
    const cancelTimeout = jest.fn();
    const recovery = recoverRealtimePrerequisite(db, { kind: 'sync-deletions' }, 31, {
      scheduleTimeout: (task) => {
        expire = task;
        return handle;
      },
      cancelTimeout,
    });

    await Promise.resolve();
    expire();
    await expect(recovery).resolves.toBe('timed-out');
    resolveTransport(transport());
    await Promise.resolve();
    await Promise.resolve();

    expect(mockServerInfo).not.toHaveBeenCalled();
    expect(mockSyncDeletedMessages).not.toHaveBeenCalled();
    expect(cancelTimeout).toHaveBeenCalledWith(handle);
  });

  it('settles stale immediately when its account generation is invalidated', async () => {
    const neverResolves = new Promise<unknown>(() => undefined);
    mockResolveTransport.mockReturnValueOnce(neverResolves);
    const timer = inertTimer();
    const recovery = recoverRealtimePrerequisite(db, { kind: 'sync-deletions' }, 41, timer);
    await Promise.resolve();
    if (!mockGenerationInvalidation) throw new Error('generation invalidation was not registered');

    mockGenerationInvalidation();

    await expect(recovery).resolves.toBe('stale');
    expect(mockServerInfo).not.toHaveBeenCalled();
    expect(mockReleaseGenerationInvalidation).toHaveBeenCalledTimes(1);
  });

  it('does not publish sync work when the live App Lock policy is closed', async () => {
    const timer = inertTimer();

    await expect(
      recoverRealtimePrerequisite(db, { kind: 'sync-account' }, 47, {
        ...timer,
        isAllowed: () => false,
      }),
    ).resolves.toBe('stale');

    expect(mockRunTrackedSync).not.toHaveBeenCalled();
    expect(mockResolveTransport).not.toHaveBeenCalled();
  });
});
