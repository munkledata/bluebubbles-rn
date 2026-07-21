/**
 * payload_data persistence (Apple rich-link preview metadata, migration 0027): the JSON blob
 * round-trips through upsert → listMessagesWithSenders as raw TEXT (parsed lazily via
 * parsePayloadData), and — like messageSummaryInfo — is COALESCE-preserved when a later
 * flagless re-upsert (delivery/read receipt) omits it.
 */
import { Chat, Message, parsePayloadData } from '@core/models';
import { listMessagesWithSenders, upsertChats, upsertHandles, upsertMessages } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

const PAYLOAD = {
  urlData: [
    {
      url: 'https://example.com/page',
      originalUrl: 'https://example.com/original',
      title: 'A Title',
      summary: 'A summary.',
      siteName: 'Example',
      itemType: 'article',
      imageUrl: 'https://cdn.example.com/img.jpg',
      iconUrl: 'https://example.com/favicon.ico',
      videoUrl: null,
    },
  ],
};

async function seedChat(db: AppDatabase): Promise<number> {
  const hm = await upsertHandles(db, [{ address: 'a@x.com' }]);
  const map = await upsertChats(
    db,
    [Chat.parse({ guid: 'c1', participants: [{ address: 'a@x.com' }] })],
    hm,
  );
  return map.get('c1')!;
}

describe('payloadData persistence (rich-link previews)', () => {
  it('round-trips the JSON blob through write → read', async () => {
    const { db } = await createTestDb();
    const chatId = await seedChat(db);
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'p1',
          text: 'https://example.com/page',
          dateCreated: 100,
          payloadData: PAYLOAD,
        }),
      ],
      () => chatId,
      new Map(),
    );
    const row = (await listMessagesWithSenders(db, chatId)).find((m) => m.guid === 'p1')!;
    // Stored as raw JSON TEXT (like messageSummaryInfo); the tolerant helper reconstructs it.
    expect(typeof row.payloadData).toBe('string');
    expect(parsePayloadData(row.payloadData)).toEqual(PAYLOAD);
  });

  it('stores NULL when the message carries no payloadData', async () => {
    const { db } = await createTestDb();
    const chatId = await seedChat(db);
    await upsertMessages(
      db,
      [Message.parse({ guid: 'p2', text: 'plain', dateCreated: 100 })],
      () => chatId,
      new Map(),
    );
    const row = (await listMessagesWithSenders(db, chatId)).find((m) => m.guid === 'p2')!;
    expect(row.payloadData).toBeNull();
    expect(parsePayloadData(row.payloadData)).toBeNull();
  });

  it('COALESCE-preserves stored metadata when a later flagless re-upsert omits it', async () => {
    const { db } = await createTestDb();
    const chatId = await seedChat(db);
    await upsertMessages(
      db,
      [Message.parse({ guid: 'p3', dateCreated: 100, payloadData: PAYLOAD })],
      () => chatId,
      new Map(),
    );
    // A read-receipt re-upsert (or a leaner live projection) carries no payloadData — it must
    // NOT wipe the stored preview: absence never means "the preview was removed".
    await upsertMessages(
      db,
      [Message.parse({ guid: 'p3', dateCreated: 100, dateRead: 5000 })],
      () => chatId,
      new Map(),
    );
    const row = (await listMessagesWithSenders(db, chatId)).find((m) => m.guid === 'p3')!;
    expect(row.dateRead).toBe(5000);
    expect(parsePayloadData(row.payloadData)).toEqual(PAYLOAD);
  });
});
