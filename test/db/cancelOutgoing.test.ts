import type Database from 'better-sqlite3';
import { Chat, Message } from '@core/models';
import {
  cancelOutgoing,
  insertOutgoingText,
  listMessagesWithSenders,
  reconcileEchoByContent,
  reconcileOutgoingError,
  reconcileOutgoingSuccess,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

async function seedChat(db: AppDatabase, guid: string): Promise<number> {
  const handles = await upsertHandles(db, [{ address: 'a@x.com' }]);
  const map = await upsertChats(
    db,
    [Chat.parse({ guid, participants: [{ address: 'a@x.com' }] })],
    handles,
  );
  return map.get(guid)!;
}

function count(raw: Database.Database, table: string, where: string, ...args: unknown[]): number {
  return (
    raw.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${where}`).get(...args) as { c: number }
  ).c;
}
/** date_deleted for a guid: undefined = no row, null = live, a number = tombstoned. */
const tombstone = (raw: Database.Database, guid: string): number | null | undefined =>
  (
    raw.prepare('SELECT date_deleted d FROM messages WHERE guid = ?').get(guid) as
      { d: number | null } | undefined
  )?.d;

describe('cancelOutgoing (2.3)', () => {
  it('hides a still-sending optimistic message and drops its queue row', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-1',
      chatId,
      chatGuid: 'c1',
      text: 'hi',
      now: 100,
    });
    expect(count(raw, 'messages', 'guid = ?', 'temp-1')).toBe(1);
    expect(count(raw, 'outgoing_queue', 'temp_guid = ?', 'temp-1')).toBe(1);

    const cancelled = await cancelOutgoing(db, 'temp-1', 9_000);

    expect(cancelled).toBe(true);
    // A TOMBSTONE, not a row removal: the POST is in flight by definition, so the row has to
    // survive for the echo to promote in place and carry date_deleted onto the real guid.
    expect(tombstone(raw, 'temp-1')).toBe(9_000);
    expect(await listMessagesWithSenders(db, chatId)).toHaveLength(0);
    expect(count(raw, 'outgoing_queue', 'temp_guid = ?', 'temp-1')).toBe(0);
    // The chat's sort key follows the surviving messages (there are none here).
    const d = raw.prepare('SELECT latest_message_date d FROM chats WHERE id = ?').get(chatId) as {
      d: number | null;
    };
    expect(d.d).toBeNull();
  });

  it('removes an errored optimistic message (the failed bubble)', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-err',
      chatId,
      chatGuid: 'c1',
      text: 'oops',
      now: 100,
    });
    await reconcileOutgoingError(db, 'temp-err', 10003, 1000);
    expect(count(raw, 'messages', "guid = ? AND send_state = 'error'", 'temp-err')).toBe(1);

    const cancelled = await cancelOutgoing(db, 'temp-err', 9_000);

    expect(cancelled).toBe(true);
    expect(tombstone(raw, 'temp-err')).toBe(9_000);
    expect(await listMessagesWithSenders(db, chatId)).toHaveLength(0);
    expect(count(raw, 'outgoing_queue', 'temp_guid = ?', 'temp-err')).toBe(0);
  });

  it('is a guarded no-op once the send is reconciled to its real guid', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-2',
      chatId,
      chatGuid: 'c1',
      text: 'sent already',
      now: 100,
    });
    // The send succeeded: temp promoted to the real guid, queue row dropped.
    await reconcileOutgoingSuccess(db, 'temp-2', {
      guid: 'real-2',
      dateCreated: 100,
      dateDelivered: 200,
    });
    expect(count(raw, 'messages', 'guid = ?', 'real-2')).toBe(1);
    expect(count(raw, 'outgoing_queue', 'temp_guid = ?', 'temp-2')).toBe(0);

    // Cancelling the now-stale tempGuid must NOT touch the confirmed real message.
    const cancelled = await cancelOutgoing(db, 'temp-2');

    expect(cancelled).toBe(false);
    expect(count(raw, 'messages', 'guid = ?', 'real-2')).toBe(1);
  });

  it('returns false for an unknown tempGuid', async () => {
    const { db } = await createTestDb();
    await seedChat(db, 'c1');
    expect(await cancelOutgoing(db, 'temp-nope')).toBe(false);
  });

  /**
   * REGRESSION GUARD for the `AND send_state IN ('sending','error')` compare-and-set.
   *
   * The state it defends against is real: a reconcile can promote the message to 'sent' while
   * its queue row is still present (an ack that didn't clear the queue, or a drain racing the
   * reconcile). Without the guard, Cancel hard-DELETES a message that was already delivered —
   * the user sees it vanish from a conversation the recipient has already read.
   *
   * It must also report NOT-OWNED. The Delete path treats `true` as "handled" and skips the
   * tombstone, so answering true for a queue-row-only cleanup left the message the user asked to
   * delete on screen, with no error, and its retry ladder stripped.
   */
  it('never deletes a DELIVERED message, and reports it did not own it', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-sent',
      chatId,
      chatGuid: 'c1',
      text: 'already delivered',
      now: 100,
    });
    // Promote the message to 'sent' but deliberately LEAVE the queue row in place.
    raw.prepare(`UPDATE messages SET send_state = 'sent' WHERE guid = 'temp-sent'`).run();
    expect(count(raw, 'outgoing_queue', 'temp_guid = ?', 'temp-sent')).toBe(1);

    const cancelled = await cancelOutgoing(db, 'temp-sent');

    // The stale queue row is cleared (so it can't be retried)...
    expect(cancelled).toBe(false); // ...but this call did NOT own the message — the caller decides
    expect(count(raw, 'outgoing_queue', 'temp_guid = ?', 'temp-sent')).toBe(0);
    // ...but the delivered message MUST survive. This is the assertion the filter protects.
    expect(count(raw, 'messages', 'guid = ?', 'temp-sent')).toBe(1);
    const row = raw
      .prepare(`SELECT send_state s, text t FROM messages WHERE guid = 'temp-sent'`)
      .get() as { s: string; t: string };
    expect(row.s).toBe('sent');
    expect(row.t).toBe('already delivered');
  });

  // An orphan queue row is still cleared — left alone it re-sends blind on the next drain — but
  // clearing it is not owning a message, so the caller is told nothing was cancelled.
  it('clears a stranded queue row whose temp message is gone, reporting not-owned', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-3',
      chatId,
      chatGuid: 'c1',
      text: 'orphan',
      now: 100,
    });
    // Simulate the message being removed out-of-band, leaving only the queue row.
    raw.prepare('DELETE FROM messages WHERE guid = ?').run('temp-3');

    const cancelled = await cancelOutgoing(db, 'temp-3');

    expect(cancelled).toBe(false);
    expect(count(raw, 'outgoing_queue', 'temp_guid = ?', 'temp-3')).toBe(0);
  });

  // A 'sending' row has a POST in flight by definition. The server still echoes it back; the
  // cancel must STICK — through the ack, through the echo, and through every later re-page.
  describe('cancel of an in-flight send vs the server echo', () => {
    it('promotes the tombstone onto the real guid, so the ack cannot re-materialize it', async () => {
      const { db, raw } = await createTestDb();
      const chatId = await seedChat(db, 'c1');
      await insertOutgoingText(db, {
        tempGuid: 'temp-flight',
        chatId,
        chatGuid: 'c1',
        text: 'too late',
        now: 100,
      });

      // User cancels while it's still 'sending' (POST already in flight).
      expect(await cancelOutgoing(db, 'temp-flight', 9_000)).toBe(true);
      expect(await listMessagesWithSenders(db, chatId)).toHaveLength(0);

      // The POST resolves AFTER the cancel → reconcile lands with the real guid. The promote is
      // in place, so the deletion moves onto the identity the SERVER holds — which is what makes
      // it survive `ensureChatSynced`'s re-page on the next chat open.
      await reconcileOutgoingSuccess(db, 'temp-flight', {
        guid: 'real-flight',
        dateCreated: 100,
        dateDelivered: 200,
      });
      expect(tombstone(raw, 'real-flight')).toBe(9_000);
      expect(count(raw, 'messages', 'guid = ?', 'temp-flight')).toBe(0);
      expect(count(raw, 'outgoing_queue', 'temp_guid = ?', 'temp-flight')).toBe(0);
      expect(await listMessagesWithSenders(db, chatId)).toHaveLength(0);

      // THE REGRESSION: a hard delete here was undone by the very next chat open.
      await upsertMessages(
        db,
        [
          Message.parse({
            guid: 'real-flight',
            isFromMe: true,
            text: 'too late',
            dateCreated: 100,
          }),
        ],
        () => chatId,
        new Map(),
      );
      expect(await listMessagesWithSenders(db, chatId)).toHaveLength(0);
    });

    it('carries the tombstone onto a socket-echoed row that landed before the ack', async () => {
      const { db, raw } = await createTestDb();
      const chatId = await seedChat(db, 'c1');
      await insertOutgoingText(db, {
        tempGuid: 'temp-echo',
        chatId,
        chatGuid: 'c1',
        text: 'raced',
        now: 100,
      });
      await cancelOutgoing(db, 'temp-echo', 9_000);

      // Simulate the socket echo (DbEventSink) inserting the real message first.
      raw
        .prepare(
          "INSERT INTO messages (guid, chat_id, text, is_from_me, date_created, send_state, error) VALUES (?, ?, ?, 1, 100, 'sent', 0)",
        )
        .run('real-echo', chatId, 'raced');
      expect(count(raw, 'messages', 'guid = ?', 'real-echo')).toBe(1);

      // The send service's reconcile then runs. This is the ONE branch that destroys the temp row
      // instead of promoting it, so it must move date_deleted across by hand.
      await reconcileOutgoingSuccess(db, 'temp-echo', {
        guid: 'real-echo',
        dateCreated: 100,
        dateDelivered: null,
      });
      expect(tombstone(raw, 'real-echo')).toBe(9_000);
      expect(await listMessagesWithSenders(db, chatId)).toHaveLength(0);
    });

    it('an ERRORED row is tombstoned too — client-side failure is not proof of non-delivery', async () => {
      const { db, raw } = await createTestDb();
      const chatId = await seedChat(db, 'c1');
      await insertOutgoingText(db, {
        tempGuid: 'temp-errd',
        chatId,
        chatGuid: 'c1',
        text: 'failed',
        now: 100,
      });
      await reconcileOutgoingError(db, 'temp-errd', 500, 1000);

      expect(await cancelOutgoing(db, 'temp-errd', 9_000)).toBe(true);
      expect(tombstone(raw, 'temp-errd')).toBe(9_000);

      // The send had actually gone through; its echo arrives minutes later. Promoted in place,
      // still hidden — a hard delete here left nothing for the echo to attach the deletion to and
      // the message returned as an ordinary sent bubble.
      await withDbTransaction(db, (context) =>
        reconcileEchoByContent(
          context,
          { guid: 'real-errd', isFromMe: true, text: 'failed', dateCreated: 100 },
          chatId,
        ),
      );
      expect(tombstone(raw, 'real-errd')).toBe(9_000);
      expect(await listMessagesWithSenders(db, chatId)).toHaveLength(0);
    });
  });
});
