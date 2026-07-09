import type Database from 'better-sqlite3';
import { Chat, Message } from '@core/models';
import { EventRouter } from '@core/realtime';
import {
  getChatIdByGuid,
  insertOutgoingAttachment,
  insertOutgoingText,
  listAttachmentsByMessageIds,
  listMessages,
  markMessageSendError,
  markOutgoingSentNoGuid,
  reconcileOutgoingSuccess,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { DbEventSink } from '@/services/realtime/dbEventSink';
import { createTestDb } from '../support/testDb';

// Gator's `new-message` echo carries NO tempGuid (chat.db ROWID-watcher emission), so the
// live echo of our own send is correlated to its optimistic `temp-…` row by CONTENT
// (reconcileEchoByContent) and promoted in place. These tests lock that path against the
// orphan / echo-race / no-guid-requeue bugs an adversarial review surfaced.

async function seedChat(db: AppDatabase, guid: string): Promise<number> {
  const handles = await upsertHandles(db, [{ address: 'a@x.com' }]);
  await upsertChats(db, [Chat.parse({ guid, participants: [{ address: 'a@x.com' }] })], handles);
  return (await getChatIdByGuid(db, guid))!;
}

function count(raw: Database.Database, table: string, where: string, ...args: unknown[]): number {
  return (
    raw.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${where}`).get(...args) as { c: number }
  ).c;
}

describe('live echo reconcile (Gator: no tempGuid on echo)', () => {
  it('content-matches a no-guid (AppleScript) send and promotes in place — no duplicate bubble', async () => {
    const { db, raw } = await createTestDb();
    const router = new EventRouter(new DbEventSink(db));
    const chatId = await seedChat(db, 'cEcho');

    await insertOutgoingText(db, {
      tempGuid: 'temp-aaa11111',
      chatId,
      chatGuid: 'cEcho',
      text: 'hello',
      now: 1000,
    });
    // AppleScript fallback: the ack had no guid, so the send service flips to 'sent' + clears
    // the queue (no spurious retry). Identity is still the tempGuid until the echo lands.
    await markOutgoingSentNoGuid(db, 'temp-aaa11111');
    expect(count(raw, 'outgoing_queue', 'temp_guid = ?', 'temp-aaa11111')).toBe(0);

    const echo = Message.parse({
      guid: 'real-1',
      text: 'hello',
      isFromMe: true,
      dateCreated: 1000,
      chats: [{ guid: 'cEcho' }],
    });
    await router.handle('new-message', JSON.stringify(echo), 'socket');

    const msgs = (await listMessages(db, chatId)) as Array<{ guid: string; sendState: string }>;
    expect(msgs).toHaveLength(1); // promoted in place — NOT orphaned into a duplicate
    expect(msgs[0]!.guid).toBe('real-1');
    expect(msgs[0]!.sendState).toBe('sent');
  });

  it('echo-before-ack preserves the optimistic attachment local_path (no re-download)', async () => {
    const { db } = await createTestDb();
    const router = new EventRouter(new DbEventSink(db));
    const chatId = await seedChat(db, 'cAtt');

    await insertOutgoingAttachment(db, {
      tempGuid: 'temp-bbb22222',
      attachmentGuid: 'temp-bbb22222-att',
      chatId,
      chatGuid: 'cAtt',
      localPath: 'file:///photo.jpg',
      mimeType: 'image/jpeg',
      transferName: 'photo.jpg',
      totalBytes: 100,
      now: 2000,
    });

    // The socket echo wins the race (arrives before the HTTP ack), carrying the real guids.
    const echo = Message.parse({
      guid: 'real-2',
      isFromMe: true,
      dateCreated: 2000,
      chats: [{ guid: 'cAtt' }],
      attachments: [{ guid: 'real-2-att', mimeType: 'image/jpeg' }],
    });
    await router.handle('new-message', JSON.stringify(echo), 'socket');
    // The ack lands second; it must be an idempotent no-op (temp already promoted).
    await reconcileOutgoingSuccess(db, 'temp-bbb22222', {
      guid: 'real-2',
      dateCreated: 2000,
      dateDelivered: null,
    });

    const msgs = (await listMessages(db, chatId)) as Array<{ id: number; guid: string }>;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.guid).toBe('real-2');
    const atts = (await listAttachmentsByMessageIds(db, [msgs[0]!.id])).get(msgs[0]!.id)!;
    expect(atts).toHaveLength(1);
    expect(atts[0]!.guid).toBe('real-2-att');
    expect(atts[0]!.localPath).toBe('file:///photo.jpg'); // preserved, not cascade-deleted
  });

  it('ack-then-echo (Private-API) reconciles in place — echo is idempotent', async () => {
    const { db } = await createTestDb();
    const router = new EventRouter(new DbEventSink(db));
    const chatId = await seedChat(db, 'cPapi');

    await insertOutgoingText(db, {
      tempGuid: 'temp-ccc33333',
      chatId,
      chatGuid: 'cPapi',
      text: 'yo',
      now: 3000,
    });
    await reconcileOutgoingSuccess(db, 'temp-ccc33333', {
      guid: 'real-3',
      dateCreated: 3000,
      dateDelivered: null,
    });
    const echo = Message.parse({
      guid: 'real-3',
      text: 'yo',
      isFromMe: true,
      dateCreated: 3000,
      chats: [{ guid: 'cPapi' }],
    });
    await router.handle('new-message', JSON.stringify(echo), 'socket');

    const msgs = (await listMessages(db, chatId)) as Array<{ guid: string }>;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.guid).toBe('real-3');
  });

  it('does NOT mis-promote a non-matching echo (different text) — inserts separately', async () => {
    const { db } = await createTestDb();
    const router = new EventRouter(new DbEventSink(db));
    const chatId = await seedChat(db, 'cNo');

    await insertOutgoingText(db, {
      tempGuid: 'temp-ddd44444',
      chatId,
      chatGuid: 'cNo',
      text: 'hello',
      now: 4000,
    });
    await markOutgoingSentNoGuid(db, 'temp-ddd44444');
    const echo = Message.parse({
      guid: 'real-4',
      text: 'a different message',
      isFromMe: true,
      dateCreated: 4001,
      chats: [{ guid: 'cNo' }],
    });
    await router.handle('new-message', JSON.stringify(echo), 'socket');

    const guids = ((await listMessages(db, chatId)) as Array<{ guid: string }>)
      .map((m) => m.guid)
      .sort();
    // The optimistic 'hello' must remain its own row; the unrelated echo is inserted separately.
    expect(guids).toEqual(['real-4', 'temp-ddd44444']);
  });

  it('dup-branch fallback copies attachment local_path when content-match was missed (db.run path)', async () => {
    const { db } = await createTestDb();
    const chatId = await seedChat(db, 'cDup');

    await insertOutgoingAttachment(db, {
      tempGuid: 'temp-eee55555',
      attachmentGuid: 'temp-eee55555-att',
      chatId,
      chatGuid: 'cDup',
      localPath: 'file:///dup.jpg',
      mimeType: 'image/jpeg',
      transferName: 'dup.jpg',
      totalBytes: 50,
      now: 5000,
    });
    // Simulate the echo inserting a SEPARATE real message + real attachment (local_path NULL)
    // WITHOUT content-matching — the genuine dup-branch precondition (upsertMessages directly,
    // not via DbEventSink, so reconcileEchoByContent never runs).
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'real-5',
          isFromMe: true,
          dateCreated: 5000,
          chats: [{ guid: 'cDup' }],
          attachments: [{ guid: 'real-5-att', mimeType: 'image/jpeg' }],
        }),
      ],
      () => chatId,
      new Map(),
    );
    // The HTTP ack now hits the dup-branch (real-5 exists): it must copy local_path onto the
    // real attachment (via db.run — db.all would throw), delete the temp row, clear the queue.
    await reconcileOutgoingSuccess(db, 'temp-eee55555', {
      guid: 'real-5',
      dateCreated: 5000,
      dateDelivered: null,
    });

    const msgs = (await listMessages(db, chatId)) as Array<{ id: number; guid: string }>;
    expect(msgs.map((x) => x.guid)).toEqual(['real-5']); // temp deleted, no duplicate
    const atts = (await listAttachmentsByMessageIds(db, [msgs[0]!.id])).get(msgs[0]!.id)!;
    expect(atts.find((a) => a.guid === 'real-5-att')?.localPath).toBe('file:///dup.jpg');
  });

  it('does NOT hijack a stale temp row outside the echo time window (cross-device guard)', async () => {
    const { db } = await createTestDb();
    const router = new EventRouter(new DbEventSink(db));
    const chatId = await seedChat(db, 'cWin');

    // A stale pending send from long ago.
    await insertOutgoingText(db, {
      tempGuid: 'temp-fff66666',
      chatId,
      chatGuid: 'cWin',
      text: 'ok',
      now: 1000,
    });
    await markOutgoingSentNoGuid(db, 'temp-fff66666');
    // A foreign echo (another device) with identical text but a far-later timestamp.
    const echo = Message.parse({
      guid: 'real-6',
      text: 'ok',
      isFromMe: true,
      dateCreated: 100_000_000,
      chats: [{ guid: 'cWin' }],
    });
    await router.handle('new-message', JSON.stringify(echo), 'socket');

    const guids = ((await listMessages(db, chatId)) as Array<{ guid: string }>)
      .map((m) => m.guid)
      .sort();
    // The stale temp row is NOT hijacked (outside the ±window); the foreign echo stands alone.
    expect(guids).toEqual(['real-6', 'temp-fff66666']);
  });

  it('a late success-ack does NOT clobber an already-failed row (RCS immediate-ack race)', async () => {
    const { db } = await createTestDb();
    const chatId = await seedChat(db, 'cRace');

    await insertOutgoingAttachment(db, {
      tempGuid: 'temp-race00001',
      attachmentGuid: 'temp-race00001-att',
      chatId,
      chatGuid: 'cRace',
      localPath: 'file:///race.jpg',
      mimeType: 'image/jpeg',
      transferName: 'race.jpg',
      totalBytes: 10,
      now: 6000,
    });
    // The genuine send FAILURE (message-send-error) lands first, keyed by tempGuid.
    await markMessageSendError(db, 'temp-race00001', 502);
    // The RCS bridge's immediate "sending" success-ack arrives LATE — it must NOT overwrite 'error'.
    await markOutgoingSentNoGuid(db, 'temp-race00001');

    const msgs = (await listMessages(db, chatId)) as Array<{ guid: string; sendState: string }>;
    expect(msgs).toHaveLength(1);
    // Failure is sticky: the late ack does not mask it back to 'sent'.
    expect(msgs[0]!.sendState).toBe('error');
  });
});
