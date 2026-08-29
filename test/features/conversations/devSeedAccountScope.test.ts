import { getDatabase } from '@db/database';
import {
  applyLocalEdit,
  applyLocalUnsend,
  getChatIdByGuid,
  insertOutgoingAttachment,
  insertOutgoingReaction,
  insertOutgoingText,
  listChatsForInbox,
  reconcileOutgoingSuccess,
} from '@db/repositories';
import {
  devEditFake,
  devInjectEffect,
  devInjectIncomingFaceTime,
  devQueueIncomingMessageWithoutDrain,
  devResumeQueuedIncomingMessages,
  devSendFake,
  devSendFakeImage,
  devSendFakeReaction,
  devSendFakeReply,
  devUnsendFake,
  injectMessage,
} from '@features/conversations/devSeed';
import {
  devPersistRealtimeEventWithoutDrain,
  devPush,
  devResumePersistedRealtimeEvents,
} from '@/services/realtimeControl';
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

const mockDb = { __db: true };

jest.mock('@db/database', () => ({ getDatabase: jest.fn(() => mockDb) }));
jest.mock('@db/repositories', () => ({
  applyLocalEdit: jest.fn(async () => undefined),
  applyLocalUnsend: jest.fn(async () => undefined),
  getChatIdByGuid: jest.fn(async () => 7),
  insertOutgoingAttachment: jest.fn(async () => undefined),
  insertOutgoingReaction: jest.fn(async () => undefined),
  insertOutgoingText: jest.fn(async () => undefined),
  listChatsForInbox: jest.fn(async () => []),
  reconcileOutgoingSuccess: jest.fn(async () => undefined),
}));
jest.mock('@/services/realtimeControl', () => ({
  devPush: { inject: jest.fn(async () => undefined) },
  devPersistRealtimeEventWithoutDrain: jest.fn(async () => ({
    pending: 1,
    due: 0,
    leased: 1,
  })),
  devResumePersistedRealtimeEvents: jest.fn(async () => ({ pending: 0, completed: 1 })),
}));
jest.mock('@/services/download', () => ({ setAttachmentFetcher: jest.fn() }));
jest.mock('@/services/download/devFetcher', () => ({ devProgressFetcher: jest.fn() }));
jest.mock('@/services/send/sendService', () => ({
  generateTempGuid: jest.fn(() => 'temp-account-scope'),
}));
jest.mock('@utils/isDev', () => ({ isDevServer: jest.fn(() => true) }));

const mockGetDatabase = getDatabase as jest.Mock;
const mockApplyLocalEdit = applyLocalEdit as jest.Mock;
const mockApplyLocalUnsend = applyLocalUnsend as jest.Mock;
const mockGetChatId = getChatIdByGuid as jest.Mock;
const mockInsertAttachment = insertOutgoingAttachment as jest.Mock;
const mockInsertReaction = insertOutgoingReaction as jest.Mock;
const mockInsertOutgoing = insertOutgoingText as jest.Mock;
const mockListChatsForInbox = listChatsForInbox as jest.Mock;
const mockReconcile = reconcileOutgoingSuccess as jest.Mock;
const mockDevPushInject = devPush.inject as jest.Mock;
const mockDevPersistWithoutDrain = devPersistRealtimeEventWithoutDrain as jest.Mock;
const mockDevResumePersisted = devResumePersistedRealtimeEvents as jest.Mock;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  jest.useFakeTimers();
  resumeRealtimeDeliveries();
  jest.clearAllMocks();
  mockGetDatabase.mockReturnValue(mockDb);
  mockApplyLocalEdit.mockResolvedValue(undefined);
  mockApplyLocalUnsend.mockResolvedValue(undefined);
  mockGetChatId.mockResolvedValue(7);
  mockInsertAttachment.mockResolvedValue(undefined);
  mockInsertReaction.mockResolvedValue(undefined);
  mockInsertOutgoing.mockResolvedValue(undefined);
  mockListChatsForInbox.mockResolvedValue([
    {
      guid: 'c-mom',
      chatIdentifier: 'c-mom',
      displayName: 'Mom',
      style: 45,
      isArchived: false,
      isPinned: false,
      muteType: 0,
    },
  ]);
  mockReconcile.mockResolvedValue(undefined);
  mockDevPersistWithoutDrain.mockResolvedValue({ pending: 1, due: 0, leased: 1 });
  mockDevResumePersisted.mockResolvedValue({ pending: 0, completed: 1 });
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  resumeRealtimeDeliveries();
});

describe('DEV fake sends — account ownership', () => {
  it('does not start immediate edit/unsend writes through a retired screen lease', async () => {
    const accountA = captureRealtimeDeliveryLease();
    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();

    await devEditFake('message-a', 'A-only edit', undefined, accountA);
    await devUnsendFake('message-a', undefined, accountA);

    expect(mockApplyLocalEdit).not.toHaveBeenCalled();
    expect(mockApplyLocalUnsend).not.toHaveBeenCalled();
  });

  it('keeps teardown waiting for an admitted immediate edit write', async () => {
    const editA = deferred();
    mockApplyLocalEdit.mockReturnValueOnce(editA.promise);
    const accountA = captureRealtimeDeliveryLease();
    const write = devEditFake('message-a', 'edited in A', undefined, accountA);
    await Promise.resolve();
    expect(mockApplyLocalEdit).toHaveBeenCalledTimes(1);

    let teardownFinished = false;
    const teardown = pauseRealtimeDeliveries().then(() => {
      teardownFinished = true;
    });
    await Promise.resolve();
    expect(teardownFinished).toBe(false);

    editA.resolve();
    await write;
    await teardown;
    expect(teardownFinished).toBe(true);
  });

  it('drops a delayed text acknowledgement after its account lease is retired', async () => {
    const accountA = captureRealtimeDeliveryLease();
    await devSendFake('chat-a', 'hello', undefined, accountA);
    expect(mockInsertOutgoing).toHaveBeenCalledTimes(1);

    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    await jest.advanceTimersByTimeAsync(700);

    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it('keeps teardown waiting for an admitted delayed reply acknowledgement', async () => {
    const reconcileA = deferred();
    mockReconcile.mockReturnValueOnce(reconcileA.promise);
    const accountA = captureRealtimeDeliveryLease();
    await devSendFakeReply('chat-a', 'reply', 'message-a', undefined, undefined, accountA);

    await jest.advanceTimersByTimeAsync(700);
    expect(mockReconcile).toHaveBeenCalledTimes(1);

    let teardownFinished = false;
    const teardown = pauseRealtimeDeliveries().then(() => {
      teardownFinished = true;
    });
    await Promise.resolve();
    expect(teardownFinished).toBe(false);

    reconcileA.resolve();
    await teardown;
    expect(teardownFinished).toBe(true);
  });

  it('drops a delayed image acknowledgement after its account lease is retired', async () => {
    const accountA = captureRealtimeDeliveryLease();
    await devSendFakeImage('chat-a', accountA);
    expect(mockInsertAttachment).toHaveBeenCalledTimes(1);

    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    await jest.advanceTimersByTimeAsync(700);

    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it('tracks the reaction acknowledgement and preserves its null delivery timestamp', async () => {
    const reconcileA = deferred();
    mockReconcile.mockReturnValueOnce(reconcileA.promise);
    const accountA = captureRealtimeDeliveryLease();
    await devSendFakeReaction('chat-a', 'message-a', 'love', undefined, undefined, accountA);
    expect(mockInsertReaction).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(599);
    expect(mockReconcile).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(mockReconcile).toHaveBeenCalledWith(
      mockDb,
      'temp-account-scope',
      expect.objectContaining({ dateDelivered: null }),
    );

    let teardownFinished = false;
    const teardown = pauseRealtimeDeliveries().then(() => {
      teardownFinished = true;
    });
    await Promise.resolve();
    expect(teardownFinished).toBe(false);

    reconcileA.resolve();
    await teardown;
    expect(teardownFinished).toBe(true);
  });

  it('forwards the screen lease and payload-derived occurrence IDs for dev injections', async () => {
    const accountA = captureRealtimeDeliveryLease();

    await injectMessage(accountA);
    await devInjectIncomingFaceTime(accountA);
    await devInjectEffect('chat-a', accountA);

    expect(mockDevPushInject).toHaveBeenCalledTimes(3);
    for (const call of mockDevPushInject.mock.calls) {
      const payload = call[1] as { guid?: string; uuid?: string };
      const eventId = payload.guid ?? payload.uuid;
      expect(eventId).toEqual(expect.any(String));
      expect(call[2]).toBe(accountA);
      expect(call[3]).toEqual({ transportOccurrenceId: `dev:${eventId}` });
    }
  });

  it('queues a payload through the no-drain proof seam and resumes it with the same lease', async () => {
    const accountA = captureRealtimeDeliveryLease();

    await devQueueIncomingMessageWithoutDrain(accountA);
    await devResumeQueuedIncomingMessages(accountA);

    expect(mockDevPersistWithoutDrain).toHaveBeenCalledWith(
      'new-message',
      expect.objectContaining({
        guid: expect.stringContaining('dev-proof-'),
        text: 'Recovered after process death 🧪',
        handle: { address: '+15551234567', displayName: 'Mom' },
        chats: [expect.objectContaining({ guid: 'c-mom' })],
      }),
      accountA,
      expect.objectContaining({ transportOccurrenceId: expect.stringContaining('dev-proof:') }),
    );
    expect(mockDevResumePersisted).toHaveBeenCalledWith(accountA);
    expect(mockDevPushInject).not.toHaveBeenCalled();
  });

  it('refuses proof staging when the exact seeded fixture chat is absent', async () => {
    mockListChatsForInbox.mockResolvedValueOnce([
      {
        guid: 'residual-chat',
        chatIdentifier: 'residual-chat',
        displayName: 'Residual data',
        style: 43,
        isArchived: false,
        isPinned: true,
        muteType: null,
      },
    ]);
    const accountA = captureRealtimeDeliveryLease();

    await devQueueIncomingMessageWithoutDrain(accountA);

    expect(mockDevPersistWithoutDrain).not.toHaveBeenCalled();
  });

  it('does not queue or resume proof work through a retired account lease', async () => {
    const accountA = captureRealtimeDeliveryLease();
    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();

    await devQueueIncomingMessageWithoutDrain(accountA);
    await devResumeQueuedIncomingMessages(accountA);

    expect(mockDevPersistWithoutDrain).not.toHaveBeenCalled();
    expect(mockDevResumePersisted).not.toHaveBeenCalled();
  });
});
