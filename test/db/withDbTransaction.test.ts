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
import {
  type DbTransactionContext,
  DbTransactionContextRejectedError,
  runInTransactionContext,
  withDbTransaction,
  withDbWriteLock,
} from '@db/transaction';
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function settled<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  try {
    return { status: 'fulfilled', value: await promise };
  } catch (reason) {
    return { status: 'rejected', reason };
  }
}

function orderedDatabase(order: string[]): AppDatabase {
  return {
    run: jest.fn(async (statement: unknown) => {
      const chunks = (statement as { queryChunks?: Array<{ value?: string[] }> }).queryChunks;
      const command = chunks
        ?.flatMap((chunk) => chunk.value ?? [])
        .join('')
        .trim();
      if (!command || !['BEGIN IMMEDIATE', 'COMMIT', 'ROLLBACK'].includes(command)) {
        throw new Error(`unexpected transaction SQL: ${String(command)}`);
      }
      order.push(command === 'BEGIN IMMEDIATE' ? 'BEGIN' : command);
    }),
  } as unknown as AppDatabase;
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

    const result = await withDbTransaction(db, async (transactionContext) => {
      await reconcileEchoByContent(
        transactionContext,
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
      withDbTransaction(db, async (transactionContext) => {
        await reconcileEchoByContent(
          transactionContext,
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

describe('DbTransactionContext', () => {
  it('is frozen, supplies the exact owner database, and rejects forged or committed contexts', async () => {
    const order: string[] = [];
    const db = orderedDatabase(order);
    let stale!: DbTransactionContext;

    const result = await withDbTransaction(db, async (context) => {
      stale = context;
      expect(Object.isFrozen(context)).toBe(true);
      return runInTransactionContext(context, async (transactionDb) => {
        expect(transactionDb).toBe(db);
        order.push('task');
        return 'joined';
      });
    });

    expect(result).toBe('joined');
    expect(order).toEqual(['BEGIN', 'task', 'COMMIT']);

    for (const context of [stale, Object.freeze({}) as DbTransactionContext]) {
      const callback = jest.fn(async () => undefined);
      await expect(runInTransactionContext(context, callback)).rejects.toBeInstanceOf(
        DbTransactionContextRejectedError,
      );
      expect(callback).not.toHaveBeenCalled();
    }
  });

  it('rejects an escaped context after rollback before invoking its callback', async () => {
    const order: string[] = [];
    const db = orderedDatabase(order);
    const ownerFailure = new Error('owner failed');
    let stale!: DbTransactionContext;

    await expect(
      withDbTransaction(db, async (context) => {
        stale = context;
        throw ownerFailure;
      }),
    ).rejects.toBe(ownerFailure);

    const callback = jest.fn(async () => undefined);
    await expect(runInTransactionContext(stale, callback)).rejects.toBeInstanceOf(
      DbTransactionContextRejectedError,
    );
    expect(callback).not.toHaveBeenCalled();
    expect(order).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it('waits for an ignored registered task before committing', async () => {
    const order: string[] = [];
    const db = orderedDatabase(order);
    const started = deferred<void>();
    const finish = deferred<void>();

    const transaction = withDbTransaction(db, async (context) => {
      void runInTransactionContext(context, async () => {
        order.push('task:start');
        started.resolve();
        await finish.promise;
        order.push('task:end');
      });
      order.push('owner:end');
    });

    let orderBeforeRelease: string[] = [];
    let statementsBeforeRelease = -1;
    let transactionOutcome!: PromiseSettledResult<void>;
    try {
      await started.promise;
      orderBeforeRelease = [...order];
      statementsBeforeRelease = (db.run as jest.Mock).mock.calls.length;
    } finally {
      finish.resolve();
      transactionOutcome = await settled(transaction);
    }
    expect(transactionOutcome).toEqual({ status: 'fulfilled', value: undefined });
    expect(orderBeforeRelease).toEqual(['BEGIN', 'task:start', 'owner:end']);
    expect(statementsBeforeRelease).toBe(1);
    expect(order).toEqual(['BEGIN', 'task:start', 'owner:end', 'task:end', 'COMMIT']);
  });

  it('observes an ignored task rejection, waits for its peers, and rolls back', async () => {
    const order: string[] = [];
    const db = orderedDatabase(order);
    const taskFailure = new Error('registered task failed');
    const slowStarted = deferred<void>();
    const slowTask = deferred<void>();

    const transaction = withDbTransaction(db, async (context) => {
      void runInTransactionContext(context, async () => {
        order.push('rejecting');
        throw taskFailure;
      });
      void runInTransactionContext(context, async () => {
        order.push('slow:start');
        slowStarted.resolve();
        await slowTask.promise;
        order.push('slow:end');
      });
    });

    let statementsBeforeRelease = -1;
    let transactionOutcome!: PromiseSettledResult<void>;
    try {
      await slowStarted.promise;
      statementsBeforeRelease = (db.run as jest.Mock).mock.calls.length;
    } finally {
      slowTask.resolve();
      transactionOutcome = await settled(transaction);
    }
    expect(transactionOutcome).toEqual({ status: 'rejected', reason: taskFailure });
    expect(statementsBeforeRelease).toBe(1);
    expect(order).toEqual(['BEGIN', 'rejecting', 'slow:start', 'slow:end', 'ROLLBACK']);
  });

  it('drains registered work before rolling back an owner failure', async () => {
    const order: string[] = [];
    const db = orderedDatabase(order);
    const ownerFailure = new Error('owner failed first');
    const started = deferred<void>();
    const finish = deferred<void>();

    const transaction = withDbTransaction(db, async (context) => {
      void runInTransactionContext(context, async () => {
        order.push('task:start');
        started.resolve();
        await finish.promise;
        order.push('task:end');
      });
      throw ownerFailure;
    });

    let statementsBeforeRelease = -1;
    let transactionOutcome!: PromiseSettledResult<void>;
    try {
      await started.promise;
      statementsBeforeRelease = (db.run as jest.Mock).mock.calls.length;
    } finally {
      finish.resolve();
      transactionOutcome = await settled(transaction);
    }
    expect(transactionOutcome).toEqual({ status: 'rejected', reason: ownerFailure });
    expect(statementsBeforeRelease).toBe(1);
    expect(order).toEqual(['BEGIN', 'task:start', 'task:end', 'ROLLBACK']);
  });

  it('rejects and latches a registration attempted after the owner settles', async () => {
    const order: string[] = [];
    const db = orderedDatabase(order);
    const lateCallback = jest.fn(async () => {
      order.push('late:ran');
    });

    const transaction = withDbTransaction(db, async (context) => {
      void runInTransactionContext(context, async () => {
        // A timer runs after the owner's promise continuation has synchronously closed admission.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        await runInTransactionContext(context, lateCallback).catch(() => undefined);
        order.push('late:rejected');
      });
    });

    await expect(transaction).rejects.toBeInstanceOf(DbTransactionContextRejectedError);
    expect(lateCallback).not.toHaveBeenCalled();
    expect(order).toEqual(['BEGIN', 'late:rejected', 'ROLLBACK']);
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

  it('does not escalate when a deep queue advances between the warning intervals', async () => {
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();
    let secondStarted = false;
    let tailStarted = false;

    const first = withDbWriteLock(() => firstGate.promise);
    const second = withDbWriteLock(async () => {
      secondStarted = true;
      await secondGate.promise;
    });
    const tail = withDbWriteLock(async () => {
      tailStarted = true;
    });
    try {
      await jest.advanceTimersByTimeAsync(0);

      await jest.advanceTimersByTimeAsync(LOCK_WAIT_MS);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(error).not.toHaveBeenCalled();

      firstGate.resolve();
      await first;
      await jest.advanceTimersByTimeAsync(0);
      expect(secondStarted).toBe(true);
      expect(tailStarted).toBe(false);

      // The tail is still blocked for a second full interval, but one holder released after it
      // joined the queue. That is measurable progress, not a wedge worth uploading as an error.
      await jest.advanceTimersByTimeAsync(LOCK_WAIT_MS);
      expect(error).not.toHaveBeenCalled();

      secondGate.resolve();
      await Promise.all([second, tail]);
      expect(tailStarted).toBe(true);
    } finally {
      firstGate.resolve();
      secondGate.resolve();
      await Promise.allSettled([first, second, tail]);
    }
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
