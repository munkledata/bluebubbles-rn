import { eq, sql } from 'drizzle-orm';
import { chats, messages, outgoingQueue } from '../schema';
import type { AppDatabase } from '../types';

/** Server fields used to promote an optimistic message to its real identity. */
export interface ServerMsgFields {
  guid: string;
  dateCreated: number | null;
  dateDelivered: number | null;
}

/** Optimistically insert an outgoing text message + its queue row, and bump the chat. */
export async function insertOutgoingText(
  db: AppDatabase,
  args: {
    tempGuid: string;
    chatId: number;
    chatGuid: string;
    text: string;
    now: number;
    selectedMessageGuid?: string;
    threadOriginatorGuid?: string;
    effectId?: string;
  },
): Promise<void> {
  await db.insert(messages).values({
    guid: args.tempGuid,
    chatId: args.chatId,
    text: args.text,
    isFromMe: true,
    dateCreated: args.now,
    sendState: 'sending',
    error: 0,
    // Persist locally so an optimistic reply renders its quote + the send-effect
    // plays on the outgoing bubble before the server echo.
    threadOriginatorGuid: args.threadOriginatorGuid ?? null,
    expressiveSendStyleId: args.effectId ?? null,
  });
  await db.insert(outgoingQueue).values({
    tempGuid: args.tempGuid,
    chatGuid: args.chatGuid,
    kind: 'text',
    payload: JSON.stringify({
      message: args.text,
      selectedMessageGuid: args.selectedMessageGuid,
      effectId: args.effectId,
    }),
  });
  await db.update(chats).set({ latestMessageDate: args.now }).where(eq(chats.id, args.chatId));
}

/**
 * Optimistically insert an outgoing reaction (an associated message row) + its
 * queue row. Unlike a text send this does NOT bump latestMessageDate — a tapback
 * must not reorder the inbox. `reaction` is e.g. 'love' or '-love' (removal).
 */
export async function insertOutgoingReaction(
  db: AppDatabase,
  args: {
    tempGuid: string;
    chatId: number;
    chatGuid: string;
    targetGuid: string;
    reaction: string;
    selectedMessageText?: string;
    now: number;
  },
): Promise<void> {
  await db.insert(messages).values({
    guid: args.tempGuid,
    chatId: args.chatId,
    text: null,
    isFromMe: true,
    dateCreated: args.now,
    sendState: 'sending',
    error: 0,
    associatedMessageGuid: args.targetGuid,
    associatedMessageType: args.reaction,
  });
  await db.insert(outgoingQueue).values({
    tempGuid: args.tempGuid,
    chatGuid: args.chatGuid,
    kind: 'reaction',
    payload: JSON.stringify({
      selectedMessageGuid: args.targetGuid,
      reaction: args.reaction,
      selectedMessageText: args.selectedMessageText ?? '',
    }),
  });
}

/**
 * Cancel a still-pending optimistic send: remove its queue row AND its optimistic
 * message — but ONLY while the send hasn't been reconciled to its real identity.
 *
 * Guard: the row is cancellable only while its `outgoing_queue` row still exists
 * AND the message is still in a temp send state ('sending' or 'error'). Once
 * `reconcileOutgoingSuccess` promotes the row to its real guid and drops the queue
 * row, this is a no-op (it can no longer find the queue row by tempGuid), so a
 * concurrent reconcile can never be clobbered. Returns whether anything was cancelled.
 */
export async function cancelOutgoing(db: AppDatabase, tempGuid: string): Promise<boolean> {
  const queued = await db.all<{ id: number }>(
    sql`SELECT id FROM outgoing_queue WHERE temp_guid = ${tempGuid} LIMIT 1`,
  );
  if (!queued[0]) return false; // already reconciled (or never queued) → not cancellable
  // The message must still be the optimistic temp row. If it's been promoted to 'sent'
  // (a reconcile that left the queue row), don't delete a real, sent message.
  const msg = await db.all<{ id: number }>(
    sql`SELECT id FROM messages WHERE guid = ${tempGuid} AND send_state IN ('sending', 'error') LIMIT 1`,
  );
  if (!msg[0]) {
    // Stranded queue row with no matching temp message → just clear the queue entry.
    await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, tempGuid));
    return true;
  }
  await db.delete(messages).where(eq(messages.guid, tempGuid));
  await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, tempGuid));
  return true;
}

/**
 * Reconcile a successful send. If the real message already exists (the socket
 * echo landed first via DbEventSink), drop the temp row; otherwise promote the
 * temp row to the real guid in place. Either way, no duplicate (guid is unique).
 */
export async function reconcileOutgoingSuccess(
  db: AppDatabase,
  tempGuid: string,
  server: ServerMsgFields,
): Promise<void> {
  const dup = await db.all<{ id: number }>(
    sql`SELECT id FROM messages WHERE guid = ${server.guid} LIMIT 1`,
  );
  if (dup[0]) {
    await db.delete(messages).where(eq(messages.guid, tempGuid));
  } else {
    await db
      .update(messages)
      .set({
        guid: server.guid,
        dateCreated: server.dateCreated ?? undefined,
        dateDelivered: server.dateDelivered ?? null,
        isFromMe: true,
        sendState: 'sent',
        error: 0,
      })
      .where(eq(messages.guid, tempGuid));
  }
  await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, tempGuid));
}

/** Max automatic retries before a queued send retires to the 'error' bubble. */
export const OUTGOING_MAX_ATTEMPTS = 5;
// A freshly-inserted row is assumed in-flight (the UI send owns it) for this long, so
// the retry processor won't double-send it; past this, an un-deleted row is stranded.
const OUTGOING_GRACE_MS = 60_000;
// Lease set on a row while a retry attempt is in flight (prevents concurrent runners).
const OUTGOING_LEASE_MS = 120_000;

/** Exponential backoff for retry N (1-based): 30s, 60s, 120s, 240s, 480s — capped at 1h. */
export function outgoingBackoffMs(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 3_600_000);
}

/** Reconcile a failed send: mark the temp message errored, bump attempts, schedule a backoff retry. */
export async function reconcileOutgoingError(
  db: AppDatabase,
  tempGuid: string,
  errorCode: number,
  now: number = Date.now(),
): Promise<void> {
  await db
    .update(messages)
    .set({ sendState: 'error', error: errorCode })
    .where(eq(messages.guid, tempGuid));
  const cur = await db.all<{ attempts: number }>(
    sql`SELECT attempts FROM outgoing_queue WHERE temp_guid = ${tempGuid} LIMIT 1`,
  );
  const attempts = (cur[0]?.attempts ?? 0) + 1;
  await db
    .update(outgoingQueue)
    .set({ attempts, nextRetryAt: now + outgoingBackoffMs(attempts) })
    .where(eq(outgoingQueue.tempGuid, tempGuid));
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
): Promise<RetryableOutgoing[]> {
  return db.all<RetryableOutgoing>(sql`
    SELECT id, temp_guid AS tempGuid, chat_guid AS chatGuid, kind, payload, attempts, created_at AS createdAt
    FROM outgoing_queue
    WHERE attempts < ${OUTGOING_MAX_ATTEMPTS}
      AND next_retry_at <= ${now}
      AND (attempts >= 1 OR created_at <= ${now - OUTGOING_GRACE_MS})
    ORDER BY created_at ASC`);
}

/**
 * Atomically lease a row for a retry attempt by pushing next_retry_at into the future.
 * Exactly one caller wins (the `next_retry_at <= now` guard); the rest get false and
 * skip — the real lock against two concurrent processors (a useRef wouldn't suffice).
 */
export async function claimOutgoing(db: AppDatabase, id: number, now: number): Promise<boolean> {
  const rows = await db.all<{ id: number }>(sql`
    UPDATE outgoing_queue SET next_retry_at = ${now + OUTGOING_LEASE_MS}
    WHERE id = ${id} AND next_retry_at <= ${now} RETURNING id`);
  return rows.length > 0;
}
