import type Database from 'better-sqlite3';
import { Chat } from '@core/models';
import {
  cancelOutgoing,
  insertOutgoingText,
  reconcileOutgoingError,
  reconcileOutgoingSuccess,
  upsertChats,
  upsertHandles,
  wasCancelledInFlight,
} from '@db/repositories';
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

describe('cancelOutgoing (2.3)', () => {
  it('removes a still-sending optimistic message + its queue row', async () => {
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

    const cancelled = await cancelOutgoing(db, 'temp-1');

    expect(cancelled).toBe(true);
    expect(count(raw, 'messages', 'guid = ?', 'temp-1')).toBe(0);
    expect(count(raw, 'outgoing_queue', 'temp_guid = ?', 'temp-1')).toBe(0);
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

    const cancelled = await cancelOutgoing(db, 'temp-err');

    expect(cancelled).toBe(true);
    expect(count(raw, 'messages', 'guid = ?', 'temp-err')).toBe(0);
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
   * REGRESSION GUARD for the `AND send_state IN ('sending','error')` filter.
   *
   * Every other test in this file reaches `cancelOutgoing`'s FIRST guard (no queue row →
   * return false), so the send_state filter was executed by no test at all — deleting it from
   * the query left the whole suite green.
   *
   * The state it defends against is real: a reconcile can promote the message to 'sent' while
   * its queue row is still present (an ack that didn't clear the queue, or a drain racing the
   * reconcile). Without the filter, Cancel then hard-DELETES a message that was already
   * delivered — the user sees it vanish from a conversation the recipient has already read.
   */
  it('never deletes a DELIVERED message, even while its queue row still exists', async () => {
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
    expect(cancelled).toBe(true);
    expect(count(raw, 'outgoing_queue', 'temp_guid = ?', 'temp-sent')).toBe(0);
    // ...but the delivered message MUST survive. This is the assertion the filter protects.
    expect(count(raw, 'messages', 'guid = ?', 'temp-sent')).toBe(1);
    const row = raw
      .prepare(`SELECT send_state s, text t FROM messages WHERE guid = 'temp-sent'`)
      .get() as { s: string; t: string };
    expect(row.s).toBe('sent');
    expect(row.t).toBe('already delivered');
    // A delivered message was never in flight, so nothing should be marked cancelled.
    expect(wasCancelledInFlight('temp-sent')).toBe(false);
  });

  it('clears a stranded queue row whose temp message is gone', async () => {
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

    expect(cancelled).toBe(true);
    expect(count(raw, 'outgoing_queue', 'temp_guid = ?', 'temp-3')).toBe(0);
  });

  // Fix #7: a 'sending' row may have a POST already in flight when the user cancels.
  // The server still echoes it back; the cancel must STICK — the bubble must not reappear.
  describe('cancel of an in-flight send vs the server echo (2.3 / fix #7)', () => {
    it('drops the reconcile echo so a cancelled in-flight send does not reappear', async () => {
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
      expect(await cancelOutgoing(db, 'temp-flight')).toBe(true);
      expect(wasCancelledInFlight('temp-flight')).toBe(true); // remembered
      expect(count(raw, 'messages', 'guid = ?', 'temp-flight')).toBe(0);

      // The POST resolves AFTER the cancel → reconcile lands with the real guid. It must
      // NOT re-materialize the message, and the cancelled marker is consumed.
      await reconcileOutgoingSuccess(db, 'temp-flight', {
        guid: 'real-flight',
        dateCreated: 100,
        dateDelivered: 200,
      });
      expect(count(raw, 'messages', 'guid = ?', 'real-flight')).toBe(0); // echo dropped
      expect(count(raw, 'messages', 'guid = ?', 'temp-flight')).toBe(0);
      expect(count(raw, 'outgoing_queue', 'temp_guid = ?', 'temp-flight')).toBe(0);
      expect(wasCancelledInFlight('temp-flight')).toBe(false); // consumed
    });

    it('also deletes a socket-echoed row that landed under the real guid before reconcile', async () => {
      const { db, raw } = await createTestDb();
      const chatId = await seedChat(db, 'c1');
      await insertOutgoingText(db, {
        tempGuid: 'temp-echo',
        chatId,
        chatGuid: 'c1',
        text: 'raced',
        now: 100,
      });
      await cancelOutgoing(db, 'temp-echo');

      // Simulate the socket echo (DbEventSink) inserting the real message first.
      raw
        .prepare(
          "INSERT INTO messages (guid, chat_id, text, is_from_me, date_created, send_state, error) VALUES (?, ?, ?, 1, 100, 'sent', 0)",
        )
        .run('real-echo', chatId, 'raced');
      expect(count(raw, 'messages', 'guid = ?', 'real-echo')).toBe(1);

      // The send service's reconcile then runs → it should remove the echoed row too.
      await reconcileOutgoingSuccess(db, 'temp-echo', {
        guid: 'real-echo',
        dateCreated: 100,
        dateDelivered: null,
      });
      expect(count(raw, 'messages', 'guid = ?', 'real-echo')).toBe(0);
    });

    it('cancelling an ERRORED row (no POST in flight) does not arm the echo-drop', async () => {
      const { db } = await createTestDb();
      const chatId = await seedChat(db, 'c1');
      await insertOutgoingText(db, {
        tempGuid: 'temp-errd',
        chatId,
        chatGuid: 'c1',
        text: 'failed',
        now: 100,
      });
      await reconcileOutgoingError(db, 'temp-errd', 500, 1000);

      expect(await cancelOutgoing(db, 'temp-errd')).toBe(true);
      // 'error' rows have no in-flight POST, so nothing is armed to suppress.
      expect(wasCancelledInFlight('temp-errd')).toBe(false);
    });
  });
});
