/**
 * Unit tests for `markUnread` / `markRead` (`src/services/chatActions.ts`).
 *
 * Invariants pinned here:
 *   - the LOCAL flip (read marker cleared) always happens, and happens FIRST;
 *   - a rejecting server call neither throws nor reverts the local flip (best-effort sync);
 *   - RCS read behavior is preserved, while RCS unread never hits the unsupported endpoint;
 *   - iMessage calls require the explicit narrow read-state capability; missing/false fails closed;
 *   - iMessage read also requires a successfully hydrated, enabled read-receipt preference;
 *   - iMessage remote read/unread requests preserve the user's per-chat action order;
 *   - the DB is opened with the lazy `ensureDatabase()`, never the eager `getDatabase()` (this path
 *     is shared with the notification actions, which run with no React tree at all).
 *
 * The DB is REAL (in-memory better-sqlite3 via createTestDb) so the local write is proven
 * against actual repository SQL; everything else (http client, api module, feature store) is
 * mocked at the module boundary like `notificationActions.test.ts`.
 */
import { sql } from 'drizzle-orm';
import { Chat, Message } from '@core/models';
import {
  getChatIdByGuid,
  setLastReadMessageGuid,
  upsertChats,
  upsertChatsWithinTransaction,
  upsertHandles,
  upsertMessages,
  upsertMessagesWithinTransaction,
} from '@db/repositories';
import { runInTransactionContext, withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

// Hoisted jest.mock factories may only reference `mock`-prefixed vars.
let mockDb: AppDatabase;
let mockServerPrivateApiEnabled = true;
let mockServerRcsEnabled = false;
let mockAcceptsRcsChat = true;
const CURRENT_RCS_PROVIDER_EPOCH = `gpe1_${'A'.repeat(43)}`;
const CURRENT_RCS_CHAT_GUID = `RCS;-;g1.${CURRENT_RCS_PROVIDER_EPOCH}.Y29udmVyc2F0aW9u`;
let mockRcsProviderEpoch: string | null = CURRENT_RCS_PROVIDER_EPOCH;
let mockImessageTypingEnabled = false;
let mockImessageReadStateEnabled = false;
let mockSendTypingIndicators = true;
let mockSendReadReceipts = true;
let mockSettingsHydrated = true;
const mockHydrate = jest.fn(async () => {
  mockSettingsHydrated = true;
});
const mockMarkChatUnread = jest.fn<Promise<unknown>, unknown[]>();
const mockMarkChatRead = jest.fn<Promise<unknown>, unknown[]>();

// The EAGER accessor throws on a killed-app wake, so it must never be reached from here.
jest.mock('@db/database', () => ({
  getDatabase: jest.fn(() => {
    throw new Error('Database not initialized — getDatabase must not run in a headless handler');
  }),
}));
/** Leases handed to `accountHttp`; review item 1073 binds requests to the Disconnect signal. */
const mockAccountHttpLeases: Array<{ generation: number; isCurrent(): boolean }> = [];
// The shared client has a different shape, so every `{ __http: true }` assertion below proves the
// request went through the account-bound client.
jest.mock('@/services/clients', () => ({
  http: { __sharedHttp: true },
  accountHttp: (lease: { generation: number; isCurrent(): boolean }) => {
    mockAccountHttpLeases.push(lease);
    return { __http: true };
  },
}));
jest.mock('@/services/databaseControl', () => ({ ensureDatabase: jest.fn(async () => mockDb) }));
jest.mock('@/services/realtimeControl', () => ({ getSocket: jest.fn(() => null) }));
jest.mock('@state/featureSettingsStore', () => ({
  useFeatureSettingsStore: {
    getState: () => ({
      sendTypingIndicators: mockSendTypingIndicators,
      sendReadReceipts: mockSendReadReceipts,
      hydrated: mockSettingsHydrated,
      hydrate: mockHydrate,
    }),
  },
}));
jest.mock('@state/sessionStore', () => ({
  sessionAccessors: {
    privateApiEnabled: () => mockServerPrivateApiEnabled,
    rcsEnabled: () => mockServerRcsEnabled,
    rcsProviderEpoch: () => mockRcsProviderEpoch,
    acceptsRcsChat: () => mockAcceptsRcsChat,
    imessageTypingEnabled: () => mockImessageTypingEnabled,
    imessageReadStateEnabled: () => mockImessageReadStateEnabled,
  },
}));
jest.mock('@core/api', () => ({
  chatsApi: {
    markChatUnread: (...a: unknown[]) => mockMarkChatUnread(...a),
    markChatRead: (...a: unknown[]) => mockMarkChatRead(...a),
  },
}));

import { getDatabase } from '@db/database';
import { ensureDatabase } from '@/services/databaseControl';
import { markRead, markUnread, sendTyping, stopAllTyping } from '@/services/chatActions';
import { getSocket } from '@/services/realtimeControl';
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
import { setChatUnreadLocal } from '../support/repositoryWrappers';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitForCall(mock: jest.Mock): Promise<void> {
  for (let turn = 0; turn < 20 && mock.mock.calls.length === 0; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (mock.mock.calls.length === 0) {
    throw new Error('expected mock call did not start within 20 event-loop turns');
  }
}

async function seedChat(db: AppDatabase, guid: string): Promise<void> {
  const hm = await upsertHandles(db, [{ address: 'a@x.com' }]);
  await upsertChats(db, [Chat.parse({ guid, participants: [{ address: 'a@x.com' }] })], hm);
  await setLastReadMessageGuid(db, guid, 'marker-1'); // start READ
}

const readState = (raw: import('better-sqlite3').Database, guid: string) =>
  raw
    .prepare(
      `SELECT last_read_message_guid AS marker, marked_unread_at AS markedUnreadAt
         FROM chats WHERE guid = ?`,
    )
    .get(guid) as { marker: string | null; markedUnreadAt: number | null };

const readMarker = (raw: import('better-sqlite3').Database, guid: string) =>
  readState(raw, guid).marker;

beforeEach(() => {
  resumeRealtimeDeliveries();
  mockMarkChatUnread.mockReset().mockResolvedValue({});
  mockMarkChatRead.mockReset().mockResolvedValue({});
  mockServerPrivateApiEnabled = true;
  mockServerRcsEnabled = false;
  mockAcceptsRcsChat = true;
  mockRcsProviderEpoch = CURRENT_RCS_PROVIDER_EPOCH;
  mockImessageTypingEnabled = false;
  mockImessageReadStateEnabled = false;
  mockSendTypingIndicators = true;
  mockSendReadReceipts = true;
  mockSettingsHydrated = true;
  mockHydrate.mockReset().mockImplementation(async () => {
    mockSettingsHydrated = true;
  });
  (getSocket as jest.Mock).mockReset().mockReturnValue(null);
  (ensureDatabase as jest.Mock).mockClear();
  (getDatabase as jest.Mock).mockClear();
});

afterEach(() => {
  resumeRealtimeDeliveries();
});

describe('sendTyping', () => {
  it('preserves supported RCS start-typing while skipping unsupported RCS stop-typing', () => {
    const emit = jest.fn();
    (getSocket as jest.Mock).mockReturnValue({ connected: true, emit });
    mockServerPrivateApiEnabled = false;
    mockServerRcsEnabled = true;

    sendTyping('RCS;-;+15551234567', true);
    sendTyping('RCS;-;+15551234567', false);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('start-typing', { guid: 'RCS;-;+15551234567' });
  });

  it('does not emit typing for legacy or stale RCS history', () => {
    const emit = jest.fn();
    (getSocket as jest.Mock).mockReturnValue({ connected: true, emit });
    mockAcceptsRcsChat = false;

    sendTyping('RCS;-;legacy-conversation', true);

    expect(emit).not.toHaveBeenCalled();
  });

  it('does not let stale helper capability restore iMessage typing', () => {
    const emit = jest.fn();
    (getSocket as jest.Mock).mockReturnValue({ connected: true, emit });
    mockServerPrivateApiEnabled = true;

    sendTyping('iMessage;-;+15551234567', true);

    expect(emit).not.toHaveBeenCalled();
  });

  it('sends one start and confirms stop even if capability and preference turn off', async () => {
    const emit = jest.fn();
    const request = jest.fn().mockResolvedValue({
      kind: 'ack',
      response: { status: 200, data: { typing: false } },
    });
    (getSocket as jest.Mock).mockReturnValue({ connected: true, emit, request });
    mockImessageTypingEnabled = true;

    sendTyping('iMessage;-;+15551234567', true);
    mockImessageTypingEnabled = false;
    mockSendTypingIndicators = false;
    sendTyping('iMessage;-;+15551234567', false);
    sendTyping('iMessage;-;+15551234567;-;wrong', true);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('start-typing', {
      guid: 'iMessage;-;+15551234567',
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('stop-typing', {
      guid: 'iMessage;-;+15551234567',
    });
  });

  it('does not queue a stale start while the socket is disconnected', () => {
    const emit = jest.fn();
    const request = jest.fn();
    (getSocket as jest.Mock).mockReturnValue({ connected: false, emit, request });
    mockImessageTypingEnabled = true;

    sendTyping('iMessage;-;+15550000001', true);
    sendTyping('iMessage;-;+15550000001', false);

    expect(emit).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('does not send stop when the typing preference blocked start', () => {
    const emit = jest.fn();
    const request = jest.fn();
    (getSocket as jest.Mock).mockReturnValue({ connected: true, emit, request });
    mockImessageTypingEnabled = true;
    mockSendTypingIndicators = false;

    sendTyping('iMessage;-;+15550000003', true);
    sendTyping('iMessage;-;+15550000003', false);

    expect(emit).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('forgets an admitted start when its account generation is retired', async () => {
    const emit = jest.fn();
    const request = jest.fn();
    (getSocket as jest.Mock).mockReturnValue({ connected: true, emit, request });
    mockImessageTypingEnabled = true;

    sendTyping('iMessage;-;+15550000004', true);
    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    sendTyping('iMessage;-;+15550000004', false);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
  });

  it('retries stop once after no acknowledgement', async () => {
    jest.useFakeTimers();
    try {
      const emit = jest.fn();
      const request = jest
        .fn()
        .mockResolvedValueOnce({ kind: 'no-ack' })
        .mockResolvedValueOnce({
          kind: 'ack',
          response: { status: 200, data: { typing: false } },
        });
      (getSocket as jest.Mock).mockReturnValue({ connected: true, emit, request });
      mockImessageTypingEnabled = true;

      sendTyping('iMessage;-;+15550000002', true);
      sendTyping('iMessage;-;+15550000002', false);
      await Promise.resolve();
      expect(request).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(1_000);
      expect(request).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenNthCalledWith(2, 'stop-typing', {
        guid: 'iMessage;-;+15550000002',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops every still-typing chat on the open socket before a background pause', () => {
    const emit = jest.fn();
    const request = jest.fn().mockResolvedValue({
      kind: 'ack',
      response: { status: 200, data: { typing: false } },
    });
    (getSocket as jest.Mock).mockReturnValue({ connected: true, emit, request });
    mockImessageTypingEnabled = true;

    sendTyping('iMessage;-;+15550000010', true);
    sendTyping('iMessage;-;+15550000011', true);
    sendTyping('iMessage;-;+15550000012', true);
    sendTyping('iMessage;-;+15550000012', false); // already stopped by the composer
    request.mockClear();

    stopAllTyping();

    // Synchronous: both stops were handed to the socket before stopAllTyping returned, so a pause
    // that closes the socket right after cannot swallow them.
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith('stop-typing', { guid: 'iMessage;-;+15550000010' });
    expect(request).toHaveBeenCalledWith('stop-typing', { guid: 'iMessage;-;+15550000011' });

    // The composer's late stop timer, and a second flush, have nothing left to send.
    request.mockClear();
    sendTyping('iMessage;-;+15550000010', false);
    stopAllTyping();
    expect(request).not.toHaveBeenCalled();
  });

  it('does not flush a stop for a typing chat whose account generation was retired', async () => {
    const emit = jest.fn();
    const request = jest.fn();
    (getSocket as jest.Mock).mockReturnValue({ connected: true, emit, request });
    mockImessageTypingEnabled = true;

    sendTyping('iMessage;-;+15550000013', true);
    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    stopAllTyping();

    expect(request).not.toHaveBeenCalled();
  });
});

describe('markUnread', () => {
  it('clears the local marker before syncing a capable iMessage server', async () => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    mockAccountHttpLeases.length = 0;
    const guid = 'iMessage;-;+15551234567';
    await seedChat(db, guid);
    mockImessageReadStateEnabled = true;
    let markerAtRemote: string | null | undefined;
    mockMarkChatUnread.mockImplementationOnce(async () => {
      markerAtRemote = readMarker(raw, guid);
      return {};
    });

    await markUnread(guid);

    expect(readMarker(raw, guid)).toBeNull();
    expect(markerAtRemote).toBeNull();
    expect(mockMarkChatUnread).toHaveBeenCalledWith({ __http: true }, guid);
    // Bound to this account's Disconnect cancellation (review item 1073).
    expect(mockAccountHttpLeases).toHaveLength(1);
    expect(mockAccountHttpLeases[0]?.generation).toBe(captureRealtimeDeliveryLease().generation);
    expect(mockAccountHttpLeases[0]?.isCurrent()).toBe(true);
  });

  it('keeps the local unread marker when the capable server call fails', async () => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    const guid = 'iMessage;-;+15551234567';
    await seedChat(db, guid);
    mockImessageReadStateEnabled = true;
    mockMarkChatUnread.mockRejectedValue(new Error('offline'));

    await expect(markUnread(guid)).resolves.toBeUndefined();

    expect(mockMarkChatUnread).toHaveBeenCalledWith({ __http: true }, guid);
    expect(readMarker(raw, guid)).toBeNull(); // local flip kept
  });

  it('updates locally at once but preserves remote order when a later action becomes ready first', async () => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    const guid = 'iMessage;-;+15551234567';
    await seedChat(db, guid);
    await setChatUnreadLocal(db, guid, 1_000);
    mockImessageReadStateEnabled = true;
    mockSettingsHydrated = false;
    const releaseHydration = deferred<void>();
    const releaseRead = deferred<void>();
    const remoteOrder: string[] = [];
    mockHydrate.mockImplementationOnce(async () => {
      await releaseHydration.promise;
      mockSettingsHydrated = true;
    });
    mockMarkChatRead.mockImplementationOnce(async () => {
      remoteOrder.push('read:start');
      await releaseRead.promise;
      remoteOrder.push('read:end');
      return {};
    });
    mockMarkChatUnread.mockImplementationOnce(async () => {
      remoteOrder.push('unread');
      return {};
    });

    const read = markRead(guid);
    await waitForCall(mockHydrate);
    expect(readState(raw, guid).markedUnreadAt).toBeNull();

    const unread = markUnread(guid);
    for (let turn = 0; turn < 20 && readState(raw, guid).markedUnreadAt === null; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(readState(raw, guid).markedUnreadAt).not.toBeNull();
    expect(mockMarkChatUnread).not.toHaveBeenCalled();
    expect(mockMarkChatRead).not.toHaveBeenCalled();

    releaseHydration.resolve();
    await waitForCall(mockMarkChatRead);
    expect(remoteOrder).toEqual(['read:start']);
    expect(mockMarkChatUnread).not.toHaveBeenCalled();

    releaseRead.resolve();
    await Promise.all([unread, read]);

    expect(remoteOrder).toEqual(['read:start', 'read:end', 'unread']);
    expect(readState(raw, guid).markedUnreadAt).not.toBeNull();
  });

  it('keeps the tap timestamp while waiting behind a rolling-back transaction', async () => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    const guid = 'iMessage;-;+15551234567';
    await seedChat(db, guid);

    const neighbourReady = deferred<void>();
    const releaseNeighbour = deferred<void>();
    const neighbour = withDbTransaction(db, async () => {
      neighbourReady.resolve();
      await releaseNeighbour.promise;
      throw new Error('mark-unread neighbour rollback');
    });
    const neighbourFailure = expect(neighbour).rejects.toThrow('mark-unread neighbour rollback');
    await neighbourReady.promise;

    const now = jest.spyOn(Date, 'now').mockReturnValue(4_000);
    let action: Promise<void> | undefined;
    try {
      let actionSettled = false;
      action = markUnread(guid);
      void action.then(
        () => {
          actionSettled = true;
        },
        () => {
          actionSettled = true;
        },
      );
      await waitForCall(ensureDatabase as jest.Mock);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(actionSettled).toBe(false);
      expect(readState(raw, guid)).toEqual({ marker: 'marker-1', markedUnreadAt: null });
      expect(mockMarkChatUnread).not.toHaveBeenCalled();
      now.mockReturnValue(9_000);

      releaseNeighbour.resolve();
      await neighbourFailure;
      await expect(action).resolves.toBeUndefined();

      expect(readState(raw, guid)).toEqual({ marker: null, markedUnreadAt: 4_000 });
      expect(mockMarkChatUnread).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
      releaseNeighbour.resolve();
      await Promise.allSettled([neighbour, action ?? Promise.resolve()]);
    }
  });

  it('rolls back both unread fields when account ownership changes during the update', async () => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    mockSettingsHydrated = false;
    const guid = 'iMessage;-;+15551234567';
    await seedChat(db, guid);

    let drain: Promise<void> | undefined;
    raw.function('pause_mark_unread_during_update', () => {
      drain = pauseRealtimeDeliveries();
      return 0;
    });
    raw.exec(`
      CREATE TRIGGER pause_mark_unread_during_update
      AFTER UPDATE OF last_read_message_guid, marked_unread_at ON chats
      BEGIN
        SELECT pause_mark_unread_during_update();
      END
    `);

    const action = markUnread(guid);
    try {
      await expect(action).resolves.toBeUndefined();
      if (!drain) throw new Error('mark-unread update did not revoke the account lease');
      await drain;
    } finally {
      resumeRealtimeDeliveries();
    }

    expect(readState(raw, guid)).toEqual({ marker: 'marker-1', markedUnreadAt: null });
    expect(mockHydrate).not.toHaveBeenCalled();
    expect(mockMarkChatUnread).not.toHaveBeenCalled();
  });

  it('RCS chats flip locally but SKIP the server call entirely', async () => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    const guid = CURRENT_RCS_CHAT_GUID;
    await seedChat(db, guid);

    await markUnread(guid);

    expect(readMarker(raw, guid)).toBeNull();
    expect(mockMarkChatUnread).not.toHaveBeenCalled();
  });

  it('opens the DB with the LAZY ensureDatabase(), never getDatabase() (headless safety)', async () => {
    const { db } = await createTestDb();
    mockDb = db;
    const guid = 'iMessage;-;+15551234567';
    await seedChat(db, guid);

    await markUnread(guid);

    expect(ensureDatabase).toHaveBeenCalledTimes(1);
    expect(getDatabase).not.toHaveBeenCalled();
  });

  it('fails closed on a missing narrow server capability', async () => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    const guid = 'iMessage;-;+15551234567';
    await seedChat(db, guid);
    mockImessageReadStateEnabled = false;

    await markUnread(guid);

    expect(mockMarkChatUnread).not.toHaveBeenCalled();
    expect(readMarker(raw, guid)).toBeNull(); // the local flip still lands
  });

  it('keeps an oversized iMessage identifier local even when the capability is on', async () => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    const guid = `iMessage;-;${'a'.repeat(1_025)}`;
    await seedChat(db, guid);
    mockImessageReadStateEnabled = true;

    await markUnread(guid);

    expect(readMarker(raw, guid)).toBeNull();
    expect(mockMarkChatUnread).not.toHaveBeenCalled();
  });

  it('does not consult the read-receipt preference when syncing unread state', async () => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    const guid = 'iMessage;-;+15551234567';
    await seedChat(db, guid);
    mockSettingsHydrated = false;
    mockSendReadReceipts = false;
    mockImessageReadStateEnabled = true;

    await markUnread(guid);

    expect(mockSettingsHydrated).toBe(false);
    expect(mockHydrate).not.toHaveBeenCalled();
    expect(readMarker(raw, guid)).toBeNull();
    expect(mockMarkChatUnread).toHaveBeenCalledWith({ __http: true }, guid);
  });

  it('uses the narrow capability independently of retired Private API', async () => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    const guid = 'iMessage;-;+15551234567';
    await seedChat(db, guid);
    mockServerPrivateApiEnabled = false;
    mockImessageReadStateEnabled = true;

    await markUnread(guid);

    expect(readMarker(raw, guid)).toBeNull();
    expect(mockMarkChatUnread).toHaveBeenCalledWith({ __http: true }, guid);
  });
});

describe('markRead', () => {
  it.each([
    ['queued', 'disabled'],
    ['queued', 'unhydrated'],
    ['transport', 'disabled'],
    ['transport', 'unhydrated'],
  ])('keeps the local read when receipts become %s / %s before dispatch', async (wait, change) => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    const guid = 'iMessage;-;privacy-race@example.test';
    await seedChat(db, guid);
    mockImessageReadStateEnabled = true;
    const blocked = deferred<unknown>();
    mockMarkChatUnread.mockImplementationOnce(() => blocked.promise);
    const predecessor = markUnread(guid);
    await waitForCall(mockMarkChatUnread);
    const transport = deferred<void>();
    const resolveReceiptTransport = jest.fn(async () => {
      if (wait === 'transport') await transport.promise;
      return { http: { __http: true } as never, isCurrent: () => true };
    });
    const read = markRead(guid, undefined, { resolveReceiptTransport });
    await waitForCall(resolveReceiptTransport);
    expect(readState(raw, guid).markedUnreadAt).toBeNull();

    if (change === 'disabled') mockSendReadReceipts = false;
    else mockSettingsHydrated = false;
    transport.resolve();
    blocked.resolve({});
    await Promise.all([predecessor, read]);

    expect(mockMarkChatRead).not.toHaveBeenCalled();
    expect(readState(raw, guid).markedUnreadAt).toBeNull();
  });

  it('preserves killed-process RCS reads before session ServerInfo has hydrated', async () => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    const guid = CURRENT_RCS_CHAT_GUID;
    const hm = await upsertHandles(db, [{ address: 'a@x.com' }]);
    await upsertChats(db, [Chat.parse({ guid, participants: [{ address: 'a@x.com' }] })], hm);
    const chatId = (await getChatIdByGuid(db, guid))!;
    await upsertMessages(
      db,
      [Message.parse({ guid: 'rcs-m1', text: 'hi', isFromMe: false, dateCreated: 1000 })],
      () => chatId,
      hm,
    );
    mockServerPrivateApiEnabled = false;
    mockServerRcsEnabled = false;
    mockRcsProviderEpoch = null;
    const killedProcessHttp = { __http: 'vault' } as never;
    const resolveReceiptTransport = jest.fn(async () => ({
      http: killedProcessHttp,
      isCurrent: () => true,
      rcsProviderEpoch: CURRENT_RCS_PROVIDER_EPOCH,
      acceptsRcsChat: () => true,
    }));

    await markRead(guid, undefined, { resolveReceiptTransport });

    expect(readMarker(raw, guid)).toBe('rcs-m1');
    expect(resolveReceiptTransport).toHaveBeenCalledTimes(1);
    expect(mockMarkChatRead).toHaveBeenCalledWith(killedProcessHttp, guid);
  });

  it.each([
    { capability: true, sends: true },
    { capability: false, sends: false },
    { capability: undefined, sends: false },
  ])(
    'a killed-process iMessage read follows its own server answer ($capability → receipt $sends)',
    async ({ capability, sends }) => {
      const { db, raw } = await createTestDb();
      mockDb = db;
      const guid = 'iMessage;-;+15551234567';
      const hm = await upsertHandles(db, [{ address: 'a@x.com' }]);
      await upsertChats(db, [Chat.parse({ guid, participants: [{ address: 'a@x.com' }] })], hm);
      const chatId = (await getChatIdByGuid(db, guid))!;
      await upsertMessages(
        db,
        [
          Message.parse({
            guid: 'imessage-killed',
            text: 'hi',
            isFromMe: false,
            dateCreated: 1000,
          }),
        ],
        () => chatId,
        hm,
      );
      // A killed-app wake never hydrates the session, so the session capability reads as absent.
      mockImessageReadStateEnabled = false;
      const killedProcessHttp = { __http: 'vault' } as never;
      const resolveReceiptTransport = jest.fn(async () => ({
        http: killedProcessHttp,
        isCurrent: () => true,
        ...(capability === undefined ? {} : { imessageReadStateEnabled: capability }),
      }));

      await markRead(guid, undefined, { resolveReceiptTransport });

      expect(readMarker(raw, guid)).toBe('imessage-killed');
      expect(resolveReceiptTransport).toHaveBeenCalledTimes(1);
      expect(mockMarkChatRead.mock.calls).toEqual(sends ? [[killedProcessHttp, guid]] : []);
    },
  );

  it('never resolves a killed-process iMessage transport while read receipts are off', async () => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    const guid = 'iMessage;-;+15551234567';
    await seedChat(db, guid);
    mockSendReadReceipts = false;
    const resolveReceiptTransport = jest.fn(async () => ({
      http: { __http: 'vault' } as never,
      isCurrent: () => true,
      imessageReadStateEnabled: true,
    }));

    await markRead(guid, undefined, { resolveReceiptTransport });

    expect(readMarker(raw, guid)).toBeNull();
    expect(resolveReceiptTransport).not.toHaveBeenCalled();
    expect(mockMarkChatRead).not.toHaveBeenCalled();
  });

  it('commits an RCS read locally but sends no receipt while provider authority is revoked', async () => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    const guid = CURRENT_RCS_CHAT_GUID;
    const hm = await upsertHandles(db, [{ address: 'a@x.com' }]);
    await upsertChats(db, [Chat.parse({ guid, participants: [{ address: 'a@x.com' }] })], hm);
    const chatId = (await getChatIdByGuid(db, guid))!;
    await upsertMessages(
      db,
      [Message.parse({ guid: 'rcs-current', text: 'hi', isFromMe: false, dateCreated: 1000 })],
      () => chatId,
      hm,
    );
    await setLastReadMessageGuid(db, guid, 'previous-marker');
    let providerCurrent = true;
    raw.function('rotate_provider_during_mark_read', () => {
      // The Google pairing rotates while the local marker is written, and stays rotated.
      providerCurrent = false;
      return 0;
    });
    raw.exec(`
      CREATE TRIGGER rotate_provider_during_mark_read
      AFTER UPDATE OF last_read_message_guid ON chats
      BEGIN
        SELECT rotate_provider_during_mark_read();
      END
    `);
    const resolveReceiptTransport = jest.fn(async () => ({
      http: { __http: 'provider-rotation' } as never,
      isCurrent: () => providerCurrent,
      rcsProviderEpoch: CURRENT_RCS_PROVIDER_EPOCH,
      acceptsRcsChat: () => providerCurrent,
    }));

    await expect(markRead(guid, undefined, { resolveReceiptTransport })).resolves.toBeUndefined();

    // The read marker is local state and commits; the receipt needs current pairing authority.
    expect(readMarker(raw, guid)).toBe('rcs-current');
    expect(mockMarkChatRead).not.toHaveBeenCalled();
  });

  it('clears the local badge before syncing a capable iMessage read', async () => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    const guid = 'iMessage;-;+15551234567';
    const hm = await upsertHandles(db, [{ address: 'a@x.com' }]);
    await upsertChats(db, [Chat.parse({ guid, participants: [{ address: 'a@x.com' }] })], hm);
    const chatId = (await getChatIdByGuid(db, guid))!;
    await upsertMessages(
      db,
      [Message.parse({ guid: 'imessage-m1', text: 'hi', isFromMe: false, dateCreated: 1000 })],
      () => chatId,
      hm,
    );
    mockImessageReadStateEnabled = true;
    let markerAtRemote: string | null | undefined;
    mockMarkChatRead.mockImplementationOnce(async () => {
      markerAtRemote = readMarker(raw, guid);
      return {};
    });

    await markRead(guid);

    expect(readMarker(raw, guid)).toBe('imessage-m1');
    expect(markerAtRemote).toBe('imessage-m1');
    expect(mockMarkChatRead).toHaveBeenCalledWith({ __http: true }, guid);
  });

  it('keeps an iMessage read local when the narrow capability is absent', async () => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    const guid = 'iMessage;-;+15551234567';
    const hm = await upsertHandles(db, [{ address: 'a@x.com' }]);
    await upsertChats(db, [Chat.parse({ guid, participants: [{ address: 'a@x.com' }] })], hm);
    const chatId = (await getChatIdByGuid(db, guid))!;
    await upsertMessages(
      db,
      [Message.parse({ guid: 'imessage-no-cap', text: 'hi', isFromMe: false, dateCreated: 1000 })],
      () => chatId,
      hm,
    );

    await markRead(guid);

    expect(readMarker(raw, guid)).toBe('imessage-no-cap');
    expect(mockHydrate).not.toHaveBeenCalled();
    expect(mockMarkChatRead).not.toHaveBeenCalled();
  });

  it('keeps an iMessage read local when persisted receipts are off', async () => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    const guid = 'iMessage;-;+15551234567';
    const hm = await upsertHandles(db, [{ address: 'a@x.com' }]);
    await upsertChats(db, [Chat.parse({ guid, participants: [{ address: 'a@x.com' }] })], hm);
    const chatId = (await getChatIdByGuid(db, guid))!;
    await upsertMessages(
      db,
      [Message.parse({ guid: 'imessage-local', text: 'hi', isFromMe: false, dateCreated: 1000 })],
      () => chatId,
      hm,
    );
    mockImessageReadStateEnabled = true;
    mockSendReadReceipts = false;

    await markRead(guid);

    expect(readMarker(raw, guid)).toBe('imessage-local');
    expect(mockMarkChatRead).not.toHaveBeenCalled();
  });

  it('advances the marker via the LAZY ensureDatabase() — the killed-app tray button path', async () => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    const guid = CURRENT_RCS_CHAT_GUID;
    const hm = await upsertHandles(db, [{ address: 'a@x.com' }]);
    await upsertChats(db, [Chat.parse({ guid, participants: [{ address: 'a@x.com' }] })], hm);
    const chatId = (await getChatIdByGuid(db, guid))!;
    await upsertMessages(
      db,
      [Message.parse({ guid: 'm1', text: 'hi', isFromMe: false, dateCreated: 1000 })],
      () => chatId,
      hm,
    );

    await markRead(guid);

    expect(ensureDatabase).toHaveBeenCalledTimes(1);
    expect(getDatabase).not.toHaveBeenCalled(); // would THROW on a headless wake
    expect(readMarker(raw, guid)).toBe('m1');
    expect(mockMarkChatRead).toHaveBeenCalledWith({ __http: true }, guid);
  });

  it('hydrates the settings first, so a user who turned read receipts off sends none', async () => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    const guid = CURRENT_RCS_CHAT_GUID;
    const hm = await upsertHandles(db, [{ address: 'a@x.com' }]);
    await upsertChats(db, [Chat.parse({ guid, participants: [{ address: 'a@x.com' }] })], hm);
    const chatId = (await getChatIdByGuid(db, guid))!;
    await upsertMessages(
      db,
      [Message.parse({ guid: 'm1', text: 'hi', isFromMe: false, dateCreated: 1000 })],
      () => chatId,
      hm,
    );
    mockSettingsHydrated = false;
    mockHydrate.mockImplementationOnce(async () => {
      mockSettingsHydrated = true;
      mockSendReadReceipts = false;
    });

    await markRead(guid);

    expect(mockHydrate).toHaveBeenCalledTimes(1);
    expect(mockMarkChatRead).not.toHaveBeenCalled();
    expect(readMarker(raw, guid)).toBe('m1'); // own badge still clears
  });

  it('keeps the local read marker and never resolves a client when hydration fails closed', async () => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    const guid = 'iMessage;-;+15551234567';
    const hm = await upsertHandles(db, [{ address: 'a@x.com' }]);
    await upsertChats(db, [Chat.parse({ guid, participants: [{ address: 'a@x.com' }] })], hm);
    const chatId = (await getChatIdByGuid(db, guid))!;
    await upsertMessages(
      db,
      [Message.parse({ guid: 'm-fail-closed', text: 'hi', isFromMe: false, dateCreated: 1000 })],
      () => chatId,
      hm,
    );
    mockImessageReadStateEnabled = true;
    mockSettingsHydrated = false;
    mockHydrate.mockImplementationOnce(async () => undefined);
    const resolveReceiptTransport = jest.fn(async () => null);

    await markRead(guid, undefined, { resolveReceiptTransport });

    expect(mockSettingsHydrated).toBe(false);
    expect(readMarker(raw, guid)).toBe('m-fail-closed');
    expect(resolveReceiptTransport).not.toHaveBeenCalled();
    expect(mockMarkChatRead).not.toHaveBeenCalled();
  });

  it('keeps an iMessage read local when persisted settings cannot be read', async () => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    const guid = 'iMessage;-;+15551234567';
    const hm = await upsertHandles(db, [{ address: 'a@x.com' }]);
    await upsertChats(db, [Chat.parse({ guid, participants: [{ address: 'a@x.com' }] })], hm);
    const chatId = (await getChatIdByGuid(db, guid))!;
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'imessage-unreadable',
          text: 'hi',
          isFromMe: false,
          dateCreated: 1000,
        }),
      ],
      () => chatId,
      hm,
    );
    mockImessageReadStateEnabled = true;
    mockSettingsHydrated = false;
    mockHydrate.mockRejectedValueOnce(new Error('settings unavailable'));

    await expect(markRead(guid)).resolves.toBeUndefined();

    expect(readMarker(raw, guid)).toBe('imessage-unreadable');
    expect(mockMarkChatRead).not.toHaveBeenCalled();
  });

  it('is a no-op for a chat this device has never seen', async () => {
    const { db } = await createTestDb();
    mockDb = db;
    mockSettingsHydrated = false;

    await markRead('iMessage;-;+19999999999');

    expect(mockHydrate).not.toHaveBeenCalled();
    expect(mockMarkChatRead).not.toHaveBeenCalled();
  });

  it('still sends a receipt for a known chat with no received message', async () => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    mockSettingsHydrated = false;
    const guid = CURRENT_RCS_CHAT_GUID;
    const hm = await upsertHandles(db, [{ address: 'a@x.com' }]);
    await upsertChats(db, [Chat.parse({ guid, participants: [{ address: 'a@x.com' }] })], hm);
    await setChatUnreadLocal(db, guid, 1_000);

    expect(readState(raw, guid)).toEqual({ marker: null, markedUnreadAt: 1_000 });

    await markRead(guid);

    expect(readState(raw, guid)).toEqual({ marker: null, markedUnreadAt: null });
    expect(mockHydrate).toHaveBeenCalledTimes(1);
    expect(mockMarkChatRead).toHaveBeenCalledWith({ __http: true }, guid);
  });

  it('clears a legacy RCS badge locally even when killed-process authorization is unavailable', async () => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    const guid = 'RCS;-;+15551234567';
    const hm = await upsertHandles(db, [{ address: 'a@x.com' }]);
    await upsertChats(db, [Chat.parse({ guid, participants: [{ address: 'a@x.com' }] })], hm);
    const chatId = (await getChatIdByGuid(db, guid))!;
    await upsertMessages(
      db,
      [Message.parse({ guid: 'm-local', text: 'hi', isFromMe: false, dateCreated: 1000 })],
      () => chatId,
      hm,
    );
    let markerAtResolution: string | null = null;
    const resolveReceiptTransport = jest.fn(async () => {
      markerAtResolution = readMarker(raw, guid);
      throw new Error('SecureStore unavailable');
    });

    await expect(markRead(guid, undefined, { resolveReceiptTransport })).resolves.toBeUndefined();

    // The marker is written before (and without) any server authority; only the receipt needs it.
    expect(readMarker(raw, guid)).toBe('m-local');
    expect(markerAtResolution).toBe('m-local');
    expect(resolveReceiptTransport).toHaveBeenCalledTimes(1);
    expect(mockMarkChatRead).not.toHaveBeenCalled();
  });

  it('waits out a rolling-back replacement before choosing the committed newest message', async () => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    mockSettingsHydrated = false;
    const guid = CURRENT_RCS_CHAT_GUID;
    const hm = await upsertHandles(db, [{ address: 'a@x.com' }]);
    const chatIds = await upsertChats(
      db,
      [Chat.parse({ guid, participants: [{ address: 'a@x.com' }] })],
      hm,
    );
    const committedChatId = chatIds.get(guid)!;
    await upsertMessages(
      db,
      [Message.parse({ guid: 'committed-newest', text: 'real', isFromMe: false, dateCreated: 1 })],
      () => committedChatId,
      hm,
    );
    await setLastReadMessageGuid(db, guid, 'previous-marker');

    const replacementReady = deferred<void>();
    const releaseReplacement = deferred<void>();
    const replacement = withDbTransaction(db, async (context) => {
      await runInTransactionContext(context, async (transactionDb) => {
        await transactionDb.run(sql`DELETE FROM chats WHERE guid = ${guid}`);
      });
      const replacementIds = await upsertChatsWithinTransaction(
        context,
        [Chat.parse({ guid, participants: [{ address: 'a@x.com' }] })],
        hm,
      );
      const replacementChatId = replacementIds.get(guid);
      if (replacementChatId == null) throw new Error('replacement chat was not inserted');
      await upsertMessagesWithinTransaction(
        context,
        [
          Message.parse({
            guid: 'rolled-back-phantom',
            text: 'phantom',
            isFromMe: false,
            dateCreated: 2,
          }),
        ],
        () => replacementChatId,
        hm,
      );
      replacementReady.resolve();
      await releaseReplacement.promise;
      throw new Error('replacement rollback');
    });
    const replacementFailure = expect(replacement).rejects.toThrow('replacement rollback');
    await replacementReady.promise;

    let actionSettled = false;
    const action = markRead(guid);
    void action.then(
      () => {
        actionSettled = true;
      },
      () => {
        actionSettled = true;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(actionSettled).toBe(false);
    expect(mockHydrate).not.toHaveBeenCalled();
    expect(mockMarkChatRead).not.toHaveBeenCalled();

    releaseReplacement.resolve();
    await replacementFailure;
    await expect(action).resolves.toBeUndefined();

    expect(readMarker(raw, guid)).toBe('committed-newest');
    expect(mockHydrate).toHaveBeenCalledTimes(1);
    expect(mockMarkChatRead).toHaveBeenCalledWith({ __http: true }, guid);
  });

  it('rolls back the marker when account ownership changes during its update', async () => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    mockSettingsHydrated = false;
    const guid = 'iMessage;-;+15551234567';
    const hm = await upsertHandles(db, [{ address: 'a@x.com' }]);
    const chatIds = await upsertChats(
      db,
      [Chat.parse({ guid, participants: [{ address: 'a@x.com' }] })],
      hm,
    );
    const chatId = chatIds.get(guid)!;
    await upsertMessages(
      db,
      [Message.parse({ guid: 'new-marker', text: 'new', isFromMe: false, dateCreated: 2 })],
      () => chatId,
      hm,
    );
    await setLastReadMessageGuid(db, guid, 'previous-marker');

    let drain: Promise<void> | undefined;
    raw.function('pause_mark_read_during_update', () => {
      drain = pauseRealtimeDeliveries();
      return 0;
    });
    raw.exec(`
      CREATE TRIGGER pause_mark_read_during_update
      AFTER UPDATE OF last_read_message_guid ON chats
      BEGIN
        SELECT pause_mark_read_during_update();
      END
    `);

    const action = markRead(guid);
    try {
      await expect(action).resolves.toBeUndefined();
      if (!drain) throw new Error('mark-read update did not revoke the account lease');
      await drain;
    } finally {
      resumeRealtimeDeliveries();
    }

    expect(readMarker(raw, guid)).toBe('previous-marker');
    expect(mockHydrate).not.toHaveBeenCalled();
    expect(mockMarkChatRead).not.toHaveBeenCalled();
  });

  it('keeps teardown waiting for a read receipt and disowns its late A-account completion', async () => {
    const accountA = await createTestDb();
    const accountB = await createTestDb();
    const guid = CURRENT_RCS_CHAT_GUID;
    mockDb = accountA.db;

    for (const { db, messageGuid } of [
      { db: accountA.db, messageGuid: 'a-newest' },
      { db: accountB.db, messageGuid: 'b-newest' },
    ]) {
      const hm = await upsertHandles(db, [{ address: 'a@x.com' }]);
      await upsertChats(db, [Chat.parse({ guid, participants: [{ address: 'a@x.com' }] })], hm);
      const chatId = (await getChatIdByGuid(db, guid))!;
      await upsertMessages(
        db,
        [Message.parse({ guid: messageGuid, text: 'hi', isFromMe: false, dateCreated: 1000 })],
        () => chatId,
        hm,
      );
    }
    // Give B a sentinel marker that an old same-guid action must never advance or clear.
    await setLastReadMessageGuid(accountB.db, guid, 'b-sentinel');

    const server = deferred<unknown>();
    mockMarkChatRead.mockImplementationOnce(() => server.promise);
    const oldAction = markRead(guid);
    let pause: Promise<void> | undefined;
    let pauseSettled = false;
    try {
      await waitForCall(mockMarkChatRead);
      pause = pauseRealtimeDeliveries().then(() => {
        pauseSettled = true;
      });
      mockDb = accountB.db;
      await Promise.resolve();
      expect(pauseSettled).toBe(false); // the whole action, not just its DB write, is tracked
    } finally {
      // Never strand the delivery slot when a synchronization assertion fails: that would make the
      // next independent account-switch case time out and hide the original failure.
      server.resolve({});
      await Promise.allSettled([oldAction, pause ?? Promise.resolve()]);
      resumeRealtimeDeliveries();
    }

    await expect(oldAction).resolves.toBeUndefined();
    await pause;

    expect(readMarker(accountB.raw, guid)).toBe('b-sentinel');
  });
});

describe('account-switch containment', () => {
  it('does not let an A-account mark-unread parked on DB open clear B’s same-guid row', async () => {
    const accountB = await createTestDb();
    const guid = 'iMessage;-;+15551234567';
    await seedChat(accountB.db, guid);

    const opening = deferred<AppDatabase>();
    (ensureDatabase as jest.Mock).mockImplementationOnce(() => opening.promise);
    const oldAction = markUnread(guid);
    expect(ensureDatabase).toHaveBeenCalledTimes(1);

    let pauseSettled = false;
    const pause = pauseRealtimeDeliveries().then(() => {
      pauseSettled = true;
    });
    mockDb = accountB.db;
    await Promise.resolve();
    expect(pauseSettled).toBe(false);

    opening.resolve(accountB.db);
    await expect(oldAction).resolves.toBeUndefined();
    await pause;
    resumeRealtimeDeliveries();

    expect(readMarker(accountB.raw, guid)).toBe('marker-1');
    expect(mockMarkChatUnread).not.toHaveBeenCalled();
  });
});
