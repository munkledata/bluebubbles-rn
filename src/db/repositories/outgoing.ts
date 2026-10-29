import { and, eq, ne, sql } from 'drizzle-orm';
import {
  CURRENT_LOCATION_MAX_REPLAY_AGE_MS,
  type IMessageTextFormattingRange,
  type MessageMention,
} from '@core/api/endpoints/messages';
import { ClientErrorCode, LOCATION_DELIVERY_UNCONFIRMED_COPY } from '@utils';
import { isRcsChatGuid } from '@utils/chat';
import { chats, messageDeletionLedger, messages, outgoingQueue } from '../schema';
import {
  runInTransactionContext,
  withDbTransaction,
  type DbCommitGuard,
  type DbTransactionContext,
} from '../transaction';
import type { AppDatabase } from '../types';
import {
  projectMessageStateWithinTransaction,
  getTrustedMessageStateLedgersWithinTransaction,
  trustedMessageStateLedgerSql,
} from './messageState';
import { requireChatIdByGuidWithinTransaction } from './chats';
import {
  findAttemptOwnerSnapshotWithinTransaction,
  MAX_SEND_ATTEMPT_OWNER_GENERATION,
  MessageGuidAliasConflictError,
  recordMessageGuidAliasWithinTransaction,
  type AttemptOwnerSnapshot,
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
  queuedMessageTarget,
  type MessageTargetServerAuthorization,
} from './messageTargets';
// The ONE tombstone write (stamp `date_deleted` + recompute the chat's denormalized sort key).
// Imported from the module that owns it rather than restated here, so the two can't drift;
// messages.ts imports nothing from this file, so there is no cycle.
import { markMessageDeletedWithinTransaction } from './messages';
import { deletionRecordAppliesSql, messageVisibleInChatSql } from './chatVisibility';

export {
  MESSAGE_GUID_ALIAS_LIMIT,
  MAX_SEND_ATTEMPT_OWNER_GENERATION,
  MessageGuidAliasConflictError,
  recordMessageGuidAliasWithinTransaction,
  type SendAttemptOwnerToken,
} from './outgoingAttemptOwnership';

/** Ownership handoff returned by an optimistic insert. Null keeps the legacy send path unchanged. */
export interface OutgoingInsertResult {
  readonly attemptOwnerToken: SendAttemptOwnerToken | null;
}

/** Server identity installed when the exact local request generation acknowledges. */
export interface OutgoingAttemptSettlement {
  readonly attemptGuid: string;
  readonly attemptOwnerToken: SendAttemptOwnerToken;
}

export type OutgoingAckDisposition = 'sent' | 'sticky-error' | 'stale-attempt-owner' | 'missing';

/** Exact correlation carried by capable RCS message DTOs and live success fanout. */
export interface ExactOutgoingAttemptSuccess {
  readonly tempGuid: string;
  readonly attemptGuid: string;
  readonly clientAttemptGeneration: number;
  readonly guid: string;
  /** Exact chat resolved by the ingestion owner. Required to recover after the temp row is purged. */
  readonly claimedChatId?: number;
  readonly dateCreated: number | null;
  readonly dateDelivered: number | null;
}

export type ExactOutgoingAttemptSuccessDisposition =
  | 'reconciled'
  | 'already-reconciled'
  | 'attempt-owner-pending'
  | 'stale-attempt'
  | 'owner-conflict'
  | 'unmatched';

/**
 * Contain a confirmed exact success whose canonical identity conflicts with retained ownership.
 * The source bubble is independently proven before this helper is called. Never install the
 * disputed attempt GUID or alter the canonical/alias/ledger reservation.
 */
function settleProvenExactOwnerConflictWithinTransaction(
  context: DbTransactionContext,
  owner: AttemptOwnerSnapshot,
  success: ExactOutgoingAttemptSuccess,
  stickyError: boolean,
): Promise<void> {
  return runInTransactionContext(context, async (db) => {
    await db
      .update(messages)
      .set({
        attemptOwnerPending: false,
        ...(stickyError ? {} : { sendState: 'sent' as const, error: 0, errorMessage: null }),
      })
      .where(
        and(
          eq(messages.guid, owner.guid),
          eq(messages.chatId, owner.chatId),
          eq(messages.attemptOwnerGeneration, owner.attemptOwnerGeneration),
        ),
      );
    if (!stickyError) {
      await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, success.tempGuid));
    }
  });
}

/** Keep a confirmed legacy/private-API send from retrying when identity promotion is ambiguous. */
function settleConfirmedLegacyIdentityConflictWithinTransaction(
  context: DbTransactionContext,
  tempGuid: string,
): Promise<void> {
  return runInTransactionContext(context, async (db) => {
    await db
      .update(messages)
      .set({
        sendState: 'sent',
        error: 0,
        errorMessage: null,
        activeSendAttemptGuid: null,
        attemptOwnerPending: false,
      })
      .where(eq(messages.guid, tempGuid));
    await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, tempGuid));
  });
}

/** Check before mutating attempt ownership whether a temp-to-canonical handoff is ambiguous. */
async function hasOutgoingIdentityHandoverConflictWithinTransaction(
  context: DbTransactionContext,
  tempGuid: string,
  realGuid: string,
  ownerChatGuid: string,
): Promise<boolean> {
  return runInTransactionContext(context, async (db) => {
    if (tempGuid === realGuid) return false;
    const trustedLedgers = await getTrustedMessageStateLedgersWithinTransaction(context);
    const messageOwners: Array<{ guid: string; chatGuid: string }> = await db.all(sql`
      SELECT m.guid, c.guid AS chatGuid
        FROM messages m
        JOIN chats c ON c.id = m.chat_id
       WHERE m.guid IN (${tempGuid}, ${realGuid})
    `);
    if (messageOwners.some((owner) => owner.chatGuid !== ownerChatGuid)) return true;
    const messageOwnerByGuid = new Map(messageOwners.map((owner) => [owner.guid, owner.chatGuid]));
    const tombstones: Array<{ guid: string; chatGuid: string | null }> = await db.all(sql`
      SELECT guid, chat_guid AS chatGuid
        FROM message_deletion_ledger
       WHERE guid IN (${tempGuid}, ${realGuid})
      UNION ALL
      SELECT guid, chat_guid AS chatGuid FROM message_server_states
       WHERE guid = ${realGuid}
         AND ${trustedMessageStateLedgerSql('message_server_states', trustedLedgers)}
    `);
    for (const tombstone of tombstones) {
      if (tombstone.chatGuid != null && tombstone.chatGuid !== ownerChatGuid) {
        return true;
      }
      if (
        tombstone.chatGuid == null &&
        tombstone.guid === realGuid &&
        messageOwnerByGuid.get(realGuid) !== ownerChatGuid
      ) {
        return true;
      }
    }
    const aliases = await db.all<{ canonicalGuid: string; chatGuid: string | null }>(sql`
      SELECT canonical_guid AS canonicalGuid, chat_guid AS chatGuid
        FROM message_guid_aliases
       WHERE alias_guid = ${tempGuid}
       LIMIT 1
    `);
    const alias = aliases[0];
    if (
      alias &&
      (alias.canonicalGuid !== realGuid ||
        (alias.chatGuid != null && alias.chatGuid !== ownerChatGuid))
    ) {
      return true;
    }
    return false;
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
  ownerChatGuid: string,
): Promise<number | null> {
  return runInTransactionContext(context, async (db) => {
    if (tempGuid === realGuid) return null;
    if (
      await hasOutgoingIdentityHandoverConflictWithinTransaction(
        context,
        tempGuid,
        realGuid,
        ownerChatGuid,
      )
    ) {
      throw new MessageGuidAliasConflictError();
    }
    const tombstones: Array<{
      guid: string;
      dateDeleted: number;
      chatGuid: string | null;
    }> = await db.all(sql`
      SELECT guid, date_deleted AS dateDeleted, chat_guid AS chatGuid
        FROM message_deletion_ledger
       WHERE guid IN (${tempGuid}, ${realGuid})
    `);
    await recordMessageGuidAliasWithinTransaction(context, tempGuid, realGuid, ownerChatGuid);
    // Hiding inherited from the chat's deleted history is not a message deletion: an explicit chat
    // restore must still undo it, so it is not carried onto the real identity (review of M069).
    // A cancelled send's tombstone also has its own ledger record, read above.
    const messageTombstones: Array<{ dateDeleted: number }> = await db.all(sql`
      SELECT m.date_deleted AS dateDeleted
        FROM messages m
        JOIN chats c ON c.id = m.chat_id
       WHERE m.guid = ${tempGuid}
         AND m.date_deleted IS NOT NULL
         AND c.guid = ${ownerChatGuid}
         AND m.date_deleted IS NOT c.history_deleted_at
    `);
    const dateDeleted = tombstones.reduce<number | null>(
      (latest, row) => (latest == null || row.dateDeleted > latest ? row.dateDeleted : latest),
      messageTombstones[0]?.dateDeleted ?? null,
    );
    const trustedLedgers = await getTrustedMessageStateLedgersWithinTransaction(context);
    const serverStates = await db.all<{ dateDeleted: number }>(sql`
      SELECT COALESCE(date_deleted, 0) AS dateDeleted FROM message_server_states
       WHERE guid = ${realGuid} AND chat_guid = ${ownerChatGuid} AND kind = 'deleted'
         AND ${trustedMessageStateLedgerSql('message_server_states', trustedLedgers)}
       LIMIT 1
    `);
    const serverDate = serverStates[0]?.dateDeleted ?? null;
    // Server deletion knowledge affects visibility but never becomes a permanent local receipt.
    if (dateDeleted == null) {
      if (serverDate != null)
        await db
          .update(messages)
          .set({ dateDeleted: serverDate })
          .where(eq(messages.guid, tempGuid));
      return serverDate;
    }

    await db
      .insert(messageDeletionLedger)
      .values({ guid: realGuid, dateDeleted, chatGuid: ownerChatGuid })
      .onConflictDoUpdate({
        target: messageDeletionLedger.guid,
        setWhere: sql`${messageDeletionLedger.chatGuid} IS NULL OR ${messageDeletionLedger.chatGuid} = excluded.chat_guid`,
        set: {
          dateDeleted: sql`MAX(${messageDeletionLedger.dateDeleted}, excluded.date_deleted)`,
          chatGuid: sql`COALESCE(${messageDeletionLedger.chatGuid}, excluded.chat_guid)`,
        },
      });
    await db
      .update(messages)
      .set({
        dateDeleted: sql`COALESCE(MAX(${messages.dateDeleted}, ${dateDeleted}), ${messages.dateDeleted}, ${dateDeleted})`,
      })
      .where(eq(messages.guid, tempGuid));
    await db.run(sql`
      DELETE FROM message_deletion_ledger
       WHERE guid = ${tempGuid}
         AND ${deletionRecordAppliesSql('message_deletion_ledger', ownerChatGuid)}
    `);
    return serverDate == null ? dateDeleted : Math.max(dateDeleted, serverDate);
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
 * INSERT ATOMICITY, shared by all optimistic-send helpers: the queue row and the visible
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
  /** Reply target part, persisted only when a reply target is present. */
  partIndex?: number;
  threadOriginatorGuid?: string;
  effectId?: string;
  subject?: string;
  mentions?: MessageMention[];
  textFormatting?: IMessageTextFormattingRange[];
  /** Current server promises exact RCS success/failure attempt correlation for this send. */
  attemptAware?: boolean;
  /** Marks the dedicated one-shot effect payload for crash recovery without enabling replay. */
  oneShotEffect?: boolean;
  /** Marks the dedicated one-shot mention payload for crash recovery without enabling replay. */
  oneShotMention?: boolean;
  /** Marks the dedicated one-shot formatted payload for crash recovery without enabling replay. */
  oneShotFormatted?: boolean;
  /** Pins this row to the separately gated exact-GUID plain-text route. */
  imessagePlainTextV1?: boolean;
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
): Promise<OutgoingInsertResult> {
  return runInTransactionContext(context, async (db) => {
    const chatId = await requireChatIdByGuidWithinTransaction(context, args.chatGuid);
    await db.insert(outgoingQueue).values({
      tempGuid: args.tempGuid,
      chatGuid: args.chatGuid,
      kind: 'text',
      payload: JSON.stringify({
        message: args.text,
        selectedMessageGuid: args.selectedMessageGuid,
        partIndex: args.selectedMessageGuid ? args.partIndex : undefined,
        effectId: args.effectId,
        imessageEffectV1: args.oneShotEffect === true ? true : undefined,
        imessageMentionV1: args.oneShotMention === true ? true : undefined,
        imessageFormattedV1: args.oneShotFormatted === true ? true : undefined,
        imessagePlainTextV1: args.imessagePlainTextV1 === true ? true : undefined,
        subject: args.subject,
        // Persisted so a crash-recovery resend keeps the subject + mention spans
        // (the queue re-POST builds its request from this payload alone).
        mentions: args.mentions?.length ? args.mentions : undefined,
        textFormatting: args.textFormatting?.length ? args.textFormatting : undefined,
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
      attemptOwnerPending: args.attemptAware === true,
      attemptOwnerGeneration: args.attemptAware === true ? 1 : 0,
      error: 0,
      // Persist locally so an optimistic reply renders its quote + the send-effect
      // plays on the outgoing bubble before the server echo.
      threadOriginatorGuid: args.threadOriginatorGuid ?? null,
      threadOriginatorPart: args.threadOriginatorGuid ? (args.partIndex ?? null) : null,
      expressiveSendStyleId: args.effectId ?? null,
      attributedBody: args.textFormatting?.length
        ? JSON.stringify([
            {
              string: args.text,
              runs: args.textFormatting.map((range) => ({
                range: [range.start, range.length],
                attributes: Object.fromEntries(
                  range.styles.map((style) => [
                    style === 'bold'
                      ? '__kIMTextBoldAttributeName'
                      : style === 'italic'
                        ? '__kIMTextItalicAttributeName'
                        : style === 'underline'
                          ? '__kIMTextUnderlineAttributeName'
                          : '__kIMTextStrikethroughAttributeName',
                    1,
                  ]),
                ),
              })),
            },
          ])
        : null,
    });
    await db
      .update(chats)
      .set({
        latestMessageDate: sql`MAX(${args.now}, COALESCE(${chats.latestMessageDate}, ${args.now}))`,
      })
      .where(eq(chats.id, chatId));
    return {
      attemptOwnerToken: args.attemptAware === true ? { generation: 1 } : null,
    };
  });
}

/** Optimistically insert an outgoing text message + its queue row, and bump the chat. */
export async function insertOutgoingText(
  db: AppDatabase,
  args: InsertOutgoingTextArgs,
): Promise<OutgoingInsertResult> {
  // ONE transaction — see the insert-atomicity note directly above.
  return withDbTransaction(db, (context) => insertOutgoingTextWithinTransaction(context, args));
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
  /** Reply target part, persisted only when a reply target is present. */
  partIndex?: number;
  threadOriginatorGuid?: string;
  /** Current server promises exact RCS success/failure attempt correlation for this send. */
  attemptAware?: boolean;
}

/** Transaction-only body for one optimistic contact-card insert. */
export function insertOutgoingContactWithinTransaction(
  context: DbTransactionContext,
  args: InsertOutgoingContactArgs,
): Promise<OutgoingInsertResult> {
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
        partIndex: args.selectedMessageGuid ? args.partIndex : undefined,
      }),
    });
    await db.insert(messages).values({
      guid: args.tempGuid,
      chatId,
      text: args.text,
      isFromMe: true,
      dateCreated: args.now,
      sendState: 'sending',
      attemptOwnerPending: args.attemptAware === true,
      attemptOwnerGeneration: args.attemptAware === true ? 1 : 0,
      error: 0,
      threadOriginatorGuid: args.threadOriginatorGuid ?? null,
      threadOriginatorPart: args.threadOriginatorGuid ? (args.partIndex ?? null) : null,
    });
    await db
      .update(chats)
      .set({
        latestMessageDate: sql`MAX(${args.now}, COALESCE(${chats.latestMessageDate}, ${args.now}))`,
      })
      .where(eq(chats.id, chatId));
    return {
      attemptOwnerToken: args.attemptAware === true ? { generation: 1 } : null,
    };
  });
}

export interface InsertOutgoingLocationArgs {
  tempGuid: string;
  chatGuid: string;
  latitude: number;
  longitude: number;
  now: number;
}

/** Transaction-only optimistic current-location insert with its durable idempotent retry row. */
export function insertOutgoingLocationWithinTransaction(
  context: DbTransactionContext,
  args: InsertOutgoingLocationArgs,
): Promise<OutgoingInsertResult> {
  if (!Number.isFinite(args.latitude) || args.latitude < -90 || args.latitude > 90) {
    throw new RangeError('latitude must be finite and between -90 and 90');
  }
  if (!Number.isFinite(args.longitude) || args.longitude < -180 || args.longitude > 180) {
    throw new RangeError('longitude must be finite and between -180 and 180');
  }
  const latitude = Object.is(args.latitude, -0) ? 0 : args.latitude;
  const longitude = Object.is(args.longitude, -0) ? 0 : args.longitude;
  return runInTransactionContext(context, async (db) => {
    const chatId = await requireChatIdByGuidWithinTransaction(context, args.chatGuid);
    await db.insert(outgoingQueue).values({
      tempGuid: args.tempGuid,
      chatGuid: args.chatGuid,
      kind: 'location',
      payload: JSON.stringify({ latitude, longitude }),
    });
    await db.insert(messages).values({
      guid: args.tempGuid,
      chatId,
      text: 'Current Location',
      isFromMe: true,
      dateCreated: args.now,
      sendState: 'sending',
      attemptOwnerPending: false,
      attemptOwnerGeneration: 0,
      error: 0,
    });
    await db
      .update(chats)
      .set({
        latestMessageDate: sql`MAX(${args.now}, COALESCE(${chats.latestMessageDate}, ${args.now}))`,
      })
      .where(eq(chats.id, chatId));
    return { attemptOwnerToken: null };
  });
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
  /** Target message part; null/undefined means legacy or unknown. */
  partIndex?: number;
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
        partIndex: args.partIndex,
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
      associatedMessagePart: args.partIndex ?? null,
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
    };
    // The durable markers are authoritative. Missing/corrupt rich fields must fail closed rather
    // than convert a possibly-dispatched helper send into manually replayable plain text.
    return (
      payload.imessageEffectV1 === true ||
      payload.imessageMentionV1 === true ||
      payload.imessageFormattedV1 === true
    );
  } catch {
    return false;
  }
}

/** Read-only preflight for the UI retry gate; the transaction below still revalidates this row. */
export async function getOutgoingRetryChatGuid(
  db: AppDatabase,
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
    // One-shot iMessage attachments, contacts, replies, effects, mentions, and formatted messages
    // may not be manually replayed: a lost HTTP acknowledgement can mean the helper dispatched them.
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
  db: AppDatabase,
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
    (context) =>
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
  expectedChatGuid?: string,
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
    (context) =>
      reconcileOutgoingSuccessWithinTransaction(context, tempGuid, server, expectedChatGuid),
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
  expectedChatGuid?: string,
): Promise<void> {
  return runInTransactionContext(context, async (db) => {
    // Backstop transaction-context callers too: only a distinct server identity belongs in this
    // body. The public wrapper and shared send-outcome service route absent/self GUIDs through the
    // no-GUID settlement instead.
    if (!server.guid || server.guid === tempGuid) return;
    const dup = await db.all<{ id: number; chatGuid: string }>(
      sql`SELECT m.id, c.guid AS chatGuid
            FROM messages m
            JOIN chats c ON c.id = m.chat_id
           WHERE m.guid = ${server.guid}
           LIMIT 1`,
    );
    const tempOwner = await db.all<{ chatId: number; chatGuid: string }>(sql`
      SELECT m.chat_id AS chatId, c.guid AS chatGuid
        FROM messages m
        JOIN chats c ON c.id = m.chat_id
       WHERE m.guid = ${tempGuid}
       LIMIT 1
    `);
    const queuedOwner = await db.all<{ chatGuid: string }>(sql`
      SELECT chat_guid AS chatGuid
        FROM outgoing_queue
       WHERE temp_guid = ${tempGuid}
       LIMIT 1
    `);
    const retainedAliases = await db.all<{
      canonicalGuid: string;
      chatGuid: string | null;
    }>(sql`
      SELECT canonical_guid AS canonicalGuid, chat_guid AS chatGuid
        FROM message_guid_aliases
       WHERE alias_guid = ${tempGuid}
       LIMIT 1
    `);
    const retainedAlias = retainedAliases[0];
    const aliasCanonicalConflict =
      retainedAlias != null && retainedAlias.canonicalGuid !== server.guid;
    const tempChatGuid = tempOwner[0]?.chatGuid ?? null;
    const queuedChatGuid = queuedOwner[0]?.chatGuid ?? null;
    const independentlyProvenOwners = [
      tempChatGuid,
      queuedChatGuid,
      expectedChatGuid ?? null,
    ].filter((value): value is string => value != null);
    if (retainedAlias?.chatGuid == null && independentlyProvenOwners.length === 0) {
      // No source row/queue/expected chat remains to settle. Preserve the quarantine and treat the
      // confirmed response as terminal instead of turning it into a retryable transport failure.
      return;
    }
    const sourceOwners = [retainedAlias?.chatGuid ?? null, ...independentlyProvenOwners].filter(
      (value): value is string => value != null,
    );
    const distinctSourceOwners = new Set(sourceOwners);
    const sourceOwnersConflict = distinctSourceOwners.size > 1;
    const sourceChatGuid = sourceOwners[0] ?? null;
    const canonicalOwnerConflict = dup[0] != null && sourceChatGuid !== dup[0].chatGuid;
    if (
      aliasCanonicalConflict ||
      sourceOwnersConflict ||
      sourceChatGuid == null ||
      canonicalOwnerConflict
    ) {
      // The server confirmed this send, but its canonical GUID either belongs to another exact
      // conversation or the source evidence disagrees. Never guess from a GUID alone: keep the
      // foreign canonical row/ledger untouched. When the source bubble still exists, settle it
      // under its temp identity; dequeue any surviving request so a confirmed send is not retried.
      // A purged, cancelled send retains its temp ledger marker without a cross-chat alias.
      await settleConfirmedLegacyIdentityConflictWithinTransaction(context, tempGuid);
      return;
    }
    if (
      await hasOutgoingIdentityHandoverConflictWithinTransaction(
        context,
        tempGuid,
        server.guid,
        sourceChatGuid,
      )
    ) {
      // A server-confirmed physical send must not be retried merely because the canonical GUID is
      // reserved by a scoped/ownerless deletion. Preserve that reservation and settle only source.
      await settleConfirmedLegacyIdentityConflictWithinTransaction(context, tempGuid);
      return;
    }
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
        sourceChatGuid,
      );
      // A live/content echo can materialize the canonical row before the HTTP acknowledgement.
      // Carry the temp row's attempt-owner state onto that canonical row before deleting it; a
      // later RCS acknowledgement can then resolve the alias and install the exact attempt id.
      const tempOwnership = await db.all<{
        activeSendAttemptGuid: string | null;
        attemptOwnerPending: number;
        attemptOwnerGeneration: number;
      }>(sql`
        SELECT active_send_attempt_guid AS activeSendAttemptGuid,
               attempt_owner_pending AS attemptOwnerPending,
               attempt_owner_generation AS attemptOwnerGeneration
          FROM messages
         WHERE guid = ${tempGuid}
         LIMIT 1
      `);
      const ownership = tempOwnership[0];
      if (ownership) {
        await db
          .update(messages)
          .set({
            activeSendAttemptGuid: ownership.activeSendAttemptGuid,
            attemptOwnerPending: ownership.attemptOwnerPending !== 0,
            attemptOwnerGeneration: ownership.attemptOwnerGeneration,
          })
          .where(eq(messages.guid, server.guid));
      }
      if (dateDeleted != null)
        await projectMessageStateWithinTransaction(context, server.guid, sourceChatGuid);
      await db.delete(messages).where(eq(messages.guid, tempGuid));
    } else if (tempOwner[0]) {
      await handoverOutgoingIdentityWithinTransaction(
        context,
        tempGuid,
        server.guid,
        sourceChatGuid,
      );
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
          activeSendAttemptGuid: null,
          attemptOwnerPending: false,
        })
        .where(eq(messages.guid, tempGuid));
    } else {
      // A chat purge can remove both the optimistic row and its queue while the HTTP request is
      // still in flight. The active request's exact chat GUID is then the only surviving ownership
      // proof. Materialize a minimal canonical row under that owner before moving an alias or
      // deletion marker. A later echo in the same chat safely hydrates it; a conflicting provider
      // or phone-number chat is rejected by immutable message ownership instead of inheriting the
      // deleted send's ledger entry.
      const sourceChat = await db.all<{ id: number }>(sql`
        SELECT id
          FROM chats
         WHERE guid = ${sourceChatGuid}
         LIMIT 1
      `);
      const sourceChatId = sourceChat[0]?.id;
      if (sourceChatId == null) {
        if (queuedOwner[0]) {
          await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, tempGuid));
        }
        return;
      }
      const dateDeleted = await handoverOutgoingIdentityWithinTransaction(
        context,
        tempGuid,
        server.guid,
        sourceChatGuid,
      );
      await db.insert(messages).values({
        guid: server.guid,
        chatId: sourceChatId,
        isFromMe: true,
        dateCreated: server.dateCreated,
        dateDelivered: server.dateDelivered,
        dateDeleted,
        sendState: 'sent',
        error: 0,
        activeSendAttemptGuid: null,
        attemptOwnerPending: false,
      });
    }
    await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, tempGuid));
  });
}

export function markOutgoingSentNoGuidWithinTransaction(
  context: DbTransactionContext,
  tempGuid: string,
  settlement?: OutgoingAttemptSettlement,
): Promise<OutgoingAckDisposition> {
  return runInTransactionContext(context, async (db) => {
    const owner = await findAttemptOwnerSnapshotWithinTransaction(context, tempGuid);
    if (!owner) {
      // Preserve the historical orphan cleanup: a successful request must not be blindly re-sent
      // merely because its optimistic bubble was purged before the acknowledgement committed.
      await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, tempGuid));
      return 'missing';
    }

    if (settlement) {
      const tokenMatchesPending =
        owner.attemptOwnerPending !== 0 &&
        owner.attemptOwnerGeneration === settlement.attemptOwnerToken.generation;
      const alreadyInstalled =
        owner.attemptOwnerPending === 0 && owner.activeSendAttemptGuid === settlement.attemptGuid;
      if (!tokenMatchesPending && !alreadyInstalled) return 'stale-attempt-owner';
      if (tokenMatchesPending) {
        // The generation check is the durable compare-and-set. In particular, acknowledgement A
        // cannot install itself after retry B increments the row, even if A waited for the DB lock.
        const installed = await db.all<{ id: number }>(sql`
          UPDATE messages
             SET active_send_attempt_guid = ${settlement.attemptGuid},
                 attempt_owner_pending = 0
           WHERE guid = ${owner.guid}
             AND attempt_owner_pending = 1
             AND attempt_owner_generation = ${settlement.attemptOwnerToken.generation}
          RETURNING id
        `);
        if (installed.length === 0) return 'stale-attempt-owner';
      }
    } else if (
      owner.attemptOwnerGeneration !== 0 ||
      owner.attemptOwnerPending !== 0 ||
      owner.activeSendAttemptGuid != null
    ) {
      // A legacy/no-token acknowledgement may settle only a row born in legacy mode. Silently
      // downgrading a modern row would allow a delayed failure from an older retry to own it.
      return 'stale-attempt-owner';
    }

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
      UPDATE messages
         SET send_state = 'sent', error = 0, error_message = NULL
       WHERE guid = ${owner.guid} AND (send_state IS NULL OR send_state <> 'error')
      RETURNING id`);
    if (promoted.length > 0) {
      await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, tempGuid));
      return 'sent';
    }
    // Ownership installation is independent from the sticky visible failure. A server error that
    // won the race remains visible and keeps its retry ladder, but subsequent exact events can now
    // be classified against the installed attempt.
    return 'sticky-error';
  });
}

/**
 * Reconcile the exact capable-RCS success triple while the caller owns the event transaction.
 * The client generation fences the unresolved request window; after ownership is settled, the
 * server attempt GUID is authoritative so an idempotency replay may safely echo an older client
 * generation. Exact payloads never fall through to heuristic content matching.
 */
function reconcileExactOutgoingAttemptSuccessCoreWithinTransaction(
  context: DbTransactionContext,
  success: ExactOutgoingAttemptSuccess,
  preservePendingError: boolean,
): Promise<ExactOutgoingAttemptSuccessDisposition> {
  return runInTransactionContext(context, async (db) => {
    if (
      !success.tempGuid ||
      !success.attemptGuid ||
      !success.guid ||
      !Number.isInteger(success.clientAttemptGeneration) ||
      success.clientAttemptGeneration < 1 ||
      success.clientAttemptGeneration > MAX_SEND_ATTEMPT_OWNER_GENERATION
    ) {
      return 'unmatched';
    }

    const owner = await findAttemptOwnerSnapshotWithinTransaction(
      context,
      success.tempGuid,
      success.guid,
    );
    if (!owner) {
      if (success.claimedChatId == null) {
        const blockedAliases = await db.all<{ aliasGuid: string }>(sql`
          SELECT alias_guid AS aliasGuid
            FROM message_guid_aliases
           WHERE alias_guid = ${success.tempGuid}
           LIMIT 1
        `);
        if (!blockedAliases[0]) return 'unmatched';
        // The exact event proves that this temp request reached a terminal success, but the
        // quarantined alias does not prove which canonical row owns it. Leave every message row
        // untouched; only prevent the same temp request from being POSTed again on the live-event
        // path. The HTTP-ack path retains its sticky retry/error behavior.
        if (!preservePendingError) {
          await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, success.tempGuid));
        }
        return 'owner-conflict';
      }
      const claimedChats = await db.all<{ chatGuid: string }>(sql`
        SELECT guid AS chatGuid
          FROM chats
         WHERE id = ${success.claimedChatId}
         LIMIT 1
      `);
      const claimedChatGuid = claimedChats[0]?.chatGuid;
      if (!claimedChatGuid) return 'owner-conflict';
      const retained = await db.all<{ dateDeleted: number; chatGuid: string | null }>(sql`
        SELECT date_deleted AS dateDeleted, chat_guid AS chatGuid
          FROM message_deletion_ledger
         WHERE guid = ${success.tempGuid}
         LIMIT 1
      `);
      const aliases = await db.all<{ canonicalGuid: string; chatGuid: string | null }>(sql`
        SELECT canonical_guid AS canonicalGuid, chat_guid AS chatGuid
          FROM message_guid_aliases
         WHERE alias_guid = ${success.tempGuid}
         LIMIT 1
      `);
      const deletionReservation = retained[0];
      const aliasReservation = aliases[0];
      if (!deletionReservation && !aliasReservation) return 'unmatched';
      if (
        (deletionReservation && deletionReservation.chatGuid !== claimedChatGuid) ||
        (aliasReservation &&
          (aliasReservation.chatGuid !== claimedChatGuid ||
            aliasReservation.canonicalGuid !== success.guid))
      ) {
        return 'owner-conflict';
      }
      if (
        await hasOutgoingIdentityHandoverConflictWithinTransaction(
          context,
          success.tempGuid,
          success.guid,
          claimedChatGuid,
        )
      ) {
        if (!preservePendingError) {
          await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, success.tempGuid));
        }
        return 'owner-conflict';
      }
      const dateDeleted = await handoverOutgoingIdentityWithinTransaction(
        context,
        success.tempGuid,
        success.guid,
        claimedChatGuid,
      );
      await db.insert(messages).values({
        guid: success.guid,
        chatId: success.claimedChatId,
        isFromMe: true,
        dateCreated: success.dateCreated,
        dateDelivered: success.dateDelivered,
        dateDeleted,
        sendState: 'sent',
        error: 0,
        activeSendAttemptGuid: success.attemptGuid,
        attemptOwnerPending: false,
        attemptOwnerGeneration: success.clientAttemptGeneration,
      });
      await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, success.tempGuid));
      return 'reconciled';
    }
    if (success.claimedChatId != null && owner.chatId !== success.claimedChatId) {
      return 'owner-conflict';
    }

    const wasPending = owner.attemptOwnerPending !== 0;
    if (wasPending) {
      if (owner.attemptOwnerGeneration !== success.clientAttemptGeneration) {
        // Keep the durable event pending. A later HTTP acknowledgement or matching exact event
        // will settle the newer local generation, after which this attempt becomes match/stale.
        return 'attempt-owner-pending';
      }
    } else if (owner.activeSendAttemptGuid !== success.attemptGuid) {
      return 'stale-attempt';
    }

    const stickyError = owner.sendState === 'error' && (!wasPending || preservePendingError);
    if (owner.guid !== success.tempGuid && owner.guid !== success.guid) {
      await settleProvenExactOwnerConflictWithinTransaction(context, owner, success, stickyError);
      return 'owner-conflict';
    }

    let duplicate: { id: number; chatId: number } | undefined;
    if (owner.guid === success.tempGuid && success.guid !== success.tempGuid) {
      const duplicates = await db.all<{ id: number; chatId: number }>(
        sql`SELECT id, chat_id AS chatId FROM messages WHERE guid = ${success.guid} LIMIT 1`,
      );
      duplicate = duplicates[0];
      if (duplicate && duplicate.chatId !== owner.chatId) {
        await settleProvenExactOwnerConflictWithinTransaction(context, owner, success, stickyError);
        return 'owner-conflict';
      }
      if (
        await hasOutgoingIdentityHandoverConflictWithinTransaction(
          context,
          success.tempGuid,
          success.guid,
          owner.chatGuid,
        )
      ) {
        await settleProvenExactOwnerConflictWithinTransaction(context, owner, success, stickyError);
        return 'owner-conflict';
      }
    }

    if (wasPending) {
      const installed = await db.all<{ id: number }>(sql`
        UPDATE messages
           SET active_send_attempt_guid = ${success.attemptGuid}, attempt_owner_pending = 0
         WHERE guid = ${owner.guid}
           AND attempt_owner_pending = 1
           AND attempt_owner_generation = ${success.clientAttemptGeneration}
        RETURNING id
      `);
      if (installed.length === 0) return 'attempt-owner-pending';
    }

    const alreadyCanonical = owner.guid === success.guid;
    if (alreadyCanonical) {
      // When exact success itself installs a pending owner, it is affirmative evidence that the
      // current attempt succeeded and may clear a preceding local/HTTP error. A duplicate success
      // for an already-settled attempt does not erase a server failure that arrived afterward.
      if (wasPending && !stickyError) {
        await db
          .update(messages)
          .set({ sendState: 'sent', error: 0, errorMessage: null })
          .where(eq(messages.guid, owner.guid));
        await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, success.tempGuid));
        return 'reconciled';
      }
      return wasPending ? 'reconciled' : 'already-reconciled';
    }

    // A canonical fallback without an alias is possible only after bounded alias pruning or a
    // repaired database. Re-establish the exact mapping; a conflicting existing mapping throws and
    // fails closed instead of attaching the event to the wrong bubble.
    if (owner.guid !== success.tempGuid) {
      await recordMessageGuidAliasWithinTransaction(
        context,
        success.tempGuid,
        success.guid,
        owner.chatGuid,
      );
      if (wasPending && !stickyError) {
        await db
          .update(messages)
          .set({ sendState: 'sent', error: 0, errorMessage: null })
          .where(eq(messages.guid, owner.guid));
        await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, success.tempGuid));
        return 'reconciled';
      }
      return wasPending ? 'reconciled' : 'already-reconciled';
    }

    if (duplicate) {
      // Cross-chat duplicates returned above before attempt ownership changed. The remaining row
      // is the same exact conversation and may safely receive the temp row's local attachment.
      const tempAttachment = await db.all<{ localPath: string | null }>(sql`
        SELECT a.local_path AS localPath
          FROM attachments a
          JOIN messages m ON m.id = a.message_id
         WHERE m.guid = ${success.tempGuid} AND a.local_path IS NOT NULL
         LIMIT 1
      `);
      const localPath = tempAttachment[0]?.localPath;
      const dateDeleted = await handoverOutgoingIdentityWithinTransaction(
        context,
        success.tempGuid,
        success.guid,
        owner.chatGuid,
      );
      if (localPath) {
        await db.run(sql`
          UPDATE attachments
             SET local_path = ${localPath}
           WHERE message_id = ${duplicate.id} AND local_path IS NULL
        `);
      }
      await db
        .update(messages)
        .set({
          activeSendAttemptGuid: success.attemptGuid,
          attemptOwnerPending: false,
          attemptOwnerGeneration: owner.attemptOwnerGeneration,
          ...(stickyError
            ? {
                sendState: 'error' as const,
                error: owner.error,
                errorMessage: owner.errorMessage,
              }
            : { sendState: 'sent' as const, error: 0, errorMessage: null }),
        })
        .where(eq(messages.guid, success.guid));
      if (dateDeleted != null) {
        await projectMessageStateWithinTransaction(context, success.guid, owner.chatGuid);
      }
      await db.delete(messages).where(eq(messages.guid, success.tempGuid));
    } else {
      await handoverOutgoingIdentityWithinTransaction(
        context,
        success.tempGuid,
        success.guid,
        owner.chatGuid,
      );
      await db
        .update(messages)
        .set({
          guid: success.guid,
          // A send hidden by its chat's deletion keeps a date inside that deleted history, so an
          // explicit restore still shows it (review of M069).
          dateCreated:
            success.dateCreated == null
              ? undefined
              : sql`CASE WHEN ${messages.dateDeleted} IS NOT NULL AND ${messages.dateDeleted} = (
                  SELECT c.history_deleted_at FROM chats c WHERE c.id = ${messages.chatId}
                ) THEN MIN(${success.dateCreated}, ${messages.dateDeleted})
                ELSE ${success.dateCreated} END`,
          dateDelivered: success.dateDelivered ?? null,
          isFromMe: true,
          activeSendAttemptGuid: success.attemptGuid,
          attemptOwnerPending: false,
          ...(stickyError ? {} : { sendState: 'sent' as const, error: 0, errorMessage: null }),
        })
        .where(eq(messages.guid, success.tempGuid));
    }
    if (!stickyError) {
      await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, success.tempGuid));
    }
    return 'reconciled';
  });
}

export function reconcileExactOutgoingAttemptSuccessWithinTransaction(
  context: DbTransactionContext,
  success: ExactOutgoingAttemptSuccess,
): Promise<ExactOutgoingAttemptSuccessDisposition> {
  return reconcileExactOutgoingAttemptSuccessCoreWithinTransaction(context, success, false);
}

export interface OutgoingAttemptAck {
  readonly guid?: string | null;
  readonly attemptGuid: string;
  /** The local generation captured before this request began. */
  readonly attemptOwnerToken: SendAttemptOwnerToken;
  /** Exact locally selected conversation retained by the active request. */
  readonly expectedChatGuid?: string;
  readonly dateCreated: number | null;
  readonly dateDelivered: number | null;
}

/**
 * Settle one capable-RCS HTTP acknowledgement under the request's local ownership token.
 *
 * The server also echoes the generation that originally created a replayed physical attempt, but
 * that value may be older after a process restart. The local token is therefore the compare-and-set
 * authority here. A server error that committed first remains sticky, while the acknowledgement
 * can still install the attempt identity and promote a distinct real message GUID atomically.
 */
export function reconcileOutgoingAttemptAckWithinTransaction(
  context: DbTransactionContext,
  tempGuid: string,
  ack: OutgoingAttemptAck,
): Promise<OutgoingAckDisposition> {
  return runInTransactionContext(context, async (db) => {
    const distinctGuid = ack.guid && ack.guid !== tempGuid ? ack.guid : undefined;
    const ownerBefore = await findAttemptOwnerSnapshotWithinTransaction(
      context,
      tempGuid,
      distinctGuid,
    );
    if (!ownerBefore) {
      const queuedOwner = await db.all<{ chatGuid: string }>(sql`
        SELECT chat_guid AS chatGuid
          FROM outgoing_queue
         WHERE temp_guid = ${tempGuid}
         LIMIT 1
      `);
      const sourceOwners = [queuedOwner[0]?.chatGuid ?? null, ack.expectedChatGuid ?? null].filter(
        (value): value is string => value != null,
      );
      const distinctSourceOwners = new Set(sourceOwners);
      const sourceChatGuid = sourceOwners[0] ?? null;
      if (distinctSourceOwners.size > 1) {
        // The request-local expected chat and durable queue disagree. Do not let the ack mutate or
        // retire the legitimate queued source until its owner resolves that contradiction.
        return 'stale-attempt-owner';
      }
      if (sourceChatGuid == null) {
        // Preserve the historical orphan cleanup. A successful request must not remain eligible
        // for blind re-send solely because its optimistic bubble was independently purged.
        await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, tempGuid));
        return 'missing';
      }
      const retainedAliases = await db.all<{ aliasGuid: string }>(sql`
        SELECT alias_guid AS aliasGuid
          FROM message_guid_aliases
         WHERE alias_guid = ${tempGuid}
         LIMIT 1
      `);
      if (retainedAliases[0]) {
        // Owner lookup already proved that this retained alias could not safely join its canonical
        // row. The exact HTTP response retires only its temp request; it must not recreate the temp
        // identity, adopt an ownerless alias, or collide with the retained canonical row.
        await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, tempGuid));
        return 'missing';
      }
      const sourceChat = await db.all<{ id: number; historyDeletedAt: number | null }>(sql`
        SELECT id, history_deleted_at AS historyDeletedAt
          FROM chats
         WHERE guid = ${sourceChatGuid}
         LIMIT 1
      `);
      const sourceChatId = sourceChat[0]?.id;
      if (sourceChatId == null) {
        await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, tempGuid));
        return 'missing';
      }

      // A local chat purge can remove both optimistic ownership records while this exact request
      // remains in flight. Recreate only a minimal, request-owned row before moving any deletion
      // ledger. The exact success fanout can hydrate/promote it later; another provider/chat cannot
      // claim it first and inherit this send's tombstone.
      let dateDeleted: number | null;
      if (distinctGuid) {
        if (
          await hasOutgoingIdentityHandoverConflictWithinTransaction(
            context,
            tempGuid,
            distinctGuid,
            sourceChatGuid,
          )
        ) {
          await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, tempGuid));
          return 'missing';
        }
        dateDeleted = await handoverOutgoingIdentityWithinTransaction(
          context,
          tempGuid,
          distinctGuid,
          sourceChatGuid,
        );
      } else {
        const deletion = await db.all<{ dateDeleted: number; chatGuid: string | null }>(sql`
          SELECT date_deleted AS dateDeleted, chat_guid AS chatGuid
            FROM message_deletion_ledger
           WHERE guid = ${tempGuid}
           LIMIT 1
        `);
        if (deletion[0]?.chatGuid != null && deletion[0].chatGuid !== sourceChatGuid) {
          await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, tempGuid));
          return 'stale-attempt-owner';
        }
        if (deletion[0]?.chatGuid == null && deletion[0]) {
          await db
            .update(messageDeletionLedger)
            .set({ chatGuid: sourceChatGuid })
            .where(eq(messageDeletionLedger.guid, tempGuid));
        }
        dateDeleted = deletion[0]?.dateDeleted ?? null;
      }
      // A whole-chat delete hides history through chats.history_deleted_at, not per-message
      // records, and it is what purged this request's rows. Keep the recreated row inside that
      // deleted history (dated no later than its boundary) so it neither shows nor revives the
      // chat, and an explicit restore still brings it back with the rest (review M069).
      const historyFloor = sourceChat[0]?.historyDeletedAt ?? null;
      const hiddenByChatDelete = dateDeleted === null && historyFloor !== null;
      await db.insert(messages).values({
        guid: distinctGuid ?? tempGuid,
        chatId: sourceChatId,
        isFromMe: true,
        dateCreated:
          hiddenByChatDelete && (ack.dateCreated === null || ack.dateCreated > historyFloor)
            ? historyFloor
            : ack.dateCreated,
        dateDelivered: ack.dateDelivered,
        dateDeleted: hiddenByChatDelete ? historyFloor : dateDeleted,
        sendState: 'sent',
        error: 0,
        activeSendAttemptGuid: ack.attemptGuid,
        attemptOwnerPending: false,
        attemptOwnerGeneration: ack.attemptOwnerToken.generation,
      });
      await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, tempGuid));
      return 'sent';
    }
    if (ack.expectedChatGuid) {
      const expectedChat = await db.all<{ id: number }>(sql`
        SELECT id
          FROM chats
         WHERE guid = ${ack.expectedChatGuid}
         LIMIT 1
      `);
      if (expectedChat[0]?.id !== ownerBefore.chatId) return 'stale-attempt-owner';
    }

    const result = await reconcileExactOutgoingAttemptSuccessCoreWithinTransaction(
      context,
      {
        tempGuid,
        attemptGuid: ack.attemptGuid,
        clientAttemptGeneration: ack.attemptOwnerToken.generation,
        guid: distinctGuid ?? ownerBefore.guid,
        dateCreated: ack.dateCreated,
        dateDelivered: ack.dateDelivered,
      },
      true,
    );
    if (result === 'attempt-owner-pending' || result === 'stale-attempt') {
      return 'stale-attempt-owner';
    }
    if (result === 'owner-conflict') {
      // The core either settled the independently proven source or retained a sticky server error.
      // Surface that terminal state so callers do not retry a confirmed request and can clear a
      // stale failure notice only for the settled case.
      return ownerBefore.sendState === 'error' ? 'sticky-error' : 'sent';
    }
    if (result === 'unmatched') return 'missing';

    const ownerAfter = await findAttemptOwnerSnapshotWithinTransaction(
      context,
      tempGuid,
      distinctGuid ?? ownerBefore.guid,
    );
    if (!ownerAfter) return 'missing';
    return ownerAfter.sendState === 'error' ? 'sticky-error' : 'sent';
  });
}

/** The minimal echo fields reconcileEchoByContent needs to correlate to an optimistic row. */
export interface EchoMatchFields {
  guid: string;
  tempGuid?: string | null;
  attemptGuid?: string | null;
  clientAttemptGeneration?: number | null;
  /** True when the wire contained a partial or malformed modern correlation tuple. */
  sendAttemptCorrelationInvalid?: true;
  isFromMe?: boolean | null;
  text?: string | null;
  dateCreated?: number | null;
  dateDelivered?: number | null;
  associatedMessageGuid?: string | null;
  associatedMessagePart?: number | null;
  associatedMessageType?: string | null;
  associatedMessageEmoji?: string | null;
  threadOriginatorGuid?: string | null;
  threadOriginatorPart?: number | null;
  /** The copy's files as the server lists them; absent when the event did not say. */
  attachments?: readonly { readonly totalBytes?: number | null }[] | null;
}

/** Only match a temp row sent within this window of the echo's own timestamp, so a
 *  coincidentally-identical message from ANOTHER device can't hijack an unrelated stale row. */
const ECHO_MATCH_WINDOW_MS = 5 * 60_000;

/** A modern optimistic send whose current attempt the server acknowledged, with its own ids. */
interface AcknowledgedModernOwner {
  readonly id: number;
  readonly guid: string;
  readonly attemptGuid: string;
  readonly generation: number;
}

/** Most look-alike unsent rows the fallback compares; with more than this it does nothing. */
const UNMARKED_COPY_CANDIDATE_LIMIT = 100;
/** Most files it reads for those rows; with more than this it does nothing. */
const UNMARKED_COPY_FILE_LIMIT = 400;
/** Phone and Google clocks may disagree this much; a copy is never older than its send beyond it. */
const UNMARKED_COPY_CLOCK_SKEW_MS = 60_000;

const sizeSignature = (sizes: readonly number[]): string =>
  [...sizes].sort((a, b) => a - b).join(',');

/**
 * Owner phone session 2026-10-21. The server's copy of a MODERN RCS send can arrive with no attempt
 * ids at all (Google did not echo the server's temp id), and modern rows never content-match, so the
 * copy was stored as a second bubble. Find the one optimistic row it belongs to, so the caller
 * reconciles it exactly with that row's own ids. When in doubt return null and the copy is stored
 * on its own as before: an extra bubble can be deleted, a message merged into the wrong one is lost.
 *
 * Only a plain copy that lists files, all with known sizes, is matched: file sizes tell sends apart,
 * while identical short texts are common. Among ALL unsent rows in this chat (any state, deleted or
 * not) with the same text, created within ECHO_MATCH_WINDOW_MS of the copy's date, none may have a
 * file of unknown size, and exactly one may have files of the same sizes. That one must be a visible
 * modern send whose current attempt the server already acknowledged, created no later than the copy
 * (allowing for clock skew), and the copy must not be dated inside its chat's deleted history or the
 * window right after it. A same-text send without files counts as unknown and blocks the merge. The
 * copy's guid may have no history (no stored row, so an existing duplicate is left alone; no
 * deletion record, server state or alias) and the send no deletion record, which a merge would carry
 * over.
 */
async function findAcknowledgedModernOwnerWithinTransaction(
  context: DbTransactionContext,
  m: EchoMatchFields,
  chatId: number,
): Promise<AcknowledgedModernOwner | null> {
  return runInTransactionContext(context, async (db) => {
    const copyDate = m.dateCreated;
    if (copyDate == null || !Array.isArray(m.attachments) || m.attachments.length === 0) {
      return null;
    }
    if (m.associatedMessageType != null || m.threadOriginatorGuid != null) return null;
    // An unknown copy size (0) can only equal an unknown send size, which blocks the merge below.
    const sizes = m.attachments.map((file) => file.totalBytes ?? 0);
    const rows: {
      id: number;
      guid: string;
      attemptGuid: string | null;
      generation: number;
      pending: number;
      sendState: string | null;
      visible: number;
      dateCreated: number | null;
      chatDeletedAt: number;
    }[] = await db.all(sql`
      SELECT mm.id, mm.guid, mm.active_send_attempt_guid AS attemptGuid,
             mm.attempt_owner_generation AS generation, mm.attempt_owner_pending AS pending,
             mm.send_state AS sendState, ${messageVisibleInChatSql('mm', 'c')} AS visible,
             mm.date_created AS dateCreated,
             MAX(COALESCE(c.history_deleted_at, 0), COALESCE(c.deleted_at, 0)) AS chatDeletedAt
        FROM messages mm
        JOIN chats c ON c.id = mm.chat_id
       WHERE mm.chat_id = ${chatId} AND mm.is_from_me = 1 AND mm.guid LIKE 'temp-%'
         AND mm.associated_message_type IS NULL AND mm.thread_originator_guid IS NULL
         AND mm.text IS ${m.text ?? null}
         AND mm.date_created >= ${copyDate - ECHO_MATCH_WINDOW_MS}
         AND mm.date_created <= ${copyDate + ECHO_MATCH_WINDOW_MS}
       LIMIT ${UNMARKED_COPY_CANDIDATE_LIMIT + 1}`);
    if (rows.length === 0 || rows.length > UNMARKED_COPY_CANDIDATE_LIMIT) return null;
    const files: { messageId: number; bytes: number | null }[] = await db.all(sql`
      SELECT message_id AS messageId, total_bytes AS bytes
        FROM attachments
       WHERE message_id IN (${sql.join(
         rows.map((row) => sql`${row.id}`),
         sql`, `,
       )})
       LIMIT ${UNMARKED_COPY_FILE_LIMIT + 1}`);
    if (files.length > UNMARKED_COPY_FILE_LIMIT) return null;
    // A file of unknown size could be this very copy's file, so nothing can be told apart. A send
    // with the same text but no files is unknown too: its files may have been purged.
    if (files.some((file) => !(file.bytes != null && file.bytes > 0))) return null;
    const filesOf = (id: number) => files.filter((file) => file.messageId === id);
    if (rows.some((row) => filesOf(row.id).length === 0)) return null;
    const wanted = sizeSignature(sizes);
    const same = rows.filter(
      (row) => sizeSignature(filesOf(row.id).map((file) => file.bytes ?? 0)) === wanted,
    );
    if (same.length !== 1) return null;
    const owner = same[0]!;
    if (
      owner.generation <= 0 ||
      owner.pending !== 0 ||
      owner.attemptGuid == null ||
      owner.sendState !== 'sent' ||
      owner.visible !== 1
    ) {
      return null;
    }
    if (owner.dateCreated == null || owner.dateCreated > copyDate + UNMARKED_COPY_CLOCK_SKEW_MS) {
      return null;
    }
    // Merging dates the send by the copy; inside a deleted chat's history it would be hidden, or
    // hidden and purged. Just after the delete, the copy may belong to a send the delete purged,
    // which can no longer block a look-alike (chatDeletedAt is 0 when it was never deleted).
    if (owner.chatDeletedAt > 0 && copyDate <= owner.chatDeletedAt + ECHO_MATCH_WINDOW_MS) {
      return null;
    }
    const history = await db.all(sql`
      SELECT 1 AS found FROM messages WHERE guid = ${m.guid}
      UNION ALL
      SELECT 1 FROM message_deletion_ledger WHERE guid IN (${m.guid}, ${owner.guid})
      UNION ALL
      SELECT 1 FROM message_server_states WHERE guid = ${m.guid}
      UNION ALL
      SELECT 1 FROM message_guid_aliases WHERE canonical_guid = ${m.guid}
      LIMIT 1`);
    if (history.length > 0) return null;
    return {
      id: owner.id,
      guid: owner.guid,
      attemptGuid: owner.attemptGuid,
      generation: owner.generation,
    };
  });
}

/**
 * Google stores a captioned RCS picture as TWO messages: the caption, then the picture with no
 * words. The server links only the picture copy to our upload (by its exact attempt ids), so our
 * bubble would keep its local caption while Google's separate caption message also arrives: the
 * caption showed twice on the sending phone. When the exact-linked copy of our own RCS upload
 * arrives with no text, drop the bubble's local caption so the chat matches Google Messages
 * (caption message, then picture). Only RCS, only an exact link, only a row that has files; a copy
 * that does carry the caption (Google kept one message) leaves the bubble alone.
 */
function dropSplitRcsCaptionWithinTransaction(
  context: DbTransactionContext,
  m: EchoMatchFields,
  chatId: number,
  disposition: ExactOutgoingAttemptSuccessDisposition,
): Promise<void> {
  return runInTransactionContext(context, async (db) => {
    if (disposition !== 'reconciled' && disposition !== 'already-reconciled') return;
    // Only an explicit empty text (null or "") proves a wordless copy; an omitted field proves nothing.
    if (!m.isFromMe || !(m.text === null || m.text === '')) return;
    await db.all(sql`
      UPDATE messages
         SET text = NULL
       WHERE guid = ${m.guid}
         AND chat_id = ${chatId}
         AND is_from_me = 1
         AND text IS NOT NULL
         AND EXISTS (SELECT 1 FROM chats c WHERE c.id = ${chatId} AND substr(c.guid, 1, 6) = 'RCS;-;')
         AND EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = messages.id)
      RETURNING id
    `);
  });
}

/** Reconcile a modern copy through its one acknowledged owner; anything but success changes nothing. */
async function reconcileModernCopyThroughOwnerWithinTransaction(
  context: DbTransactionContext,
  m: EchoMatchFields,
  chatId: number,
  owner: AcknowledgedModernOwner,
): Promise<ExactOutgoingAttemptSuccessDisposition | null> {
  return runInTransactionContext(context, async () => {
    const disposition = await reconcileExactOutgoingAttemptSuccessWithinTransaction(context, {
      tempGuid: owner.guid,
      attemptGuid: owner.attemptGuid,
      clientAttemptGeneration: owner.generation,
      guid: m.guid,
      claimedChatId: chatId,
      dateCreated: m.dateCreated ?? null,
      dateDelivered: m.dateDelivered ?? null,
    });
    return disposition === 'reconciled' || disposition === 'already-reconciled'
      ? disposition
      : null;
  });
}

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
): Promise<ExactOutgoingAttemptSuccessDisposition | null> {
  return runInTransactionContext(context, async (db) => {
    if (!m.isFromMe || m.guid.startsWith('temp-')) return null;
    if (m.sendAttemptCorrelationInvalid === true) return 'unmatched';
    const hasExactAttemptField =
      m.tempGuid != null || m.attemptGuid != null || m.clientAttemptGeneration != null;
    if (hasExactAttemptField) {
      if (!m.tempGuid || !m.attemptGuid || m.clientAttemptGeneration == null) {
        // Partial modern correlation is a protocol violation, not permission to content-match.
        return 'unmatched';
      }
      const disposition = await reconcileExactOutgoingAttemptSuccessWithinTransaction(context, {
        tempGuid: m.tempGuid,
        attemptGuid: m.attemptGuid,
        clientAttemptGeneration: m.clientAttemptGeneration,
        guid: m.guid,
        claimedChatId: chatId,
        dateCreated: m.dateCreated ?? null,
        dateDelivered: m.dateDelivered ?? null,
      });
      await dropSplitRcsCaptionWithinTransaction(context, m, chatId, disposition);
      return disposition;
    }
    // A modern send's copy that carries no attempt ids: reconcile it through its one owner.
    const modernOwner = await findAcknowledgedModernOwnerWithinTransaction(context, m, chatId);
    if (modernOwner) {
      const merged = await reconcileModernCopyThroughOwnerWithinTransaction(
        context,
        m,
        chatId,
        modernOwner,
      );
      if (merged) return merged;
    }
    // Already reconciled (the HTTP ack promoted the temp row first) → leave it to the upsert.
    const already = await db.all<{ id: number }>(
      sql`SELECT id FROM messages WHERE guid = ${m.guid} LIMIT 1`,
    );
    if (already[0]) return null;
    // Match on the fields the BARE socket echo reliably carries — serializeMessage emits NO
    // has_attachments/attachments on the live event, so we must NOT gate on them. A reaction
    // matches its target+type+known part, a reply matches its target+known part+text, and a plain
    // message cannot claim a reply row. Unknown reaction/reply parts reconcile only when the
    // candidate is unique. Other messages match exact text. This covers attachments too:
    // an outgoing attachment send and its echo both have null text. (Attachments are always sent
    // via the Private API — the AppleScript fallback is plain-text only — so on the ack-less
    // no-guid path only TEXT arrives here, and text matches reliably; an attachment that races
    // its ack falls back to reconcileOutgoingSuccess's dup-branch local_path carry-over.)
    const isReactionEcho = m.associatedMessageType != null;
    const isReplyEcho = !isReactionEcho && m.threadOriginatorGuid != null;
    const reactionHasCustomEmoji = m.associatedMessageType?.replace(/^-/, '') === 'emoji';
    const match = isReactionEcho
      ? sql`associated_message_type = ${m.associatedMessageType}
              AND associated_message_guid IS ${m.associatedMessageGuid ?? null}
              ${reactionHasCustomEmoji ? sql`AND associated_message_emoji IS ${m.associatedMessageEmoji ?? null}` : sql``}
              ${m.associatedMessagePart == null ? sql`` : sql`AND associated_message_part IS ${m.associatedMessagePart}`}`
      : isReplyEcho
        ? sql`associated_message_type IS NULL
                AND text IS ${m.text ?? null}
                AND thread_originator_guid IS ${m.threadOriginatorGuid}
                ${m.threadOriginatorPart == null ? sql`` : sql`AND thread_originator_part IS ${m.threadOriginatorPart}`}`
        : sql`associated_message_type IS NULL
                AND thread_originator_guid IS NULL
                AND text IS ${m.text ?? null}`;
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
    // A legacy/bare reaction or reply echo has unknown part identity. Preserve its old
    // single-candidate reconciliation path, but never guess between multiple otherwise-valid
    // part-specific rows. A known incoming part remains exact and rapid identical sends retain
    // their oldest-first rule.
    const requiresUniqueUnknownPartMatch =
      (isReactionEcho && m.associatedMessagePart == null) ||
      (isReplyEcho && m.threadOriginatorPart == null);
    const rows = await db.all<{ guid: string }>(sql`
      SELECT guid FROM messages
      WHERE chat_id = ${chatId} AND is_from_me = 1 AND guid LIKE 'temp-%'
        AND send_state IN ('sending', 'sent', 'error')
        AND attempt_owner_generation = 0 AND ${match} ${window}
      ORDER BY (date_deleted IS NULL) DESC, (send_state = 'sending') DESC, date_created ASC, id ASC
      LIMIT ${requiresUniqueUnknownPartMatch ? 2 : 1}`);
    if (requiresUniqueUnknownPartMatch && rows.length !== 1) return null;
    const temp = rows[0];
    if (!temp) return null;
    const owners = await db.all<{ chatGuid: string }>(sql`
      SELECT guid AS chatGuid FROM chats WHERE id = ${chatId} LIMIT 1
    `);
    const ownerChatGuid = owners[0]?.chatGuid;
    if (!ownerChatGuid) return null;
    if (
      await hasOutgoingIdentityHandoverConflictWithinTransaction(
        context,
        temp.guid,
        m.guid,
        ownerChatGuid,
      )
    ) {
      return null;
    }
    await handoverOutgoingIdentityWithinTransaction(context, temp.guid, m.guid, ownerChatGuid);
    // Drop the queue row BEFORE promoting, so a concurrent retry tick in the gap can't claim and
    // re-POST a send that's already being reconciled.
    await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, temp.guid));
    await db
      .update(messages)
      .set({ guid: m.guid, sendState: 'sent', error: 0, errorMessage: null })
      .where(eq(messages.guid, temp.guid));
    return null;
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
): Promise<ExactOutgoingAttemptSuccessDisposition | null> {
  if (!m.isFromMe || m.guid.startsWith('temp-')) return null;
  if (m.sendAttemptCorrelationInvalid === true) return 'unmatched';
  return withDbTransaction(
    db,
    async (context) => {
      const hasExactAttemptField =
        m.tempGuid != null || m.attemptGuid != null || m.clientAttemptGeneration != null;
      if (hasExactAttemptField) {
        if (!m.tempGuid || !m.attemptGuid || m.clientAttemptGeneration == null) {
          return 'unmatched';
        }
        const disposition = await reconcileExactOutgoingAttemptSuccessWithinTransaction(context, {
          tempGuid: m.tempGuid,
          attemptGuid: m.attemptGuid,
          clientAttemptGeneration: m.clientAttemptGeneration,
          guid: m.guid,
          claimedChatId: chatId,
          dateCreated: m.dateCreated ?? null,
          dateDelivered: m.dateDelivered ?? null,
        });
        await dropSplitRcsCaptionWithinTransaction(context, m, chatId, disposition);
        return disposition;
      }
      // A modern send's copy that carries no attempt ids: reconcile it through its one owner.
      const modernOwner = await findAcknowledgedModernOwnerWithinTransaction(context, m, chatId);
      if (modernOwner) {
        const merged = await reconcileModernCopyThroughOwnerWithinTransaction(
          context,
          m,
          chatId,
          modernOwner,
        );
        if (merged) return merged;
      }
      // Already materialized (a prior sync/echo created it) → leave it to the upsert.
      const already = await db.all<{ id: number }>(
        sql`SELECT id FROM messages WHERE guid = ${m.guid} LIMIT 1`,
      );
      if (already[0]) return null;
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
          -- Content matching is legacy-only. A modern row (generation > 0) must carry the exact
          -- server tuple; otherwise an old identical sync row could steal the optimistic bubble.
          AND mm.attempt_owner_generation = 0
          AND mm.associated_message_type IS NULL AND mm.text IS ${m.text ?? null}
          AND EXISTS (
            SELECT 1 FROM attachments a
            WHERE a.message_id = mm.id AND a.guid LIKE '%-att' AND a.local_path IS NOT NULL
          )
          ${window}
        ORDER BY (mm.date_deleted IS NULL) DESC, (mm.send_state = 'sending') DESC,
                 mm.date_created ASC, mm.id ASC LIMIT 1`);
      const temp = rows[0];
      if (!temp) return null;
      const owners = await db.all<{ chatGuid: string }>(sql`
        SELECT guid AS chatGuid FROM chats WHERE id = ${chatId} LIMIT 1
      `);
      const ownerChatGuid = owners[0]?.chatGuid;
      if (!ownerChatGuid) return null;
      if (
        await hasOutgoingIdentityHandoverConflictWithinTransaction(
          context,
          temp.guid,
          m.guid,
          ownerChatGuid,
        )
      ) {
        return null;
      }
      // Queue deletion and identity promotion are one commit. Otherwise a crash/rollback between
      // them can either re-send an acknowledged attachment or strand the optimistic temp row.
      await handoverOutgoingIdentityWithinTransaction(context, temp.guid, m.guid, ownerChatGuid);
      await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, temp.guid));
      await db
        .update(messages)
        .set({ guid: m.guid, sendState: 'sent', error: 0, errorMessage: null })
        .where(eq(messages.guid, temp.guid));
      return null;
    },
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

export {
  imessagePlainTextQueueState,
  OUTGOING_GRACE_MS,
  OUTGOING_MAX_ATTEMPTS,
  outgoingBackoffMs,
} from './outgoingRetryPolicy';
export * from './outgoingRetry';
