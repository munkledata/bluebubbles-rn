/**
 * `listStickersForTargets` (src/db/repositories/attachments.ts) and the invariant that pairs with
 * it: a sticker must be reachable as an OVERLAY on its target, and must still be absent from the
 * message list itself, so it renders exactly once.
 *
 * Context for the reader: a sticker is an "associated message" like a tapback, but it carries an
 * image instead of a glyph. Before this query existed, every chat-thread read filtered
 * `associated_message_type IS NULL`, so a received sticker reached nothing at all — invisible, with
 * no indication a message had arrived.
 */
import { Attachment, Chat, Message } from '@core/models';
import {
  listMessagesWithSenders,
  listStickersForTargets,
  updateAttachmentLocalPath,
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
  // The message the sticker gets slapped onto.
  await upsertMessages(
    db,
    [Message.parse({ guid: 'mt', text: 'hi', dateCreated: 100, handle: { address: 'a@x.com' } })],
    () => chatId,
    hm,
  );
  return { chatId, hm };
}

/** Place a sticker on `target`, optionally with an attachment row. */
async function sticker(
  db: AppDatabase,
  chatId: number,
  hm: Map<string, number>,
  args: {
    guid: string;
    target: string;
    date: number;
    type?: string;
    attGuid?: string;
    from?: string;
  },
) {
  await upsertMessages(
    db,
    [
      Message.parse({
        guid: args.guid,
        text: null,
        dateCreated: args.date,
        handle: { address: args.from ?? 'a@x.com' },
        associatedMessageGuid: args.target,
        associatedMessageType: args.type ?? 'sticker',
        attachments: args.attGuid
          ? [
              Attachment.parse({
                guid: args.attGuid,
                mimeType: 'image/png',
                isSticker: true,
                width: 200,
                height: 200,
              }),
            ]
          : undefined,
      }),
    ],
    () => chatId,
    hm,
  );
}

describe('listStickersForTargets', () => {
  it('returns an empty map for no targets without touching the db', async () => {
    const { db } = await createTestDb();
    await expect(listStickersForTargets(db, [])).resolves.toEqual(new Map());
  });

  it('groups stickers under the guid of the message they were placed on', async () => {
    const { db } = await createTestDb();
    const { chatId, hm } = await setup(db);
    await sticker(db, chatId, hm, { guid: 's1', target: 'mt', date: 200, attGuid: 'sa1' });

    const map = await listStickersForTargets(db, ['mt']);
    const list = map.get('mt') ?? [];
    expect(list).toHaveLength(1);
    expect(list[0]?.stickerMessageGuid).toBe('s1');
    expect(list[0]?.targetGuid).toBe('mt');
    expect(list[0]?.attachment?.guid).toBe('sa1');
    expect(list[0]?.attachment?.mimeType).toBe('image/png');
  });

  // The linkage arrives part-prefixed on the wire (`bp:0/<guid>` for an attachment part) and is
  // stripped at the zod boundary, so the stored value must match the BARE target guid. Left raw,
  // the join would never match and stickers would stay invisible — the same trap that once made
  // other people's reactions invisible.
  it('matches a target whose linkage arrived part-prefixed on the wire', async () => {
    const { db } = await createTestDb();
    const { chatId, hm } = await setup(db);
    await sticker(db, chatId, hm, { guid: 's1', target: 'bp:0/mt', date: 200, attGuid: 'sa1' });

    const map = await listStickersForTargets(db, ['mt']);
    expect(map.get('mt')).toHaveLength(1);
  });

  // A sticker on the LIVE path has no attachment row until the next sync; the overlay must be able
  // to render a pending tile rather than assume an image exists.
  it('yields a row with a null attachment when the image has not arrived yet', async () => {
    const { db } = await createTestDb();
    const { chatId, hm } = await setup(db);
    await sticker(db, chatId, hm, { guid: 's1', target: 'mt', date: 200 });

    const list = (await listStickersForTargets(db, ['mt'])).get('mt') ?? [];
    expect(list).toHaveLength(1);
    expect(list[0]?.attachment).toBeNull();
  });

  it('surfaces a downloaded local path so the overlay can show the image', async () => {
    const { db } = await createTestDb();
    const { chatId, hm } = await setup(db);
    await sticker(db, chatId, hm, { guid: 's1', target: 'mt', date: 200, attGuid: 'sa1' });
    await updateAttachmentLocalPath(db, 'sa1', 'file:///s/sa1.png');

    const list = (await listStickersForTargets(db, ['mt'])).get('mt') ?? [];
    expect(list[0]?.attachment?.localPath).toBe('file:///s/sa1.png');
  });

  it('orders multiple stickers oldest-first and keeps unrelated targets apart', async () => {
    const { db } = await createTestDb();
    const { chatId, hm } = await setup(db);
    await upsertMessages(
      db,
      [Message.parse({ guid: 'mt2', text: 'yo', dateCreated: 150 })],
      () => chatId,
      hm,
    );
    await sticker(db, chatId, hm, { guid: 's2', target: 'mt', date: 300, attGuid: 'sa2' });
    await sticker(db, chatId, hm, { guid: 's1', target: 'mt', date: 200, attGuid: 'sa1' });
    await sticker(db, chatId, hm, { guid: 's3', target: 'mt2', date: 400, attGuid: 'sa3' });

    const map = await listStickersForTargets(db, ['mt', 'mt2']);
    expect((map.get('mt') ?? []).map((s) => s.stickerMessageGuid)).toEqual(['s1', 's2']);
    expect((map.get('mt2') ?? []).map((s) => s.stickerMessageGuid)).toEqual(['s3']);
  });

  it('ignores a reaction, a removal and a locally deleted sticker', async () => {
    const { db } = await createTestDb();
    const { chatId, hm } = await setup(db);
    await sticker(db, chatId, hm, { guid: 'r1', target: 'mt', date: 200, type: 'love' });
    await sticker(db, chatId, hm, { guid: 's-off', target: 'mt', date: 210, type: '-sticker' });

    expect((await listStickersForTargets(db, ['mt'])).get('mt')).toBeUndefined();
  });
});

// The other half of the fix: narrowing the thread filter must NOT let the sticker render as its own
// bubble as well as an overlay. If this ever fails, a sticker is showing twice.
describe('a sticker stays out of the message list itself', () => {
  it('is absent from listMessagesWithSenders while its target is present', async () => {
    const { db } = await createTestDb();
    const { chatId, hm } = await setup(db);
    await sticker(db, chatId, hm, { guid: 's1', target: 'mt', date: 200, attGuid: 'sa1' });

    const rows = await listMessagesWithSenders(db, chatId, 50);
    const guids = rows.map((r) => r.guid);
    expect(guids).toContain('mt');
    expect(guids).not.toContain('s1');
  });

  // The safety property the narrowed predicate buys: an associated type we do NOT recognise (the
  // server emits raw numeric Apple codes for anything its map lacks) now falls through and renders
  // as an ordinary message instead of vanishing without a trace.
  it('lets an UNKNOWN associated type through rather than swallowing it', async () => {
    const { db } = await createTestDb();
    const { chatId, hm } = await setup(db);
    await sticker(db, chatId, hm, { guid: 'unknown-1', target: 'mt', date: 200, type: '2999' });

    const guids = (await listMessagesWithSenders(db, chatId, 50)).map((r) => r.guid);
    expect(guids).toContain('unknown-1');
  });
});
