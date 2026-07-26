/**
 * Branch top-ups for src/db/repositories/outgoing.ts — the guard clauses, backstops, and
 * cancelled-send paths not exercised by echoReconcile/outgoingQueueService. Every case
 * asserts observable DB state (or a documented return value).
 */
import type Database from 'better-sqlite3';
import { Chat, Message } from '@core/models';
import {
  applyServerSendError,
  cancelOutgoing,
  getChatIdByGuid,
  insertOutgoingAttachment,
  insertOutgoingText,
  listAttachmentsByMessageIds,
  listMessages,
  listMessagesWithSenders,
  markOutgoingSentNoGuid,
  reconcileEchoByContent,
  reconcileOutgoingAttachmentByContent,
  reconcileOutgoingError,
  reconcileOutgoingSuccess,
  upsertChats,
  upsertHandles,
  upsertMessages,
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
    { s: string; e: number } | undefined;
/** date_deleted for a guid: undefined = no row, null = live, a number = tombstoned. */
const tombstone = (raw: Database.Database, guid: string): number | null | undefined =>
  (
    raw.prepare('SELECT date_deleted d FROM messages WHERE guid = ?').get(guid) as
      | { d: number | null }
      | undefined
  )?.d;
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

  // Cleared, because an orphan queue row re-sends blind on the next drain — but reported as
  // not-owned: clearing an orphan is not the same as removing the user's message, and the Delete
  // path skips its tombstone when this answers true.
  it('clears a STRANDED queue row that has no matching temp message, reporting not-owned', async () => {
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
    expect(await cancelOutgoing(db, 'temp-s')).toBe(false);
    expect(queueCount(raw, 'temp-s')).toBe(0);
  });

  it("an 'error' cancel TOMBSTONES rather than deleting — the server may still have it", async () => {
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
    expect(await cancelOutgoing(db, 'temp-err', 9_000)).toBe(true);
    // 'error' is NOT proof the server never got it: a send can fail client-side (a 30s HTTP
    // timeout) after the origin processed it. The row has to survive so the later echo can
    // carry the deletion onto the real guid.
    expect(tombstone(raw, 'temp-err')).toBe(9_000);
    // …and invisible either way (listMessagesWithSenders is the render query; it filters tombstones)
    expect(await listMessagesWithSenders(db, chatId)).toHaveLength(0);
    expect(queueCount(raw, 'temp-err')).toBe(0);
  });

  it("a 'sending' cancel survives a late success-ack whose echo already landed (dup branch)", async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-snd',
      chatId,
      chatGuid: 'c1',
      text: 'hi',
      now: 1,
    });
    expect(await cancelOutgoing(db, 'temp-snd', 9_000)).toBe(true);
    // The socket echo beat the ack and inserted the real message.
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
    // The in-flight POST resolves late. The dup branch destroys the temp row, so it must carry the
    // tombstone across first — a HARD delete of the real guid here was undone by the next re-page.
    await reconcileOutgoingSuccess(db, 'temp-snd', {
      guid: 'real-snd',
      dateCreated: 1,
      dateDelivered: null,
    });
    expect(await listMessagesWithSenders(db, chatId)).toHaveLength(0); // cancelled stays cancelled
    expect(tombstone(raw, 'real-snd')).toBe(9_000);
    // A re-page cannot bring it back: date_deleted is absent from upsertMessages' conflict set.
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
    expect(await listMessagesWithSenders(db, chatId)).toHaveLength(0);
  });

  it('a late NO-GUID (AppleScript/RCS) ack after a cancel keeps the row hidden, not resurrected', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-ng',
      chatId,
      chatGuid: 'c1',
      text: 'hi',
      now: 1,
    });
    expect(await cancelOutgoing(db, 'temp-ng', 9_000)).toBe(true);
    // The guid-less ack resolves late. It flips the state, never the tombstone — the row has to
    // stay so the fanout's rcs-<id> is promoted ONTO it (carrying date_deleted) instead of
    // inserting a fresh, visible bubble.
    await markOutgoingSentNoGuid(db, 'temp-ng');
    expect(msgState(raw, 'temp-ng')?.s).toBe('sent');
    expect(tombstone(raw, 'temp-ng')).toBe(9_000);
    expect(queueCount(raw, 'temp-ng')).toBe(0);
    await reconcileEchoByContent(
      db,
      { guid: 'rcs-42', isFromMe: true, text: 'hi', dateCreated: 1 },
      chatId,
    );
    expect(tombstone(raw, 'rcs-42')).toBe(9_000);
    expect(await listMessagesWithSenders(db, chatId)).toHaveLength(0);
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

  it('reports FALSE when no queue row owns the guid (so a caller can fall through)', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-noq',
      chatId,
      chatGuid: 'c1',
      text: 'hi',
      now: 1,
    });
    raw.prepare("DELETE FROM outgoing_queue WHERE temp_guid='temp-noq'").run();

    expect(await reconcileOutgoingError(db, 'temp-noq', 42, 1_000)).toBe(false);
    // The bubble is still flipped — only the ladder had nothing to advance.
    expect(msgState(raw, 'temp-noq')).toEqual({ s: 'error', e: 42 });
  });
});

/**
 * P3/P4 — the two guards in this file that used to read a value into JavaScript and then use the
 * stale copy as the condition for a write. Both are now compare-and-set.
 */
describe('sticky-error and ladder-ownership guards are IN the write', () => {
  it('markOutgoingSentNoGuid does not promote an errored row, and leaves its ladder alone', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-sticky',
      chatId,
      chatGuid: 'c1',
      text: 'hi',
      now: 1,
    });
    // The server-pushed failure landed just before the success ack.
    await reconcileOutgoingError(db, 'temp-sticky', 77, 1_000);

    await markOutgoingSentNoGuid(db, 'temp-sticky');

    expect(msgState(raw, 'temp-sticky')).toEqual({ s: 'error', e: 77 });
    expect(queueCount(raw, 'temp-sticky')).toBe(1); // retry ladder intact
  });

  it('markOutgoingSentNoGuid still clears a queue row whose message is gone (no blind re-send)', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-orph',
      chatId,
      chatGuid: 'c1',
      text: 'hi',
      now: 1,
    });
    raw.prepare("DELETE FROM messages WHERE guid='temp-orph'").run();

    await markOutgoingSentNoGuid(db, 'temp-orph');

    expect(queueCount(raw, 'temp-orph')).toBe(0);
  });

  /**
   * The retryable branch of applyServerSendError only exists for the RCS immediate-ack flow, where
   * the ack has ALREADY deleted the queue row by the time the failure arrives. Deciding on a
   * separate "is there a queue row?" SELECT meant that when the ack landed between the read and the
   * write, the UPDATE matched nothing, reported nothing, and the re-enqueue was never reached.
   */
  it('applyServerSendError re-enqueues when the ladder is gone, instead of silently doing nothing', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-reenq',
      chatId,
      chatGuid: 'c1',
      text: 'relay me',
      now: 1,
    });
    // The immediate ack: bubble marked sent, queue row consumed.
    raw.prepare("UPDATE messages SET send_state='sent' WHERE guid='temp-reenq'").run();
    raw.prepare("DELETE FROM outgoing_queue WHERE temp_guid='temp-reenq'").run();

    await applyServerSendError(db, 'temp-reenq', 502, 5_000_000, true);

    expect(msgState(raw, 'temp-reenq')).toEqual({ s: 'error', e: 502 });
    const q = raw
      .prepare("SELECT kind, attempts a FROM outgoing_queue WHERE temp_guid='temp-reenq'")
      .get() as { kind: string; a: number };
    expect(q).toMatchObject({ kind: 'text', a: 1 });
  });

  it('applyServerSendError advances the EXISTING ladder rather than re-enqueuing a second one', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-live',
      chatId,
      chatGuid: 'c1',
      text: 'fast fail',
      now: 1,
    });

    await applyServerSendError(db, 'temp-live', 502, 5_000_000, true);

    expect(queueCount(raw, 'temp-live')).toBe(1); // one ladder, not two
    const q = raw
      .prepare("SELECT attempts a, next_retry_at n FROM outgoing_queue WHERE temp_guid='temp-live'")
      .get() as { a: number; n: number };
    expect(q.a).toBe(1);
    expect(q.n).toBe(5_000_000 + 30_000);
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

describe('a cancelled send vs a later IDENTICAL one', () => {
  /**
   * Both rows match the echo by content, so the ORDER BY has to prefer the LIVE one. Promoting the
   * tombstoned row instead would hide the message the user actually sent and leave the visible
   * bubble stuck on its temp identity.
   */
  it('promotes the live send first, and the cancelled one only on its own echo', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, { tempGuid: 'temp-a', chatId, chatGuid: 'c1', text: 'ok', now: 1 });
    await cancelOutgoing(db, 'temp-a', 9_000);
    await insertOutgoingText(db, { tempGuid: 'temp-b', chatId, chatGuid: 'c1', text: 'ok', now: 2 });

    await reconcileEchoByContent(
      db,
      { guid: 'real-b', isFromMe: true, text: 'ok', dateCreated: 2 },
      chatId,
    );
    expect(tombstone(raw, 'real-b')).toBeNull(); // the LIVE send took the echo
    expect(msgState(raw, 'temp-a')).toBeDefined(); // the cancelled one is still waiting

    // The cancelled send's own echo (it had left the device) then finds the only candidate left.
    await reconcileEchoByContent(
      db,
      { guid: 'real-a', isFromMe: true, text: 'ok', dateCreated: 1 },
      chatId,
    );
    expect(tombstone(raw, 'real-a')).toBe(9_000);
    const visible = await listMessagesWithSenders(db, chatId);
    expect(visible.map((m) => m.guid)).toEqual(['real-b']);
  });
});
