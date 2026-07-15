/**
 * Arbitrary-emoji tapbacks (iOS 18 / macOS 15) through the ingestion + reactions repo:
 * the server sends associatedMessageType 'emoji'/'-emoji' with the glyph in
 * associatedMessageEmoji. Distinct glyphs coexist per sender; a removal only clears
 * its own glyph; classic tapbacks are unaffected.
 */
import { Chat, Message } from '@core/models';
import {
  listReactionsByMessageGuids,
  upsertChats,
  upsertHandles,
  upsertMessages,
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
  args: { guid: string; type: string; emoji?: string; from?: string; date: number },
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
        associatedMessageEmoji: args.emoji ?? null,
        handle: args.from ? { address: args.from } : null,
      }),
    ],
    () => chatId,
    hm,
  );
}

describe('emoji tapbacks in listReactionsByMessageGuids', () => {
  it('returns an emoji reaction with its glyph', async () => {
    const { db } = await createTestDb();
    const { chatId, hm } = await setup(db);
    await react(db, chatId, hm, { guid: 'r1', type: 'emoji', emoji: '🔥', from: 'a@x.com', date: 200 });

    const rows = (await listReactionsByMessageGuids(db, ['mt'])).get('mt') ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ baseType: 'emoji', emoji: '🔥', isFromMe: 0 });
  });

  it('distinct glyphs from the SAME sender coexist (unlike classic types)', async () => {
    const { db } = await createTestDb();
    const { chatId, hm } = await setup(db);
    await react(db, chatId, hm, { guid: 'r1', type: 'emoji', emoji: '🔥', from: 'a@x.com', date: 200 });
    await react(db, chatId, hm, { guid: 'r2', type: 'emoji', emoji: '🫡', from: 'a@x.com', date: 300 });

    const rows = (await listReactionsByMessageGuids(db, ['mt'])).get('mt') ?? [];
    expect(rows.map((r) => r.emoji).sort()).toEqual(['🫡', '🔥'].sort());
  });

  it("a '-emoji' removal clears ONLY its own glyph", async () => {
    const { db } = await createTestDb();
    const { chatId, hm } = await setup(db);
    await react(db, chatId, hm, { guid: 'r1', type: 'emoji', emoji: '🔥', from: 'a@x.com', date: 200 });
    await react(db, chatId, hm, { guid: 'r2', type: 'emoji', emoji: '🫡', from: 'a@x.com', date: 300 });
    await react(db, chatId, hm, { guid: 'r3', type: '-emoji', emoji: '🔥', from: 'a@x.com', date: 400 });

    const rows = (await listReactionsByMessageGuids(db, ['mt'])).get('mt') ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.emoji).toBe('🫡');
  });

  it('the same glyph from DIFFERENT senders stays two rows (one per sender)', async () => {
    const { db } = await createTestDb();
    const { chatId, hm } = await setup(db);
    await react(db, chatId, hm, { guid: 'r1', type: 'emoji', emoji: '🔥', from: 'a@x.com', date: 200 });
    await react(db, chatId, hm, { guid: 'r2', type: 'emoji', emoji: '🔥', from: 'b@x.com', date: 300 });

    const rows = (await listReactionsByMessageGuids(db, ['mt'])).get('mt') ?? [];
    expect(rows).toHaveLength(2);
  });

  it('classic and emoji tapbacks coexist on one message; classic toggle still works', async () => {
    const { db } = await createTestDb();
    const { chatId, hm } = await setup(db);
    await react(db, chatId, hm, { guid: 'r1', type: 'love', from: 'a@x.com', date: 200 });
    await react(db, chatId, hm, { guid: 'r2', type: 'emoji', emoji: '🔥', from: 'a@x.com', date: 300 });
    await react(db, chatId, hm, { guid: 'r3', type: '-love', from: 'a@x.com', date: 400 });

    const rows = (await listReactionsByMessageGuids(db, ['mt'])).get('mt') ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ baseType: 'emoji', emoji: '🔥' });
  });

  it('a glyph-less emoji row is skipped (unrenderable), not crashed on', async () => {
    const { db } = await createTestDb();
    const { chatId, hm } = await setup(db);
    await react(db, chatId, hm, { guid: 'r1', type: 'emoji', from: 'a@x.com', date: 200 });

    const rows = (await listReactionsByMessageGuids(db, ['mt'])).get('mt') ?? [];
    expect(rows).toHaveLength(0);
  });

  it('emoji reactions never appear as chat rows (associated filter unchanged)', async () => {
    const { db, raw } = await createTestDb();
    const { chatId, hm } = await setup(db);
    await react(db, chatId, hm, { guid: 'r1', type: 'emoji', emoji: '🔥', from: 'a@x.com', date: 200 });
    // The visible-message queries all filter associated_message_type IS NULL.
    const visible = raw
      .prepare('SELECT guid FROM messages WHERE associated_message_type IS NULL')
      .all() as Array<{ guid: string }>;
    expect(visible.map((r) => r.guid)).toEqual(['mt']);
  });
});
