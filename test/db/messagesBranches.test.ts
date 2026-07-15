/**
 * Branch top-ups for src/db/repositories/messages.ts — the onConflictDoUpdate COALESCE/MAX
 * preserve rules (a later event that OMITS a field must never blank a good stored value), the
 * paginate cursors, the around-window, delete, and the small read-null helpers. Each case
 * asserts observable DB state.
 */
import type Database from 'better-sqlite3';
import { Chat, Message } from '@core/models';
import {
  applyLocalEdit,
  applyLocalUnsend,
  clearLocalUnsend,
  deleteMessageByGuid,
  getChatGuidByMessageGuid,
  getChatIdByGuid,
  getMessagePreviewByGuid,
  getMessageTextByGuid,
  insertOutgoingText,
  listMessagesAround,
  listMessagesWithSenders,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

async function seedChat(db: AppDatabase, guid = 'c1'): Promise<{ chatId: number; hm: Map<string, number> }> {
  const hm = await upsertHandles(db, [{ address: 'a@x.com' }]);
  await upsertChats(db, [Chat.parse({ guid, participants: [{ address: 'a@x.com' }] })], hm);
  return { chatId: (await getChatIdByGuid(db, guid))!, hm };
}
async function put(db: AppDatabase, chatId: number, hm: Map<string, number>, m: Record<string, unknown>) {
  await upsertMessages(db, [Message.parse(m)], () => chatId, hm);
}
const col = (raw: Database.Database, guid: string, c: string): unknown =>
  (raw.prepare(`SELECT ${c} v FROM messages WHERE guid = ?`).get(guid) as { v: unknown })?.v;

describe('upsertMessages — COALESCE/MAX preserve on conflict', () => {
  it('a later event with empty text does NOT blank a stored body', async () => {
    const { db, raw } = await createTestDb();
    const { chatId, hm } = await seedChat(db);
    await put(db, chatId, hm, { guid: 'm1', text: 'hello', dateCreated: 1, handle: { address: 'a@x.com' } });
    // A delivery-receipt re-upsert carries no text.
    await put(db, chatId, hm, { guid: 'm1', dateCreated: 1, dateDelivered: 2 });
    expect(col(raw, 'm1', 'text')).toBe('hello'); // preserved
    expect(col(raw, 'm1', 'date_delivered')).toBe(2); // plain overwrite still applied
  });

  it('a later handle-less re-sync does NOT wipe an already-resolved sender', async () => {
    const { db, raw } = await createTestDb();
    const { chatId, hm } = await seedChat(db);
    await put(db, chatId, hm, { guid: 'm2', text: 'hi', dateCreated: 1, handle: { address: 'a@x.com' } });
    const handleId = col(raw, 'm2', 'handle_id');
    expect(handleId).not.toBeNull();
    await put(db, chatId, new Map(), { guid: 'm2', text: 'hi', dateCreated: 1 }); // no handle in map
    expect(col(raw, 'm2', 'handle_id')).toBe(handleId); // sender preserved
  });

  it('a later event that OMITS wasDeliveredQuietly cannot downgrade a stored true', async () => {
    const { db, raw } = await createTestDb();
    const { chatId, hm } = await seedChat(db);
    await put(db, chatId, hm, { guid: 'm3', text: 'q', dateCreated: 1, wasDeliveredQuietly: true });
    expect(col(raw, 'm3', 'was_delivered_quietly')).toBe(1);
    await put(db, chatId, hm, { guid: 'm3', text: 'q', dateCreated: 1 }); // flag omitted → NULL excluded
    expect(col(raw, 'm3', 'was_delivered_quietly')).toBe(1); // still true
  });

  it('hasAttachments is MAX-preserved (a later omit cannot flip 1 → 0)', async () => {
    const { db, raw } = await createTestDb();
    const { chatId, hm } = await seedChat(db);
    await put(db, chatId, hm, { guid: 'm4', text: 'x', dateCreated: 1, hasAttachments: true });
    expect(col(raw, 'm4', 'has_attachments')).toBe(1);
    await put(db, chatId, hm, { guid: 'm4', text: 'x', dateCreated: 1, hasAttachments: false });
    expect(col(raw, 'm4', 'has_attachments')).toBe(1); // MAX keeps the 1
  });

  it('the emoji-tapback glyph is COALESCE-preserved across a later omit', async () => {
    const { db, raw } = await createTestDb();
    const { chatId, hm } = await seedChat(db);
    await put(db, chatId, hm, {
      guid: 'r1',
      isFromMe: true,
      dateCreated: 1,
      associatedMessageGuid: 'm1',
      associatedMessageType: 'emoji',
      associatedMessageEmoji: '🔥',
    });
    // A delivery-receipt re-upsert of the tapback omits the glyph.
    await put(db, chatId, hm, {
      guid: 'r1',
      isFromMe: true,
      dateCreated: 1,
      associatedMessageGuid: 'm1',
      associatedMessageType: 'emoji',
    });
    expect(col(raw, 'r1', 'associated_message_emoji')).toBe('🔥');
  });

  it('a genuine edit (dateEdited + new text) still overwrites on conflict', async () => {
    const { db, raw } = await createTestDb();
    const { chatId, hm } = await seedChat(db);
    await put(db, chatId, hm, { guid: 'm5', text: 'before', dateCreated: 1, handle: { address: 'a@x.com' } });
    await put(db, chatId, hm, { guid: 'm5', text: 'after', dateCreated: 1, dateEdited: 9 });
    expect(col(raw, 'm5', 'text')).toBe('after'); // non-empty excluded overwrites
    expect(col(raw, 'm5', 'date_edited')).toBe(9);
  });
});

describe('paginate + around windows', () => {
  it('listMessagesWithSenders honors the beforeDate cursor AND the sinceDate floor', async () => {
    const { db } = await createTestDb();
    const { chatId, hm } = await seedChat(db);
    for (const d of [10, 20, 30, 40]) {
      await put(db, chatId, hm, { guid: `d${d}`, text: `t${d}`, dateCreated: d });
    }
    const older = await listMessagesWithSenders(db, chatId, 100, 30); // strictly < 30
    expect(older.map((m) => m.guid)).toEqual(['d20', 'd10']);
    const windowed = await listMessagesWithSenders(db, chatId, 100, 40, 20); // >= 20 AND < 40
    expect(windowed.map((m) => m.guid)).toEqual(['d30', 'd20']);
  });

  it('listMessagesAround returns context on BOTH sides of the anchor, newest-first', async () => {
    const { db } = await createTestDb();
    const { chatId, hm } = await seedChat(db);
    for (const d of [10, 20, 30, 40, 50]) {
      await put(db, chatId, hm, { guid: `a${d}`, text: `t${d}`, dateCreated: d });
    }
    const around = await listMessagesAround(db, chatId, 30, 1, 1); // 1 older(+anchor) & 1 newer
    expect(around.map((m) => m.guid)).toEqual(['a40', 'a30', 'a20']);
  });
});

describe('read-null helpers + edit/unsend + delete', () => {
  it('getMessagePreviewByGuid returns null for a miss, a preview for a hit', async () => {
    const { db } = await createTestDb();
    const { chatId, hm } = await seedChat(db);
    expect(await getMessagePreviewByGuid(db, 'ghost')).toBeNull();
    await put(db, chatId, hm, { guid: 'p1', text: 'preview', dateCreated: 1, handle: { address: 'a@x.com' } });
    expect(await getMessagePreviewByGuid(db, 'p1')).toMatchObject({ guid: 'p1', text: 'preview' });
  });

  it('getChatGuidByMessageGuid resolves the owning chat, null when unknown', async () => {
    const { db } = await createTestDb();
    const { chatId, hm } = await seedChat(db, 'chatX');
    await put(db, chatId, hm, { guid: 'g1', text: 'x', dateCreated: 1 });
    expect(await getChatGuidByMessageGuid(db, 'g1')).toBe('chatX');
    expect(await getChatGuidByMessageGuid(db, 'nope')).toBeNull();
  });

  it('applyLocalEdit / applyLocalUnsend / clearLocalUnsend mutate in place; getMessageTextByGuid reflects it', async () => {
    const { db } = await createTestDb();
    const { chatId, hm } = await seedChat(db);
    await put(db, chatId, hm, { guid: 'e1', text: 'orig', dateCreated: 1 });
    await applyLocalEdit(db, 'e1', 'edited', 7);
    expect(await getMessageTextByGuid(db, 'e1')).toEqual({ text: 'edited', dateEdited: 7 });
    expect(await getMessageTextByGuid(db, 'missing')).toBeNull();

    await applyLocalUnsend(db, 'e1', 12);
    expect((await getMessageTextByGuid(db, 'e1'))).not.toBeNull(); // row still there
    await clearLocalUnsend(db, 'e1'); // revert an optimistic unsend
    const around = await listMessagesWithSenders(db, chatId);
    expect(around.find((m) => m.guid === 'e1')?.dateRetracted).toBeNull();
  });

  it('deleteMessageByGuid removes the message AND its outgoing_queue row', async () => {
    const { db, raw } = await createTestDb();
    const { chatId } = await seedChat(db);
    await insertOutgoingText(db, { tempGuid: 'temp-del', chatId, chatGuid: 'c1', text: 'bye', now: 1 });
    await deleteMessageByGuid(db, 'temp-del');
    expect(col(raw, 'temp-del', 'guid')).toBeUndefined();
    const q = raw.prepare('SELECT COUNT(*) c FROM outgoing_queue WHERE temp_guid = ?').get('temp-del') as {
      c: number;
    };
    expect(q.c).toBe(0);
  });
});
