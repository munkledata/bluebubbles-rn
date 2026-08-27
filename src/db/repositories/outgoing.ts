import { and, eq, ne, sql } from 'drizzle-orm';
import type { MessageMention } from '@core/api/endpoints/messages';
import {
  chats,
  messageDeletionLedger,
  messageGuidAliases,
  messages,
  outgoingQueue,
} from '../schema';
import {
  runInTransactionContext,
  withDbTransaction,
  type DbCommitGuard,
  type DbTransactionContext,
} from '../transaction';
import type { AppDatabase } from '../types';
import { requireChatIdByGuidWithinTransaction } from './chats';
import type { RetryableOutgoing } from './outgoingRetry';
import { OUTGOING_LEASE_MS, OUTGOING_MAX_ATTEMPTS } from './outgoingRetryPolicy';
// The ONE tombstone write (stamp `date_deleted` + recompute the chat's denormalized sort key).
// Imported from the module that owns it rather than restated here, so the two can't drift;
// messages.ts imports nothing from this file, so there is no cycle.
import { markMessageDeletedWithinTransaction } from './messages';

/** Maximum durable temp → real message mappings retained for stale UI actions. */
export const MESSAGE_GUID_ALIAS_LIMIT = 4096;

/** One client temp GUID was observed mapping to two different server identities. */
export class MessageGuidAliasConflictError extends Error {
  override readonly name = 'MessageGuidAliasConflictError';

  constructor() {
    // Fixed copy only: GUIDs are account data and must not leak through diagnostics.
    super('message GUID alias conflicts with an existing canonical identity');
  }
}

/**
 * Record one learned temp → real identity while an owning promotion transaction is open.
 *
 * Re-observing the same mapping refreshes its recency. A different canonical identity for an
 * existing alias is ambiguous and fails closed instead of letting a stale destructive action hit
 * the wrong message. The id-ordered prune is deterministic and retains exactly the newest cap.
 */
async function recordMessageGuidAliasWithinTransaction(
  context: DbTransactionContext,
  aliasGuid: string,
  canonicalGuid: string,
): Promise<void> {
  return runInTransactionContext(context, async (db) => {
    const existing = await db.all<{ canonicalGuid: string }>(sql`
      SELECT canonical_guid AS canonicalGuid
        FROM message_guid_aliases
       WHERE alias_guid = ${aliasGuid}
       LIMIT 1
    `);
    const previous = existing[0]?.canonicalGuid;
    if (previous != null && previous !== canonicalGuid) {
      throw new MessageGuidAliasConflictError();
    }
    if (previous != null) {
      await db.delete(messageGuidAliases).where(eq(messageGuidAliases.aliasGuid, aliasGuid));
    }
    await db.insert(messageGuidAliases).values({ aliasGuid, canonicalGuid });
    await db.run(sql`
      DELETE FROM message_guid_aliases
       WHERE id IN (
         SELECT id
           FROM message_guid_aliases
          ORDER BY id DESC
          LIMIT -1 OFFSET ${MESSAGE_GUID_ALIAS_LIMIT}
       )
    `);
  });
}

/** Server fields used to promote an optimistic message to its real identity. */
export interface ServerMsgFields {
  /**
   * The real server GUID. ABSENT on the AppleScript send path (the helper isn't
   * connected, so the server can't ack a GUID) — callers MUST NOT invoke this with an
   * undefined guid; instead they call `markOutgoingSentNoGuid`, and the live socket
   * `new-message` echo reconciles the optimistic row by CONTENT (`reconcileEchoByContent`,
   * since Gator's echo carries no tempGuid). The guard below is a belt-and-braces backstop.
   */
  guid: string;
  dateCreated: number | null;
  dateDelivered: number | null;
}

/**
 * Record an optimistic temp GUID's canonical server identity and move durable deletion knowledge.
 *
 * Call only from an already-owned transaction, immediately before the message-row identity
 * update. Keeping the row's `date_deleted` is not enough: a later chat purge removes that row,
 * and `upsertMessages` consults this independent ledger by the NEW GUID before re-ingesting it.
 * The independent alias survives a later message purge; merge both deletion keys so a marker that
 * arrived under the real GUID also wins over an older temp marker.
 */
async function handoverOutgoingIdentityWithinTransaction(
  context: DbTransactionContext,
  tempGuid: string,
  realGuid: string,
): Promise<number | null> {
  return runInTransactionContext(context, async (db) => {
    if (tempGuid === realGuid) return null;
    await recordMessageGuidAliasWithinTransaction(context, tempGuid, realGuid);
    const tombstones: Array<{ dateDeleted: number }> = await db.all<{ dateDeleted: number }>(sql`
      SELECT date_deleted AS dateDeleted
        FROM message_deletion_ledger
       WHERE guid IN (${tempGuid}, ${realGuid})
      UNION ALL
      SELECT date_deleted AS dateDeleted
        FROM messages
       WHERE guid = ${tempGuid} AND date_deleted IS NOT NULL
    `);
    const dateDeleted = tombstones.reduce<number | null>(
      (latest, row) => (latest == null || row.dateDeleted > latest ? row.dateDeleted : latest),
      null,
    );
    if (dateDeleted == null) return null;

    await db
      .insert(messageDeletionLedger)
      .values({ guid: realGuid, dateDeleted })
      .onConflictDoUpdate({
        target: messageDeletionLedger.guid,
        set: {
          dateDeleted: sql`MAX(${messageDeletionLedger.dateDeleted}, excluded.date_deleted)`,
        },
      });
    await db
      .update(messages)
      .set({
        dateDeleted: sql`COALESCE(MAX(${messages.dateDeleted}, ${dateDeleted}), ${messages.dateDeleted}, ${dateDeleted})`,
      })
      .where(eq(messages.guid, tempGuid));
    await db.delete(messageDeletionLedger).where(eq(messageDeletionLedger.guid, tempGuid));
    return dateDeleted;
  });
}

/**
 * A CANCELLED SEND IS A TOMBSTONE, NEVER A HARD DELETE — the one rule behind every path below.
 *
 * Cancelling cannot unsend what the server already accepted, and no local state proves it did not:
 * a 'sending' row has a POST in flight by definition, and an 'error' row can be a send that timed
 * out client-side (30 s) after the server processed it — which is exactly why the two content
 * reconcilers deliberately match 'error' rows. So the message will come back: from the live echo,
 * from the RCS fanout materializing `rcs-<id>` minutes later, or from `ensureChatSynced`'s
 * 500-message re-page on the very next chat open. Removing the row destroys the only thing that
 * later identity can inherit the deletion from.
 *
 * `date_deleted` survives all of it. The reconcilers promote IN PLACE and also move the independent
 * deletion-ledger key to the real guid, so the tombstone survives both ordinary re-pages and a
 * later chat purge followed by re-ingestion. Every render/count/search query filters it out, so the
 * bubble VANISHES and stays gone.
 *
 * This replaced an in-memory set of "cancelled while in flight" temp guids consulted on the ack
 * paths. That could not work: it died with the process, and it was never consulted on the
 * INGESTION path (`upsertMessages`), which is what actually re-creates the row.
 */

/**
 * INSERT ATOMICITY, shared by all four optimistic-send helpers: the queue row and the visible
 * message row commit TOGETHER, in ONE transaction. Neither half is any use alone, and both
 * failure modes are silent:
 *  - message without a queue row → a bubble frozen on 'sending' forever. Nothing recovers it (the
 *    retry processor reads `outgoing_queue` only, and unlike scheduled_messages nothing resets a
 *    stuck `send_state='sending'` at boot), so the message is silently never sent.
 *  - queue row without a message → the drain re-POSTs it from the self-contained payload with no
 *    bubble anywhere. That is not only a crash story: the messages INSERT can throw on its own (a
 *    `messages.chat_id REFERENCES chats(id)` failure if the chat row went away mid-send, or the
 *    FTS trigger), and then the send the caller just reported as FAILED goes out ~60 s later
 *    anyway — after the user retyped it, so the recipient gets it twice.
 * As separate autocommits no ORDER avoids both (which is why ordering them was not enough); the
 * transaction does. Every statement is short + DB-only and no caller is itself inside a
 * transaction, so the no-nesting rule holds. `countOutgoingQueueHealth` reports whether either
 * half is ever stranded on a real device.
 */

export interface InsertOutgoingTextArgs {
  tempGuid: string;
  /** @deprecated Ignored. The transaction resolves `chatGuid` to its committed local id. */
  chatId?: number;
  chatGuid: string;
  text: string;
  now: number;
  selectedMessageGuid?: string;
  threadOriginatorGuid?: string;
  effectId?: string;
  subject?: string;
  mentions?: MessageMention[];
}

/**
 * Transaction-only body for an optimistic text insert.
 *
 * Call only from a transaction that already owns the DB write mutex. The public
 * {@link insertOutgoingText} wrapper below remains the ordinary standalone entry point.
 */
export async function insertOutgoingTextWithinTransaction(
  context: DbTransactionContext,
  args: InsertOutgoingTextArgs,
): Promise<void> {
  return runInTransactionContext(context, async (db) => {
    const chatId = await requireChatIdByGuidWithinTransaction(context, args.chatGuid);
    await db.insert(outgoingQueue).values({
      tempGuid: args.tempGuid,
      chatGuid: args.chatGuid,
      kind: 'text',
      payload: JSON.stringify({
        message: args.text,
        selectedMessageGuid: args.selectedMessageGuid,
        effectId: args.effectId,
        subject: args.subject,
        // Persisted so a crash-recovery resend keeps the subject + mention spans
        // (the queue re-POST builds its request from this payload alone).
        mentions: args.mentions?.length ? args.mentions : undefined,
      }),
    });
    await db.insert(messages).values({
      guid: args.tempGuid,
      chatId,
      text: args.text,
      subject: args.subject ?? null,
      isFromMe: true,
      dateCreated: args.now,
      sendState: 'sending',
      error: 0,
      // Persist locally so an optimistic reply renders its quote + the send-effect
      // plays on the outgoing bubble before the server echo.
      threadOriginatorGuid: args.threadOriginatorGuid ?? null,
      expressiveSendStyleId: args.effectId ?? null,
    });
    await db
      .update(chats)
      .set({
        latestMessageDate: sql`MAX(${args.now}, COALESCE(${chats.latestMessageDate}, ${args.now}))`,
      })
      .where(eq(chats.id, chatId));
  });
}

/** Optimistically insert an outgoing text message + its queue row, and bump the chat. */
export async function insertOutgoingText(
  db: AppDatabase,
  args: InsertOutgoingTextArgs,
): Promise<void> {
  // ONE transaction — see the insert-atomicity note directly above.
  await withDbTransaction(db, (context) => insertOutgoingTextWithinTransaction(context, args));
}

/**
 * Optimistic CONTACT-CARD send: the same placeholder bubble as a text send, but queued under
 * `kind:'contact'` so a retry re-POSTs the STRUCTURED contact fields.
 *
 * This kind exists specifically so a failed contact send cannot be retried as a text message.
 * Queuing it as `kind:'text'` (what this used to do) made `runOutgoingQueue` re-send the
 * bubble's placeholder — the contact's display NAME — as a plain message, so the recipient got
 * "Craig Federighi" instead of a card and the bubble flipped to 'sent'.
 *
 * `text` is the caller-supplied placeholder (the contact's display name); the payload carries
 * the structured fields the server needs to rebuild the vCard on a retry.
 */
export interface InsertOutgoingContactArgs {
  tempGuid: string;
  /** @deprecated Ignored. The transaction resolves `chatGuid` to its committed local id. */
  chatId?: number;
  chatGuid: string;
  /** Placeholder bubble text (the contact's display name). */
  text: string;
  contact: {
    firstName?: string;
    lastName?: string;
    organization?: string;
    phones?: unknown[];
    emails?: unknown[];
  };
  now: number;
  selectedMessageGuid?: string;
  threadOriginatorGuid?: string;
}

/** Transaction-only body for one optimistic contact-card insert. */
export function insertOutgoingContactWithinTransaction(
  context: DbTransactionContext,
  args: InsertOutgoingContactArgs,
): Promise<void> {
  return runInTransactionContext(context, async (db) => {
    const chatId = await requireChatIdByGuidWithinTransaction(context, args.chatGuid);
    await db.insert(outgoingQueue).values({
      tempGuid: args.tempGuid,
      chatGuid: args.chatGuid,
      kind: 'contact',
      payload: JSON.stringify({
        firstName: args.contact.firstName,
        lastName: args.contact.lastName,
        organization: args.contact.organization,
        phones: args.contact.phones?.length ? args.contact.phones : undefined,
        emails: args.contact.emails?.length ? args.contact.emails : undefined,
        selectedMessageGuid: args.selectedMessageGuid,
      }),
    });
    await db.insert(messages).values({
      guid: args.tempGuid,
      chatId,
      text: args.text,
      isFromMe: true,
      dateCreated: args.now,
      sendState: 'sending',
      error: 0,
      threadOriginatorGuid: args.threadOriginatorGuid ?? null,
    });
    await db
      .update(chats)
      .set({
        latestMessageDate: sql`MAX(${args.now}, COALESCE(${chats.latestMessageDate}, ${args.now}))`,
      })
      .where(eq(chats.id, chatId));
  });
}

/** Standalone optimistic contact-card owner; composing services use the transaction-only body. */
export async function insertOutgoingContact(
  db: AppDatabase,
  args: InsertOutgoingContactArgs,
): Promise<void> {
  // ONE transaction — see the insert-atomicity note above insertOutgoingText.
  await withDbTransaction(db, (context) => insertOutgoingContactWithinTransaction(context, args));
}

/**
 * Optimistically insert an outgoing reaction (an associated message row) + its
 * queue row. Unlike a text send this does NOT bump latestMessageDate — a tapback
 * must not reorder the inbox. `reaction` is e.g. 'love' or '-love' (removal).
 */
export interface InsertOutgoingReactionArgs {
  tempGuid: string;
  /** @deprecated Ignored. The transaction resolves `chatGuid` to its committed local id. */
  chatId?: number;
  chatGuid: string;
  targetGuid: string;
  reaction: string;
  /** Glyph for an 'emoji'/'-emoji' tapback; persisted so the optimistic badge renders it. */
  emoji?: string;
  selectedMessageText?: string;
  now: number;
}

/** Transaction-only body for an optimistic reaction insert. */
export function insertOutgoingReactionWithinTransaction(
  context: DbTransactionContext,
  args: InsertOutgoingReactionArgs,
): Promise<void> {
  return runInTransactionContext(context, async (db) => {
    const chatId = await requireChatIdByGuidWithinTransaction(context, args.chatGuid);
    await db.insert(outgoingQueue).values({
      tempGuid: args.tempGuid,
      chatGuid: args.chatGuid,
      kind: 'reaction',
      payload: JSON.stringify({
        selectedMessageGuid: args.targetGuid,
        reaction: args.reaction,
        ...(args.emoji ? { emoji: args.emoji } : {}),
      }),
    });
    await db.insert(messages).values({
      guid: args.tempGuid,
      chatId,
      text: null,
      isFromMe: true,
      dateCreated: args.now,
      sendState: 'sending',
      error: 0,
      associatedMessageGuid: args.targetGuid,
      associatedMessageType: args.reaction,
      associatedMessageEmoji: args.emoji ?? null,
    });
  });
}

/** Standalone optimistic-reaction owner; composing services use the transaction-only body. */
export async function insertOutgoingReaction(
  db: AppDatabase,
  args: InsertOutgoingReactionArgs,
): Promise<void> {
  // ONE transaction — see the insert-atomicity note above insertOutgoingText.
  await withDbTransaction(db, (context) => insertOutgoingReactionWithinTransaction(context, args));
}

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
  db: AppDatabase,
  guid: string,
  now: number = Date.now(),
): Promise<boolean> {
  return withDbTransaction(db, (context) =>
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
 * A refused claim therefore writes nothing at all, so it can never strip the ladder off a send that
 * is in flight. A claimed one re-arms that ladder in the same transaction as the flip — attempts
 * reset, because the button is the ONLY recourse for a row already retired at the attempt cap, and
 * leased, so a drain tick can't re-POST the same payload alongside the caller's own attempt.
 */
export function claimFailedOutgoingForRetryWithinTransaction(
  context: DbTransactionContext,
  tempGuid: string,
  clock: () => number = Date.now,
): Promise<RetryHandover> {
  return runInTransactionContext(context, async (db) => {
    const now = clock();
    const queued = await db.all<RetryableOutgoing>(sql`
        SELECT id, temp_guid AS tempGuid, chat_guid AS chatGuid, kind, payload, attempts,
               created_at AS createdAt
        FROM outgoing_queue WHERE temp_guid = ${tempGuid} LIMIT 1`);
    const row = queued[0];
    if (!row) return { claim: 'unsendable' };
    const taken = await db.all<{ id: number }>(sql`
        UPDATE messages SET send_state = 'sending', error = 0, error_message = NULL
         WHERE guid = ${tempGuid} AND send_state = 'error'
        RETURNING id`);
    if (taken.length === 0) {
      // Read AFTER the failed compare-and-set, and only to word the message to the user — no write
      // depends on it, so a stale answer here is harmless.
      const cur = await db.all<{ sendState: string | null }>(
        sql`SELECT send_state AS sendState FROM messages WHERE guid = ${tempGuid} LIMIT 1`,
      );
      return { claim: cur[0]?.sendState === 'sending' ? 'sending' : 'settled' };
    }
    await db.run(sql`
        UPDATE outgoing_queue SET attempts = 0, next_retry_at = ${now + OUTGOING_LEASE_MS}
         WHERE temp_guid = ${tempGuid}`);
    return { claim: 'claimed', row: { ...row, attempts: 0 } };
  });
}

/**
 * Claim one failed send in its own guarded transaction. Callers that already own the transaction
 * must use {@link claimFailedOutgoingForRetryWithinTransaction} instead of nesting this wrapper.
 */
export async function claimFailedOutgoingForRetry(
  db: AppDatabase,
  tempGuid: string,
  clock: () => number = Date.now,
  commitGuard?: DbCommitGuard,
): Promise<RetryHandover> {
  return withDbTransaction(
    db,
    (context) => claimFailedOutgoingForRetryWithinTransaction(context, tempGuid, clock),
    commitGuard,
  );
}

/**
 * Reconcile a successful send. If the real message already exists (the socket
 * echo landed first via DbEventSink), drop the temp row; otherwise promote the
 * temp row to the real guid in place. Either way, no duplicate (guid is unique).
 *
 * A send the user CANCELLED needs no branch of its own: the discard left a TOMBSTONED temp row
 * (see the rule at the top of this file), the promote below carries both `date_deleted` and its
 * independent deletion-ledger key onto the real identity, so the message stays hidden through a
 * later re-page or purge/re-ingestion. The dup branch has to move it by hand — that is the one place
 * the temp row is destroyed rather than promoted.
 *
 * The promote (or dup-drop) and the queue-row delete commit in ONE transaction. As two
 * autocommits, a process death in the gap left an orphan queue row whose temp_guid no longer
 * names any message: after the grace window the drain re-POSTs that payload, and once the
 * server's idempotency TTL has lapsed (an overnight kill) the recipient gets the message twice,
 * with no local bubble for the second copy until its echo inserts one. Same reasoning as
 * `DbEventSink`, which reconciles inside its own transaction for exactly this pair of writes.
 */
export async function reconcileOutgoingSuccess(
  db: AppDatabase,
  tempGuid: string,
  server: ServerMsgFields,
  commitGuard?: DbCommitGuard,
): Promise<void> {
  // Preserve the standalone helper's exact historical backstops before it opens an owner. A false
  // guard must not turn an invalid empty-GUID input from a quiet no-op into a rejection.
  if (!server.guid) return;
  if (server.guid === tempGuid) {
    await withDbTransaction(
      db,
      (context) => markOutgoingSentNoGuidWithinTransaction(context, tempGuid),
      commitGuard,
    );
    return;
  }
  await withDbTransaction(
    db,
    (context) => reconcileOutgoingSuccessWithinTransaction(context, tempGuid, server),
    commitGuard,
  );
}

/**
 * Transaction-only body for one successful-send identity handoff.
 *
 * The shared send-outcome service uses this form so its account lease guards the exact final
 * promotion/dequeue owner. Standalone repository callers must use {@link reconcileOutgoingSuccess}
 * so the identity handoff and queue-row removal cannot split across commits.
 */
export function reconcileOutgoingSuccessWithinTransaction(
  context: DbTransactionContext,
  tempGuid: string,
  server: ServerMsgFields,
): Promise<void> {
  return runInTransactionContext(context, async (db) => {
    // Backstop transaction-context callers too: only a distinct server identity belongs in this
    // body. The public wrapper and shared send-outcome service route absent/self GUIDs through the
    // no-GUID settlement instead.
    if (!server.guid || server.guid === tempGuid) return;
    const dup = await db.all<{ id: number }>(
      sql`SELECT id FROM messages WHERE guid = ${server.guid} LIMIT 1`,
    );
    if (dup[0]) {
      // The live echo already inserted the real message (it beat this ack, and content-match
      // didn't promote our temp row — e.g. an edge where the text differs). Carry any on-disk
      // local_path from the temp row's attachment onto the real row's attachment BEFORE the
      // cascade-delete, so a just-sent image isn't lost to a re-download. (One attachment per
      // outgoing message in this app.)
      const tempAtt = await db.all<{ localPath: string | null }>(
        sql`SELECT ta.local_path AS localPath FROM attachments ta
              JOIN messages tm ON tm.id = ta.message_id
              WHERE tm.guid = ${tempGuid} AND ta.local_path IS NOT NULL LIMIT 1`,
      );
      const lp = tempAtt[0]?.localPath;
      if (lp) {
        // db.run (not db.all) — a non-returning UPDATE; db.all throws "use run()" on better-sqlite3.
        await db.run(
          sql`UPDATE attachments SET local_path = ${lp} WHERE message_id = ${dup[0].id} AND local_path IS NULL`,
        );
      }
      // Carry a local DELETION across too. This is the ONE path that destroys the temp row instead
      // of promoting it, and the row may already be gone after a chat purge. Move the durable
      // ledger key first, then tombstone the real row from that retained timestamp.
      const dateDeleted = await handoverOutgoingIdentityWithinTransaction(
        context,
        tempGuid,
        server.guid,
      );
      if (dateDeleted != null)
        await markMessageDeletedWithinTransaction(context, server.guid, dateDeleted);
      await db.delete(messages).where(eq(messages.guid, tempGuid));
    } else {
      await handoverOutgoingIdentityWithinTransaction(context, tempGuid, server.guid);
      await db
        .update(messages)
        .set({
          guid: server.guid,
          dateCreated: server.dateCreated ?? undefined,
          dateDelivered: server.dateDelivered ?? null,
          isFromMe: true,
          sendState: 'sent',
          error: 0,
          errorMessage: null,
        })
        .where(eq(messages.guid, tempGuid));
    }
    await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, tempGuid));
  });
}

/**
 * Reconcile a send that SUCCEEDED but returned no GUID (the AppleScript fallback path).
 * The message left the device, so: drop the queue row (no more retries) and flip the
 * still-temp optimistic bubble to 'sent'. Its identity stays the tempGuid until the socket
 * `new-message` echo (which carries the tempGuid) promotes it to the real guid. Used by the
 * send services and the retry processor for the absent-guid case.
 *
 * The promote and the queue-row delete commit in ONE transaction, for the same reason as
 * {@link reconcileOutgoingSuccess}: as two autocommits, a death in the gap leaves a 'sent' bubble
 * whose queue row survives, and the next launch's drain re-sends a message already delivered.
 *
 * A cancelled send needs no branch here either: the discard already TOMBSTONED the row, and this
 * write touches send_state/error only, so the message stays hidden while keeping the identity the
 * fanout will promote (see the cancelled-send rule at the top of this file).
 */
export async function markOutgoingSentNoGuid(
  db: AppDatabase,
  tempGuid: string,
  commitGuard?: DbCommitGuard,
): Promise<void> {
  await withDbTransaction(
    db,
    (context) => markOutgoingSentNoGuidWithinTransaction(context, tempGuid),
    commitGuard,
  );
}

export function markOutgoingSentNoGuidWithinTransaction(
  context: DbTransactionContext,
  tempGuid: string,
): Promise<void> {
  return runInTransactionContext(context, async (db) => {
    // Never downgrade a row the server already told us FAILED. With the RCS bridge's immediate
    // "sending" ack, a genuine send failure (`message-send-error`) can land just BEFORE this
    // success ack; promoting to 'sent' would clobber it and hide the failure. 'error' is sticky —
    // leave the errored row (and its retry-queue entry) exactly as reconcileOutgoingError set them.
    //
    // The guard is IN the write: as a separate SELECT it answered for an instant that had already
    // passed by the time the UPDATE ran, so an error frame landing between the two was overwritten
    // and the message showed as sent with no error badge and no retry row — silently never
    // delivered. Same shape as `retireOutgoing` / `claimOutgoingForSend`.
    const promoted = await db.all<{ id: number }>(sql`
      UPDATE messages SET send_state = 'sent', error = 0, error_message = NULL
       WHERE guid = ${tempGuid} AND (send_state IS NULL OR send_state <> 'error')
      RETURNING id`);
    if (promoted.length > 0) {
      await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, tempGuid));
      return;
    }
    // Nothing matched: either the row is stickily 'error' (leave its ladder alone) or there is no
    // message at all — and an ack for a message that no longer exists must still clear the queue
    // row, or that orphan re-sends blind on every later drain.
    const cur = await db.all<{ id: number }>(
      sql`SELECT id FROM messages WHERE guid = ${tempGuid} LIMIT 1`,
    );
    if (cur.length === 0)
      await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, tempGuid));
  });
}

/** The minimal echo fields reconcileEchoByContent needs to correlate to an optimistic row. */
export interface EchoMatchFields {
  guid: string;
  isFromMe?: boolean | null;
  text?: string | null;
  dateCreated?: number | null;
  associatedMessageGuid?: string | null;
  associatedMessageType?: string | null;
}

/** Only match a temp row sent within this window of the echo's own timestamp, so a
 *  coincidentally-identical message from ANOTHER device can't hijack an unrelated stale row. */
const ECHO_MATCH_WINDOW_MS = 5 * 60_000;

/**
 * Reconcile the LIVE echo of one of OUR sent messages against its optimistic temp row.
 *
 * Gator's `new-message` is a chat.db ROWID-watcher emission and carries NO tempGuid (unlike
 * the upstream app, which correlates it in its message manager) — so we cannot match by
 * tempGuid. Instead, an incoming is-from-me message with a REAL guid is matched by CONTENT to
 * a still-pending `temp-…` row in the same chat (same text / reaction / attachment) and that
 * row is promoted IN PLACE to the real guid. The caller's subsequent upsert then UPDATEs the
 * same row (preserving its id, attachments + local_path) instead of inserting a duplicate; the
 * queue row is dropped. No-op if the real guid already exists (already reconciled by the HTTP
 * ack) or nothing matches.
 *
 * MUST be called ONLY on the live realtime echo path (DbEventSink), never the full/incremental
 * SYNC path: sync replays historical sent messages, and content-matching a brand-new optimistic
 * send to an OLD identical message would corrupt its identity. The retry/ack path reconciles
 * sync/offline sends by guid instead.
 */
export async function reconcileEchoByContent(
  context: DbTransactionContext,
  m: EchoMatchFields,
  chatId: number,
): Promise<void> {
  return runInTransactionContext(context, async (db) => {
    if (!m.isFromMe || m.guid.startsWith('temp-')) return;
    // Already reconciled (the HTTP ack promoted the temp row first) → leave it to the upsert.
    const already = await db.all<{ id: number }>(
      sql`SELECT id FROM messages WHERE guid = ${m.guid} LIMIT 1`,
    );
    if (already[0]) return;
    // Match on the fields the BARE socket echo reliably carries — serializeMessage emits NO
    // has_attachments/attachments on the live event, so we must NOT gate on them. A reaction
    // matches its target+type; everything else matches exact text. This covers attachments too:
    // an outgoing attachment send and its echo both have null text. (Attachments are always sent
    // via the Private API — the AppleScript fallback is plain-text only — so on the ack-less
    // no-guid path only TEXT arrives here, and text matches reliably; an attachment that races
    // its ack falls back to reconcileOutgoingSuccess's dup-branch local_path carry-over.)
    const match =
      m.associatedMessageType != null
        ? sql`associated_message_type = ${m.associatedMessageType} AND associated_message_guid IS ${m.associatedMessageGuid ?? null}`
        : sql`associated_message_type IS NULL AND text IS ${m.text ?? null}`;
    // Time-bound the match to a send near the echo's own timestamp (defeats a cross-device
    // identical-content hijack of an unrelated stale row).
    const echoDate = m.dateCreated ?? null;
    const window =
      echoDate != null
        ? sql`AND date_created >= ${echoDate - ECHO_MATCH_WINDOW_MS} AND date_created <= ${echoDate + ECHO_MATCH_WINDOW_MS}`
        : sql``;
    // A LIVE row wins over a TOMBSTONED one (`date_deleted IS NULL` first). A cancelled send keeps
    // its row so this promote can carry the tombstone onto the real guid — but if the user then
    // re-sends the same words, both rows match this echo by content, and promoting the cancelled one
    // would hide the message they actually sent while leaving the visible bubble stuck on its temp
    // identity. The tombstoned row is still reachable: it is the only candidate left once the live
    // one has been promoted, which is exactly when its own echo arrives.
    // Then prefer an actually-in-flight 'sending' row, then oldest-first (the first echo corresponds
    // to the first send) so rapid identical sends promote in order, not swapped.
    // 'error' rows are matchable too: a send that FAILED client-side (502/timeout) may still have
    // gone through server-side — its echo must promote the errored bubble in place (clearing the
    // queue row, which stops the retry ladder) instead of inserting a duplicate. The ±window +
    // exact-content + same-chat guards bound stale-row hijack.
    const rows = await db.all<{ guid: string }>(sql`
      SELECT guid FROM messages
      WHERE chat_id = ${chatId} AND is_from_me = 1 AND guid LIKE 'temp-%'
        AND send_state IN ('sending', 'sent', 'error') AND ${match} ${window}
      ORDER BY (date_deleted IS NULL) DESC, (send_state = 'sending') DESC, date_created ASC, id ASC
      LIMIT 1`);
    const temp = rows[0];
    if (!temp) return;
    await handoverOutgoingIdentityWithinTransaction(context, temp.guid, m.guid);
    // Drop the queue row BEFORE promoting, so a concurrent retry tick in the gap can't claim and
    // re-POST a send that's already being reconciled.
    await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, temp.guid));
    await db
      .update(messages)
      .set({ guid: m.guid, sendState: 'sent', error: 0, errorMessage: null })
      .where(eq(messages.guid, temp.guid));
  });
}

/**
 * Reconcile the SYNC materialization of one of OUR sent ATTACHMENT messages against its optimistic
 * temp row — the sync-safe sibling of {@link reconcileEchoByContent}.
 *
 * Why a SEPARATE helper (and not just calling reconcileEchoByContent on the sync path): RCS messages
 * carry NO server rowid, so the real `rcs-<id>` row is usually first materialized by a SYNC read —
 * `syncChatMessages` (thread re-open / pull-to-refresh) or `syncAllChats`'s lastMessage upsert
 * (reconnect) — NOT the live socket echo. Those sync paths never call reconcileEchoByContent, so the
 * optimistic picture's MESSAGE row is never promoted in place; upsertAttachments (keyed by
 * message_id) then can't find the temp `-att` under the new real row and inserts the server
 * attachment with a NULL local_path — a second, image-less bubble, while the on-disk image is
 * stranded on an orphaned temp duplicate. Promoting the temp row HERE, before upsertMessages, lets
 * the existing per-message-id local_path carry-over (see upsertAttachments) preserve the image.
 *
 * reconcileEchoByContent is deliberately BANNED on the sync path because it would content-match a
 * fresh optimistic TEXT send to an OLD identical historical message. This helper is sync-safe: it
 * only ever matches a still-pending optimistic send that STILL OWNS a `-att` attachment with a
 * non-null local_path — a historical re-sync has no such pending row, so it can't be hijacked; the
 * ±window additionally rejects an old identical picture surfaced by a history backfill. It is inert
 * for iMessage/SMS (their temp row is already promoted in place by the real-guid ack, so no pending
 * `temp-…` `-att` exists at sync time) and for received messages (not is-from-me).
 */
export async function reconcileOutgoingAttachmentByContent(
  db: AppDatabase,
  m: EchoMatchFields,
  chatId: number,
  commitGuard?: DbCommitGuard,
): Promise<void> {
  if (!m.isFromMe || m.guid.startsWith('temp-')) return;
  await withDbTransaction(
    db,
    async (context) => {
      // Already materialized (a prior sync/echo created it) → leave it to the upsert.
      const already = await db.all<{ id: number }>(
        sql`SELECT id FROM messages WHERE guid = ${m.guid} LIMIT 1`,
      );
      if (already[0]) return;
      // Time-bound to a send near the echo's own timestamp (same window as reconcileEchoByContent) so a
      // history re-sync of an OLD identical picture can't claim a fresh optimistic row.
      const echoDate = m.dateCreated ?? null;
      const window =
        echoDate != null
          ? sql`AND mm.date_created >= ${echoDate - ECHO_MATCH_WINDOW_MS} AND mm.date_created <= ${echoDate + ECHO_MATCH_WINDOW_MS}`
          : sql``;
      // Match a pending optimistic outgoing message that STILL OWNS a local (on-disk) attachment — that
      // pending-local-`-att` gate is what makes this sync-safe. Match text too (a caption-less picture
      // and its echo both carry NULL text) so a text send can never claim a picture row. Prefer an
      // in-flight 'sending' row, then oldest-first, so rapid identical sends promote in send order.
      // 'error' included for the same reason as reconcileEchoByContent: a client-side-failed picture
      // whose upload actually landed must be promoted (and its queue row cleared), not duplicated.
      const rows = await db.all<{ guid: string }>(sql`
        SELECT mm.guid FROM messages mm
        WHERE mm.chat_id = ${chatId} AND mm.is_from_me = 1 AND mm.guid LIKE 'temp-%'
          AND mm.send_state IN ('sending', 'sent', 'error')
          AND mm.associated_message_type IS NULL AND mm.text IS ${m.text ?? null}
          AND EXISTS (
            SELECT 1 FROM attachments a
            WHERE a.message_id = mm.id AND a.guid LIKE '%-att' AND a.local_path IS NOT NULL
          )
          ${window}
        ORDER BY (mm.date_deleted IS NULL) DESC, (mm.send_state = 'sending') DESC,
                 mm.date_created ASC, mm.id ASC LIMIT 1`);
      const temp = rows[0];
      if (!temp) return;
      // Queue deletion and identity promotion are one commit. Otherwise a crash/rollback between
      // them can either re-send an acknowledged attachment or strand the optimistic temp row.
      await handoverOutgoingIdentityWithinTransaction(context, temp.guid, m.guid);
      await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, temp.guid));
      await db
        .update(messages)
        .set({ guid: m.guid, sendState: 'sent', error: 0, errorMessage: null })
        .where(eq(messages.guid, temp.guid));
    },
    commitGuard,
  );
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
    await db
      .update(messages)
      .set({ sendState: 'error', error: errorCode, errorMessage: null })
      .where(and(eq(messages.guid, tempGuid), ne(messages.sendState, 'sent')));
  });
}

/**
 * Permanently retire a queue row (no further automatic retries): attempts jumps to the cap and
 * the bubble is forced to 'error' unless it already reconciled to 'sent'. For failures no retry
 * can ever fix — the attachment's on-disk file is gone, or the row's kind is unknown. The queue
 * row is KEPT, matching the natural attempts-cap retirement (the bubble's 'error' state is what
 * makes it cancellable, and `cancelOutgoing` removes the ladder along with it either way).
 *
 * The optional guard authorizes this standalone commit. Services composing the write use
 * {@link retireOutgoingWithinTransaction} inside their own short guarded owner.
 */
export async function retireOutgoing(
  db: AppDatabase,
  tempGuid: string,
  errorCode = 1,
  commitGuard?: DbCommitGuard,
): Promise<void> {
  await withDbTransaction(
    db,
    (context) => retireOutgoingWithinTransaction(context, tempGuid, errorCode),
    commitGuard,
  );
}

export { OUTGOING_GRACE_MS, OUTGOING_MAX_ATTEMPTS, outgoingBackoffMs } from './outgoingRetryPolicy';
export * from './outgoingRetry';
