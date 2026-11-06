import { sql } from 'drizzle-orm';
import type { DurableEventTransactionContext } from '@core/realtime';
import { logger } from '@core/secure';
import type { ReadDb, WriteDb } from './types';

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
 * Told once, right after the wedge is reported. The report itself cannot be saved while the queue
 * is wedged (saving it needs this queue), so error reporting installs a listener that keeps a
 * record outside SQLite for the next launch (review M045).
 */
let writeQueueWedgeListener: (() => void) | null = null;

/**
 * Optional async-context tracker for the nesting rule. Tests install one backed by
 * AsyncLocalStorage (test/support/transactionNesting.ts), so a `withDbTransaction` or
 * `withDbWriteLock` call made anywhere inside an owner callback, however many helpers deep, rejects
 * at once with {@link DbTransactionNestedError} instead of waiting forever. The app never installs
 * one: Hermes has no async-context propagation, so there it is the type system (a transaction
 * callback holds a WriteDb, which no own-transaction helper accepts) plus the watchdog below.
 */
export interface TransactionNestingDetector {
  /** Run `fn` as an owner frame: the marker is visible to everything the callback awaits. */
  runInside<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Called by every lock claim. Inside an active owner frame, return a promise that REJECTS with
   * {@link DbTransactionNestedError} if that frame is still active after a short grace: the owner
   * is waiting on this claim, which is the deadlock. A claim started from inside an owner but not
   * awaited by it (a queued follow-up) sees the frame settle first and is never rejected. Null when
   * the caller is not inside any owner.
   */
  nestedClaimDeadline(): Promise<never> | null;
}
let nestingDetector: TransactionNestingDetector | null = null;
export function setTransactionNestingDetector(detector: TransactionNestingDetector | null): void {
  nestingDetector = detector;
}

/** A transaction or write-lock claim was made from inside an open owner callback. */
export class DbTransactionNestedError extends Error {
  constructor(
    message = 'withDbTransaction/withDbWriteLock called inside an open transaction or write lock',
  ) {
    super(message);
    this.name = 'DbTransactionNestedError';
  }
}

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

/** A repair lost its exclusive write sequence before its next transaction could begin. */
export class DbWriteFenceRejectedError extends Error {
  constructor() {
    super('database write fence observed interleaved work');
    this.name = 'DbWriteFenceRejectedError';
  }
}

export interface DbWriteFence {
  /** Pass this exact guard to every transaction owned by the fenced operation. */
  readonly commitGuard: DbCommitGuard;
}

interface DbWriteFenceState {
  readonly baseGuard?: DbCommitGuard;
  expectedRelease: number;
  valid: boolean;
}

const dbWriteFenceStates = new WeakMap<DbCommitGuard, DbWriteFenceState>();

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

/** Install (or with `null` remove) the one wedge listener. See {@link writeQueueWedgeListener}. */
export function setWriteQueueWedgeListener(listener: (() => void) | null): void {
  writeQueueWedgeListener = listener;
}

/**
 * The one place a wedge is reported. Error reporting also calls it on a later launch to replay a
 * wedge an earlier run recorded but could not save; `waiting` is then unknown and omitted.
 */
export function reportWriteQueueWedge(waiting?: number): void {
  logger.error('[db] write queue appears wedged', 's9d54bjxmi', {
    waitedMs: 2 * LOCK_WAIT_WARN_MS,
    ...(waiting === undefined ? {} : { waiting }),
  });
}

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
      reportWriteQueueWedge(waitingForLock);
      try {
        writeQueueWedgeListener?.();
      } catch {
        // Keeping the record is best effort; the watchdog itself must never throw.
      }
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
  // Ask before touching the queue, so the frame lookup sees the caller's own async context.
  const nestedDeadline = nestingDetector?.nestedClaimDeadline() ?? null;
  const prev = txQueue;
  let release: () => void = () => {};
  txQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  const releasesAtEntry = lockReleases;
  const disarm = armLockWatchdog();
  const deadlines: Promise<never>[] = [];
  if (nestedDeadline) deadlines.push(nestedDeadline);
  let devDeadline: ReturnType<typeof setTimeout> | undefined;
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    // Development builds turn a wait during which NOTHING released into a thrown error: that is the
    // signature of a nested claim (the holder is this caller's own ancestor), and throwing into the
    // inner caller fails the outer callback, which rolls back and frees the queue. Release builds
    // keep the never-cancel policy and only report (see armLockWatchdog).
    deadlines.push(
      new Promise<never>((_, reject) => {
        devDeadline = setTimeout(() => {
          if (lockReleases === releasesAtEntry) {
            reject(
              new DbTransactionNestedError(
                `possible nested transaction: the write queue did not move for ${LOCK_WAIT_WARN_MS}ms`,
              ),
            );
          }
        }, LOCK_WAIT_WARN_MS);
      }),
    );
  }
  try {
    if (deadlines.length === 0) {
      await prev;
    } else {
      try {
        await Promise.race([prev, ...deadlines]);
      } catch (error) {
        // Hand the slot on so the queue keeps moving once the holder finishes.
        void prev.then(() => release());
        throw error;
      }
    }
  } finally {
    disarm();
    if (devDeadline !== undefined) clearTimeout(devDeadline);
  }
  return () => {
    lockReleases += 1;
    release();
  };
}

/**
 * Capture an optimistic sequence over the shared DB queue without retaining the lock.
 *
 * Transactions carrying this fence may run in bounded batches. Any transaction or write-lock
 * holder that does not carry the same guard advances the release count, so the next fenced transaction
 * rejects before BEGIN. This detects interleaving without holding the mutex across network work.
 */
export async function captureDbWriteFence(baseGuard?: DbCommitGuard): Promise<DbWriteFence> {
  const release = await claimWriteLock();
  let state: DbWriteFenceState | undefined;
  try {
    assertCommitAllowed(baseGuard);
    state = { baseGuard, expectedRelease: lockReleases, valid: true };
    const commitGuard = (): boolean =>
      state!.valid && (state!.baseGuard === undefined || state!.baseGuard());
    dbWriteFenceStates.set(commitGuard, state);
    return Object.freeze({ commitGuard });
  } finally {
    release();
    if (state?.valid) state.expectedRelease = lockReleases;
  }
}

function admitDbWriteFence(commitGuard?: DbCommitGuard): DbWriteFenceState | undefined {
  if (!commitGuard) return undefined;
  const state = dbWriteFenceStates.get(commitGuard);
  if (!state) return undefined;
  if (!state.valid || state.expectedRelease !== lockReleases) {
    state.valid = false;
    throw new DbWriteFenceRejectedError();
  }
  return state;
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
export async function withDbWriteLock<T>(
  dbOrFn: ReadDb | (() => Promise<T>),
  fn?: (tx: WriteDb) => Promise<T>,
): Promise<T> {
  // Two call shapes, one declaration (the write scanner identifies this function by its single
  // declaration). `withDbWriteLock(fn)`: `fn` runs its own raw work (PRAGMA rekey) and never touches
  // the shared Drizzle handle. `withDbWriteLock(db, fn)`: `fn` receives the write-capable view of
  // `db` for exactly the lock's lifetime (autocommit statements, serialized against every
  // transaction).
  if (typeof dbOrFn !== 'function' && typeof fn !== 'function') {
    throw new TypeError(
      'withDbWriteLock(db, fn) needs the callback that receives the write handle',
    );
  }
  const release = await claimWriteLock();
  try {
    const run = (): Promise<T> =>
      typeof dbOrFn === 'function' ? dbOrFn() : fn!(dbOrFn as unknown as WriteDb);
    return nestingDetector ? await nestingDetector.runInside(run) : await run();
  } finally {
    release();
  }
}

export async function withDbTransaction<T>(
  db: ReadDb,
  fn: (tx: WriteDb, context: DbTransactionContext) => Promise<T>,
  commitGuard?: DbCommitGuard,
): Promise<T> {
  // The same object: the ReadDb/WriteDb split is compile-time only. The callback receives the
  // write-capable view for exactly the lifetime of BEGIN..COMMIT.
  const tx = db as unknown as WriteDb;
  const release = await claimWriteLock();
  let admittedFence: DbWriteFenceState | undefined;
  // The release lives in a finally that also wraps the BEGIN: if BEGIN itself throws (or the
  // driver rejects before it), an un-released lock would wedge every subsequent write forever.
  try {
    admittedFence = admitDbWriteFence(commitGuard);
    // The caller may have waited behind another transaction longer than account teardown's bounded
    // drain. Re-check immediately after acquiring the mutex, before touching the shared database.
    assertCommitAllowed(commitGuard);
    await tx.run(sql`BEGIN IMMEDIATE`);
    try {
      // BEGIN itself is asynchronous on-device. Catch a revocation that landed while it opened.
      assertCommitAllowed(commitGuard);
      const result = nestingDetector
        ? await nestingDetector.runInside(() => runTransactionOwner(tx, fn))
        : await runTransactionOwner(tx, fn);
      // This is deliberately inside the rollback scope: if ownership changed during any statement,
      // reject here so every partial write is rolled back instead of leaking into the next account.
      assertCommitAllowed(commitGuard);
      await tx.run(sql`COMMIT`);
      return result;
    } catch (err) {
      try {
        await tx.run(sql`ROLLBACK`);
      } catch {
        // The failure may have already aborted the transaction — nothing left to roll back.
      }
      throw err;
    }
  } finally {
    release();
    if (admittedFence?.valid) admittedFence.expectedRelease = lockReleases;
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
  db: WriteDb;
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
  fn: (db: WriteDb) => Promise<T>,
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
  db: WriteDb,
  fn: (tx: WriteDb, context: DbTransactionContext) => Promise<T>,
): Promise<T> {
  const context = Object.freeze({}) as DbTransactionContext;
  const state: DbTransactionContextState = { accepting: true, db, tasks: [] };
  dbTransactionContexts.set(context, state);

  let ownerOutcome: { ok: true; value: T } | { ok: false; reason: unknown };
  try {
    ownerOutcome = { ok: true, value: await fn(db, context) };
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
