/* eslint-disable import/first -- Jest mocks must be registered before importing their consumers. */
/**
 * RCS conversations outside the active Google pairing: bare legacy `RCS;-;<id>` guids and guids
 * from an older pairing epoch. Their local state is keyed by the exact stored guid, so archive, pin,
 * mute, read markers, delete and folder membership must work for them; only steps that reach the
 * server need the current pairing. No ServerInfo is loaded here, so there is no current pairing at
 * all, which also covers a cold start while offline.
 */
import type Database from 'better-sqlite3';
import { Chat, Message } from '@core/models';
import {
  createCustomFolder,
  getChatIdByGuid,
  insertScheduled,
  listChatsForInbox,
  listScheduledByChat,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

// Hoisted jest.mock factories may only reference `mock`-prefixed vars.
let mockDb: AppDatabase;
const mockDeleteScheduled = jest.fn<Promise<unknown>, [unknown, string]>();

jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));
jest.mock('@/services/clients', () => ({ http: { __http: true } }));
jest.mock('@/services/databaseControl', () => ({ ensureDatabase: jest.fn(async () => mockDb) }));
jest.mock('@/services/realtimeControl', () => ({ getSocket: jest.fn(() => null) }));
jest.mock('@/services/download/downloadService', () => ({ cancelAttachmentDownloads: jest.fn() }));
jest.mock('@state/featureSettingsStore', () => ({
  useFeatureSettingsStore: {
    getState: () => ({ privateApiEnabled: true, sendReadReceipts: true, hydrated: true }),
  },
}));
jest.mock('@core/api', () => ({
  chatsApi: {},
  scheduledApi: { deleteScheduled: (http: unknown, id: string) => mockDeleteScheduled(http, id) },
}));
jest.mock('@/services/notifications/notifeeService', () => ({
  cancelReminderNotification: jest.fn(async () => undefined),
  cancelForChat: jest.fn(async () => undefined),
}));

import {
  deleteChat,
  markAllChatsRead,
  markUnread,
  setChatArchived,
  setChatMuted,
  setChatPinned,
} from '@/services/chatActions';
import { replaceCustomFolderMembership } from '@/services/customFolderCommands';

const LEGACY_RCS_GUID = 'RCS;-;legacy-conversation';
const OLD_PAIRING_RCS_GUID = `RCS;-;g1.gpe1_${'B'.repeat(43)}.b2xkLWNvbnZlcnNhdGlvbg`;

interface ChatState {
  archived: number;
  pinned: number;
  mute: string | null;
  unreadAt: number | null;
  lastRead: string | null;
}

describe.each([
  ['a legacy bare RCS guid', LEGACY_RCS_GUID],
  ['an RCS guid from an older Google pairing', OLD_PAIRING_RCS_GUID],
])('local actions on %s', (_label, guid) => {
  let raw: Database.Database;

  const chat = (): ChatState =>
    raw
      .prepare(
        `SELECT is_archived AS archived, is_pinned AS pinned, mute_type AS mute,
                marked_unread_at AS unreadAt, last_read_message_guid AS lastRead
           FROM chats WHERE guid = ?`,
      )
      .get(guid) as ChatState;

  beforeEach(async () => {
    const t = await createTestDb();
    mockDb = t.db;
    raw = t.raw;
    mockDeleteScheduled.mockReset();
    const hm = await upsertHandles(t.db, [{ address: '+15551234567' }]);
    await upsertChats(
      t.db,
      [Chat.parse({ guid, participants: [{ address: '+15551234567' }] })],
      hm,
    );
    const chatId = (await getChatIdByGuid(t.db, guid))!;
    await upsertMessages(
      t.db,
      [Message.parse({ guid: 'rcs-history-m1', text: 'hi', isFromMe: false, dateCreated: 1_000 })],
      () => chatId,
      hm,
    );
  });

  it('archives, pins and mutes', async () => {
    await setChatArchived(guid, true);
    await setChatPinned(guid, true);
    await setChatMuted(guid, true);

    expect(chat()).toMatchObject({ archived: 1, pinned: 1, mute: 'mute' });
  });

  it('marks unread, and mark-all-read clears it', async () => {
    await markUnread(guid);
    expect(chat().unreadAt).not.toBeNull();

    await markAllChatsRead();

    expect(chat()).toMatchObject({ unreadAt: null, lastRead: 'rcs-history-m1' });
  });

  it('joins a custom folder instead of reporting the folder as deleted', async () => {
    const folder = await createCustomFolder(mockDb, 'Old RCS');

    await expect(replaceCustomFolderMembership(folder.id, [guid])).resolves.toEqual({
      status: 'committed',
      value: true,
    });

    expect(
      raw
        .prepare('SELECT chat_guid AS chatGuid FROM custom_folder_members WHERE folder_id = ?')
        .all(folder.id),
    ).toEqual([{ chatGuid: guid }]);
  });

  it('deletes locally but keeps the server-backed scheduled send for a later cancel', async () => {
    await insertScheduled(mockDb, {
      chatGuid: guid,
      text: 'later',
      scheduledFor: 9_000,
      serverId: 'srv-rcs-history',
    });

    await deleteChat(guid);

    expect((await listChatsForInbox(mockDb)).map((row) => row.guid)).not.toContain(guid);
    // The server cancel would address a possibly reused provider id, so it is skipped.
    expect(mockDeleteScheduled).not.toHaveBeenCalled();
    expect(await listScheduledByChat(mockDb, guid)).toHaveLength(1);
  });
});
