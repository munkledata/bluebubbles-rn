/**
 * Unit tests for `markUnread` (`src/services/chatActions.ts`) — the Mark-as-Unread service.
 *
 * Invariants pinned here:
 *   - the LOCAL flip (read marker cleared) always happens, and happens FIRST;
 *   - a rejecting server call neither throws nor reverts the local flip (best-effort sync);
 *   - `RCS;-;` chats never hit the server (the RCS sidecar has no unread endpoint);
 *   - the master Private API toggle gates the server call.
 *
 * The DB is REAL (in-memory better-sqlite3 via createTestDb) so the local write is proven
 * against actual repository SQL; everything else (http client, api module, feature store) is
 * mocked at the module boundary like `notificationActions.test.ts`.
 */
import { Chat } from '@core/models';
import { setLastReadMessageGuid, upsertChats, upsertHandles } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

// Hoisted jest.mock factories may only reference `mock`-prefixed vars.
let mockDb: AppDatabase;
let mockPrivateApiEnabled = true;
const mockMarkChatUnread = jest.fn<Promise<unknown>, unknown[]>();

jest.mock('@db/database', () => ({ getDatabase: () => mockDb }));
jest.mock('@/services/clients', () => ({ http: { __http: true } }));
jest.mock('@/services/databaseControl', () => ({ ensureDatabase: jest.fn() }));
jest.mock('@/services/realtimeControl', () => ({ getSocket: jest.fn(() => null) }));
jest.mock('@state/featureSettingsStore', () => ({
  useFeatureSettingsStore: {
    getState: () => ({ privateApiEnabled: mockPrivateApiEnabled, sendReadReceipts: true }),
  },
}));
jest.mock('@core/api', () => ({
  chatsApi: { markChatUnread: (...a: unknown[]) => mockMarkChatUnread(...a) },
}));

import { markUnread } from '@/services/chatActions';

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
  mockPrivateApiEnabled = true;
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
