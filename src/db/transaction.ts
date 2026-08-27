import { sql } from 'drizzle-orm';
import type { DurableEventTransactionContext } from '@core/realtime';
import { logger } from '@core/secure';
import type { AppDatabase } from './types';

/**
 * Serializes {@link withDbTransaction} callers: the tail of the queue, which every new caller
 * awaits before touching BEGIN and resolves after its COMMIT/ROLLBACK.
 *
 * It is deliberately a promise that can only RESOLVE — never reject. A rejecting link would
 * poison every caller that awaits it (and the unhandled rejection would surface as a crash), so
 * a failed transaction must still hand the lock cleanly to the next one.
 */
let txQueue: Promise<void> = Promise.resolve();

/** Callers currently parked on {@link txQueue}. Context for the watchdog line only. */
let waitingForLock = 0;
/**
 * Monotonic count of lock holders that have RELEASED. The watchdog cannot observe a cycle (see
 * below), but it CAN observe that nothing at all finished while a caller waited — which is the
 * difference between "the queue is deep" and "the queue is not moving".
 */
let lockReleases = 0;
/**
 * A wedge is reported at most once per process. In a real wedge every later caller trips the same
 * watchdog, and `error` is the one level captured into the durable error-report upload queue — so
 * an unguarded escalation would POST the same report once per blocked writer, forever.
 */
let wedgeReported = false;

/**
 * Optional last-moment ownership check for account-scoped transactions. Returning `false` aborts
 * before BEGIN when the caller was revoked while waiting for the mutex, or rolls the transaction
 * back when revocation happened while its statements were running.
 */
export type DbCommitGuard = () => boolean;

/** A guarded transaction lost ownership before it could safely commit. */
export class DbCommitGuardRejectedError extends Error {
  constructor() {
    super('database commit guard rejected the transaction');
    this.name = 'DbCommitGuardRejectedError';
  }
}

function assertCommitAllowed(guard?: DbCommitGuard): void {
  if (guard && !guard()) throw new DbCommitGuardRejectedError();
}

/**
 * Run `fn` inside an explicit BEGIN IMMEDIATE / COMMIT, rolling back if it throws.
 *
 * Why not drizzle's `db.transaction()`: the better-sqlite3 driver (Node tests) delegates to
 * better-sqlite3's native `.transaction()`, which REJECTS async callbacks — while the op-sqlite
 * side is async-only. Explicit statements via `db.run(sql\`…\`)` are the one shape both drivers
 * execute identically (same non-returning-write path the repositories already rely on; prepared
 * BEGIN/COMMIT/ROLLBACK is verified to work under better-sqlite3).
 *
 * BEGIN IMMEDIATE takes the write lock up front so the transaction can't fail on upgrade later.
 *
 * SERIALIZED — one shared connection means only ONE transaction may be open at a time, and
 * nothing upstream enforces that: socket/FCM events are dispatched fire-and-forget and the sink
 * awaits several round-trips before it reaches its transaction, so two handlers really do land on
 * BEGIN IMMEDIATE at once. Un-queued, the second BEGIN throws "cannot start a transaction within a
 * transaction" and rejects the handler outright — the message is never written, `NotifyingEventSink`
 * awaits the DB sink so it never posts a notification, and the router's rethrow dies in the caller's
 * `void`. So callers queue on {@link txQueue} instead of interleaving.
 *
 * WHAT THE QUEUE DOES NOT DO — it serializes BEGIN..COMMIT, nothing else. A statement a caller
 * issues BEFORE (or after) its own transaction is a plain autocommit write on the shared
 * connection, so it silently JOINS whichever transaction happens to be open at that moment, and a
 * rollback on THAT side erases it — while the caller still holds the row ids it just read back.
 * That is a live-message-losing FK trap (a stale chat id fails `messages.chat_id REFERENCES
 * chats(id)`), and the queue cannot see it, let alone fix it. The fix belongs to the CALLER: put
 * every write an event depends on inside the one callback (see `DbEventSink.onEvent`, which pulls
 * its handle/chat upserts + chat-id lookup in with the message write).
 *
 * `fn` must NEVER call withDbTransaction itself (directly or transitively): the nested call would
 * wait on a lock its own caller holds, and because the mutex is process-wide that wedges EVERY
 * later DB write for the life of the process — a silent, unrecoverable hang with no error anywhere.
 * The rule is easy to break by accident, because a growing number of repository helpers now transact
 * internally and composing two of them is all it takes.
 *
 * It cannot be detected from inside: a module-level "am I in a transaction" flag would be true for a
 * legitimate concurrent caller too (there is no async-context propagation in Hermes), so rejecting on
 * it would break the very queuing this exists to provide. What IS detectable is the SYMPTOM — a wait
 * that never ends ({@link LOCK_WAIT_WARN_MS}). The first warning is development-only; release
 * reporting begins only at the finite ERROR escalation below.
 * The watchdog reports only what it MEASURED, never a diagnosis: a long wait alone proves nothing
 * about a cycle (a burst of live messages, or one oversized transaction, produces the same wait), so
 * it is a `warn`. It escalates to `error` only after a second interval in which not one lock holder
 * anywhere released — the queue is then not merely deep, it is not moving. That distinction matters
 * beyond wording: `error` is the level the error-report sink uploads to the server, so a duration-only
 * `error` would fingerprint a burst as a recurring critical defect that does not exist. The waiter is
 * never cancelled: if the wait is merely long, the write still lands once the lock frees.
 *
 * CAVEAT — an UNRELATED writer (a UI send, the outgoing-queue drain, a download's local-path
 * write) issued while a transaction is open joins it too, and a rollback takes that bystander
 * write with it. Queuing makes this MORE likely during a burst, not less: N events now run N
 * back-to-back transactions, so the connection is inside a transaction for most of the burst
 * rather than only for the first handler. That is the price of not losing the other N-1 messages,
 * and it is only payable when a transaction actually fails — but it is why the scope must stay
 * small and short-lived: a couple of statements, no awaits on anything but the DB, and never a
 * network/native call.
 */
const LOCK_WAIT_WARN_MS = 10_000;

/**
 * Arm the wait watchdog for the caller that is about to park on the queue. Returns the disarm.
 *
 * Two stages, deliberately (see the note above): stage 1 states only the measured wait, stage 2
 * escalates ONLY when no lock holder released across both intervals.
 */
function armLockWatchdog(): () => void {
  const releasesAtEntry = lockReleases;
  waitingForLock += 1;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const first = setTimeout(() => {
    logger.warn(`[db] waited ${LOCK_WAIT_WARN_MS}ms for the write lock`, {
      waitedMs: LOCK_WAIT_WARN_MS,
      waiting: waitingForLock,
      releasedWhileWaiting: lockReleases - releasesAtEntry,
    });
    escalation = setTimeout(() => {
      // Still parked, and the queue has not handed the lock on ONCE since we joined it. A deep
      // queue drains; this does not.
      if (lockReleases !== releasesAtEntry || wedgeReported) return;
      wedgeReported = true;
      logger.error('[db] write queue appears wedged', 's9d54bjxmi', {
        waitedMs: 2 * LOCK_WAIT_WARN_MS,
        waiting: waitingForLock,
      });
    }, LOCK_WAIT_WARN_MS);
  }, LOCK_WAIT_WARN_MS);
  return () => {
    waitingForLock -= 1;
    clearTimeout(first);
    if (escalation !== undefined) clearTimeout(escalation);
  };
}

/**
 * Take the write-lock slot and resolve with its release. MUST be called (not awaited) synchronously
 * by the entry point, so two callers entering back-to-back can't both read the same `prev` and run
 * concurrently — an async function body runs to its first `await`, which is what makes the claim
 * below synchronous with the call.
 */
async function claimWriteLock(): Promise<() => void> {
  const prev = txQueue;
  let release: () => void = () => {};
  txQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  const disarm = armLockWatchdog();
  try {
    await prev;
  } finally {
    disarm();
  }
  return () => {
    lockReleases += 1;
    release();
  };
}

/**
 * Serialize database work that must not run inside — or alongside — anyone's transaction, WITHOUT
 * opening a SQL transaction of its own.
 *
 * Callers are SQLCipher's `PRAGMA rekey` (see `rotateDbKey`) and account-cache maintenance. Rekey
 * uses an implicit transaction on the same single connection; issued blind it can be undone by a
 * neighbour's ROLLBACK after the new key was already promoted. Cache cleanup takes one slot per
 * autocommit delete, and its final residue read takes another, so neither can join or observe a
 * neighbour's uncommitted transaction. Do not put an entire unbounded cache wipe in one callback.
 *
 * Same nesting rule as {@link withDbTransaction}, and the same queue — `fn` must never call either.
 */
export async function withDbWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const release = await claimWriteLock();
  try {
    return await fn();
  } finally {
    release();
  }
}

export async function withDbTransaction<T>(
  db: AppDatabase,
  fn: (context: DbTransactionContext) => Promise<T>,
  commitGuard?: DbCommitGuard,
): Promise<T> {
  const release = await claimWriteLock();
  // The release lives in a finally that also wraps the BEGIN: if BEGIN itself throws (or the
  // driver rejects before it), an un-released lock would wedge every subsequent write forever.
  try {
    // The caller may have waited behind another transaction longer than account teardown's bounded
    // drain. Re-check immediately after acquiring the mutex, before touching the shared database.
    assertCommitAllowed(commitGuard);
    await db.run(sql`BEGIN IMMEDIATE`);
    try {
      // BEGIN itself is asynchronous on-device. Catch a revocation that landed while it opened.
      assertCommitAllowed(commitGuard);
      const result = await runTransactionOwner(db, fn);
      // This is deliberately inside the rollback scope: if ownership changed during any statement,
      // reject here so every partial write is rolled back instead of leaking into the next account.
      assertCommitAllowed(commitGuard);
      await db.run(sql`COMMIT`);
      return result;
    } catch (err) {
      try {
        await db.run(sql`ROLLBACK`);
      } catch {
        // The failure may have already aborted the transaction — nothing left to roll back.
      }
      throw err;
    }
  } finally {
    release();
  }
}

/**
 * Opaque runtime proof that work belongs to the currently active transaction. Only
 * {@link withDbTransaction} creates one, and {@link runInTransactionContext} verifies its object
 * identity against a private WeakMap before invoking any callback.
 */
export type DbTransactionContext = DurableEventTransactionContext;

/** A transaction context was forged, stale, or used after its owner stopped accepting work. */
export class DbTransactionContextRejectedError extends Error {
  constructor() {
    super('database transaction context is not active');
    this.name = 'DbTransactionContextRejectedError';
  }
}

type DbTransactionContextState = {
  accepting: boolean;
  db: AppDatabase;
  tasks: Array<Promise<unknown>>;
  violation?: DbTransactionContextRejectedError;
};

const dbTransactionContexts = new WeakMap<DbTransactionContext, DbTransactionContextState>();

function observedRejection<T>(error: unknown): Promise<T> {
  const rejected = Promise.reject<T>(error);
  // The caller still receives the rejecting promise. This internal observer prevents a deliberately
  // ignored registration from becoming an unhandled rejection before the owner can roll back.
  void rejected.catch(() => undefined);
  return rejected;
}

/**
 * Register bounded DB-only work in an active transaction.
 *
 * Registration happens synchronously before `fn` starts. The owning transaction therefore waits
 * for the task even when its immediate caller forgets to await it. A call made while that owner is
 * closing rejects before `fn` and latches the violation so catching/ignoring the rejection cannot
 * accidentally permit COMMIT.
 */
export function runInTransactionContext<T>(
  context: DbTransactionContext,
  fn: (db: AppDatabase) => Promise<T>,
): Promise<T> {
  const state =
    typeof context === 'object' && context !== null
      ? dbTransactionContexts.get(context)
      : undefined;
  if (!state) return observedRejection(new DbTransactionContextRejectedError());
  if (!state.accepting) {
    const violation = new DbTransactionContextRejectedError();
    state.violation ??= violation;
    return observedRejection(violation);
  }

  let resolveTask!: (value: T | PromiseLike<T>) => void;
  let rejectTask!: (reason?: unknown) => void;
  const task = new Promise<T>((resolve, reject) => {
    resolveTask = resolve;
    rejectTask = reject;
  });
  state.tasks.push(task);
  void task.catch(() => undefined);

  try {
    Promise.resolve(fn(state.db)).then(resolveTask, rejectTask);
  } catch (error) {
    rejectTask(error);
  }
  return task;
}

type SettledFailure = { reason: unknown };

async function settleRegisteredTasks(
  state: DbTransactionContextState,
): Promise<SettledFailure | undefined> {
  const outcomes = await Promise.allSettled(state.tasks);
  const rejected = outcomes.find(
    (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
  );
  return rejected ? { reason: rejected.reason } : undefined;
}

async function runTransactionOwner<T>(
  db: AppDatabase,
  fn: (context: DbTransactionContext) => Promise<T>,
): Promise<T> {
  const context = Object.freeze({}) as DbTransactionContext;
  const state: DbTransactionContextState = { accepting: true, db, tasks: [] };
  dbTransactionContexts.set(context, state);

  let ownerOutcome: { ok: true; value: T } | { ok: false; reason: unknown };
  try {
    ownerOutcome = { ok: true, value: await fn(context) };
  } catch (reason) {
    ownerOutcome = { ok: false, reason };
  }

  // Close synchronously when the owner settles. The registered task set is now fixed: a task that
  // tries to add later work rejects and latches a rollback-forcing violation instead.
  state.accepting = false;
  let taskFailure: SettledFailure | undefined;
  try {
    taskFailure = await settleRegisteredTasks(state);
  } finally {
    // The token is inactive before the final account guard and before COMMIT/ROLLBACK.
    dbTransactionContexts.delete(context);
  }

  if (!ownerOutcome.ok) throw ownerOutcome.reason;
  if (state.violation) throw state.violation;
  if (taskFailure) throw taskFailure.reason;
  return ownerOutcome.value;
}
