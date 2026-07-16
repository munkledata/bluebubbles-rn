/**
 * Branch top-ups for src/db/repositories/outgoing.ts — the guard clauses, backstops, and
 * cancelled-in-flight paths not exercised by echoReconcile/outgoingQueueService. Every case
 * asserts observable DB state (or a documented return value).
 */
import type Database from 'better-sqlite3';
import { Chat, Message } from '@core/models';
import {
  cancelOutgoing,
  getChatIdByGuid,
  insertOutgoingAttachment,
  insertOutgoingText,
  listAttachmentsByMessageIds,
  listMessages,
  markOutgoingSentNoGuid,
  reconcileEchoByContent,
  reconcileOutgoingAttachmentByContent,
  reconcileOutgoingError,
  reconcileOutgoingSuccess,
  upsertChats,
  upsertHandles,
  upsertMessages,
  wasCancelledInFlight,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

async function seedChat(db: AppDatabase, guid: string): Promise<number> {
  const hm = await upsertHandles(db, [{ address: 'a@x.com' }]);
  await upsertChats(db, [Chat.parse({ guid, participants: [{ address: 'a@x.com' }] })], hm);
  return (await getChatIdByGuid(db, guid))!;
}
const msgState = (raw: Database.Database, guid: string) =>
  raw.prepare('SELECT send_state s, error e FROM messages WHERE guid = ?').get(guid) as
    | { s: string; e: number }
    | undefined;
const queueCount = (raw: Database.Database, tempGuid: string): number =>
  (
    raw.prepare('SELECT COUNT(*) c FROM outgoing_queue WHERE temp_guid = ?').get(tempGuid) as {
      c: number;
    }
  ).c;

describe('reconcileOutgoingSuccess — backstops & branches', () => {
  it('no-ops on an empty guid (never promote a row to NULL identity)', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-1',
      chatId,
      chatGuid: 'c1',
      text: 'hi',
      now: 1,
    });
    await reconcileOutgoingSuccess(db, 'temp-1', { guid: '', dateCreated: 1, dateDelivered: null });
    // Row untouched: still the temp guid, still sending, queue row intact.
    expect(msgState(raw, 'temp-1')?.s).toBe('sending');
    expect(queueCount(raw, 'temp-1')).toBe(1);
  });

  it('treats guid===tempGuid (RCS self-ack) like the no-guid path: sent + dequeue, not promote', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-rcs',
      chatId,
      chatGuid: 'c1',
      text: 'yo',
      now: 1,
    });
    await reconcileOutgoingSuccess(db, 'temp-rcs', {
      guid: 'temp-rcs',
      dateCreated: 1,
      dateDelivered: null,
    });
    // Still identified by the tempGuid (NOT deleted as its own "duplicate"), flipped to sent, dequeued.
    expect(msgState(raw, 'temp-rcs')?.s).toBe('sent');
    expect(queueCount(raw, 'temp-rcs')).toBe(0);
  });

  it('dup-branch WITHOUT a temp local_path just drops the temp row (no UPDATE)', async () => {
    const { db } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    // Optimistic TEXT (no attachment → no local_path to carry over).
    await insertOutgoingText(db, {
      tempGuid: 'temp-d',
      chatId,
      chatGuid: 'c1',
      text: 'hi',
      now: 1,
    });
    // Echo already inserted the real message directly (dup-branch precondition).
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'real-d',
          isFromMe: true,
          dateCreated: 1,
          text: 'hi',
          chats: [{ guid: 'c1' }],
        }),
      ],
      () => chatId,
      new Map(),
    );
    await reconcileOutgoingSuccess(db, 'temp-d', {
      guid: 'real-d',
      dateCreated: 1,
      dateDelivered: null,
    });
    const guids = ((await listMessages(db, chatId)) as Array<{ guid: string }>).map((m) => m.guid);
    expect(guids).toEqual(['real-d']); // temp dropped, no duplicate
  });
});

describe('cancelOutgoing — branches', () => {
  it('returns false when there is no queue row (already reconciled / never queued)', async () => {
    const { db } = await createTestDb();
    await seedChat(db, 'c1');
    expect(await cancelOutgoing(db, 'nope')).toBe(false);
  });

  it('clears a STRANDED queue row that has no matching temp message', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-s',
      chatId,
      chatGuid: 'c1',
      text: 'hi',
      now: 1,
    });
    // Delete only the message, leaving the queue row stranded.
    raw.prepare('DELETE FROM messages WHERE guid = ?').run('temp-s');
    expect(await cancelOutgoing(db, 'temp-s')).toBe(true);
    expect(queueCount(raw, 'temp-s')).toBe(0);
  });

  it("an 'error' cancel deletes the row but does NOT arm the cancelled-in-flight suppression", async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-err',
      chatId,
      chatGuid: 'c1',
      text: 'hi',
      now: 1,
    });
    raw.prepare("UPDATE messages SET send_state = 'error' WHERE guid = ?").run('temp-err');
    expect(await cancelOutgoing(db, 'temp-err')).toBe(true);
    expect(msgState(raw, 'temp-err')).toBeUndefined(); // message deleted
    expect(wasCancelledInFlight('temp-err')).toBe(false); // no in-flight POST to suppress
  });

  it("a 'sending' cancel arms suppression, and the later success-ack erases the server echo", async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-snd',
      chatId,
      chatGuid: 'c1',
      text: 'hi',
      now: 1,
    });
    expect(await cancelOutgoing(db, 'temp-snd')).toBe(true);
    expect(wasCancelledInFlight('temp-snd')).toBe(true);
    // The in-flight POST resolves late: reconcile must drop BOTH the temp row and the real echo.
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'real-snd',
          isFromMe: true,
          dateCreated: 1,
          text: 'hi',
          chats: [{ guid: 'c1' }],
        }),
      ],
      () => chatId,
      new Map(),
    );
    await reconcileOutgoingSuccess(db, 'temp-snd', {
      guid: 'real-snd',
      dateCreated: 1,
      dateDelivered: null,
    });
    expect(await listMessages(db, chatId)).toHaveLength(0); // cancelled stays cancelled
    expect(wasCancelledInFlight('temp-snd')).toBe(false); // consumed
  });

  it('a late NO-GUID (AppleScript) ack after a cancel erases the row instead of resurrecting it', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-ng',
      chatId,
      chatGuid: 'c1',
      text: 'hi',
      now: 1,
    });
    expect(await cancelOutgoing(db, 'temp-ng')).toBe(true); // 'sending' → arms suppression + deletes
    expect(wasCancelledInFlight('temp-ng')).toBe(true);
    // The AppleScript fallback resolves late with no guid → markOutgoingSentNoGuid's cancelled
    // branch drops any leftover row + queue entry (never flips a cancelled send back to 'sent').
    await markOutgoingSentNoGuid(db, 'temp-ng');
    expect(msgState(raw, 'temp-ng')).toBeUndefined();
    expect(queueCount(raw, 'temp-ng')).toBe(0);
    expect(wasCancelledInFlight('temp-ng')).toBe(false); // consumed
  });
});

describe('reconcileOutgoingError — attempts + backoff', () => {
  it('marks errored, bumps attempts to 1, and schedules a backoff on the queue row', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-e',
      chatId,
      chatGuid: 'c1',
      text: 'hi',
      now: 1,
    });
    await reconcileOutgoingError(db, 'temp-e', 42, 1_000);
    expect(msgState(raw, 'temp-e')).toEqual({ s: 'error', e: 42 });
    const q = raw
      .prepare('SELECT attempts a, next_retry_at n FROM outgoing_queue WHERE temp_guid = ?')
      .get('temp-e') as { a: number; n: number };
    expect(q.a).toBe(1);
    expect(q.n).toBe(1_000 + 30_000); // first backoff = 30s
  });
});

describe('reconcileEchoByContent — guard clauses', () => {
  it('returns early for a received (not-from-me) echo', async () => {
    const { db } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-g',
      chatId,
      chatGuid: 'c1',
      text: 'hi',
      now: 1,
    });
    await reconcileEchoByContent(
      db,
      { guid: 'real-x', isFromMe: false, text: 'hi', dateCreated: 1 },
      chatId,
    );
    // temp row untouched (still the temp guid).
    expect(((await listMessages(db, chatId)) as Array<{ guid: string }>)[0]!.guid).toBe('temp-g');
  });

  it('returns early when the echo carries a temp- guid (nothing real to reconcile to)', async () => {
    const { db } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-h',
      chatId,
      chatGuid: 'c1',
      text: 'hi',
      now: 1,
    });
    await reconcileEchoByContent(
      db,
      { guid: 'temp-h', isFromMe: true, text: 'hi', dateCreated: 1 },
      chatId,
    );
    expect(((await listMessages(db, chatId)) as Array<{ guid: string }>)[0]!.guid).toBe('temp-h');
  });

  it('no-ops when the real guid already exists (already reconciled by the ack)', async () => {
    const { db } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'real-y',
          isFromMe: true,
          dateCreated: 1,
          text: 'hi',
          chats: [{ guid: 'c1' }],
        }),
      ],
      () => chatId,
      new Map(),
    );
    // No temp row to promote AND the guid exists → pure no-op (no throw, no extra row).
    await reconcileEchoByContent(
      db,
      { guid: 'real-y', isFromMe: true, text: 'hi', dateCreated: 1 },
      chatId,
    );
    expect(await listMessages(db, chatId)).toHaveLength(1);
  });

  it('matches with NO date window when the echo omits dateCreated', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-nw',
      chatId,
      chatGuid: 'c1',
      text: 'ping',
      now: 5,
    });
    // dateCreated undefined → the `window` fragment is empty; content match alone promotes.
    await reconcileEchoByContent(db, { guid: 'real-nw', isFromMe: true, text: 'ping' }, chatId);
    expect(msgState(raw, 'real-nw')?.s).toBe('sent');
    expect(queueCount(raw, 'temp-nw')).toBe(0);
  });
});

describe('reconcileOutgoingAttachmentByContent — sync-safe promote', () => {
  it('promotes a still-pending optimistic picture that owns a local attachment', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingAttachment(db, {
      tempGuid: 'temp-att1',
      attachmentGuid: 'temp-att1-att',
      chatId,
      chatGuid: 'c1',
      localPath: 'file:///p.jpg',
      mimeType: 'image/jpeg',
      transferName: 'p.jpg',
      totalBytes: 10,
      now: 100,
    });
    await reconcileOutgoingAttachmentByContent(
      db,
      { guid: 'rcs-real-1', isFromMe: true, text: null, dateCreated: 100 },
      chatId,
    );
    expect(msgState(raw, 'rcs-real-1')?.s).toBe('sent');
    const id = (
      raw.prepare('SELECT id FROM messages WHERE guid = ?').get('rcs-real-1') as { id: number }
    ).id;
    const atts = (await listAttachmentsByMessageIds(db, [id])).get(id)!;
    expect(atts[0]!.localPath).toBe('file:///p.jpg'); // on-disk file preserved through the promote
  });

  it('does NOT match a text-only pending send (no local attachment to protect)', async () => {
    const { db } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-txt',
      chatId,
      chatGuid: 'c1',
      text: 'hi',
      now: 100,
    });
    await reconcileOutgoingAttachmentByContent(
      db,
      { guid: 'rcs-real-2', isFromMe: true, text: 'hi', dateCreated: 100 },
      chatId,
    );
    // temp text row is NOT hijacked by the attachment reconcile.
    expect(((await listMessages(db, chatId)) as Array<{ guid: string }>)[0]!.guid).toBe('temp-txt');
  });

  it('no-ops for a received message and for an already-materialized guid', async () => {
    const { db } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    // not-from-me guard:
    await reconcileOutgoingAttachmentByContent(
      db,
      { guid: 'r', isFromMe: false, dateCreated: 1 },
      chatId,
    );
    // already-exists guard:
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'exists-1',
          isFromMe: true,
          dateCreated: 1,
          chats: [{ guid: 'c1' }],
        }),
      ],
      () => chatId,
      new Map(),
    );
    await reconcileOutgoingAttachmentByContent(
      db,
      { guid: 'exists-1', isFromMe: true, dateCreated: 1 },
      chatId,
    );
    expect(await listMessages(db, chatId)).toHaveLength(1);
  });
});

describe('cancelled-in-flight set — bounded eviction', () => {
  it('evicts the oldest entry once the cap is exceeded', async () => {
    const { db } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    // Arm > CANCELLED_SET_MAX (256) cancels; each 'sending' cancel calls markCancelled.
    const guids: string[] = [];
    for (let i = 0; i < 300; i++) {
      const g = `temp-evict-${i}`;
      guids.push(g);
      await insertOutgoingText(db, { tempGuid: g, chatId, chatGuid: 'c1', text: `m${i}`, now: i });
      await cancelOutgoing(db, g);
    }
    // The first of the 300 is well past the cap → evicted; the last is still present.
    expect(wasCancelledInFlight(guids[0]!)).toBe(false);
    expect(wasCancelledInFlight(guids[299]!)).toBe(true);
  });
});
