import { Chat, Message } from '@core/models';
import {
  getSyncMarker,
  listChats,
  listMessages,
  maxMessageMarker,
  searchMessages,
  setSyncMarker,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import { createTestDb } from '../support/testDb';

function chat(guid: string, extra: Record<string, unknown> = {}) {
  return Chat.parse({
    guid,
    displayName: guid,
    participants: [{ address: 'alice@me.com' }],
    ...extra,
  });
}
function message(
  guid: string,
  text: string,
  dateCreated: number,
  extra: Record<string, unknown> = {},
) {
  return Message.parse({ guid, text, dateCreated, ...extra });
}

describe('repositories', () => {
  it('upserts handles and returns address→id, deduping within a batch', async () => {
    const { db } = await createTestDb();
    const map = await upsertHandles(db, [
      { address: 'a@x.com' },
      { address: 'b@x.com' },
      { address: 'a@x.com', displayName: 'Alice' }, // duplicate address
    ]);
    expect(map.size).toBe(2);
    expect(map.get('a@x.com')).toBeGreaterThan(0);
  });

  it('upserts chats, links participants, and is idempotent on guid', async () => {
    const { db, raw } = await createTestDb();
    const handles = await upsertHandles(db, [{ address: 'alice@me.com' }]);
    const first = await upsertChats(db, [chat('c1')], handles);
    const second = await upsertChats(db, [chat('c1', { displayName: 'Renamed' })], handles);
    expect(first.get('c1')).toBe(second.get('c1')); // same id, updated in place

    const chatCount = raw.prepare('SELECT COUNT(*) c FROM chats').get() as { c: number };
    const linkCount = raw.prepare('SELECT COUNT(*) c FROM chat_handles').get() as { c: number };
    expect(chatCount.c).toBe(1);
    expect(linkCount.c).toBe(1);
    const name = raw.prepare('SELECT display_name d FROM chats WHERE guid = ?').get('c1') as {
      d: string;
    };
    expect(name.d).toBe('Renamed');
  });

  it('upserts messages with chat resolution and refreshes latest_message_date', async () => {
    const { db, raw } = await createTestDb();
    const handles = await upsertHandles(db, [{ address: 'alice@me.com' }]);
    const chatMap = await upsertChats(db, [chat('c1')], handles);
    const chatId = chatMap.get('c1')!;

    await upsertMessages(
      db,
      [message('m1', 'hello', 1000), message('m2', 'world', 2000)],
      () => chatId,
      handles,
    );

    const msgs = await listMessages(db, chatId);
    expect(msgs).toHaveLength(2);
    expect((msgs[0] as { text: string }).text).toBe('world'); // newest first

    const latest = raw
      .prepare('SELECT latest_message_date d FROM chats WHERE id = ?')
      .get(chatId) as { d: number };
    expect(latest.d).toBe(2000);
  });

  it('orders the chat list by latest message, archived excluded', async () => {
    const { db } = await createTestDb();
    const handles = await upsertHandles(db, [{ address: 'alice@me.com' }]);
    const map = await upsertChats(
      db,
      [chat('old'), chat('new'), chat('arch', { isArchived: true })],
      handles,
    );
    await upsertMessages(db, [message('mo', 'a', 100)], () => map.get('old')!, handles);
    await upsertMessages(db, [message('mn', 'b', 999)], () => map.get('new')!, handles);

    const chats = (await listChats(db)) as Array<{ guid: string }>;
    expect(chats.map((c) => c.guid)).toEqual(['new', 'old']); // archived excluded, newest first
  });

  it('full-text searches message bodies via FTS5', async () => {
    const { db } = await createTestDb();
    const handles = await upsertHandles(db, [{ address: 'alice@me.com' }]);
    const map = await upsertChats(db, [chat('c1')], handles);
    const chatId = map.get('c1')!;
    await upsertMessages(
      db,
      [
        message('m1', 'the quick brown fox', 1),
        message('m2', 'lazy dog sleeps', 2),
        message('m3', 'quick thinking', 3),
      ],
      () => chatId,
      handles,
    );

    const hits = await searchMessages(db, 'quick');
    const texts = hits.map((h) => h.text);
    expect(texts).toContain('the quick brown fox');
    expect(texts).toContain('quick thinking');
    expect(texts).not.toContain('lazy dog sleeps');
  });

  it('reads/writes sync markers and derives the max marker from messages', async () => {
    const { db } = await createTestDb();
    expect(await getSyncMarker(db)).toEqual({ lastSyncedRowId: null, lastSyncedTimestamp: null });
    await setSyncMarker(db, { lastSyncedRowId: 42, lastSyncedTimestamp: 1234 });
    expect(await getSyncMarker(db)).toEqual({ lastSyncedRowId: 42, lastSyncedTimestamp: 1234 });

    const handles = await upsertHandles(db, [{ address: 'alice@me.com' }]);
    const map = await upsertChats(db, [chat('c1')], handles);
    await upsertMessages(
      db,
      [
        message('m1', 'x', 500, { originalROWID: 10 }),
        message('m2', 'y', 900, { originalROWID: 25 }),
      ],
      () => map.get('c1')!,
      handles,
    );
    expect(await maxMessageMarker(db)).toEqual({ lastSyncedRowId: 25, lastSyncedTimestamp: 900 });
  });
});
