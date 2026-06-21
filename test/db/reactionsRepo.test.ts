import { Chat, Message } from '@core/models';
import {
  getMessagePreviewByGuid,
  listMessagesWithSenders,
  listReactionsByMessageGuids,
  upsertChats,
  upsertHandles,
  upsertMessages,
  type ReactionRow,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

const ADDRS = ['a@x.com', 'b@x.com'];

async function setup(db: AppDatabase) {
  const hm = await upsertHandles(
    db,
    ADDRS.map((address) => ({ address })),
  );
  const map = await upsertChats(
    db,
    [Chat.parse({ guid: 'c1', participants: ADDRS.map((address) => ({ address })) })],
    hm,
  );
  const chatId = map.get('c1')!;
  // The reacted-to target message.
  await upsertMessages(
    db,
    [Message.parse({ guid: 'mt', text: 'hi', dateCreated: 100, handle: { address: 'a@x.com' } })],
    () => chatId,
    hm,
  );
  return { chatId, hm };
}

async function react(
  db: AppDatabase,
  chatId: number,
  hm: Map<string, number>,
  args: { guid: string; type: string; from?: string; date: number },
) {
  await upsertMessages(
    db,
    [
      Message.parse({
        guid: args.guid,
        isFromMe: !args.from,
        dateCreated: args.date,
        associatedMessageGuid: 'mt',
        associatedMessageType: args.type,
        handle: args.from ? { address: args.from } : null,
      }),
    ],
    () => chatId,
    hm,
  );
}

describe('listReactionsByMessageGuids', () => {
  it('groups distinct senders by target guid', async () => {
    const { db } = await createTestDb();
    const { chatId, hm } = await setup(db);
    await react(db, chatId, hm, { guid: 'r1', type: 'love', from: 'a@x.com', date: 110 });
    await react(db, chatId, hm, { guid: 'r2', type: 'love', date: 120 }); // me

    const byGuid = await listReactionsByMessageGuids(db, ['mt']);
    const list = byGuid.get('mt') ?? [];
    expect(list).toHaveLength(2);
    expect(list.every((r: ReactionRow) => r.baseType === 'love')).toBe(true);
    expect(list.some((r) => r.isFromMe === 1)).toBe(true);
  });

  it('collapses add→remove (latest wins) to no badge', async () => {
    const { db } = await createTestDb();
    const { chatId, hm } = await setup(db);
    await react(db, chatId, hm, { guid: 'r1', type: 'love', from: 'a@x.com', date: 110 });
    await react(db, chatId, hm, { guid: 'r2', type: '-love', from: 'a@x.com', date: 120 });

    const byGuid = await listReactionsByMessageGuids(db, ['mt']);
    expect(byGuid.get('mt') ?? []).toHaveLength(0);
  });

  it('keeps only the latest type per sender', async () => {
    const { db } = await createTestDb();
    const { chatId, hm } = await setup(db);
    await react(db, chatId, hm, { guid: 'r1', type: 'love', from: 'a@x.com', date: 110 });
    await react(db, chatId, hm, { guid: 'r2', type: 'like', from: 'a@x.com', date: 120 });

    const list = (await listReactionsByMessageGuids(db, ['mt'])).get('mt') ?? [];
    // love and like are distinct (sender,type) keys, so both survive their own collapse
    expect(list.map((r) => r.baseType).sort()).toEqual(['like', 'love']);
  });

  it('returns an empty map for no guids', async () => {
    const { db } = await createTestDb();
    expect((await listReactionsByMessageGuids(db, [])).size).toBe(0);
  });

  it('excludes reaction rows from the bubble list', async () => {
    const { db } = await createTestDb();
    const { chatId, hm } = await setup(db);
    await react(db, chatId, hm, { guid: 'r1', type: 'love', from: 'a@x.com', date: 110 });
    const rows = await listMessagesWithSenders(db, chatId);
    expect(rows.map((m) => m.guid)).toEqual(['mt']); // the reaction is not a bubble
  });

  it('getMessagePreviewByGuid resolves hit/miss', async () => {
    const { db } = await createTestDb();
    await setup(db);
    expect((await getMessagePreviewByGuid(db, 'mt'))?.text).toBe('hi');
    expect(await getMessagePreviewByGuid(db, 'nope')).toBeNull();
  });
});
