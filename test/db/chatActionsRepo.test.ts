import type Database from 'better-sqlite3';
import { Chat } from '@core/models';
import {
  deleteChatLocal,
  getChatIdByGuid,
  insertOutgoingText,
  setChatArchive,
  setChatPin,
  upsertChats,
  upsertHandles,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

async function seedChat(
  db: AppDatabase,
  guid: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const handles = await upsertHandles(db, [{ address: 'a@b.com' }]);
  await upsertChats(
    db,
    [Chat.parse({ guid, participants: [{ address: 'a@b.com' }], ...extra })],
    handles,
  );
}

const col = (raw: Database.Database, guid: string, c: string): number | string | null =>
  (raw.prepare(`SELECT ${c} v FROM chats WHERE guid = ?`).get(guid) as { v: number | string })?.v ??
  null;
const counts = (raw: Database.Database, table: string): number =>
  (raw.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;

describe('chat actions repo', () => {
  it('pins and unpins a chat locally', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await setChatPin(db, 'c1', true);
    expect(col(raw, 'c1', 'is_pinned')).toBe(1);
    await setChatPin(db, 'c1', false);
    expect(col(raw, 'c1', 'is_pinned')).toBe(0);
  });

  it('archives a chat locally', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await setChatArchive(db, 'c1', true);
    expect(col(raw, 'c1', 'is_archived')).toBe(1);
  });

  it('keeps a local pin/archive through a server re-sync (server fields still update)', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1', { displayName: 'Old' });
    await setChatPin(db, 'c1', true);
    await setChatArchive(db, 'c1', true);

    // Server re-syncs the same chat with pin/archive absent (false) + a new name.
    await seedChat(db, 'c1', { displayName: 'New', isPinned: false, isArchived: false });

    expect(col(raw, 'c1', 'is_pinned')).toBe(1); // local pin survived
    expect(col(raw, 'c1', 'is_archived')).toBe(1); // local archive survived
    expect(col(raw, 'c1', 'display_name')).toBe('New'); // server-authoritative field updated
  });

  it('deleteChatLocal removes the chat, its messages, and its queue rows', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const chatId = await getChatIdByGuid(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-x',
      chatId: chatId!,
      chatGuid: 'c1',
      text: 'hi',
      now: 1000,
    });
    expect(counts(raw, 'messages')).toBe(1);
    expect(counts(raw, 'outgoing_queue')).toBe(1);

    await deleteChatLocal(db, 'c1');
    expect(counts(raw, 'chats')).toBe(0);
    expect(counts(raw, 'messages')).toBe(0);
    expect(counts(raw, 'outgoing_queue')).toBe(0);
  });
});
