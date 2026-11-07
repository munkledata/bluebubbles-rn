/**
 * Outgoing discard, retry claims and retirement (moved from outgoing.ts): discarding or cancelling a
 * queued send, claiming a failed send for retry, and retiring settled or uncertain rows.
 */

import { and, eq, ne, sql } from 'drizzle-orm';
import { CURRENT_LOCATION_MAX_REPLAY_AGE_MS } from '@core/api/endpoints/messages';
import { ClientErrorCode, LOCATION_DELIVERY_UNCONFIRMED_COPY } from '@utils';
import { isRcsChatGuid } from '@utils/chat';
import { messages, outgoingQueue } from '../schema';
import {
  type DbCommitGuard,
  type DbTransactionContext,
  runInTransactionContext,
  withDbTransaction,
} from '../transaction';
import type { Queryable, ReadDb } from '../types';
import {
  MAX_SEND_ATTEMPT_OWNER_GENERATION,
  type SendAttemptOwnerToken,
} from './outgoingAttemptOwnership';
import type { RetryableOutgoing } from './outgoingRetry';
import {
  imessagePlainTextQueueState,
  OUTGOING_LEASE_MS,
  OUTGOING_MAX_ATTEMPTS,
  withIMessagePlainTextRetrySafety,
} from './outgoingRetryPolicy';
import {
  isMessageTargetAvailableWithinTransaction,
  type MessageTargetServerAuthorization,
  queuedMessageTarget,
} from './messageTargets';
import { markMessageDeletedWithinTransaction } from './messages';

/**
 * Remove a not-yet-confirmed optimistic send — the ONE guarded write behind both user
 * affordances ("Cancel Sending" on a live send, "Delete"/"Remove" on a failed one), exported
 * under both names. Returns whether this call OWNED the message: false ⇒ it is not an
 * unconfirmed row of ours and the caller must apply the ordinary local-delete (tombstone) path.
 *
 * THE WHOLE DECISION IS IN THE WRITE. A `SELECT … then DELETE` was the bug: the tap races the
 * 20 s retry drain, which leases the row, flips it to 'sending' and starts a POST that can run for
 * seconds, while the sheet the user is tapping shows the state from when it opened. What the write
 * matches is therefore the only trustworthy answer, and the compare-and-set matches ONLY a
 * `temp-…` row still in an unconfirmed state ('sending' or 'error'):
 *  - a row promoted to 'sent' in the gap survives untouched — on the guid-less ack paths (RCS
 *    bridge / AppleScript) a SUCCESSFUL send keeps its temp guid, so hard-deleting it would remove
 *    a message the recipient already has and the server echo would re-insert it as a fresh bubble;
 *  - a real (server-issued) guid is never matched: it belongs on the caller's ordinary tombstone
 *    path, which recomputes the chat's sort key and reports "unknown guid" honestly.
 *
 * What it writes is a TOMBSTONE, not a row removal — see the cancelled-send rule at the top of this
 * file. Both matched states can correspond to a message the server already has, and the row is what
 * the later echo/fanout/re-page promotes in place, carrying `date_deleted` onto the real identity.
 *
 * The queue row goes in BOTH branches, inside the same transaction. When we tombstoned the bubble
 * the ladder must not outlive it (an orphan queue row re-sends blind on the next drain — a message
 * the user explicitly cancelled, with nothing on screen to tell them). When we did NOT match — an
 * orphan row, or a bubble the caller is about to tombstone itself — a surviving ladder would
 * re-POST behind the user's back the thing they just deleted.
 *
 * Reporting "owned" for a queue-row-only cleanup is what this must never do again: the Delete path
 * treats true as "handled" and skips the tombstone, so the message the user asked to delete stayed
 * on screen with no error while its retry ladder was silently stripped.
 */
export function discardOutgoingMessageWithinTransaction(
  context: DbTransactionContext,
  guid: string,
  now: number,
): Promise<boolean> {
  return runInTransactionContext(context, async (db) => {
    const owned = await db.all<{ id: number }>(sql`
      UPDATE messages SET date_deleted = ${now}
       WHERE guid = ${guid} AND guid LIKE 'temp-%' AND send_state IN ('sending', 'error')
      RETURNING id`);
    await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, guid));
    if (owned.length === 0) return false;
    // Re-stamp through the shared tombstone helper for its SECOND effect: recomputing the chat's
    // denormalized latest_message_date. Cancelling the newest message otherwise leaves the inbox
    // sorted (and previewing) on a row nothing renders. Idempotent — the stamp above already
    // decided; this only repeats it.
    await markMessageDeletedWithinTransaction(context, guid, now);
    return true;
  });
}
/**
 * Discard one optimistic outgoing message in its own standalone transaction. Callers that already own
 * the transaction must use {@link discardOutgoingMessageWithinTransaction} instead of nesting this
 * wrapper.
 */
export async function discardOutgoingMessage(
  db: ReadDb,
  guid: string,
  now: number = Date.now(),
): Promise<boolean> {
  return withDbTransaction(db, (db, context) =>
    discardOutgoingMessageWithinTransaction(context, guid, now),
  );
}
/**
 * "Cancel Sending" — the same write as {@link discardOutgoingMessage}. The two affordances differ
 * only in the wording of their dialog: both ask for an unconfirmed optimistic send to be removed,
 * and both must refuse a send that already left the device. Kept as a name so the call sites read
 * as what the user tapped.
 */
export const cancelOutgoing = discardOutgoingMessage;
/** What {@link claimFailedOutgoingForRetry} found when it tried to take the row over. */
export type RetryClaim =
  /** The errored row is now 'sending' and its queue payload is handed back — re-POST it. */
  | 'claimed'
  /** An automatic retry currently owns it (a POST is in flight) — do nothing. */
  | 'sending'
  /** Already sent/promoted/gone — re-sending would deliver a second copy. */
  | 'settled'
  /**
   * No queue row, so there is no payload to re-POST and no honest way to rebuild one — an errored
   * bubble whose ladder the RCS immediate ack consumed, or a real server guid that failed after
   * delivery. Nothing is written.
   */
  | 'unsendable';
/** The outcome of {@link claimFailedOutgoingForRetry}; `row` is present only when 'claimed'. */
export interface RetryHandover {
  claim: RetryClaim;
  /** The QUEUE payload to re-POST, under the row's ORIGINAL temp guid. */
  row?: RetryableOutgoing;
  /** Exact local generation the retry acknowledgement must compare-and-set. */
  attemptOwnerToken?: SendAttemptOwnerToken;
}
function isQueuedOneShotText(row: Pick<RetryableOutgoing, 'kind' | 'payload'>): boolean {
  if (row.kind !== 'text') return false;
  try {
    const payload = JSON.parse(row.payload) as {
      imessageEffectV1?: unknown;
      imessageMentionV1?: unknown;
      imessageFormattedV1?: unknown;
      imessageSubjectV1?: unknown;
    };
    // The durable markers are authoritative. Missing/corrupt rich fields must fail closed rather
    // than convert a possibly-dispatched helper send into manually replayable plain text.
    return (
      payload.imessageEffectV1 === true ||
      payload.imessageMentionV1 === true ||
      payload.imessageFormattedV1 === true ||
      payload.imessageSubjectV1 === true
    );
  } catch {
    return false;
  }
}
/** Read-only preflight for the UI retry gate; the transaction below still revalidates this row. */
export async function getOutgoingRetryChatGuid(
  db: Queryable,
  guid: string,
): Promise<string | null> {
  const rows = await db.all<{ chatGuid: string }>(sql`
    SELECT q.chat_guid AS chatGuid
      FROM outgoing_queue q
      LEFT JOIN message_guid_aliases a
        ON a.alias_guid = q.temp_guid AND a.chat_guid = q.chat_guid
     WHERE q.temp_guid = ${guid} OR a.canonical_guid = ${guid}
     ORDER BY (q.temp_guid = ${guid}) DESC, q.id DESC
     LIMIT 1
  `);
  return rows[0]?.chatGuid ?? null;
}
/**
 * Take over a FAILED optimistic send so the caller can re-send it — under the SAME temp guid, from
 * the SAME queue payload.
 *
 * The state flip is a compare-and-set on `send_state = 'error'`, and that guard is the whole point.
 * The retry sheet holds a snapshot from the moment it opened, but the 20 s drain claims eligible
 * rows continuously and flips them to 'sending' before every POST — so by the time the user taps
 * "Try Again" the row may be mid-flight (a second POST would deliver a second copy) or already
 * delivered (the guid-less ack paths keep the temp guid). Only an 'error' row is ours to re-send;
 * the other outcomes are reported so the caller can say so instead of silently duplicating.
 *
 * TWO THINGS THIS MUST NOT DO, both of which it used to.
 *  - MINT A NEW TEMP GUID. It deleted the row so the caller could re-send from scratch, but the
 *    server's idempotency cache is keyed on exactly that id: a send that failed client-side (a
 *    30 s HTTP timeout) yet landed server-side is then dispatched a SECOND time under the new key.
 *    The automatic drain never had this bug because it re-POSTs under `row.tempGuid`.
 *  - REBUILD THE SEND FROM THE BUBBLE. The caller only has what is on screen, so a failed CONTACT
 *    CARD went out as a plain text message reading the contact's display name — precisely the
 *    outcome `kind:'contact'` exists to prevent — and a reply lost its target, a send lost its
 *    effect id, subject and mention spans. Only the queue payload carries those, so the payload is
 *    what is handed back.
 * Nothing is destroyed either: the row the user is trying to rescue survives the claim, so a throw
 * in the re-send (or a process death) leaves a failed bubble and a live ladder rather than nothing.
 *
 * ONE transaction, and only ONE thing in it decides: the compare-and-set on the message. The queue
 * payload is read first, but that read is not a decision — inside the transaction nothing can
 * change under it, and with no payload there is simply nothing to re-POST ('unsendable': an
 * attachment retired because its on-disk file is gone, or a ladder the RCS immediate ack consumed).
 * A refused claim with a resolved owner writes nothing at all, so it can never strip the ladder off
 * a send that is in flight. The sole exception is an ownerless ladder, which is retired to prevent a
 * later tokenless automatic POST. A claimed one re-arms that ladder in the same transaction as the
 * flip — attempts reset, because the button is the ONLY recourse for a row already retired at the
 * attempt cap, and leased, so a drain tick can't re-POST the same payload alongside the caller's own
 * attempt.
 */
export function claimFailedOutgoingForRetryWithinTransaction(
  context: DbTransactionContext,
  guid: string,
  clock: () => number = Date.now,
  serverAuthorization?: MessageTargetServerAuthorization,
  locationAvailable?: () => boolean,
  rcsAvailable?: (chatGuid: string) => boolean,
  imessagePlainTextAvailable?: (chatGuid: string) => boolean,
): Promise<RetryHandover> {
  return runInTransactionContext(context, async (db) => {
    const now = clock();
    const queued = await db.all<RetryableOutgoing>(sql`
        SELECT q.id, q.temp_guid AS tempGuid, q.chat_guid AS chatGuid, q.kind, q.payload,
               q.attempts, q.created_at AS createdAt
          FROM outgoing_queue q
          LEFT JOIN message_guid_aliases a
            ON a.alias_guid = q.temp_guid AND a.chat_guid = q.chat_guid
         WHERE q.temp_guid = ${guid} OR a.canonical_guid = ${guid}
         ORDER BY (q.temp_guid = ${guid}) DESC, q.id DESC
         LIMIT 1`);
    const row = queued[0];
    if (!row) return { claim: 'unsendable' };
    // A Google source id can be reused after a re-pair. Keep the old failed bubble/ladder intact;
    // never flip it to sending or mutate its retry bookkeeping without exact current-epoch proof.
    if (isRcsChatGuid(row.chatGuid) && rcsAvailable?.(row.chatGuid) !== true) {
      return { claim: 'unsendable' };
    }
    if (row.kind === 'location' && locationAvailable?.() !== true) {
      return { claim: 'unsendable' };
    }
    const imessagePlainTextState = imessagePlainTextQueueState(row.kind, row.payload);
    if (
      imessagePlainTextState === 'retry-safe' &&
      imessagePlainTextAvailable?.(row.chatGuid) !== true
    ) {
      return { claim: 'unsendable' };
    }
    // A narrow plain text without a retry proof was refused by the server or may have been sent;
    // a manual re-send could only stop before the network and relabel the bubble "maybe sent".
    if (imessagePlainTextState === 'unsafe') return { claim: 'unsendable' };
    const queuedTarget = queuedMessageTarget(row.kind, row.payload);
    // One-shot iMessage attachments, contacts, replies, effects, mentions, formatted and subject
    // messages may not be manually replayed: a lost HTTP acknowledgement can mean the helper dispatched them.
    if (
      isQueuedOneShotText(row) ||
      (!isRcsChatGuid(row.chatGuid) &&
        (row.kind === 'attachment' ||
          row.kind === 'contact' ||
          (row.kind === 'text' && queuedTarget.kind === 'target')))
    ) {
      return { claim: 'unsendable' };
    }

    const direct = await db.all<{
      guid: string;
      sendState: string | null;
      generation: number;
      error: number | null;
    }>(sql`
      SELECT m.guid, m.send_state AS sendState,
             m.attempt_owner_generation AS generation, m.error
        FROM messages m
        JOIN chats c ON c.id = m.chat_id
       WHERE m.guid = ${row.tempGuid}
         AND c.guid = ${row.chatGuid}
       LIMIT 1
    `);
    const aliased = direct[0]
      ? []
      : await db.all<{
          guid: string;
          sendState: string | null;
          generation: number;
          error: number | null;
        }>(sql`
          SELECT m.guid, m.send_state AS sendState,
                 m.attempt_owner_generation AS generation, m.error
            FROM message_guid_aliases a
            JOIN messages m ON m.guid = a.canonical_guid
            JOIN chats c ON c.id = m.chat_id
           WHERE a.alias_guid = ${row.tempGuid}
             AND a.chat_guid = ${row.chatGuid}
             AND c.guid = ${row.chatGuid}
           LIMIT 1
    `);
    const current = direct[0] ?? aliased[0];
    if (!current) {
      // The durable payload has lost the only direct/alias link that proves its send mode. Retire
      // this exact ladder rather than leave it for an automatic tokenless POST. Preserve the
      // historical settled result because this also covers a legitimately promoted legacy row.
      await db
        .update(outgoingQueue)
        .set({ attempts: OUTGOING_MAX_ATTEMPTS })
        .where(eq(outgoingQueue.id, row.id));
      return { claim: 'settled' };
    }
    if (
      current.error === ClientErrorCode.effectDeliveryUnconfirmed ||
      current.error === ClientErrorCode.mentionDeliveryUnconfirmed ||
      current.error === ClientErrorCode.formattedDeliveryUnconfirmed
    ) {
      // Effects, mentions, and formatted messages are one-shot even when their payload survives for
      // reconciliation. A manual retry could mint another helper dispatch after an ambiguity.
      return { claim: 'unsendable' };
    }
    if (
      row.kind === 'location' &&
      (current.error === ClientErrorCode.locationDeliveryUnconfirmed ||
        current.error === ClientErrorCode.locationRejected ||
        !Number.isSafeInteger(row.createdAt) ||
        row.createdAt < 0 ||
        row.createdAt > now ||
        now - row.createdAt >= CURRENT_LOCATION_MAX_REPLAY_AGE_MS)
    ) {
      await db
        .update(outgoingQueue)
        .set({ attempts: OUTGOING_MAX_ATTEMPTS, payload: '{}' })
        .where(eq(outgoingQueue.id, row.id));
      await db
        .update(messages)
        .set({
          sendState: 'error',
          error: ClientErrorCode.locationDeliveryUnconfirmed,
          errorMessage: LOCATION_DELIVERY_UNCONFIRMED_COPY,
        })
        .where(eq(messages.guid, current.guid));
      return { claim: 'unsendable' };
    }
    const unsupportedRcsReply =
      queuedTarget.kind === 'target' && row.kind !== 'reaction' && isRcsChatGuid(row.chatGuid);
    const targetAvailable =
      !unsupportedRcsReply &&
      (queuedTarget.kind === 'none' ||
        (queuedTarget.kind === 'target' &&
          (await isMessageTargetAvailableWithinTransaction(context, {
            chatGuid: row.chatGuid,
            messageGuid: queuedTarget.messageGuid,
            partIndex: queuedTarget.partIndex,
            allowRcsWholeMessage: row.kind === 'reaction' && isRcsChatGuid(row.chatGuid),
            serverAuthorization,
          }))));
    if (!targetAvailable) {
      await db
        .update(outgoingQueue)
        .set({ attempts: OUTGOING_MAX_ATTEMPTS })
        .where(eq(outgoingQueue.id, row.id));
      await db
        .update(messages)
        .set({ sendState: 'error', error: ClientErrorCode.cannotBeSent, errorMessage: null })
        .where(eq(messages.guid, current.guid));
      return { claim: 'unsendable' };
    }
    if (current.generation >= MAX_SEND_ATTEMPT_OWNER_GENERATION) {
      throw new Error('send attempt ownership generation exhausted');
    }

    // Send mode is durable per optimistic row. A generation-0 row was created against a legacy
    // server and must stay legacy even if today's connection advertises the capability: a cached
    // pre-upgrade success cannot round-trip ownership. Conversely, generation>0 can never fall
    // back to the legacy path when capability discovery is temporarily unavailable.
    const modern = current.generation > 0;
    const taken = modern
      ? await db.all<{ id: number; generation: number }>(sql`
          UPDATE messages
             SET send_state = 'sending', error = 0, error_message = NULL,
                 attempt_owner_pending = 1,
                 attempt_owner_generation = attempt_owner_generation + 1
           WHERE guid = ${current.guid} AND send_state = 'error'
             AND attempt_owner_generation = ${current.generation}
             AND attempt_owner_generation < ${MAX_SEND_ATTEMPT_OWNER_GENERATION}
          RETURNING id, attempt_owner_generation AS generation`)
      : await db.all<{ id: number; generation: number }>(sql`
          UPDATE messages SET send_state = 'sending', error = 0, error_message = NULL
           WHERE guid = ${current.guid} AND send_state = 'error'
             AND attempt_owner_generation = 0
          RETURNING id, attempt_owner_generation AS generation`);
    if (taken.length === 0) {
      // Read AFTER the failed compare-and-set, and only to word the message to the user — no write
      // depends on it, so a stale answer here is harmless.
      const cur = await db.all<{ sendState: string | null }>(
        sql`SELECT send_state AS sendState FROM messages WHERE guid = ${current.guid} LIMIT 1`,
      );
      return { claim: cur[0]?.sendState === 'sending' ? 'sending' : 'settled' };
    }
    const claimedPayload =
      imessagePlainTextState === 'retry-safe'
        ? withIMessagePlainTextRetrySafety(row.payload, false)
        : row.payload;
    if (claimedPayload == null) {
      throw new Error('narrow iMessage text retry proof could not be consumed');
    }
    const queueTaken = await db.all<{ id: number }>(sql`
        UPDATE outgoing_queue
           SET attempts = 0, next_retry_at = ${now + OUTGOING_LEASE_MS},
               payload = ${claimedPayload}
         WHERE temp_guid = ${row.tempGuid} AND payload = ${row.payload}
        RETURNING id`);
    if (queueTaken.length === 0) {
      throw new Error('outgoing retry payload changed during guarded claim');
    }
    return {
      claim: 'claimed',
      row: { ...row, attempts: 0 },
      ...(modern ? { attemptOwnerToken: { generation: taken[0]!.generation } } : {}),
    };
  });
}
/**
 * Claim one failed send in its own guarded transaction. Callers that already own the transaction
 * must use {@link claimFailedOutgoingForRetryWithinTransaction} instead of nesting this wrapper.
 */
export async function claimFailedOutgoingForRetry(
  db: ReadDb,
  guid: string,
  clock: () => number = Date.now,
  commitGuard?: DbCommitGuard,
  serverAuthorization?: MessageTargetServerAuthorization,
  locationAvailable?: () => boolean,
  rcsAvailable?: (chatGuid: string) => boolean,
  imessagePlainTextAvailable?: (chatGuid: string) => boolean,
): Promise<RetryHandover> {
  return withDbTransaction(
    db,
    (db, context) =>
      claimFailedOutgoingForRetryWithinTransaction(
        context,
        guid,
        clock,
        serverAuthorization,
        locationAvailable,
        rcsAvailable,
        imessagePlainTextAvailable,
      ),
    commitGuard,
  );
}
/**
 * The canonical row a temp GUID's alias points to, only when the alias is scoped to that row's own
 * chat (an ownerless alias never matches). Looked up by message id through indexes.
 */
function scopedAliasCanonicalRowSql(tempGuid: string) {
  return sql`${messages.id} IN (
    SELECT m.id FROM message_guid_aliases a
      JOIN messages m ON m.guid = a.canonical_guid
      JOIN chats c ON c.id = m.chat_id AND c.guid = a.chat_guid
     WHERE a.alias_guid = ${tempGuid}
  )`;
}
/** Permanently retire all outgoing state for one temporary GUID inside its owning transaction. */
export function retireOutgoingWithinTransaction(
  context: DbTransactionContext,
  tempGuid: string,
  errorCode = 1,
): Promise<void> {
  return runInTransactionContext(context, async (db) => {
    await db
      .update(outgoingQueue)
      .set({ attempts: OUTGOING_MAX_ATTEMPTS })
      .where(eq(outgoingQueue.tempGuid, tempGuid));
    // Two indexed updates (the temp row, then its scoped alias's canonical row). One OR with a
    // correlated alias subquery made SQLite scan every message under the global lock (M066).
    await db
      .update(messages)
      .set({ sendState: 'error', error: errorCode, errorMessage: null })
      .where(and(eq(messages.guid, tempGuid), ne(messages.sendState, 'sent')));
    await db
      .update(messages)
      .set({ sendState: 'error', error: errorCode, errorMessage: null })
      .where(and(scopedAliasCanonicalRowSql(tempGuid), ne(messages.sendState, 'sent')));
  });
}
/** Keep a one-shot attachment and its local file, but make an uncertain result non-replayable. */
export function retireUncertainOutgoingWithinTransaction(
  context: DbTransactionContext,
  tempGuid: string,
  errorCode: number,
  detail: string,
  scrubPayload = false,
): Promise<boolean> {
  return runInTransactionContext(context, async (db) => {
    const owned = await db
      .update(outgoingQueue)
      .set({ attempts: OUTGOING_MAX_ATTEMPTS, ...(scrubPayload ? { payload: '{}' } : {}) })
      .where(eq(outgoingQueue.tempGuid, tempGuid))
      .returning({ id: outgoingQueue.id });
    if (owned.length === 0) return false;
    // Same two indexed updates as retireOutgoingWithinTransaction (M066).
    const markedTemp = await db
      .update(messages)
      .set({ sendState: 'error', error: errorCode, errorMessage: detail })
      .where(and(eq(messages.guid, tempGuid), ne(messages.sendState, 'sent')))
      .returning({ id: messages.id });
    const markedCanonical = await db
      .update(messages)
      .set({ sendState: 'error', error: errorCode, errorMessage: detail })
      .where(and(scopedAliasCanonicalRowSql(tempGuid), ne(messages.sendState, 'sent')))
      .returning({ id: messages.id });
    return markedTemp.length + markedCanonical.length > 0;
  });
}
