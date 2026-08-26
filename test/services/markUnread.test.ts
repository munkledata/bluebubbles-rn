/**
 * Unit tests for `markUnread` / `markRead` (`src/services/chatActions.ts`).
 *
 * Invariants pinned here:
 *   - the LOCAL flip (read marker cleared) always happens, and happens FIRST;
 *   - a rejecting server call neither throws nor reverts the local flip (best-effort sync);
 *   - `RCS;-;` chats never hit the server (the RCS sidecar has no unread endpoint);
 *   - the master Private API toggle gates the server call, and is HYDRATED first — headlessly the
 *     store sits at its module defaults (everything on), so an un-hydrated read would ignore it;
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
let mockPrivateApiEnabled = true;
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
jest.mock('@/services/clients', () => ({ http: { __http: true } }));
jest.mock('@/services/databaseControl', () => ({ ensureDatabase: jest.fn(async () => mockDb) }));
jest.mock('@/services/realtimeControl', () => ({ getSocket: jest.fn(() => null) }));
jest.mock('@state/featureSettingsStore', () => ({
  useFeatureSettingsStore: {
    getState: () => ({
      privateApiEnabled: mockPrivateApiEnabled,
      sendReadReceipts: true,
      hydrated: mockSettingsHydrated,
      hydrate: mockHydrate,
    }),
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
import { markRead, markUnread } from '@/services/chatActions';
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

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
  mockPrivateApiEnabled = true;
  mockSettingsHydrated = true;
  mockHydrate.mockClear();
  (ensureDatabase as jest.Mock).mockClear();
  (getDatabase as jest.Mock).mockClear();
});

afterEach(() => {
  resumeRealtimeDeliveries();
});

describe('markUnread', () => {
  it('clears the local read marker AND fires the server call for an iMessage chat', async () => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    const guid = 'iMessage;-;+15551234567';
    await seedChat(db, guid);

    await markUnread(guid);

    expect(readMarker(raw, guid)).toBeNull();
    expect(mockMarkChatUnread).toHaveBeenCalledWith({ __http: true }, guid);
  });

  it('a REJECTING server call neither throws nor reverts the local flip', async () => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    const guid = 'iMessage;-;+15551234567';
    await seedChat(db, guid);
    mockMarkChatUnread.mockRejectedValue(new Error('offline'));

    await expect(markUnread(guid)).resolves.toBeUndefined();

    expect(mockMarkChatUnread).toHaveBeenCalledTimes(1);
    expect(readMarker(raw, guid)).toBeNull(); // local flip kept
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
      expect(mockMarkChatUnread).toHaveBeenCalledWith({ __http: true }, guid);
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
    const guid = 'RCS;-;+15551234567';
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

  it('hydrates the feature settings before reading the Private API toggle (headless defaults)', async () => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    const guid = 'iMessage;-;+15551234567';
    await seedChat(db, guid);
    // Headless: no UI boot effect ran, so the store is un-hydrated and at its (all-on) defaults.
    mockSettingsHydrated = false;
    mockHydrate.mockImplementationOnce(async () => {
      mockSettingsHydrated = true;
      mockPrivateApiEnabled = false; // what the user actually chose
    });

    await markUnread(guid);

    expect(mockHydrate).toHaveBeenCalledTimes(1);
    expect(mockMarkChatUnread).not.toHaveBeenCalled();
    expect(readMarker(raw, guid)).toBeNull(); // the local flip still lands
  });

  it('the Private API master toggle OFF skips the server call (local flip still lands)', async () => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    const guid = 'iMessage;-;+15551234567';
    await seedChat(db, guid);
    mockPrivateApiEnabled = false;

    await markUnread(guid);

    expect(readMarker(raw, guid)).toBeNull();
    expect(mockMarkChatUnread).not.toHaveBeenCalled();
  });
});

describe('markRead', () => {
  it('advances the marker via the LAZY ensureDatabase() — the killed-app tray button path', async () => {
    const { db, raw } = await createTestDb();
    mockDb = db;
    const guid = 'iMessage;-;+15551234567';
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
    const guid = 'iMessage;-;+15551234567';
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
      mockPrivateApiEnabled = false;
    });

    await markRead(guid);

    expect(mockHydrate).toHaveBeenCalledTimes(1);
    expect(mockMarkChatRead).not.toHaveBeenCalled();
    expect(readMarker(raw, guid)).toBe('m1'); // own badge still clears
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
    const guid = 'iMessage;-;+15550000000';
    const hm = await upsertHandles(db, [{ address: 'a@x.com' }]);
    await upsertChats(db, [Chat.parse({ guid, participants: [{ address: 'a@x.com' }] })], hm);

    await markRead(guid);

    expect(readMarker(raw, guid)).toBeNull();
    expect(mockHydrate).toHaveBeenCalledTimes(1);
    expect(mockMarkChatRead).toHaveBeenCalledWith({ __http: true }, guid);
  });

  it('waits out a rolling-back replacement before choosing the committed newest message', async () => {
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
    const guid = 'iMessage;-;+15551234567';
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
