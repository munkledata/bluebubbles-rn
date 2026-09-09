import { eq, sql } from 'drizzle-orm';
import { isRcsChatGuid } from '@utils/chat';
import { messages, outgoingQueue } from '../schema';
import {
  runInTransactionContext,
  withDbTransaction,
  type DbCommitGuard,
  type DbTransactionContext,
} from '../transaction';
import type { AppDatabase } from '../types';
import {
  MAX_SEND_ATTEMPT_OWNER_GENERATION,
  recordMessageGuidAliasWithinTransaction,
  type SendAttemptOwnerToken,
} from './outgoingAttemptOwnership';
import {
  isMessageTargetAvailableWithinTransaction,
  queuedMessageTarget,
  type MessageTargetServerAuthorization,
} from './messageTargets';
import {
  OUTGOING_GRACE_MS,
  OUTGOING_LEASE_MS,
  OUTGOING_MAX_ATTEMPTS,
  outgoingBackoffMs,
} from './outgoingRetryPolicy';

/** Retry, async-error, requeue, claim, and queue-health ownership for outgoing sends. */

/**
 * Transaction-only failed-send reconciliation: mark the temp message errored, bump attempts, and
 * schedule a backoff retry. Call only while the process-wide DB transaction is already owned.
 *
 * Returns whether this call actually OWNED a queue row — i.e. whether the retry ladder was really
 * advanced. Callers that have a fallback (see {@link applyServerSendErrorWithinTransaction}) must
 * branch on this rather than on a preceding "is there a queue row?" SELECT: the ack that deletes
 * the row can land between such a read and this write, and then the ladder silently goes nowhere.
 *
 * The attempts bump is a compare-and-set on the value we read (`AND attempts = <read>`), so a
 * concurrent bump/retire wins outright and is reported as "not owned" instead of being clobbered.
 */
async function reconcileOutgoingErrorForMessageWithinTransaction(
  context: DbTransactionContext,
  tempGuid: string,
  messageGuid: string,
  errorCode: number,
  now: number = Date.now(),
  errorMessage?: string | null,
): Promise<boolean> {
  return runInTransactionContext(context, async (db) => {
    const cur = await db.all<{
      attempts: number;
      sendState: string | null;
      currentError: number | null;
      currentErrorMessage: string | null;
    }>(sql`
        SELECT q.attempts, m.send_state AS sendState, m.error AS currentError,
               m.error_message AS currentErrorMessage
          FROM outgoing_queue q LEFT JOIN messages m ON m.guid = ${messageGuid}
         WHERE q.temp_guid = ${tempGuid} LIMIT 1`);
    const current = cur[0];
    const prior = current?.attempts;
    if (prior == null) {
      await db
        .update(messages)
        .set({
          sendState: 'error',
          error: errorCode,
          ...(errorMessage === undefined ? {} : { errorMessage }),
        })
        .where(eq(messages.guid, messageGuid));
      return false;
    }
    // This is the legacy/temp-only duplicate defense. Modern attemptGuid copies are deduplicated
    // durably before this repository; an old event may still supply no shared attempt id. Its first
    // copy has moved the bubble to this error and advanced/rebuilt a ladder, so accepting a matching
    // second copy avoids consuming two attempts. A later retry first flips the bubble to
    // `sending`/error=0, making its next failure distinguishable again.
    if (prior > 0 && current.sendState === 'error' && current.currentError === errorCode) {
      if (errorMessage !== undefined && current.currentErrorMessage !== errorMessage) {
        await db.update(messages).set({ errorMessage }).where(eq(messages.guid, messageGuid));
      }
      return true;
    }
    await db
      .update(messages)
      .set({
        sendState: 'error',
        error: errorCode,
        ...(errorMessage === undefined ? {} : { errorMessage }),
      })
      .where(eq(messages.guid, messageGuid));
    const attempts = prior + 1;
    const bumped = await db.all<{ id: number }>(sql`
        UPDATE outgoing_queue SET attempts = ${attempts}, next_retry_at = ${now + outgoingBackoffMs(attempts)}
         WHERE temp_guid = ${tempGuid} AND attempts = ${prior}
        RETURNING id`);
    return bumped.length > 0;
  });
}

/**
 * Transaction-only local/HTTP failure. A modern caller supplies the token captured before its
 * request; a delayed failure may mutate only while that exact generation is still pending.
 */
export async function reconcileOutgoingErrorWithinTransaction(
  context: DbTransactionContext,
  tempGuid: string,
  errorCode: number,
  now: number = Date.now(),
  errorMessage?: string | null,
  attemptOwnerToken?: SendAttemptOwnerToken,
): Promise<boolean> {
  return runInTransactionContext(context, async (db) => {
    const direct = await db.all<{
      guid: string;
      pending: number;
      generation: number;
    }>(sql`
      SELECT guid, attempt_owner_pending AS pending,
             attempt_owner_generation AS generation
        FROM messages
       WHERE guid = ${tempGuid}
       LIMIT 1
    `);
    const aliased = direct[0]
      ? []
      : await db.all<{ guid: string; pending: number; generation: number }>(sql`
          SELECT m.guid, m.attempt_owner_pending AS pending,
                 m.attempt_owner_generation AS generation
            FROM message_guid_aliases a
            JOIN messages m ON m.guid = a.canonical_guid
           WHERE a.alias_guid = ${tempGuid}
           LIMIT 1
        `);
    const owner = direct[0] ?? aliased[0];
    if (attemptOwnerToken) {
      if (!owner || owner.pending === 0 || owner.generation !== attemptOwnerToken.generation) {
        return false;
      }
    } else if (owner && owner.generation > 0) {
      // Mode is captured at optimistic insert. A modern row never silently downgrades merely
      // because a caller lost its token or current capability discovery is unavailable.
      return false;
    }
    return reconcileOutgoingErrorForMessageWithinTransaction(
      context,
      tempGuid,
      owner?.guid ?? tempGuid,
      errorCode,
      now,
      errorMessage,
    );
  });
}

/** Public failed-send reconciliation owns one short, optionally account-guarded transaction. */
export async function reconcileOutgoingError(
  db: AppDatabase,
  tempGuid: string,
  errorCode: number,
  now: number = Date.now(),
  commitGuard?: DbCommitGuard,
  errorMessage?: string | null,
  attemptOwnerToken?: SendAttemptOwnerToken,
): Promise<boolean> {
  return withDbTransaction(
    db,
    (context) =>
      reconcileOutgoingErrorWithinTransaction(
        context,
        tempGuid,
        errorCode,
        now,
        errorMessage,
        attemptOwnerToken,
      ),
    commitGuard,
  );
}

/**
 * Transaction-only message error state from a SERVER-pushed `message-send-error` (Messages.app
 * rejected the send after it already left the app). Unlike {@link reconcileOutgoingError} this does
 * NOT touch the outgoing_queue — it only surfaces the failure on the bubble. Try Again remains
 * available only when a queue row exists or the reviewed retryable branch below rebuilds one.
 * Returns whether the guid matched a local message; false is a no-op and lets callers try another
 * server-supplied identity without a separate racy existence check.
 */
export function markMessageSendErrorWithinTransaction(
  context: DbTransactionContext,
  guid: string,
  errorCode = 1,
  errorMessage?: string | null,
): Promise<boolean> {
  return runInTransactionContext(context, async (db) => {
    const updated = await db
      .update(messages)
      .set({
        sendState: 'error',
        error: errorCode,
        ...(errorMessage === undefined ? {} : { errorMessage }),
      })
      .where(eq(messages.guid, guid))
      .returning({ id: messages.id });
    return updated.length > 0;
  });
}

/** Standalone server-pushed send-error owner. */
export async function markMessageSendError(
  db: AppDatabase,
  guid: string,
  errorCode = 1,
  commitGuard?: DbCommitGuard,
  errorMessage?: string | null,
): Promise<boolean> {
  return withDbTransaction(
    db,
    (context) => markMessageSendErrorWithinTransaction(context, guid, errorCode, errorMessage),
    commitGuard,
  );
}

/**
 * Re-enqueue cycle cap. The RCS immediate-ack flow can loop forever on a permanently-failing
 * send: ack marks the bubble 'sent' + deletes the queue row → the async failure re-enqueues →
 * the retry is acked again → fails async again → … Nothing durable survives each cycle (the
 * ack resets both the queue row and the message's error field), so the cap lives here: at most
 * MAX_REQUEUE_CYCLES automatic ladders per tempGuid per app session; after that the failure stays
 * on the bubble without a queue row, so the current manual action reports it cannot resend. Bounded
 * at {@link REQUEUE_MAP_MAX} entries (oldest key evicted on insert) so a long session cannot grow
 * it without limit.
 */
const requeueCycles = new Map<string, number>();
const MAX_REQUEUE_CYCLES = 2;
const REQUEUE_MAP_MAX = 256;

type RequeueCommitEffect = () => void;

function requeueCycleKey(tempGuid: string, scope: string | number): string {
  return JSON.stringify([scope, tempGuid]);
}

/**
 * Re-arm the automatic retry ladder for a send whose failure arrived AFTER its ack — the RCS
 * immediate-ack contract: the server acks instantly, relays to Google in the background, and
 * reports a send-phase failure via `message-send-error` with `retryable: true`. By then the ack
 * already deleted the queue row, so without this the "picture failed after the ack" case cannot be
 * retried from the current manual action. Rebuilds an ATTACHMENT queue row from the message and
 * attachment rows only when the server certifies that dispatch never began. Text/contact payloads
 * are not reconstructable here: the message table loses contact-card kind and mention metadata, so
 * guessing could resend a contact as its display name or silently drop mentions.
 *
 * Returns null (caller falls back to bubble-only error) when: the guid isn't a temp- row
 * anymore (promoted rows can't be re-sent), it's a reaction (never flagged retryable by the
 * server), the message is TOMBSTONED (the user cancelled/deleted it — rebuilding a ladder would
 * re-send behind their back the very thing they removed), a queue row already exists, the cycle cap
 * is spent, or an attachment's on-disk file reference is gone.
 */
async function reEnqueueOutgoingFromMessageWithinTransaction(
  context: DbTransactionContext,
  tempGuid: string,
  now: number,
  scope: string | number = 'process',
  messageGuid: string = tempGuid,
): Promise<RequeueCommitEffect | null> {
  return runInTransactionContext(context, async (db) => {
    const cycleKey = requeueCycleKey(tempGuid, scope);
    if (!tempGuid.startsWith('temp-')) return null;
    if ((requeueCycles.get(cycleKey) ?? 0) >= MAX_REQUEUE_CYCLES) return null;
    const rows = await db.all<{
      id: number;
      chatGuid: string | null;
      text: string | null;
      selectedMessageGuid: string | null;
      partIndex: number | null;
    }>(sql`
      SELECT m.id, c.guid AS chatGuid, m.text,
             m.thread_originator_guid AS selectedMessageGuid,
             m.thread_originator_part AS partIndex
      FROM messages m JOIN chats c ON c.id = m.chat_id
      WHERE m.guid = ${messageGuid} AND m.associated_message_type IS NULL
        AND m.date_deleted IS NULL LIMIT 1`);
    const msg = rows[0];
    if (!msg?.chatGuid) return null;
    const queued = await db.all<{ id: number }>(
      sql`SELECT id FROM outgoing_queue WHERE temp_guid = ${tempGuid} LIMIT 1`,
    );
    if (queued[0]) return null; // a live ladder already owns it — bump, don't duplicate
    const att = await db.all<{ guid: string; localPath: string | null }>(sql`
      SELECT guid, local_path AS localPath FROM attachments
      WHERE message_id = ${msg.id} AND guid LIKE '%-att' LIMIT 1`);
    const firstAtt = att[0];
    if (!firstAtt?.localPath) return null; // unsafe/absent payload or nothing on disk to re-upload
    const payload = JSON.stringify({
      attachmentGuid: firstAtt.guid,
      localPath: firstAtt.localPath,
      ...(msg.text ? { text: msg.text } : {}),
      ...(msg.selectedMessageGuid
        ? {
            selectedMessageGuid: msg.selectedMessageGuid,
            ...(msg.partIndex == null ? {} : { partIndex: msg.partIndex }),
          }
        : {}),
    });
    // attempts starts at 1: the failed background relay WAS attempt one, and attempts>=1 also
    // bypasses the fresh-row grace window so the ladder re-fires on the next drain tick.
    await db.insert(outgoingQueue).values({
      tempGuid,
      chatGuid: msg.chatGuid,
      kind: 'attachment',
      payload,
      attempts: 1,
      nextRetryAt: now + outgoingBackoffMs(1),
    });
    // SQL may still roll back (durable checkpoint, account guard, or COMMIT failure). Return an
    // idempotent effect so the owner records this in-memory cycle only after the transaction has
    // actually committed. This cap is deliberately session-local, so a process death before the
    // effect runs is equivalent to the existing restart behavior.
    let recorded = false;
    return () => {
      if (recorded) return;
      recorded = true;
      const nextCount = (requeueCycles.get(cycleKey) ?? 0) + 1;
      if (requeueCycles.size >= REQUEUE_MAP_MAX) {
        const oldest = requeueCycles.keys().next().value;
        if (oldest !== undefined) requeueCycles.delete(oldest);
      }
      requeueCycles.set(cycleKey, nextCount);
    };
  });
}

export type ServerSendErrorDisposition =
  /** The failure owned this bubble and existing error/retry behavior was applied. */
  | 'applied'
  /** A newer request is in flight but has not acknowledged its server-owned attempt id yet. */
  | 'attempt-owner-pending'
  /** A modern row was targeted without the complete server correlation triple. */
  | 'attempt-identity-missing'
  /** The bubble has a different (or deliberately unowned legacy) active attempt. */
  | 'stale-attempt'
  /** No local message or live queue matched this candidate guid. */
  | 'unmatched';

/** Complete capable-RCS correlation triple copied from the server event. */
export interface ServerSendAttemptIdentity {
  readonly tempGuid: string;
  readonly attemptGuid: string;
  readonly clientAttemptGeneration: number;
}

export interface ServerSendErrorTransactionResult {
  /** True for an applied, deferred-pending, or safely handled stale candidate. */
  matched: boolean;
  /** Lets the durable-event owner retry only the unresolved request-to-ack window. */
  disposition: ServerSendErrorDisposition;
  /** Invoke only after the SQL transaction commits; idempotent and null if no cycle began. */
  onCommitted: RequeueCommitEffect | null;
}

/**
 * Transaction-only SERVER-pushed `message-send-error` reconciliation with retry-ladder awareness.
 * Call only while the process-wide DB transaction is already owned.
 *
 * If the guid still has an outgoing_queue row (an optimistic send the app owns — e.g. the RCS
 * bridge failed FAST, before/around the immediate ack), route through
 * {@link reconcileOutgoingErrorWithinTransaction}
 * so attempts is bumped and the backoff rescheduled — without this, a fast async failure left
 * attempts at 0/1 forever and the ladder never converged. When the queue row is already gone (the RCS
 * immediate-ack consumed it) and the server flagged the failure `retryable` (send-phase:
 * nothing reached Google, so a re-send cannot duplicate), re-enqueue a fresh ladder via
 * the transaction-only re-enqueue helper. The result says whether the guid matched a local message
 * or live queue row; a false result lets the realtime sink try the payload's next identity. A
 * matched bubble is flipped to the error state, and a re-enqueued ladder clears it again on success.
 */
export async function applyServerSendErrorWithinTransaction(
  context: DbTransactionContext,
  guid: string,
  errorCode = 1,
  now: number = Date.now(),
  retryable = false,
  requeueScope: string | number = 'process',
  errorMessage?: string | null,
  attemptIdentity?: ServerSendAttemptIdentity,
): Promise<ServerSendErrorTransactionResult> {
  return runInTransactionContext(context, async (db) => {
    type AttemptOwnerRow = {
      guid: string;
      activeSendAttemptGuid: string | null;
      attemptOwnerPending: number;
      attemptOwnerGeneration: number;
    };
    const findOwner = async (
      tempGuid: string,
      fallbackGuid: string,
    ): Promise<AttemptOwnerRow | null> => {
      const direct = await db.all<AttemptOwnerRow>(sql`
        SELECT guid, active_send_attempt_guid AS activeSendAttemptGuid,
               attempt_owner_pending AS attemptOwnerPending,
               attempt_owner_generation AS attemptOwnerGeneration
          FROM messages
         WHERE guid = ${tempGuid}
         LIMIT 1
      `);
      if (direct[0]) return direct[0];
      const aliased = await db.all<AttemptOwnerRow>(sql`
        SELECT m.guid, m.active_send_attempt_guid AS activeSendAttemptGuid,
               m.attempt_owner_pending AS attemptOwnerPending,
               m.attempt_owner_generation AS attemptOwnerGeneration
          FROM message_guid_aliases a
          JOIN messages m ON m.guid = a.canonical_guid
         WHERE a.alias_guid = ${tempGuid}
         LIMIT 1
      `);
      if (aliased[0]) return aliased[0];
      if (fallbackGuid !== tempGuid) {
        const fallback = await db.all<AttemptOwnerRow>(sql`
          SELECT guid, active_send_attempt_guid AS activeSendAttemptGuid,
                 attempt_owner_pending AS attemptOwnerPending,
                 attempt_owner_generation AS attemptOwnerGeneration
            FROM messages
           WHERE guid = ${fallbackGuid}
           LIMIT 1
        `);
        if (fallback[0]) return fallback[0];
      }
      return null;
    };

    let queueGuid = guid;
    let targetGuid = guid;
    if (attemptIdentity) {
      if (
        !attemptIdentity.tempGuid ||
        !attemptIdentity.attemptGuid ||
        !Number.isInteger(attemptIdentity.clientAttemptGeneration) ||
        attemptIdentity.clientAttemptGeneration < 1 ||
        attemptIdentity.clientAttemptGeneration > MAX_SEND_ATTEMPT_OWNER_GENERATION
      ) {
        return { matched: true, disposition: 'attempt-identity-missing', onCommitted: null };
      }
      let owner = await findOwner(attemptIdentity.tempGuid, guid);
      let recoveredAfterAliasPrune = false;
      if (!owner) {
        // A bounded alias may have been pruned before a delayed failure arrives. Recover only when
        // the exact active attempt identifies one and only one canonical row; ambiguity fails closed.
        const activeOwners = await db.all<AttemptOwnerRow>(sql`
          SELECT guid, active_send_attempt_guid AS activeSendAttemptGuid,
                 attempt_owner_pending AS attemptOwnerPending,
                 attempt_owner_generation AS attemptOwnerGeneration
            FROM messages
           WHERE active_send_attempt_guid = ${attemptIdentity.attemptGuid}
           LIMIT 2
        `);
        owner = activeOwners.length === 1 ? activeOwners[0] : null;
        recoveredAfterAliasPrune = owner != null;
      }
      if (!owner) return { matched: false, disposition: 'unmatched', onCommitted: null };
      if (recoveredAfterAliasPrune) {
        // A retry row keeps the original temp identity. Restore its bounded lookup before rebuilding
        // that row, otherwise the later claim cannot find the canonical owner and sends without the
        // generation token that its acknowledgement requires.
        await recordMessageGuidAliasWithinTransaction(
          context,
          attemptIdentity.tempGuid,
          owner.guid,
        );
      }
      queueGuid = attemptIdentity.tempGuid;
      targetGuid = owner.guid;
      if (owner.attemptOwnerPending !== 0) {
        if (owner.attemptOwnerGeneration !== attemptIdentity.clientAttemptGeneration) {
          return { matched: true, disposition: 'attempt-owner-pending', onCommitted: null };
        }
        const installed = await db.all<{ id: number }>(sql`
          UPDATE messages
             SET active_send_attempt_guid = ${attemptIdentity.attemptGuid},
                 attempt_owner_pending = 0
           WHERE guid = ${owner.guid}
             AND attempt_owner_pending = 1
             AND attempt_owner_generation = ${attemptIdentity.clientAttemptGeneration}
          RETURNING id
        `);
        if (installed.length === 0) {
          return { matched: true, disposition: 'attempt-owner-pending', onCommitted: null };
        }
      } else if (owner.activeSendAttemptGuid !== attemptIdentity.attemptGuid) {
        return { matched: true, disposition: 'stale-attempt', onCommitted: null };
      }
    } else {
      const owner = await findOwner(guid, guid);
      if (owner?.attemptOwnerGeneration && owner.attemptOwnerGeneration > 0) {
        return { matched: true, disposition: 'attempt-identity-missing', onCommitted: null };
      }
      targetGuid = owner?.guid ?? guid;
    }
    // The bump IS the "is a ladder still alive?" test. Asking first with a SELECT and then
    // committing to that branch lost the whole retryable path when the ack deleted the queue row in
    // between (three awaits wide): the UPDATE matched nothing, reported nothing, and the re-enqueue
    // below was never reached — the one case this machinery exists for, downgraded to bubble-only.
    if (
      await reconcileOutgoingErrorForMessageWithinTransaction(
        context,
        queueGuid,
        targetGuid,
        errorCode,
        now,
        errorMessage,
      )
    ) {
      return { matched: true, disposition: 'applied', onCommitted: null };
    }
    const onCommitted = retryable
      ? await reEnqueueOutgoingFromMessageWithinTransaction(
          context,
          queueGuid,
          now,
          requeueScope,
          targetGuid,
        )
      : null;
    const matched =
      (await markMessageSendErrorWithinTransaction(context, targetGuid, errorCode, errorMessage)) ||
      onCommitted != null;
    return {
      matched,
      disposition: matched ? 'applied' : 'unmatched',
      onCommitted,
    };
  });
}

/** Public server-error reconciliation owns one short transaction. */
export async function applyServerSendError(
  db: AppDatabase,
  guid: string,
  errorCode = 1,
  now: number = Date.now(),
  retryable = false,
  requeueScope: string | number = 'process',
  errorMessage?: string | null,
  attemptIdentity?: ServerSendAttemptIdentity,
): Promise<boolean> {
  const result = await withDbTransaction(db, (context) =>
    applyServerSendErrorWithinTransaction(
      context,
      guid,
      errorCode,
      now,
      retryable,
      requeueScope,
      errorMessage,
      attemptIdentity,
    ),
  );
  result.onCommitted?.();
  return result.matched;
}

export interface RetryableOutgoing {
  id: number;
  tempGuid: string;
  chatGuid: string;
  kind: string;
  payload: string;
  attempts: number;
  createdAt: number;
}

/**
 * Rows eligible for an automatic retry: under the attempt cap, their backoff has
 * elapsed, and they're either already-failed (attempts ≥ 1) or stranded past the
 * in-flight grace window (a UI send that never completed — e.g. a crash mid-send).
 */
export async function listRetryableOutgoing(
  db: AppDatabase,
  now: number,
  limit?: number,
): Promise<RetryableOutgoing[]> {
  // SQLite's -1 means "all rows" for existing foreground callers. Any explicit invalid cap is a
  // safe empty run rather than an accidental unbounded headless drain.
  const rowLimit =
    limit === undefined ? -1 : Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  return db.all<RetryableOutgoing>(sql`
    SELECT id, temp_guid AS tempGuid, chat_guid AS chatGuid, kind, payload, attempts, created_at AS createdAt
    FROM outgoing_queue
    WHERE attempts < ${OUTGOING_MAX_ATTEMPTS}
      AND next_retry_at <= ${now}
      AND (attempts >= 1 OR created_at <= ${now - OUTGOING_GRACE_MS})
    ORDER BY created_at ASC
    LIMIT ${rowLimit}`);
}

/**
 * Atomically lease one retry row and flip its exact optimistic bubble back to `sending` while an
 * owning transaction is open.
 *
 * Returning `temp_guid` from the winning lease avoids trusting a caller-supplied GUID that could
 * disagree with `id`. The state flip scopes `markOutgoingSentNoGuid`'s sticky-error guard to
 * failures reported during this new attempt. Both writes must commit together: a lease without
 * the visible flip lets manual Try Again overlap the drain, while a flip without its lease can be
 * claimed by a second drain.
 */
export interface OutgoingSendClaim {
  readonly claimed: boolean;
  /** Present only for a row that was born in attempt-aware mode. */
  readonly attemptOwnerToken?: SendAttemptOwnerToken;
}

export function claimOutgoingForSendWithinTransaction(
  context: DbTransactionContext,
  id: number,
  clock: () => number,
  serverAuthorization?: MessageTargetServerAuthorization,
): Promise<OutgoingSendClaim> {
  return runInTransactionContext(context, async (db) => {
    // Read AFTER acquiring the process-wide lock. A timestamp captured before a long queue wait
    // can make the two-minute lease expire as soon as it commits, allowing a second sender in.
    const now = clock();
    const rows = await db.all<{
      tempGuid: string;
      chatGuid: string;
      kind: string;
      payload: string;
    }>(sql`
        UPDATE outgoing_queue SET next_retry_at = ${now + OUTGOING_LEASE_MS}
        WHERE id = ${id} AND next_retry_at <= ${now}
        RETURNING temp_guid AS tempGuid, chat_guid AS chatGuid, kind, payload`);
    const claimed = rows[0];
    if (!claimed) return { claimed: false };

    const direct = await db.all<{ guid: string; generation: number }>(sql`
      SELECT guid, attempt_owner_generation AS generation
        FROM messages
       WHERE guid = ${claimed.tempGuid}
       LIMIT 1
    `);
    const aliased = direct[0]
      ? []
      : await db.all<{ guid: string; generation: number }>(sql`
          SELECT m.guid, m.attempt_owner_generation AS generation
            FROM message_guid_aliases a
            JOIN messages m ON m.guid = a.canonical_guid
           WHERE a.alias_guid = ${claimed.tempGuid}
           LIMIT 1
    `);
    const owner = direct[0] ?? aliased[0];
    if (!owner) {
      // A queue row without its direct/aliased message cannot prove whether it was born in modern
      // attempt-aware mode. Retire it before returning so the caller can never POST it through the
      // tokenless legacy path; later rows in the same drain remain eligible to make progress.
      await db
        .update(outgoingQueue)
        .set({ attempts: OUTGOING_MAX_ATTEMPTS })
        .where(eq(outgoingQueue.id, id));
      return { claimed: false };
    }

    const queuedTarget = queuedMessageTarget(claimed.kind, claimed.payload);
    const unsupportedRcsReply =
      queuedTarget.kind === 'target' &&
      claimed.kind !== 'reaction' &&
      isRcsChatGuid(claimed.chatGuid);
    const targetAvailable =
      !unsupportedRcsReply &&
      (queuedTarget.kind === 'none' ||
        (queuedTarget.kind === 'target' &&
          (await isMessageTargetAvailableWithinTransaction(context, {
            chatGuid: claimed.chatGuid,
            messageGuid: queuedTarget.messageGuid,
            partIndex: queuedTarget.partIndex,
            allowRcsWholeMessage: claimed.kind === 'reaction' && isRcsChatGuid(claimed.chatGuid),
            serverAuthorization,
          }))));
    if (!targetAvailable) {
      // Target loss is permanent for this queued attempt. Keep the capped ladder so the failed
      // bubble remains user-removable, and update the resolved canonical owner when an alias exists.
      await db
        .update(outgoingQueue)
        .set({ attempts: OUTGOING_MAX_ATTEMPTS })
        .where(eq(outgoingQueue.id, id));
      await db
        .update(messages)
        .set({ sendState: 'error', error: 1, errorMessage: null })
        .where(eq(messages.guid, owner.guid));
      return { claimed: false };
    }

    if (owner.generation === 0) {
      // Generation zero is a durable legacy-mode marker. Never upgrade it based on today's
      // capability advertisement; an old cached response cannot supply modern correlation.
      await db
        .update(messages)
        .set({ sendState: 'sending', error: 0, errorMessage: null })
        .where(eq(messages.guid, owner.guid));
      return { claimed: true };
    }
    if (owner.generation >= MAX_SEND_ATTEMPT_OWNER_GENERATION) {
      throw new Error('send attempt ownership generation exhausted');
    }

    const advanced = await db.all<{ generation: number }>(sql`
      UPDATE messages
         SET send_state = 'sending', error = 0, error_message = NULL,
             attempt_owner_pending = 1,
             attempt_owner_generation = attempt_owner_generation + 1
       WHERE guid = ${owner.guid}
         AND attempt_owner_generation = ${owner.generation}
         AND attempt_owner_generation < ${MAX_SEND_ATTEMPT_OWNER_GENERATION}
      RETURNING attempt_owner_generation AS generation
    `);
    if (!advanced[0]) {
      // Keep the lease and generation in one all-or-nothing transaction. A partial claim would
      // suppress the real owner for two minutes without giving this request a valid fence.
      throw new Error('outgoing send attempt owner changed during claim');
    }
    return {
      claimed: true,
      attemptOwnerToken: { generation: advanced[0].generation },
    };
  });
}

/**
 * Standalone automatic-claim owner retained for repository and DEV callers. Production services
 * that compose this write use {@link claimOutgoingForSendWithinTransaction} inside their own short
 * guarded owner instead of nesting this wrapper.
 */
export async function claimOutgoingForSend(
  db: AppDatabase,
  id: number,
  clock: () => number,
  commitGuard?: DbCommitGuard,
): Promise<boolean> {
  const result = await withDbTransaction(
    db,
    (context) => claimOutgoingForSendWithinTransaction(context, id, clock),
    commitGuard,
  );
  return result.claimed;
}

/** Halves of an optimistic send that lost their partner (see {@link countOutgoingQueueHealth}). */
export interface OutgoingQueueHealth {
  /**
   * Optimistic bubbles frozen on 'sending' with NO queue row to recover them. Nothing retries
   * these and nothing resets them at boot, so each one is a message the user believes is on its
   * way that will never be sent. TOMBSTONED rows are excluded: a cancelled send deliberately keeps
   * its 'sending' state (so the echo can still promote it) and its ladder is gone on purpose, so
   * counting it would report a permanent, self-inflicted "stranded" every launch.
   */
  strandedSending: number;
  /**
   * Queue rows whose optimistic message is gone and has no retained temp-to-canonical alias that
   * resolves to an existing message. Each will be re-sent blind on the next drain, with no bubble
   * anywhere to show for it — including a send the user explicitly cancelled.
   */
  orphanQueueRows: number;
}

/**
 * Count the two halves of the optimistic-send lifecycle that can be left without their partner if
 * the process dies between two of its adjacent commits. Both are supposed to be impossible now
 * (every insert/reconcile/discard commits the pair in one transaction) — this is the cheap
 * standing check that says whether that's actually true on real devices, since the windows are far
 * too small to reproduce deliberately. Log at warn only when non-zero.
 *
 * Both halves must stay INDEX-DRIVEN: this is awaited ahead of the boot drain, and `messages` is
 * the biggest table on the device. `guid LIKE 'temp-%'` cannot use `messages_guid_idx` — SQLite's
 * LIKE optimization is off under the default case-insensitive LIKE — and plans as a full scan of
 * every synced message. The half-open RANGE below is the same set of guids (they are minted
 * lowercase by `generateTempGuid`; '.' is the next byte after '-') and plans as an index search.
 */
export async function countOutgoingQueueHealth(db: AppDatabase): Promise<OutgoingQueueHealth> {
  const rows = await db.all<OutgoingQueueHealth>(sql`
    SELECT
      (SELECT COUNT(*) FROM messages m
        WHERE m.guid >= 'temp-' AND m.guid < 'temp.' AND m.send_state = 'sending'
          AND m.date_deleted IS NULL
          AND NOT EXISTS (SELECT 1 FROM outgoing_queue q WHERE q.temp_guid = m.guid)
      ) AS strandedSending,
      (SELECT COUNT(*) FROM outgoing_queue q
        WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.guid = q.temp_guid)
          AND NOT EXISTS (
            SELECT 1
              FROM message_guid_aliases a
              JOIN messages m ON m.guid = a.canonical_guid
             WHERE a.alias_guid = q.temp_guid
          )
      ) AS orphanQueueRows`);
  return rows[0] ?? { strandedSending: 0, orphanQueueRows: 0 };
}
