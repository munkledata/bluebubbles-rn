import { ApiError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';
// Import the endpoint module directly (not the @core/api barrel) so this stays
// node-importable in tests without pulling in ky (ESM).
import * as scheduledApi from '@core/api/endpoints/scheduled';
import {
  MAX_SEND_ATTACHMENT_TEXT_BYTES,
  MAX_IMESSAGE_SCHEDULED_ATTACHMENT_BYTES,
  isSupportedImessageAttachmentType,
} from '@core/models/serverInfo';
import {
  asRecurrence,
  nextOccurrence,
  ScheduledCreateUncertainError,
  type Recurrence,
} from '@core/schedule';
import { logger } from '@core/secure';
import { currentRcsProviderEpoch, isCurrentRcsChatGuid } from '@core/rcs/providerIdentity';
import {
  claimDueScheduled,
  deferScheduledClaim,
  insertScheduledWithinTransaction,
  getChatHeader,
  listDueScheduled,
  markScheduledFailed,
  markScheduledSent,
  rearmScheduled,
  resetStuckScheduled,
  ScheduledOutgoingClaimLostError,
  ScheduledOutgoingTargetUnavailableError,
  type ScheduledRow,
  type ScheduledTextHandoverTransition,
} from '@db/repositories';
import { DbCommitGuardRejectedError, withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { isProvenOneToOneIMessageChat, isRcsChatGuid } from '@utils/chat';
import { utf8Encode } from '@utils/bytes';
import {
  RcsCapabilityUnavailableError,
  sendCapabilityCommitGuard,
  type RcsCapabilitySource,
} from './rcsAttemptCapability';
import { sendTextMessage } from './sendService';

export interface ScheduleArgs {
  chatGuid: string;
  text: string;
  scheduledFor: number;
  selectedMessageGuid?: string;
  /** Reply target part. Ignored when there is no selected message. */
  selectedMessagePartIndex?: number;
  /** null/undefined = one-shot; a recurring message is LOCAL-ONLY (the server can't repeat). */
  recurrence?: Recurrence | null;
}

export interface ScheduleAttachmentArgs {
  chatGuid: string;
  text: string;
  scheduledFor: number;
  attachmentName: string;
  mimeType: string;
  /** Canonical base64 bytes already read from a bounded local file. */
  attachmentData: string;
}

function decodedBase64Size(value: string): number {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return -1;
  }
  return (value.length / 4) * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
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

/**
 * One FIFO per database + account generation. Recovery may reset every `sending` row, so the next
 * runner must not invalidate and repeat recovery until the exact runner that lost authority has
 * fully unwound its network/DB continuation.
 */
const scheduledRunTails = new WeakMap<object, Map<ScheduledRecoveryKey, Promise<void>>>();

interface ScheduledRunReservation {
  readonly waitForTurn: Promise<void>;
  finish(): void;
}

/** Reserve the next non-overlapping run synchronously, before this caller's first await. */
function reserveScheduledRun(database: object, key: ScheduledRecoveryKey): ScheduledRunReservation {
  const tails = scheduledRunTails.get(database) ?? new Map<ScheduledRecoveryKey, Promise<void>>();
  if (!scheduledRunTails.has(database)) scheduledRunTails.set(database, tails);

  const waitForTurn = tails.get(key) ?? Promise.resolve();
  let resolveCurrent!: () => void;
  const currentSettled = new Promise<void>((resolve) => {
    resolveCurrent = resolve;
  });
  const tail = waitForTurn.then(
    () => currentSettled,
    () => currentSettled,
  );
  tails.set(key, tail);

  let finished = false;
  return {
    waitForTurn,
    finish: () => {
      if (finished) return;
      finished = true;
      resolveCurrent();
      void tail.then(() => {
        if (tails.get(key) !== tail) return;
        tails.delete(key);
        if (tails.size === 0) scheduledRunTails.delete(database);
      });
    },
  };
}

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
 * attempts are removed, allowing a later tick to retry while still failing closed now. Callback
 * expiry is handled by the serialized `runDueScheduled` owner only after that whole run settles;
 * `ensureScheduledRecovery` must never invalidate a cache while a live claim may still exist.
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
 * Only a refusal the server sent proves it saved nothing. A timeout, a dropped connection, or a
 * server or reply-format error can follow a create the Mac already stored.
 */
function scheduledCreateMayHaveLanded(error: unknown): boolean {
  return !(
    error instanceof ApiError &&
    (error.kind === 'bad_request' || error.kind === 'unauthorized')
  );
}

/**
 * After a create whose reply was lost, find the Mac's copy so the phone does not keep a second one
 * that would also send (review M095). Returns its id, or null when the Mac has none. When the list
 * cannot be read either, a create that never reached the Mac (no connection) keeps the phone copy
 * as before; any other outcome stops, because only the owner can check Scheduled and try again.
 */
async function findServerScheduledCopy(
  http: HttpClient,
  args: ScheduleArgs,
  createError: unknown,
  accountScope: ScheduledOperationScope | undefined,
): Promise<string | null> {
  let items: scheduledApi.ScheduledItem[];
  try {
    items = await scheduledApi.getScheduled(http);
  } catch {
    assertScheduledScope(accountScope);
    if (createError instanceof ApiError && createError.kind === 'no_connection') return null;
    throw new ScheduledCreateUncertainError();
  }
  assertScheduledScope(accountScope);
  const copy = items.find(
    (item) =>
      item.chatGuid === args.chatGuid &&
      item.text === args.text &&
      item.scheduledFor === args.scheduledFor,
  );
  return copy?.id ?? null;
}

/**
 * Schedule a message. Prefers SERVER-side scheduling (Gator fires it on time even if the
 * phone is asleep), recording the returned uuid so the on-device worker SKIPS it (no
 * double-send). Reply targets are rejected. Plain RCS and recurring messages are local-only;
 * ordinary iMessage text also falls back locally when the server is older or offline. A create
 * whose reply was lost first looks for the Mac's copy (findServerScheduledCopy).
 */
export async function scheduleTextMessage(
  db: AppDatabase,
  http: HttpClient,
  args: ScheduleArgs,
  accountScope?: ScheduledOperationScope,
  capabilitySource?: RcsCapabilitySource,
): Promise<{ id: number; serverId: string | null }> {
  assertScheduledScope(accountScope);
  if (args.selectedMessageGuid !== undefined || args.selectedMessagePartIndex !== undefined) {
    throw new Error('Scheduled replies were retired in this release.');
  }
  if (isRcsChatGuid(args.chatGuid)) {
    if (
      !isCurrentRcsChatGuid(capabilitySource?.serverInfo, args.chatGuid) ||
      (capabilitySource?.kind === 'session' && !capabilitySource.isCurrent())
    ) {
      throw new RcsCapabilityUnavailableError(
        'This RCS conversation belongs to an unavailable or previous Google pairing.',
      );
    }
  }
  const commitGuard = sendCapabilityCommitGuard(
    accountScope ? () => accountScope.isCurrent() : undefined,
    capabilitySource,
  );
  let serverId: string | null = null;
  if (!isRcsChatGuid(args.chatGuid) && !args.selectedMessageGuid && !args.recurrence) {
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
      if (scheduledCreateMayHaveLanded(e)) {
        serverId = await findServerScheduledCopy(http, args, e, accountScope);
      }
      if (serverId === null) {
        logger.debug('[sched] server-side schedule failed; using on-device fallback', e);
      }
    }
  }
  assertScheduledScope(accountScope);
  const id = await withDbTransaction(
    db,
    (context) => insertScheduledWithinTransaction(context, { ...args, serverId }),
    commitGuard,
  );
  assertScheduledScope(accountScope);
  return { id, serverId };
}

/**
 * Store one small file on the Mac for a one-time iMessage send. Unlike text schedules, this has
 * NO phone-only fallback: the phone does not retain the bytes in its scheduled-message row.
 * An uncertain create response must be checked in Scheduled before the user tries again.
 */
export async function scheduleAttachmentMessage(
  db: AppDatabase,
  http: HttpClient,
  args: ScheduleAttachmentArgs,
  accountScope: ScheduledOperationScope,
  capabilitySource: RcsCapabilitySource | undefined,
): Promise<{ id: number; serverId: string }> {
  const capability = capabilitySource?.serverInfo;
  const current = sendCapabilityCommitGuard(() => accountScope.isCurrent(), capabilitySource);
  if (!current()) throw new ScheduledSessionChangedError();
  if (
    capability?.supports_imessage_scheduled_attachment !== true ||
    capability.supports_imessage_attachment_upload !== true ||
    (args.mimeType === 'application/pdf' &&
      capability.supports_imessage_pdf_attachment_upload !== true) ||
    (args.text.length > 0 && capability.supports_imessage_attachment_caption_upload !== true)
  ) {
    throw new Error('Scheduled iMessage attachments are unavailable on this server.');
  }
  const byteSize = decodedBase64Size(args.attachmentData);
  if (
    !/^(?:iMessage|any);-;/.test(args.chatGuid) ||
    !isSupportedImessageAttachmentType(args.mimeType, args.attachmentName) ||
    byteSize <= 0 ||
    byteSize > MAX_IMESSAGE_SCHEDULED_ATTACHMENT_BYTES ||
    (args.text.length > 0 &&
      (args.text.trim().length === 0 ||
        utf8Encode(args.text).byteLength > MAX_SEND_ATTACHMENT_TEXT_BYTES))
  ) {
    throw new Error('Choose one JPEG, PNG, or PDF up to 512 KiB and a plain caption.');
  }
  const header = await getChatHeader(db, args.chatGuid);
  if (!current()) throw new ScheduledSessionChangedError();
  if (!isProvenOneToOneIMessageChat(header)) {
    throw new Error('A proven existing one-to-one iMessage chat is required.');
  }
  const created = await scheduledApi.createScheduled(http, {
    chatGuid: args.chatGuid,
    message: args.text,
    scheduledFor: args.scheduledFor,
    method: 'narrow-attachment',
    attachmentName: args.attachmentName,
    attachmentData: args.attachmentData,
  });
  if (!current()) throw new ScheduledSessionChangedError();
  if (
    !created?.id ||
    created.method !== 'narrow-attachment' ||
    created.attachmentName !== args.attachmentName
  ) {
    throw new Error(
      'Schedule creation could not be confirmed. Check Scheduled before trying again.',
    );
  }
  const id = await withDbTransaction(
    db,
    (context) =>
      insertScheduledWithinTransaction(context, {
        chatGuid: args.chatGuid,
        text: args.text,
        scheduledFor: args.scheduledFor,
        attachmentName: args.attachmentName,
        serverId: created.id,
      }),
    current,
  );
  if (!current()) throw new ScheduledSessionChangedError();
  return { id, serverId: created.id };
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
  selectedMessagePartIndex?: number,
) => Promise<void>;

/**
 * Once the current Google pairing is known, an RCS row from any other pairing can never be sent:
 * Google may reuse its old source id for someone else. Its failure then counts as an attempt, so
 * the row retires at the cap instead of being deferred forever like a temporary RCS outage.
 */
function belongsToAnotherKnownRcsPairing(
  chatGuid: string,
  source: RcsCapabilitySource | undefined,
): boolean {
  return (
    isRcsChatGuid(chatGuid) &&
    currentRcsProviderEpoch(source?.serverInfo) !== null &&
    !isCurrentRcsChatGuid(source?.serverInfo, chatGuid)
  );
}

/**
 * Before the hand-off the only network step is the server-capability lookup (a proven one-to-one
 * iMessage chat needs it). When that cannot reach the server nothing was sent, so the row is
 * released without spending one of its five attempts, as an RCS capability gap already is.
 * Offline, the 20 s ticker would otherwise retire the schedule, and a recurring series with it,
 * within about 100 s. A 4xx refusal or any other error still counts as a failed attempt.
 */
function isUnreachableBeforeHandover(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.kind === 'no_connection' ||
      error.kind === 'timeout' ||
      error.kind === 'cancelled' ||
      error.kind === 'server_error')
  );
}

/**
 * Fire every due scheduled message: atomically CLAIM the row (pending → sending)
 * so a concurrent tick / the home+chat tickers can't double-send it, send via the
 * normal optimistic path with plain text, then mark it sent. Legacy reply rows are retired by the
 * authoritative claim and never reach a sender. A send
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
  /** Capture foreground cache provenance or fixed task-local info for each physical handoff. */
  captureCapabilitySource?: () => RcsCapabilitySource | undefined,
): Promise<number> {
  const recoveryKey = scheduledRecoveryKey(accountScope);
  const reservation = reserveScheduledRun(db as object, recoveryKey);
  try {
    await reservation.waitForTurn;
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
      const capabilitySource = captureCapabilitySource?.();
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
          await sender(
            m.chatGuid,
            m.text,
            m.selectedMessageGuid,
            settle,
            m.selectedMessagePartIndex,
          );
        } else {
          await sendTextMessage(
            db,
            http,
            {
              chatGuid: m.chatGuid,
              text: m.text,
            },
            Date.now(),
            recordAtomicHandover,
            { scheduledId: m.id, transition, commitGuard },
            undefined,
            capabilitySource,
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
          if (
            e instanceof DbCommitGuardRejectedError ||
            (e instanceof RcsCapabilityUnavailableError &&
              !belongsToAnotherKnownRcsPairing(m.chatGuid, capabilitySource)) ||
            isUnreachableBeforeHandover(e)
          ) {
            await deferScheduledClaim(db, m.id, commitGuard);
            continue;
          }
          // A compare-and-set miss means this runner no longer owns the scheduled row. Do not
          // overwrite its newer state with a failure transition.
          if (e instanceof ScheduledOutgoingClaimLostError) {
            logger.debug('[sched] outgoing handoff skipped after scheduled claim changed');
            continue;
          }
          if (e instanceof ScheduledOutgoingTargetUnavailableError) {
            logger.debug('[sched] scheduled reply retired after its target became unavailable');
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
              errorName:
                failureWriteError instanceof Error ? failureWriteError.name : 'UnknownError',
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
  } finally {
    // A callback-local deadline can expire without advancing the account generation. Delete the
    // shared recovery result only after this exact runner has fully settled, then release the FIFO;
    // the next runner can safely reset any claim this expired continuation left `sending`.
    try {
      if (accountScope && !accountScope.isCurrent()) {
        recoveryStatesForDatabase(db as object).delete(recoveryKey);
      }
    } finally {
      reservation.finish();
    }
  }
}
