import { Chat, Message } from '@core/models';
import {
  deleteChatLocal,
  markMessageDeleted,
  searchChatGuidsByMessage,
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
