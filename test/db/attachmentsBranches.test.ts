/**
 * Branch top-ups for src/db/repositories/attachments.ts — the empty-input early returns, the
 * media bucketing (photo/video/document) with the all-buckets-full early break + link dedup,
 * getAttachmentByGuid miss, the temp→real reconcile DELETE branch, and promoteAttachmentGuid's
 * dup vs update branches. Each case asserts observable DB state.
 */
import type Database from 'better-sqlite3';
import { Attachment, Chat, Message } from '@core/models';
import {
  getAttachmentByGuid,
  getChatIdByGuid,
  insertOutgoingAttachment,
  listAttachmentsByMessageIds,
  listChatAttachmentsByKind,
  promoteAttachmentGuid,
  updateAttachmentLocalPath,
  upsertAttachments,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

async function seedChat(db: AppDatabase, guid = 'c1'): Promise<number> {
  const hm = await upsertHandles(db, [{ address: 'a@x.com' }]);
  await upsertChats(db, [Chat.parse({ guid, participants: [{ address: 'a@x.com' }] })], hm);
  return (await getChatIdByGuid(db, guid))!;
}
/** Upsert a message (optionally with attachments/text) and return its row id. */
async function putMsg(
  db: AppDatabase,
  chatId: number,
  m: Record<string, unknown>,
): Promise<number> {
  const map = await upsertMessages(db, [Message.parse(m)], () => chatId, new Map());
  return map.get(m.guid as string)!;
}

describe('empty-input early returns', () => {
  it('upsertAttachments does nothing for [] and for guid-less items', async () => {
    const { db } = await createTestDb();
    await expect(upsertAttachments(db, [])).resolves.toBeUndefined();
    // A message with an item whose att has no guid → filtered → deduped empty → early return.
    const chatId = await seedChat(db);
    const id = await putMsg(db, chatId, { guid: 'm0', dateCreated: 1 });
    await expect(
      upsertAttachments(db, [{ att: { guid: '' } as unknown as Attachment, messageId: id }]),
    ).resolves.toBeUndefined();
    expect(await listAttachmentsByMessageIds(db, [id])).toEqual(new Map());
  });

  it('listAttachmentsByMessageIds returns an empty map for no ids', async () => {
    const { db } = await createTestDb();
    expect(await listAttachmentsByMessageIds(db, [])).toEqual(new Map());
  });

  it('getAttachmentByGuid returns null for a miss', async () => {
    const { db } = await createTestDb();
    expect(await getAttachmentByGuid(db, 'ghost')).toBeNull();
  });
});

describe('listChatAttachmentsByKind — bucketing + early break + link dedup', () => {
  it('buckets photos/videos/documents, stops once all buckets are full, and dedups links', async () => {
    const { db } = await createTestDb();
    const chatId = await seedChat(db, 'cMedia');
    // Newest-first scan; give descending dates. limit=1 so all three buckets fill fast and the
    // all-buckets-full break (line ~212) fires while a row still remains. Order so a photo, video
    // AND document all land inside the bounded scan window (limit*4), with a trailing extra row
    // AFTER all three buckets are full so the early break actually executes.
    const media: Array<[string, string, number]> = [
      ['p1', 'image/jpeg', 100],
      ['v1', 'video/mp4', 99],
      ['d1', 'application/pdf', 98],
      ['p2', 'image/png', 97], // trailing row: reached only if the break DIDN'T fire
    ];
    for (const [g, mime, date] of media) {
      await putMsg(db, chatId, {
        guid: `msg-${g}`,
        dateCreated: date,
        chats: [{ guid: 'cMedia' }],
        attachments: [{ guid: g, mimeType: mime }],
      });
    }
    // One link (the newest) — the per-bucket `limit` caps links too.
    await putMsg(db, chatId, { guid: 'L1', text: 'see https://a.com/x', dateCreated: 200, chats: [{ guid: 'cMedia' }] });

    const res = await listChatAttachmentsByKind(db, 'cMedia', 1);
    expect(res.photos).toHaveLength(1);
    expect(res.videos).toHaveLength(1);
    expect(res.documents).toHaveLength(1);
    // Newest of each kind wins the single slot.
    expect(res.photos[0]!.guid).toBe('p1');
    expect(res.videos[0]!.guid).toBe('v1');
    expect(res.documents[0]!.guid).toBe('d1');
    expect(res.links.map((l) => l.url)).toEqual(['https://a.com/x']);
  });

  it('dedups repeated link URLs to the most recent occurrence', async () => {
    const { db } = await createTestDb();
    const chatId = await seedChat(db, 'cLinks');
    // Two messages share a URL (dedup → one entry), one distinct URL. A high limit keeps the
    // loop from breaking early so the seen-URL `continue` branch is exercised.
    await putMsg(db, chatId, { guid: 'L1', text: 'see https://a.com/x', dateCreated: 200, chats: [{ guid: 'cLinks' }] });
    await putMsg(db, chatId, { guid: 'L2', text: 'also https://a.com/x again', dateCreated: 190, chats: [{ guid: 'cLinks' }] });
    await putMsg(db, chatId, { guid: 'L3', text: 'new https://b.com/y', dateCreated: 180, chats: [{ guid: 'cLinks' }] });
    const res = await listChatAttachmentsByKind(db, 'cLinks', 5);
    expect(res.links.map((l) => l.url)).toEqual(['https://a.com/x', 'https://b.com/y']);
    expect(res.links[0]!.messageGuid).toBe('L1'); // most-recent occurrence of the deduped URL
  });
});

describe('upsertAttachments — temp→real reconcile DELETE branch', () => {
  it('drops the temp -att row when the real guid already exists on the message', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db);
    // Optimistic picture: message + temp `-att` (with a local_path).
    await insertOutgoingAttachment(db, {
      tempGuid: 'temp-m',
      attachmentGuid: 'temp-m-att',
      chatId,
      chatGuid: 'c1',
      localPath: 'file:///pic.jpg',
      mimeType: 'image/jpeg',
      transferName: 'pic.jpg',
      totalBytes: 10,
      now: 1,
    });
    const messageId = (raw.prepare('SELECT id FROM messages WHERE guid = ?').get('temp-m') as { id: number }).id;
    // The REAL attachment already exists on the same message (raw-insert so this doesn't itself reconcile).
    raw
      .prepare('INSERT INTO attachments (guid, message_id, mime_type) VALUES (?, ?, ?)')
      .run('real-att', messageId, 'image/jpeg');
    // Now the echo upsert arrives for the real att → temp found + real exists → DELETE temp branch.
    await upsertAttachments(db, [{ att: Attachment.parse({ guid: 'real-att', mimeType: 'image/jpeg' }), messageId }]);

    const atts = (await listAttachmentsByMessageIds(db, [messageId])).get(messageId)!;
    expect(atts.map((a) => a.guid)).toEqual(['real-att']); // temp-m-att deleted, no duplicate
  });
});

describe('promoteAttachmentGuid — dup vs update branches', () => {
  it('updates the temp row to the server guid + local_path when the server guid is new', async () => {
    const { db } = await createTestDb();
    const chatId = await seedChat(db);
    await insertOutgoingAttachment(db, {
      tempGuid: 'temp-u',
      attachmentGuid: 'temp-u-att',
      chatId,
      chatGuid: 'c1',
      localPath: 'file:///a.jpg',
      mimeType: 'image/jpeg',
      transferName: 'a.jpg',
      totalBytes: 10,
      now: 1,
    });
    await promoteAttachmentGuid(db, 'temp-u-att', 'server-u', 'file:///a-final.jpg');
    const row = await getAttachmentByGuid(db, 'server-u');
    expect(row?.localPath).toBe('file:///a-final.jpg');
    expect(await getAttachmentByGuid(db, 'temp-u-att')).toBeNull(); // re-pointed in place
  });

  it('drops the temp row (no rename) when the server guid already exists', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db);
    await insertOutgoingAttachment(db, {
      tempGuid: 'temp-d',
      attachmentGuid: 'temp-d-att',
      chatId,
      chatGuid: 'c1',
      localPath: 'file:///b.jpg',
      mimeType: 'image/jpeg',
      transferName: 'b.jpg',
      totalBytes: 10,
      now: 1,
    });
    const messageId = (raw.prepare('SELECT id FROM messages WHERE guid = ?').get('temp-d') as { id: number }).id;
    raw
      .prepare('INSERT INTO attachments (guid, message_id, mime_type) VALUES (?, ?, ?)')
      .run('server-d', messageId, 'image/jpeg');
    await promoteAttachmentGuid(db, 'temp-d-att', 'server-d', 'file:///b.jpg');
    expect(await getAttachmentByGuid(db, 'temp-d-att')).toBeNull(); // temp dropped, no dup
    expect(await getAttachmentByGuid(db, 'server-d')).not.toBeNull();
  });
});

describe('updateAttachmentLocalPath', () => {
  it('persists a downloaded file path onto the attachment', async () => {
    const { db } = await createTestDb();
    const chatId = await seedChat(db);
    const id = await putMsg(db, chatId, {
      guid: 'msg-dl',
      dateCreated: 1,
      chats: [{ guid: 'c1' }],
      attachments: [{ guid: 'att-dl', mimeType: 'image/jpeg' }],
    });
    await updateAttachmentLocalPath(db, 'att-dl', 'file:///downloaded.jpg');
    const atts = (await listAttachmentsByMessageIds(db, [id])).get(id)!;
    expect(atts[0]!.localPath).toBe('file:///downloaded.jpg');
  });
});
