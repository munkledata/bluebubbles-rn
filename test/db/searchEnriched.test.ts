import { Chat, Message } from '@core/models';
import {
  deleteChatLocal,
  getChatIdByGuid,
  markMessageDeleted,
  searchChatGuidsByMessage,
  searchMessagesInChat,
  searchMessagesEnriched,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

async function seed(db: AppDatabase) {
  const hm = await upsertHandles(db, [{ address: 'craig@apple.com', displayName: 'Craig' }]);
  const map = await upsertChats(
    db,
    [
      Chat.parse({
        guid: 'c-craig',
        displayName: 'Craig Federighi',
        participants: [{ address: 'craig@apple.com' }],
      }),
    ],
    hm,
  );
  const chatId = map.get('c-craig')!;
  await upsertMessages(
    db,
    [
      Message.parse({
        guid: 'm1',
        text: 'You catch the keynote?',
        dateCreated: 100,
        handle: { address: 'craig@apple.com' },
      }),
      Message.parse({
        guid: 'm2',
        text: 'totally unrelated',
        dateCreated: 200,
        handle: { address: 'craig@apple.com' },
      }),
      // A reaction whose (null) text must never appear in results.
      Message.parse({
        guid: 'r1',
        dateCreated: 300,
        associatedMessageGuid: 'm1',
        associatedMessageType: 'love',
        handle: { address: 'craig@apple.com' },
      }),
    ],
    () => chatId,
    hm,
  );
}

describe('searchMessagesEnriched', () => {
  it('returns matching messages enriched with chat context', async () => {
    const { db } = await createTestDb();
    await seed(db);
    const results = await searchMessagesEnriched(db, 'keynote');
    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.text).toContain('keynote');
    expect(r.chatGuid).toBe('c-craig');
    expect(r.chatDisplayName).toBe('Craig Federighi');
    expect(typeof r.dateCreated).toBe('number');
  });

  it('returns nothing for an empty / too-short query', async () => {
    const { db } = await createTestDb();
    await seed(db);
    expect(await searchMessagesEnriched(db, '')).toEqual([]);
  });

  it('does not match reaction rows', async () => {
    const { db } = await createTestDb();
    await seed(db);
    // "love" is the reaction type, never indexed text → no result.
    expect(await searchMessagesEnriched(db, 'love')).toEqual([]);
  });

  it('excludes a deleted message even though its text is still in the FTS index', async () => {
    const { db } = await createTestDb();
    await seed(db);
    expect(await searchMessagesEnriched(db, 'keynote')).toHaveLength(1);
    // Tombstoning only re-indexes the unchanged text, so the FTS row survives — the query-time
    // `date_deleted IS NULL` filter is what makes the deleted message VANISH from search.
    await markMessageDeleted(db, 'm1', 5000);
    expect(await searchMessagesEnriched(db, 'keynote')).toEqual([]);
  });

  /**
   * Search renders its rows DIRECTLY — no chat-list intersection filters them — so it is a reader
   * of the chat tombstone exactly like the inbox is. Deleting a conversation removes its message
   * rows, but the next `syncAllChats` re-inserts each chat's lastMessage, putting that text back in
   * the FTS index; without the visibility predicate the hit was listed under the deleted thread's
   * name and tapping it re-opened (and re-paged) the conversation the user deleted.
   */
  it('excludes hits in a locally-deleted chat, including a message the next sync re-inserted', async () => {
    const { db } = await createTestDb();
    await seed(db);
    await deleteChatLocal(db, 'c-craig', 5000);
    expect(await searchMessagesEnriched(db, 'keynote')).toEqual([]);
    expect(await searchChatGuidsByMessage(db, 'keynote')).toEqual([]);

    // The re-sync's lastMessage upsert puts the text back into the index (the chat stays hidden:
    // the re-inserted message is older than the tombstone).
    const chatId = (await upsertChats(db, [Chat.parse({ guid: 'c-craig' })], new Map())).get(
      'c-craig',
    )!;
    await upsertMessages(
      db,
      [Message.parse({ guid: 'm1', text: 'You catch the keynote?', dateCreated: 100 })],
      () => chatId,
      new Map(),
    );
    expect(await searchMessagesEnriched(db, 'keynote')).toEqual([]);

    // A genuinely NEW message un-hides the conversation, and its search hits come back with it.
    await upsertMessages(
      db,
      [Message.parse({ guid: 'm9', text: 'keynote again?', dateCreated: 9000 })],
      () => chatId,
      new Map(),
    );
    expect((await searchMessagesEnriched(db, 'keynote')).map((r) => r.guid).sort()).toEqual([
      'm1',
      'm9',
    ]);
  });
});

describe('searchMessagesInChat', () => {
  it('keeps one stable chat-scoped page set across equal/null dates and later inserts', async () => {
    const { db, raw } = await createTestDb();
    await seed(db);
    const chatId = (await getChatIdByGuid(db, 'c-craig'))!;
    const matching = Array.from({ length: 52 }, (_, index) =>
      Message.parse({ guid: `needle-${index}`, text: 'needle body', dateCreated: 1000 }),
    );
    matching.push(
      Message.parse({
        guid: 'needle-overlay',
        text: 'needle overlay',
        dateCreated: 1001,
        associatedMessageGuid: 'needle-0',
        associatedMessageType: 'love',
      }),
      Message.parse({
        guid: 'needle-retracted',
        text: 'needle revoked',
        dateCreated: 1002,
        dateRetracted: 1003,
      }),
    );
    await upsertMessages(db, matching, () => chatId, new Map());
    raw.prepare("UPDATE messages SET date_created = NULL WHERE guid = 'needle-0'").run();

    const first = await searchMessagesInChat(db, 'c-craig', 'needle');
    expect(first.totalCount).toBe(52);
    expect(first.results).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    // This matching row arrived after the initial snapshot and must not shift page two.
    await upsertMessages(
      db,
      [Message.parse({ guid: 'needle-late', text: 'needle late', dateCreated: 1000 })],
      () => chatId,
      new Map(),
    );
    const second = await searchMessagesInChat(db, 'c-craig', 'needle', first.nextCursor);
    const frozen = [...first.results, ...second.results];
    expect(second.results).toHaveLength(2);
    expect(new Set(frozen.map((row) => row.id)).size).toBe(52);
    expect(frozen.map((row) => row.guid)).not.toContain('needle-late');
    expect(frozen.at(-1)?.dateCreated).toBeNull();

    const otherMap = await upsertChats(db, [Chat.parse({ guid: 'c-other' })], new Map());
    await upsertMessages(
      db,
      [Message.parse({ guid: 'needle-other', text: 'needle elsewhere', dateCreated: 2000 })],
      () => otherMap.get('c-other')!,
      new Map(),
    );
    expect(
      (await searchMessagesInChat(db, 'c-other', 'needle')).results.map((r) => r.guid),
    ).toEqual(['needle-other']);
  });
});
