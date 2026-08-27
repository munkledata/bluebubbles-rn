import { and, eq, sql } from 'drizzle-orm';
import { messages, outgoingQueue } from '../schema';
import {
  runInTransactionContext,
  withDbTransaction,
  type DbCommitGuard,
  type DbTransactionContext,
} from '../transaction';
import type { AppDatabase } from '../types';
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
export async function reconcileOutgoingErrorWithinTransaction(
  context: DbTransactionContext,
  tempGuid: string,
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
          FROM outgoing_queue q LEFT JOIN messages m ON m.guid = q.temp_guid
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
        .where(eq(messages.guid, tempGuid));
      return false;
    }
    // Gator fans one message-send-error over BOTH socket and FCM but supplies no shared attempt id.
    // The first copy has already moved the bubble to this exact error and advanced/rebuilt a ladder;
    // treating the second copy as success prevents one server failure from consuming two attempts.
    // A genuine later retry first flips the bubble back to `sending`/error=0, so its next failure is
    // still distinguishable and advances normally.
    if (prior > 0 && current.sendState === 'error' && current.currentError === errorCode) {
      if (errorMessage !== undefined && current.currentErrorMessage !== errorMessage) {
        await db.update(messages).set({ errorMessage }).where(eq(messages.guid, tempGuid));
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
      .where(eq(messages.guid, tempGuid));
    const attempts = prior + 1;
    const bumped = await db.all<{ id: number }>(sql`
        UPDATE outgoing_queue SET attempts = ${attempts}, next_retry_at = ${now + outgoingBackoffMs(attempts)}
         WHERE temp_guid = ${tempGuid} AND attempts = ${prior}
        RETURNING id`);
    return bumped.length > 0;
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
): Promise<boolean> {
  return withDbTransaction(
    db,
    (context) =>
      reconcileOutgoingErrorWithinTransaction(context, tempGuid, errorCode, now, errorMessage),
    commitGuard,
  );
}

/**
 * Transaction-only message error state from a SERVER-pushed `message-send-error` (Messages.app
 * rejected the send after it already left the app). Unlike {@link reconcileOutgoingError} this does
 * NOT touch the outgoing_queue — it only surfaces the failure on the bubble (error badge + retry).
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
 * MAX_REQUEUE_CYCLES automatic ladders per tempGuid per app session; after that the failure
 * stays on the bubble for a manual retry. Bounded at {@link REQUEUE_MAP_MAX} entries (oldest key
 * evicted on insert) so a long session cannot grow it without limit.
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
 * already deleted the queue row, so without this the "picture failed after the ack" case was
 * manual-retry only. Rebuilds a queue row from the message (+ attachment) rows.
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
): Promise<RequeueCommitEffect | null> {
  return runInTransactionContext(context, async (db) => {
    const cycleKey = requeueCycleKey(tempGuid, scope);
    if (!tempGuid.startsWith('temp-')) return null;
    if ((requeueCycles.get(cycleKey) ?? 0) >= MAX_REQUEUE_CYCLES) return null;
    const rows = await db.all<{
      id: number;
      text: string | null;
      subject: string | null;
      threadOriginatorGuid: string | null;
      expressiveSendStyleId: string | null;
      chatGuid: string | null;
    }>(sql`
      SELECT m.id, m.text, m.subject,
             m.thread_originator_guid AS threadOriginatorGuid,
             m.expressive_send_style_id AS expressiveSendStyleId,
             c.guid AS chatGuid
      FROM messages m JOIN chats c ON c.id = m.chat_id
      WHERE m.guid = ${tempGuid} AND m.associated_message_type IS NULL
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
    let kind: 'text' | 'attachment';
    let payload: string;
    const firstAtt = att[0];
    if (firstAtt) {
      if (!firstAtt.localPath) return null; // nothing on disk to re-upload
      kind = 'attachment';
      payload = JSON.stringify({ attachmentGuid: firstAtt.guid, localPath: firstAtt.localPath });
    } else {
      kind = 'text';
      payload = JSON.stringify({
        message: msg.text ?? '',
        selectedMessageGuid: msg.threadOriginatorGuid ?? undefined,
        effectId: msg.expressiveSendStyleId ?? undefined,
        subject: msg.subject ?? undefined,
      });
    }
    // attempts starts at 1: the failed background relay WAS attempt one, and attempts>=1 also
    // bypasses the fresh-row grace window so the ladder re-fires on the next drain tick.
    await db.insert(outgoingQueue).values({
      tempGuid,
      chatGuid: msg.chatGuid,
      kind,
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

export interface ServerSendErrorTransactionResult {
  matched: boolean;
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
): Promise<ServerSendErrorTransactionResult> {
  return runInTransactionContext(context, async (_db) => {
    // The bump IS the "is a ladder still alive?" test. Asking first with a SELECT and then
    // committing to that branch lost the whole retryable path when the ack deleted the queue row in
    // between (three awaits wide): the UPDATE matched nothing, reported nothing, and the re-enqueue
    // below was never reached — the one case this machinery exists for, downgraded to bubble-only.
    if (
      await reconcileOutgoingErrorWithinTransaction(context, guid, errorCode, now, errorMessage)
    ) {
      return { matched: true, onCommitted: null };
    }
    const onCommitted = retryable
      ? await reEnqueueOutgoingFromMessageWithinTransaction(context, guid, now, requeueScope)
      : null;
    return {
      matched:
        (await markMessageSendErrorWithinTransaction(context, guid, errorCode, errorMessage)) ||
        onCommitted != null,
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
export function claimOutgoingForSendWithinTransaction(
  context: DbTransactionContext,
  id: number,
  clock: () => number,
): Promise<boolean> {
  return runInTransactionContext(context, async (db) => {
    // Read AFTER acquiring the process-wide lock. A timestamp captured before a long queue wait
    // can make the two-minute lease expire as soon as it commits, allowing a second sender in.
    const now = clock();
    const rows = await db.all<{ tempGuid: string }>(sql`
        UPDATE outgoing_queue SET next_retry_at = ${now + OUTGOING_LEASE_MS}
        WHERE id = ${id} AND next_retry_at <= ${now}
        RETURNING temp_guid AS tempGuid`);
    const claimed = rows[0];
    if (!claimed) return false;
    await db
      .update(messages)
      .set({ sendState: 'sending', error: 0, errorMessage: null })
      .where(and(eq(messages.guid, claimed.tempGuid), eq(messages.sendState, 'error')));
    return true;
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
  return withDbTransaction(
    db,
    (context) => claimOutgoingForSendWithinTransaction(context, id, clock),
    commitGuard,
  );
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
   * Queue rows whose optimistic message is gone. Each will be re-sent blind on the next drain,
   * with no bubble anywhere to show for it — including a send the user explicitly cancelled.
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
      ) AS orphanQueueRows`);
  return rows[0] ?? { strandedSending: 0, orphanQueueRows: 0 };
}
