/** Optimistic outgoing inserts (moved from outgoing.ts): text, contact, location and reaction rows. */

import { eq, sql } from 'drizzle-orm';
import type { IMessageTextFormattingRange, MessageMention } from '@core/api/endpoints/messages';
import { chats, messages, outgoingQueue } from '../schema';
import {
  type DbTransactionContext,
  runInTransactionContext,
  withDbTransaction,
} from '../transaction';
import type { ReadDb } from '../types';
import { requireChatIdByGuidWithinTransaction } from './chats';
import type { SendAttemptOwnerToken } from './outgoingAttemptOwnership';

/** Ownership handoff returned by an optimistic insert. Null keeps the legacy send path unchanged. */
export interface OutgoingInsertResult {
  readonly attemptOwnerToken: SendAttemptOwnerToken | null;
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
  /** Marks the dedicated one-shot FP-006 subject payload for crash recovery without replay. */
  oneShotSubject?: boolean;
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
        imessageSubjectV1: args.oneShotSubject === true ? true : undefined,
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
  db: ReadDb,
  args: InsertOutgoingTextArgs,
): Promise<OutgoingInsertResult> {
  // ONE transaction — see the insert-atomicity note directly above.
  return withDbTransaction(db, (db, context) => insertOutgoingTextWithinTransaction(context, args));
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
  db: ReadDb,
  args: InsertOutgoingReactionArgs,
): Promise<void> {
  // ONE transaction — see the insert-atomicity note above insertOutgoingText.
  await withDbTransaction(db, (db, context) =>
    insertOutgoingReactionWithinTransaction(context, args),
  );
}
