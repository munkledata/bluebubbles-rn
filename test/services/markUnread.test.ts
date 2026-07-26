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
import { Chat, Message } from '@core/models';
import {
  getChatIdByGuid,
  setLastReadMessageGuid,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
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

async function seedChat(db: AppDatabase, guid: string): Promise<void> {
  const hm = await upsertHandles(db, [{ address: 'a@x.com' }]);
  await upsertChats(db, [Chat.parse({ guid, participants: [{ address: 'a@x.com' }] })], hm);
  await setLastReadMessageGuid(db, guid, 'marker-1'); // start READ
}

const readMarker = (raw: import('better-sqlite3').Database, guid: string) =>
  (
    raw.prepare('SELECT last_read_message_guid m FROM chats WHERE guid = ?').get(guid) as {
      m: string | null;
    }
  ).m;

beforeEach(() => {
  mockMarkChatUnread.mockReset().mockResolvedValue({});
  mockMarkChatRead.mockReset().mockResolvedValue({});
  mockPrivateApiEnabled = true;
  mockSettingsHydrated = true;
  mockHydrate.mockClear();
  (ensureDatabase as jest.Mock).mockClear();
  (getDatabase as jest.Mock).mockClear();
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

    await markRead('iMessage;-;+19999999999');

    expect(mockMarkChatRead).not.toHaveBeenCalled();
  });
});
