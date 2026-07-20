import { Chat, Message } from '@core/models';
import {
  getMessagePreviewByGuid,
  listMessagesWithSenders,
  listReactionsByMessageGuids,
  markMessageDeleted,
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
  args: { guid: string; type: string; from?: string; date: number; target?: string },
) {
  await upsertMessages(
    db,
    [
      Message.parse({
        guid: args.guid,
        isFromMe: !args.from,
        dateCreated: args.date,
        // The wire carries a part prefix (`p:0/<guid>`); the Message schema strips it on parse so
        // the reaction matches the target's bare guid. Default to the bare form for existing cases.
        associatedMessageGuid: args.target ?? 'mt',
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

  it('attaches an incoming reaction whose linkage carries the p:0/ wire prefix (regression)', async () => {
    // The bug: OTHER people's reactions arrive as `associatedMessageGuid: 'p:0/<targetGuid>'`, but
    // the target message's own guid is bare ('mt'), so left raw the reaction never matched and
    // stayed invisible. The Message schema now strips the prefix on parse.
    const { db } = await createTestDb();
    const { chatId, hm } = await setup(db);
    await react(db, chatId, hm, {
      guid: 'r1',
      type: 'love',
      from: 'a@x.com',
      date: 110,
      target: 'p:0/mt',
    });
    const list = (await listReactionsByMessageGuids(db, ['mt'])).get('mt') ?? [];
    expect(list).toHaveLength(1);
    expect(list[0]?.baseType).toBe('love');
    expect(list[0]?.isFromMe).toBe(0); // from someone else
  });

  it('also strips the bp:0/ (attachment-part) prefix', async () => {
    const { db } = await createTestDb();
    const { chatId, hm } = await setup(db);
    await react(db, chatId, hm, {
      guid: 'r1',
      type: 'like',
      from: 'a@x.com',
      date: 110,
      target: 'bp:0/mt',
    });
    expect((await listReactionsByMessageGuids(db, ['mt'])).get('mt') ?? []).toHaveLength(1);
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

  it('drops a tombstoned (deleted) reaction row from the badge', async () => {
    const { db } = await createTestDb();
    const { chatId, hm } = await setup(db);
    await react(db, chatId, hm, { guid: 'r1', type: 'love', from: 'a@x.com', date: 110 });
    // The reaction badges the target first…
    expect((await listReactionsByMessageGuids(db, ['mt'])).get('mt') ?? []).toHaveLength(1);
    // …then the reaction message lands in "Recently Deleted" (tombstoned via date_deleted) — the
    // badge must vanish, like every other render/count query that filters date_deleted IS NULL.
    await markMessageDeleted(db, 'r1', 5000);
    expect((await listReactionsByMessageGuids(db, ['mt'])).get('mt') ?? []).toHaveLength(0);
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
