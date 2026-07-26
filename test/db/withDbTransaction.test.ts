import type Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { Chat } from '@core/models';
import { logger } from '@core/secure';
import {
  getChatIdByGuid,
  insertOutgoingText,
  reconcileEchoByContent,
  upsertChats,
  upsertHandles,
} from '@db/repositories';
import { withDbTransaction, withDbWriteLock } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

// withDbTransaction exists for ONE call site today: DbEventSink wraps
// reconcileEchoByContent + upsertMessages so the queue-delete and the temp→real guid promote
// commit atomically (a crash in the gap used to strand a queue-less unpromoted temp row — a
// permanent duplicate bubble). These tests exercise that exact pair through the helper.

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

/**
 * The two writes of an optimistic send, spelled out instead of calling `insertOutgoingText`.
 *
 * That helper now owns ITS OWN transaction (the queue row and the bubble must commit together),
 * and `withDbTransaction` must never be re-entered from inside a callback — the nested call waits
 * on the lock its own caller holds and every later write in the process hangs behind it. Using a
 * self-transacting helper as a transaction BODY would therefore be testing the one thing the
 * helper forbids; these tests need any pair of plain writes, so they use plain writes.
 */
async function queueSend(
  db: AppDatabase,
  args: { chatId: number; chatGuid: string; tempGuid: string; text: string; now: number },
): Promise<void> {
  await db.run(sql`
    INSERT INTO outgoing_queue (temp_guid, chat_guid, kind, payload)
    VALUES (${args.tempGuid}, ${args.chatGuid}, 'text', ${JSON.stringify({ message: args.text })})`);
  await db.run(sql`
    INSERT INTO messages (guid, chat_id, text, is_from_me, date_created, send_state, error)
    VALUES (${args.tempGuid}, ${args.chatId}, ${args.text}, 1, ${args.now}, 'sending', 0)`);
}

describe('withDbTransaction', () => {
  it('commits: the echo-reconcile inside the transaction persists and the result is returned', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'cTx1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-tx1',
      chatId,
      chatGuid: 'cTx1',
      text: 'hello',
      now: 1000,
    });

    const result = await withDbTransaction(db, async () => {
      await reconcileEchoByContent(
        db,
        { guid: 'real-tx1', isFromMe: true, text: 'hello', dateCreated: 1000 },
        chatId,
      );
      return 'done';
    });

    expect(result).toBe('done');
    // Queue row dropped and temp row promoted — both committed.
    expect(count(raw, 'outgoing_queue', 'temp_guid = ?', 'temp-tx1')).toBe(0);
    expect(count(raw, 'messages', 'guid = ?', 'real-tx1')).toBe(1);
    expect(count(raw, 'messages', 'guid = ?', 'temp-tx1')).toBe(0);
  });

  it('rolls back: a failure after the reconcile restores the queue row AND the temp identity', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'cTx2');
    await insertOutgoingText(db, {
      tempGuid: 'temp-tx2',
      chatId,
      chatGuid: 'cTx2',
      text: 'hello',
      now: 1000,
    });

    await expect(
      withDbTransaction(db, async () => {
        await reconcileEchoByContent(
          db,
          { guid: 'real-tx2', isFromMe: true, text: 'hello', dateCreated: 1000 },
          chatId,
        );
        throw new Error('upsert failed');
      }),
    ).rejects.toThrow('upsert failed');

    // Neither half of the reconcile survived: the queue row is back and the message row still
    // carries its temp identity (no half-promoted state).
    expect(count(raw, 'outgoing_queue', 'temp_guid = ?', 'temp-tx2')).toBe(1);
    expect(count(raw, 'messages', 'guid = ?', 'temp-tx2')).toBe(1);
    expect(count(raw, 'messages', 'guid = ?', 'real-tx2')).toBe(0);
  });

  it('a later write on the same connection still works after a rollback', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'cTx3');

    await expect(
      withDbTransaction(db, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // The connection is out of the failed transaction — a normal autocommit write succeeds.
    await insertOutgoingText(db, {
      tempGuid: 'temp-tx3',
      chatId,
      chatGuid: 'cTx3',
      text: 'after',
      now: 2000,
    });
    expect(count(raw, 'messages', 'guid = ?', 'temp-tx3')).toBe(1);
  });
});

// The serialization contract. There is ONE shared connection, so only one transaction may be
// open at a time — and nothing upstream enforces that: socket/FCM events are dispatched
// fire-and-forget and DbEventSink awaits several round-trips before it reaches its transaction,
// so two handlers really do land on BEGIN IMMEDIATE at once. Un-queued, the second BEGIN throws
// on the shared connection and its whole event is lost (no row, no notification, no retry —
// the router's rejection dies in a `void`). These tests pin the queue that prevents it.
describe('withDbTransaction serialization', () => {
  it('two overlapping transactions both commit — neither call rejects', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'cTx4');

    // Deliberately NOT awaiting the first before starting the second: this is the real
    // interleave, and it is what breaks without the queue.
    const first = withDbTransaction(db, () =>
      queueSend(db, {
        tempGuid: 'temp-tx4a',
        chatId,
        chatGuid: 'cTx4',
        text: 'first',
        now: 1000,
      }),
    );
    const second = withDbTransaction(db, () =>
      queueSend(db, {
        tempGuid: 'temp-tx4b',
        chatId,
        chatGuid: 'cTx4',
        text: 'second',
        now: 1001,
      }),
    );

    // Neither may reject (Promise.all surfaces either rejection as a test failure).
    await Promise.all([first, second]);

    // Both messages AND both queue rows survived — no transaction ate the other's writes.
    expect(count(raw, 'messages', 'guid = ?', 'temp-tx4a')).toBe(1);
    expect(count(raw, 'messages', 'guid = ?', 'temp-tx4b')).toBe(1);
    expect(count(raw, 'outgoing_queue', 'temp_guid = ?', 'temp-tx4a')).toBe(1);
    expect(count(raw, 'outgoing_queue', 'temp_guid = ?', 'temp-tx4b')).toBe(1);
  });

  it('runs queued transactions in submission order, never interleaved', async () => {
    const { db } = await createTestDb();
    const order: string[] = [];
    const tx = (tag: string): Promise<void> =>
      withDbTransaction(db, async () => {
        order.push(`${tag}:start`);
        // Yield mid-transaction — a later caller must still not slip in here.
        await Promise.resolve();
        order.push(`${tag}:end`);
      });

    await Promise.all([tx('a'), tx('b'), tx('c')]);

    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  it('a rejecting transaction rolls back its own writes without poisoning the queue', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'cTx5');

    const failing = withDbTransaction(db, async () => {
      await queueSend(db, {
        tempGuid: 'temp-tx5-bad',
        chatId,
        chatGuid: 'cTx5',
        text: 'doomed',
        now: 1000,
      });
      throw new Error('sink blew up');
    });
    const next = withDbTransaction(db, () =>
      queueSend(db, {
        tempGuid: 'temp-tx5-ok',
        chatId,
        chatGuid: 'cTx5',
        text: 'survivor',
        now: 1001,
      }),
    );

    await expect(failing).rejects.toThrow('sink blew up');
    // The queue link can only resolve, so the failure does not propagate to the next caller.
    await expect(next).resolves.toBeUndefined();

    expect(count(raw, 'messages', 'guid = ?', 'temp-tx5-bad')).toBe(0);
    expect(count(raw, 'messages', 'guid = ?', 'temp-tx5-ok')).toBe(1);
  });

  it('a failed BEGIN releases the queue instead of wedging every later write', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'cTx6');

    // A transaction opened outside the helper (the documented bystander caveat) makes
    // BEGIN IMMEDIATE throw — BEFORE the inner try/catch that owns ROLLBACK. If the queue slot
    // leaked on that path, every subsequent write in the process would hang forever.
    raw.exec('BEGIN');
    let ranBody = false;
    await expect(
      withDbTransaction(db, async () => {
        ranBody = true;
      }),
    ).rejects.toThrow();
    raw.exec('ROLLBACK');
    expect(ranBody).toBe(false);

    await withDbTransaction(db, () =>
      queueSend(db, {
        tempGuid: 'temp-tx6',
        chatId,
        chatGuid: 'cTx6',
        text: 'after a failed BEGIN',
        now: 2000,
      }),
    );
    expect(count(raw, 'messages', 'guid = ?', 'temp-tx6')).toBe(1);
  });
});

/**
 * The wait watchdog, and what it is allowed to CLAIM.
 *
 * It can only ever observe a symptom: there is no async-context propagation in Hermes, so at the
 * moment a caller is waiting, a nested (circular) wait is indistinguishable from a merely long one.
 * The level is what makes the wording load-bearing — `error` is the only level the crash-report sink
 * captures and uploads, so a duration-only "nested withDbTransaction deadlocks" line turns one slow
 * transaction (or a reconnect fanout of buffered events) into a recurring critical defect report on
 * the operator's server for a bug that does not exist. So stage 1 reports the measured wait at
 * `warn`, and only a second interval in which not ONE lock holder released anywhere escalates —
 * once per process, not once per blocked writer.
 *
 * Driven through `withDbWriteLock`, which shares the exact queue and watchdog with
 * `withDbTransaction` but needs no database, so the timings aren't entangled with driver IO.
 */
describe('write-lock wait watchdog', () => {
  const LOCK_WAIT_MS = 10_000;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
    jest.useRealTimers();
  });

  it('says nothing at all when the lock was free (the timer is cleared on the fast path)', async () => {
    await withDbWriteLock(async () => undefined);

    await jest.advanceTimersByTimeAsync(3 * LOCK_WAIT_MS);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('warns on a long wait, and escalates only once when nothing releases at all', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = withDbWriteLock(() => held);
    const waiter = withDbWriteLock(async () => undefined);
    // Let the holder take the lock (and disarm its own watchdog) before any clock moves.
    await jest.advanceTimersByTimeAsync(0);

    await jest.advanceTimersByTimeAsync(LOCK_WAIT_MS);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('waited');
    // A long wait alone must NOT be reported as a deadlock — this is the level that uploads.
    expect(error).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(LOCK_WAIT_MS);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toContain('wedged');

    // Still wedged, but the report is not re-emitted — every later blocked writer would otherwise
    // queue its own copy into the durable upload queue.
    await jest.advanceTimersByTimeAsync(5 * LOCK_WAIT_MS);
    expect(error).toHaveBeenCalledTimes(1);

    release();
    await holder;
    await waiter;
  });
});
