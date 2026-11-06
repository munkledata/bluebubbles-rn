import type Database from 'better-sqlite3';
import { Message } from '@core/models';
import { EventRouter } from '@core/realtime';
import { deliverRaw } from '../support/realtimeRouter';
import {
  insertOutgoingText,
  listAttachmentsByMessageIds,
  reconcileOutgoingAttachmentByContent,
  reconcileOutgoingSuccess,
  upsertMessages,
} from '@db/repositories';
import type { ReadDb } from '@db/types';
import { DbEventSink } from '@/services/realtime/dbEventSink';
import { createTestDb } from '../support/testDb';
import {
  insertOutgoingAttachment,
  listMessages,
  markMessageSendError,
  markOutgoingSentNoGuid,
} from '../support/repositoryWrappers';
import { seedChat } from '../support/chatFixtures';

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
    await deliverRaw(router, 'new-message', JSON.stringify(echo), 'socket');

    const msgs = (await listMessages(db, chatId)) as Array<{ guid: string; sendState: string }>;
    expect(msgs).toHaveLength(1); // promoted in place — NOT orphaned into a duplicate
    expect(msgs[0]!.guid).toBe('real-1');
    expect(msgs[0]!.sendState).toBe('sent');
  });

  it('promotes an ERRORED temp row when its echo lands (client saw 502 but the send actually delivered)', async () => {
    // The incident shape: the app's POST failed (Caddy 502 / bridge hiccup) so the bubble went
    // 'error' + the queue row stayed armed — but the server had actually accepted the send, and
    // its echo arrives under the real guid. The echo must promote the errored row in place AND
    // clear the queue row (stopping the retry ladder → no duplicate send), not insert a twin.
    const { db, raw } = await createTestDb();
    const router = new EventRouter(new DbEventSink(db));
    const chatId = await seedChat(db, 'cErrEcho');

    await insertOutgoingText(db, {
      tempGuid: 'temp-err11111',
      chatId,
      chatGuid: 'cErrEcho',
      text: 'made it anyway',
      now: 1000,
    });
    // Simulate handleSendFailure: bubble errored, attempts bumped, backoff armed.
    raw
      .prepare(
        "UPDATE messages SET send_state='error', error=502, error_message='stale detail' WHERE guid='temp-err11111'",
      )
      .run();
    raw
      .prepare(
        "UPDATE outgoing_queue SET attempts=1, next_retry_at=0 WHERE temp_guid='temp-err11111'",
      )
      .run();

    const echo = Message.parse({
      guid: 'real-recovered',
      text: 'made it anyway',
      isFromMe: true,
      dateCreated: 1000,
      chats: [{ guid: 'cErrEcho' }],
    });
    await deliverRaw(router, 'new-message', JSON.stringify(echo), 'socket');

    const msgs = (await listMessages(db, chatId)) as Array<{
      guid: string;
      sendState: string;
      errorMessage: string | null;
    }>;
    expect(msgs).toHaveLength(1); // no duplicate bubble
    expect(msgs[0]!.guid).toBe('real-recovered');
    expect(msgs[0]!.sendState).toBe('sent');
    expect(msgs[0]!.errorMessage).toBeNull();
    expect(count(raw, 'outgoing_queue', 'temp_guid = ?', 'temp-err11111')).toBe(0); // ladder stopped
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
    await deliverRaw(router, 'new-message', JSON.stringify(echo), 'socket');
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
    await deliverRaw(router, 'new-message', JSON.stringify(echo), 'socket');

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
    await deliverRaw(router, 'new-message', JSON.stringify(echo), 'socket');

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
    await deliverRaw(router, 'new-message', JSON.stringify(echo), 'socket');

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

// A GROUP iMessage text goes out through the Mac's AppleScript fallback: the send reply carries no
// guid, so the temp row stays `temp-…` until a copy of the real message is matched to it. When the
// first copy to arrive is a SYNC read (an open chat's refresh, a reconnect), not the live echo, the
// sync path must match it too — otherwise the real row is inserted beside the temp row, and the
// late live echo finds the real guid already stored and leaves the temp bubble as a duplicate.
describe('sync-first copy of a no-guid text send', () => {
  async function pendingNoGuidText(db: ReadDb, chatGuid: string, tempGuid: string) {
    const chatId = await seedChat(db, chatGuid);
    await insertOutgoingText(db, { tempGuid, chatId, chatGuid, text: 'hello', now: 1000 });
    await markOutgoingSentNoGuid(db, tempGuid);
    return chatId;
  }

  async function syncCopy(db: ReadDb, chatId: number, fields: Record<string, unknown>) {
    const copy = Message.parse({
      guid: 'real-sync-1',
      text: 'hello',
      isFromMe: true,
      dateCreated: 1500,
      ...fields,
    });
    // The sync engine's order: content reconcile, then the upsert.
    await reconcileOutgoingAttachmentByContent(db, copy, chatId);
    await upsertMessages(db, [copy], () => chatId, new Map());
    return copy;
  }

  it('merges the temp bubble into a sync-read copy, and a later live echo adds nothing', async () => {
    const { db, raw } = await createTestDb();
    const router = new EventRouter(new DbEventSink(db));
    const chatId = await pendingNoGuidText(db, 'cSync', 'temp-sync0001');

    const copy = await syncCopy(db, chatId, {});
    await deliverRaw(
      router,
      'new-message',
      JSON.stringify({ ...copy, chats: [{ guid: 'cSync' }] }),
      'socket',
    );

    const msgs = (await listMessages(db, chatId)) as { guid: string; sendState: string }[];
    expect(msgs.map((m) => [m.guid, m.sendState])).toEqual([['real-sync-1', 'sent']]);
    expect(count(raw, 'outgoing_queue', 'temp_guid = ?', 'temp-sync0001')).toBe(0);
  });

  it('merges a sync-read copy that lands before the no-guid reply, and the reply adds nothing', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'cSyncEarly');
    await insertOutgoingText(db, {
      tempGuid: 'temp-sync0004',
      chatId,
      chatGuid: 'cSyncEarly',
      text: 'hello',
      now: 1000,
    });

    await syncCopy(db, chatId, {});
    await markOutgoingSentNoGuid(db, 'temp-sync0004');

    const msgs = (await listMessages(db, chatId)) as { guid: string; sendState: string }[];
    expect(msgs.map((m) => [m.guid, m.sendState])).toEqual([['real-sync-1', 'sent']]);
    expect(count(raw, 'outgoing_queue', 'temp_guid = ?', 'temp-sync0004')).toBe(0);
  });

  it('leaves the temp bubble alone for a copy outside the time window, or with other text', async () => {
    const { db } = await createTestDb();
    const chatId = await pendingNoGuidText(db, 'cSyncGuard', 'temp-sync0002');

    await syncCopy(db, chatId, { guid: 'real-far', dateCreated: 100_000_000 });
    await syncCopy(db, chatId, { guid: 'real-other', text: 'hello!' });

    const guids = ((await listMessages(db, chatId)) as { guid: string }[])
      .map((m) => m.guid)
      .sort();
    expect(guids).toEqual(['real-far', 'real-other', 'temp-sync0002']);
  });

  it('never lets another device’s earlier identical text consume a queued, unsent bubble', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'cSyncEarlier');
    // Queued while offline: still 'sending', its queue row waiting to be posted.
    await insertOutgoingText(db, {
      tempGuid: 'temp-sync0005',
      chatId,
      chatGuid: 'cSyncEarlier',
      text: 'hello',
      now: 200_000,
    });

    // The Mac sent the same words two minutes earlier.
    await syncCopy(db, chatId, { guid: 'real-other-device', dateCreated: 80_000 });

    const msgs = (await listMessages(db, chatId)) as { guid: string; sendState: string }[];
    expect(msgs.map((m) => m.guid).sort()).toEqual(['real-other-device', 'temp-sync0005']);
    expect(count(raw, 'outgoing_queue', 'temp_guid = ?', 'temp-sync0005')).toBe(1);
  });

  it('never matches a failed text bubble from sync', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await pendingNoGuidText(db, 'cSyncState', 'temp-sync0006');
    await markMessageSendError(db, 'temp-sync0006');
    expect(
      raw.prepare('SELECT send_state AS s FROM messages WHERE guid = ?').get('temp-sync0006'),
    ).toEqual({
      s: 'error',
    });

    await syncCopy(db, chatId, {});

    const guids = ((await listMessages(db, chatId)) as { guid: string }[])
      .map((m) => m.guid)
      .sort();
    expect(guids).toEqual(['real-sync-1', 'temp-sync0006']);
  });

  it('never lets a reply or reaction copy claim a plain text bubble', async () => {
    const { db } = await createTestDb();
    const chatId = await pendingNoGuidText(db, 'cSyncKind', 'temp-sync0003');
    await upsertMessages(
      db,
      [Message.parse({ guid: 'target-1', text: 'earlier', isFromMe: false, dateCreated: 10 })],
      () => chatId,
      new Map(),
    );

    await syncCopy(db, chatId, { guid: 'real-reply', threadOriginatorGuid: 'target-1' });
    await syncCopy(db, chatId, {
      guid: 'real-reaction',
      associatedMessageGuid: 'target-1',
      associatedMessageType: 'like',
    });

    const guids = ((await listMessages(db, chatId)) as { guid: string }[]).map((m) => m.guid);
    expect(guids).toContain('temp-sync0003');
  });
});
