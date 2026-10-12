/* eslint-disable import/first -- Jest mocks must be registered before importing their consumers. */
const mockServerInfo = jest.fn(async (): Promise<Record<string, unknown>> => ({
  server_version: '1.9.0',
  supports_message_deleted: true,
}));
const mockGetMessageStateAuthority = jest.fn(async (): Promise<unknown> => null);
const mockSyncMessageState = jest.fn(async (): Promise<void> => undefined);
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
jest.mock('@db/repositories/messageState', () => ({
  ...jest.requireActual('@db/repositories/messageState'),
  getMessageStateAuthority: () => mockGetMessageStateAuthority(),
}));
jest.mock('@/services/sync/messageStateSync', () => ({
  ...jest.requireActual('@/services/sync/messageStateSync'),
  syncMessageState: (...args: unknown[]) => (mockSyncMessageState as jest.Mock)(...args),
}));

import { MessageStateRepairRequiredError } from '@core/api/endpoints/messageState';
import { MessageStateSyncIncompleteError } from '@/services/sync/messageStateSync';
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
      undefined,
      undefined,
      undefined,
      expect.objectContaining({
        server_version: '1.9.0',
        supports_message_deleted: true,
      }),
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

  describe('deleted-message catch-up on a server with message-state sync', () => {
    const epoch = '11111111-1111-4111-8111-111111111111';
    const stateInfo = {
      server_version: '2.0.0',
      supports_message_deleted: true,
      supports_message_state_sync: true,
      message_state_sync_version: 1,
      supports_provider_repair_snapshot: true,
      imessage_provider_epoch: epoch,
    };

    it('uses the legacy catch-up until the app has set up message-state sync', async () => {
      mockServerInfo.mockResolvedValueOnce(stateInfo);
      mockGetMessageStateAuthority.mockResolvedValueOnce(null);

      await expect(
        recoverRealtimePrerequisite(db, { kind: 'sync-account' }, 23, inertTimer()),
      ).resolves.toBe('recovered');
      expect(mockSyncMessageState).not.toHaveBeenCalled();
      expect(mockSyncDeletedMessages).toHaveBeenCalled();
    });

    it.each([
      ['a backlog beyond this push', () => new MessageStateSyncIncompleteError()],
      ['a repair only the app can run', () => new MessageStateRepairRequiredError()],
    ])('still recovers the waiting event when catch-up stops at %s', async (_label, failure) => {
      mockServerInfo.mockResolvedValueOnce(stateInfo);
      mockGetMessageStateAuthority.mockResolvedValueOnce({ providerEpoch: epoch });
      mockSyncMessageState.mockRejectedValueOnce(failure());

      await expect(
        recoverRealtimePrerequisite(db, { kind: 'sync-account' }, 23, inertTimer()),
      ).resolves.toBe('recovered');
      expect(mockSyncMessageState).toHaveBeenCalledWith(
        db,
        expect.anything(),
        expect.objectContaining({
          providerEpoch: epoch,
          maxPages: REALTIME_PREREQUISITE_DELETION_MAX_PAGES,
        }),
      );
      expect(mockSyncDeletedMessages).not.toHaveBeenCalled();
    });
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
