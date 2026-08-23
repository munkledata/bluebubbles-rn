import type { HttpClient } from '@core/api/http';
// Import the endpoint module directly (not the @core/api barrel) so this stays
// node-importable in tests without pulling in ky (ESM).
import * as scheduledApi from '@core/api/endpoints/scheduled';
import { asRecurrence, nextOccurrence, type Recurrence } from '@core/schedule';
import { logger } from '@core/secure';
import {
  claimDueScheduled,
  insertScheduled,
  listDueScheduled,
  markScheduledFailed,
  markScheduledSent,
  rearmScheduled,
  resetStuckScheduled,
  ScheduledOutgoingClaimLostError,
  type ScheduledRow,
  type ScheduledTextHandoverTransition,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { sendTextMessage } from './sendService';

export interface ScheduleArgs {
  chatGuid: string;
  text: string;
  scheduledFor: number;
  selectedMessageGuid?: string;
  /** null/undefined = one-shot; a recurring message is LOCAL-ONLY (the server can't repeat). */
  recurrence?: Recurrence | null;
}

/** Minimal account-ownership seam; production passes a RealtimeDeliveryLease, tests may omit it. */
export interface ScheduledOperationScope {
  /** Stable account generation. Production leases always provide this. */
  readonly generation?: number;
  isCurrent(): boolean;
}

/** A scheduled operation was retired by Disconnect before it could safely finish. */
export class ScheduledSessionChangedError extends Error {
  constructor() {
    super('Scheduled operation stopped because the account session changed');
    this.name = 'ScheduledSessionChangedError';
  }
}

function assertScheduledScope(scope?: ScheduledOperationScope): void {
  if (scope && !scope.isCurrent()) throw new ScheduledSessionChangedError();
}

const DEFAULT_SCHEDULED_RECOVERY_BATCH_ROWS = 25;
const SCHEDULED_RECOVERY_MAX_BATCHES = 4;
const UNSCOPED_SCHEDULED_RECOVERY = Symbol('unscoped-scheduled-recovery');

type ScheduledRecoveryKey = number | ScheduledOperationScope | typeof UNSCOPED_SCHEDULED_RECOVERY;
interface ScheduledRecoveryState {
  readonly promise: Promise<number>;
}

/**
 * One recovery state per physical DB wrapper and account generation. A WeakMap avoids retaining a
 * retired database for the lifetime of the JS process.
 */
const scheduledRecoveryStates = new WeakMap<
  object,
  Map<ScheduledRecoveryKey, ScheduledRecoveryState>
>();

/** Keep WeakMap bookkeeping out of DB-tainted data flow; these are JS objects, not SQL handles. */
function recoveryStatesForDatabase(
  database: object,
): Map<ScheduledRecoveryKey, ScheduledRecoveryState> {
  const existing = scheduledRecoveryStates.get(database);
  if (existing) return existing;
  const created = new Map<ScheduledRecoveryKey, ScheduledRecoveryState>();
  scheduledRecoveryStates.set(database, created);
  return created;
}

/** Recovery deliberately stopped before an unbounded backlog could monopolize one wake/tick. */
export class ScheduledRecoveryIncompleteError extends Error {
  constructor(readonly recoveredRows: number) {
    super(`Scheduled recovery remains incomplete after ${recoveredRows} rows`);
    this.name = 'ScheduledRecoveryIncompleteError';
  }
}

function scheduledRecoveryKey(scope?: ScheduledOperationScope): ScheduledRecoveryKey {
  if (scope?.generation !== undefined) return scope.generation;
  return scope ?? UNSCOPED_SCHEDULED_RECOVERY;
}

function recoveryBatchRows(maxRows?: number): number {
  if (maxRows === undefined) return DEFAULT_SCHEDULED_RECOVERY_BATCH_ROWS;
  if (!Number.isFinite(maxRows) || maxRows < 1) {
    throw new RangeError('Scheduled recovery batch size must be a positive finite number');
  }
  return Math.floor(maxRows);
}

async function recoverInterruptedScheduledRows(
  db: AppDatabase,
  accountScope: ScheduledOperationScope | undefined,
  maxRows: number | undefined,
): Promise<number> {
  const batchRows = recoveryBatchRows(maxRows);
  const commitGuard = accountScope ? () => accountScope.isCurrent() : undefined;
  let recovered = 0;

  for (let batch = 0; batch < SCHEDULED_RECOVERY_MAX_BATCHES; batch += 1) {
    assertScheduledScope(accountScope);
    const count = await resetStuckScheduled(db, batchRows, commitGuard);
    assertScheduledScope(accountScope);
    recovered += count;
    if (count < batchRows) return recovered;
  }

  // A full final batch means there may be more crash-left rows. Do not claim or send anything
  // until a later invocation proves recovery reached an empty/partial batch.
  throw new ScheduledRecoveryIncompleteError(recovered);
}

/**
 * Recover crash-left `sending` rows before this account generation can make its first claim.
 *
 * Publication is synchronous: the promise is stored before its first reset begins, so concurrent
 * Home/chat/background callers share one recovery. A successful promise stays cached for this
 * DB+generation and therefore can never reset a live claim made later in the same runtime. Failed
 * or revoked attempts are removed, allowing a later tick to retry while still failing closed now.
 */
export function ensureScheduledRecovery(
  db: AppDatabase,
  accountScope?: ScheduledOperationScope,
  maxRows?: number,
): Promise<number> {
  assertScheduledScope(accountScope);
  const key = scheduledRecoveryKey(accountScope);
  const states = recoveryStatesForDatabase(db as object);
  const existing = states.get(key);
  if (existing) return existing.promise;

  // getDatabase() is normally one long-lived wrapper. Retain only the newest numeric account
  // generation so repeated Disconnect/reconnect cycles cannot grow this inner Map forever.
  if (typeof key === 'number') {
    for (const retainedKey of states.keys()) {
      if (typeof retainedKey === 'number' && retainedKey !== key) states.delete(retainedKey);
    }
  }

  let state!: ScheduledRecoveryState;
  // Starting from a resolved promise defers the first DB call until after `state` is published.
  const promise = Promise.resolve()
    .then(() => recoverInterruptedScheduledRows(db, accountScope, maxRows))
    .catch((error: unknown) => {
      if (states?.get(key) === state) states.delete(key);
      throw error;
    });
  state = { promise };
  states.set(key, state);
  return promise;
}

/**
 * Schedule a message. Prefers SERVER-side scheduling (Gator fires it on time even if the
 * phone is asleep), recording the returned uuid so the on-device worker SKIPS it (no
 * double-send). Falls back to a local-only row when the server can't schedule it: an older
 * server, an offline create, a reply-target message (Gator's flat body can't carry one), or
 * a RECURRING message (the server fires once and forgets — only the local ticker re-arms).
 */
export async function scheduleTextMessage(
  db: AppDatabase,
  http: HttpClient,
  args: ScheduleArgs,
  accountScope?: ScheduledOperationScope,
): Promise<{ id: number; serverId: string | null }> {
  assertScheduledScope(accountScope);
  let serverId: string | null = null;
  if (!args.selectedMessageGuid && !args.recurrence) {
    try {
      const created = await scheduledApi.createScheduled(http, {
        chatGuid: args.chatGuid,
        message: args.text,
        scheduledFor: args.scheduledFor,
      });
      // The request snapshots A's credentials at entry. Its response can arrive after Disconnect;
      // never turn that old response into a row in whichever database is now active.
      assertScheduledScope(accountScope);
      serverId = created?.id ?? null;
    } catch (e) {
      // A revoked request is not an ordinary offline fallback. Falling through would insert the
      // old account's message as a local-only row and let the next account's ticker send it.
      assertScheduledScope(accountScope);
      logger.debug('[sched] server-side schedule failed; using on-device fallback', e);
    }
  }
  assertScheduledScope(accountScope);
  const id = await insertScheduled(db, { ...args, serverId });
  assertScheduledScope(accountScope);
  return { id, serverId };
}

/**
 * How a due row is actually sent. `onQueued` is the handover signal: the sender awaits it the
 * instant delivery is durably owned by something else (for the real path, the outgoing queue).
 * A sender that never calls it — the dev fixtures, which have no queue behind them — is settled
 * on resolve instead, exactly as before.
 */
type Sender = (
  chatGuid: string,
  text: string,
  selectedMessageGuid: string | undefined,
  onQueued: () => Promise<void>,
) => Promise<void>;

/**
 * Fire every due scheduled message: atomically CLAIM the row (pending → sending)
 * so a concurrent tick / the home+chat tickers can't double-send it, send via the
 * normal optimistic path (preserving any reply target), then mark it sent. A send
 * that throws bumps the attempt counter and either releases the row back to
 * 'pending' for a later retry or retires it to 'error' past the cap (recurring
 * rows included — a permanently-failing recurring row still retires). A RECURRING
 * row that sends successfully is NOT marked sent: it is re-armed to its next
 * occurrence (pending, attempts reset) in one UPDATE. `sender` is injected so dev
 * can pass devSendFake (no server). Node-testable. Returns the number actually
 * sent this run.
 *
 * The production path transfers ownership atomically: the scheduled sent/re-arm transition,
 * optimistic message, queue row, and chat bump share ONE guarded transaction. The HTTP POST starts
 * only after that commit. A process kill therefore leaves either a recoverable `sending` schedule
 * with no outgoing work, or one terminal/re-armed schedule whose occurrence is owned by the queue.
 * The optional injected sender remains for development fixtures and focused branch tests; its
 * `onQueued` callback uses the standalone terminal helpers and bounded retry path.
 */
export async function runDueScheduled(
  db: AppDatabase,
  http: HttpClient,
  now: number,
  sender?: Sender,
  accountScope?: ScheduledOperationScope,
  maxRows?: number,
): Promise<number> {
  assertScheduledScope(accountScope);
  await ensureScheduledRecovery(db, accountScope, maxRows);
  assertScheduledScope(accountScope);
  const commitGuard = accountScope ? () => accountScope.isCurrent() : undefined;
  // Server-backed rows are informational only: the server fires them. Filter them BEFORE LIMIT,
  // or an old block of server rows can starve every local fallback/recurrence on every wake.
  const due = await listDueScheduled(db, now, maxRows, true);
  // A due-list read can be parked behind native SQLite while Disconnect wipes and reconnects. Do
  // not claim — and especially do not SEND — any row returned to an operation that no longer owns
  // the account generation.
  assertScheduledScope(accountScope);
  let fired = 0;
  for (const candidate of due) {
    assertScheduledScope(accountScope);
    // The list is only a bounded candidate snapshot. Re-check due/local/pending atomically and use
    // the row returned by that claim, so an intervening edit cannot send stale text or a future/
    // server-owned occurrence.
    let m: ScheduledRow | null;
    try {
      m = await claimDueScheduled(db, candidate.id, now, commitGuard);
    } catch (error) {
      // A scope revoked inside the claim transaction reports the scheduler's public session error,
      // while an unrelated database failure keeps its original diagnostic.
      assertScheduledScope(accountScope);
      throw error;
    }
    if (!m) continue;
    assertScheduledScope(accountScope);
    const recurrence = asRecurrence(m.recurrence);
    const transition: ScheduledTextHandoverTransition = recurrence
      ? {
          kind: 'rearm',
          // Catch-up semantics: skip stale slots, so a device that was off for a week sends one
          // occurrence now and re-arms for the next future slot.
          nextScheduledFor: nextOccurrence(m.scheduledFor, recurrence, now),
        }
      : { kind: 'sent' };
    // `settled` = the outgoing queue owns delivery from here on (flipped BEFORE the terminal write,
    // because that is the instant ownership changes hands). `terminalWritten` = the row actually
    // reached its terminal state on disk. They are separate because the write can fail on its own,
    // and the two mean very different things to the catch below.
    let settled = false;
    let terminalWritten = false;
    /**
     * Stamp the row terminal. Returns whether THIS attempt matched a row: `rearmScheduled` is a
     * compare-and-set on `status='sending'`, so it legitimately reports false when a previous
     * attempt already re-armed it. `terminalWritten` therefore accumulates — it means "at least one
     * attempt landed", which is the only thing the diagnostic below can honestly claim.
     *
     * Each repository transition owns its own short transaction, so it queues behind a neighbouring
     * writer instead of silently joining that writer's rollback. Safe against the no-nesting rule:
     * `settle` is invoked from `sendTextMessage` only after `insertOutgoingText`'s transaction has
     * committed, and again after `sender()` resolves.
     */
    const writeTerminal = async (): Promise<boolean> => {
      assertScheduledScope(accountScope);
      let matched: boolean;
      if (transition.kind === 'rearm') {
        matched = await rearmScheduled(db, m.id, transition.nextScheduledFor, commitGuard);
      } else {
        matched = await markScheduledSent(db, m.id, null, commitGuard);
      }
      assertScheduledScope(accountScope);
      terminalWritten = terminalWritten || matched;
      return matched;
    };
    const settle = async (): Promise<void> => {
      if (settled) return;
      settled = true;
      // Counted at the HANDOVER, not after the write: the message is durably queued at this point,
      // so it fired even if stamping the row fails and has to be re-attempted below.
      fired += 1;
      await writeTerminal();
    };
    const recordAtomicHandover = (): void => {
      if (settled) return;
      settled = true;
      terminalWritten = true;
      fired += 1;
    };
    try {
      assertScheduledScope(accountScope);
      if (sender) {
        await sender(m.chatGuid, m.text, m.selectedMessageGuid, settle);
      } else {
        await sendTextMessage(
          db,
          http,
          { chatGuid: m.chatGuid, text: m.text, selectedMessageGuid: m.selectedMessageGuid },
          Date.now(),
          recordAtomicHandover,
          { scheduledId: m.id, transition, commitGuard },
        );
      }
      assertScheduledScope(accountScope);
      await settle(); // no-op when the sender already handed over
    } catch (e) {
      // Once Disconnect revokes the generation, no failure/re-arm write belongs to this runner.
      // Teardown drains this tracked operation and wipes A's claimed row before B can connect.
      assertScheduledScope(accountScope);
      // A throw BEFORE the handover is an ordinary send failure: release/retire the row.
      if (!settled) {
        // A compare-and-set miss means this runner no longer owns the scheduled row. Do not
        // overwrite its newer state with a failure transition.
        if (e instanceof ScheduledOutgoingClaimLostError) {
          logger.debug('[sched] outgoing handoff skipped after scheduled claim changed');
          continue;
        }

        let status: 'pending' | 'error' | 'stale' | null = null;
        let failureWriteError: unknown;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            status = await markScheduledFailed(db, m.id, commitGuard);
            break;
          } catch (transitionError) {
            assertScheduledScope(accountScope);
            failureWriteError = transitionError;
          }
        }
        if (status === null) {
          logger.warn(`[sched] failure transition failed twice (${m.id}); row left 'sending'`, {
            errorName: failureWriteError instanceof Error ? failureWriteError.name : 'UnknownError',
          });
        } else {
          assertScheduledScope(accountScope);
          logger.debug(`[sched] send failed (${m.id}) → ${status}`, e);
        }
        continue;
      }
      // A throw AFTER the handover is a delivery problem the queue now owns — re-arming the
      // scheduled row on top of it (markScheduledFailed releases it to 'pending') would send the
      // message a second time.
      logger.debug(`[sched] send threw after handover (${m.id}); queue owns delivery`, e);
    }
    // Retry only when the first terminal transaction failed or its compare-and-set did not match.
    // A successfully committed helper is durable because it owns the write-lock slot and cannot be
    // erased by a neighbouring rollback.
    if (settled && !terminalWritten) {
      try {
        assertScheduledScope(accountScope);
        await writeTerminal();
      } catch (e2) {
        assertScheduledScope(accountScope);
        logger.warn(`[sched] terminal write failed twice (${m.id}); row left 'sending'`, e2);
      }
      // Neither attempt matched: a recurring row whose `status='sending'` guard missed (someone
      // else moved it) is left 'pending' at a PAST scheduledFor and re-fires on every tick.
      if (!terminalWritten) {
        logger.warn(`[sched] scheduled row ${m.id} was never stamped terminal`);
      }
    }
  }
  return fired;
}
