import { Chat, Message } from '@core/models';
import {
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
});
