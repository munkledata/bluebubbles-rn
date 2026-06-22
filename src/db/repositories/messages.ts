import { eq, inArray, sql } from 'drizzle-orm';
import type { Attachment, Message } from '@core/models';
import { chats, messages, outgoingQueue } from '../schema';
import type { AppDatabase } from '../types';
import { dedupeBy, toFtsQuery } from './_shared';
import { upsertAttachments } from './attachments';

/**
 * Upsert messages. `resolveChatId` maps a message to its local chat id; messages
 * with no resolvable chat are skipped. Returns guid → row id and refreshes each
 * touched chat's denormalized latest_message_date.
 */
export async function upsertMessages(
  db: AppDatabase,
  items: Message[],
  resolveChatId: (m: Message) => number | undefined,
  handleIdByAddress: Map<string, number>,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const deduped = dedupeBy(
    items.filter((m) => !!m?.guid),
    (m) => m.guid,
  );
  const withChat = deduped
    .map((m) => ({ m, chatId: resolveChatId(m) }))
    .filter((x): x is { m: Message; chatId: number } => x.chatId != null);
  if (withChat.length === 0) return map;

  const rows = await db
    .insert(messages)
    .values(
      withChat.map(({ m, chatId }) => ({
        guid: m.guid,
        originalRowId: m.originalROWID ?? null,
        chatId,
        handleId: m.handle?.address ? (handleIdByAddress.get(m.handle.address) ?? null) : null,
        text: m.text ?? null,
        subject: m.subject ?? null,
        attributedBody: m.attributedBody ? JSON.stringify(m.attributedBody) : null,
        isFromMe: m.isFromMe ?? false,
        dateCreated: m.dateCreated ?? null,
        dateRead: m.dateRead ?? null,
        dateDelivered: m.dateDelivered ?? null,
        dateEdited: m.dateEdited ?? null,
        dateRetracted: m.dateRetracted ?? null,
        hasAttachments: m.hasAttachments ?? false,
        associatedMessageGuid: m.associatedMessageGuid ?? null,
        associatedMessageType: m.associatedMessageType ?? null,
        threadOriginatorGuid: m.threadOriginatorGuid ?? null,
        expressiveSendStyleId: m.expressiveSendStyleId ?? null,
        error: m.error ?? 0,
        // NULL (not false) when the event omits the flag, so the COALESCE on conflict
        // (below) can keep a previously-stored `true` instead of being handed a 0 that
        // would mask the real value. Consumers treat NULL as falsy, same as false.
        wasDeliveredQuietly: m.wasDeliveredQuietly ?? null,
        didNotifyRecipient: m.didNotifyRecipient ?? null,
      })),
    )
    .onConflictDoUpdate({
      target: messages.guid,
      set: {
        text: sql`excluded.text`,
        dateRead: sql`excluded.date_read`,
        dateDelivered: sql`excluded.date_delivered`,
        dateEdited: sql`excluded.date_edited`,
        dateRetracted: sql`excluded.date_retracted`,
        error: sql`excluded.error`,
        // Delivery tiers flip on a later updated-message event (Apple may report the
        // quiet delivery after the initial echo), so refresh them on conflict too — but
        // COALESCE so a later event that OMITS the flag (excluded = NULL) can't downgrade
        // a previously-stored `true` back to false/null. A present flag still overwrites.
        wasDeliveredQuietly: sql`COALESCE(excluded.was_delivered_quietly, ${messages.wasDeliveredQuietly})`,
        didNotifyRecipient: sql`COALESCE(excluded.did_notify_recipient, ${messages.didNotifyRecipient})`,
      },
    })
    .returning({ id: messages.id, guid: messages.guid });

  for (const r of rows) map.set(r.guid, r.id);

  // Upsert nested attachments now that we have message ids.
  const attRows: Array<{ att: Attachment; messageId: number }> = [];
  for (const { m } of withChat) {
    const messageId = map.get(m.guid);
    if (messageId == null) continue;
    for (const att of m.attachments ?? []) {
      if (att?.guid) attRows.push({ att, messageId });
    }
  }
  await upsertAttachments(db, attRows);

  // Refresh denormalized latest_message_date for touched chats.
  const touched = [...new Set(withChat.map((x) => x.chatId))];
  if (touched.length > 0) {
    await db
      .update(chats)
      .set({
        latestMessageDate: sql`(SELECT MAX(date_created) FROM messages WHERE messages.chat_id = chats.id)`,
      })
      .where(inArray(chats.id, touched));
  }
  return map;
}

/** Messages for a chat, newest first. */
export function listMessages(db: AppDatabase, chatId: number, limit = 100) {
  return db
    .select()
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(sql`${messages.dateCreated} DESC`)
    .limit(limit);
}

/** Full-text search over message bodies (FTS5), ranked. */
export async function searchMessages(
  db: AppDatabase,
  queryText: string,
  limit = 50,
): Promise<Array<Record<string, unknown>>> {
  const match = toFtsQuery(queryText);
  if (!match) return [];
  const rows = await db.all<Record<string, unknown>>(
    sql`SELECT m.* FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE messages_fts MATCH ${match} ORDER BY rank LIMIT ${limit}`,
  );
  return rows;
}

export interface SearchResultRow {
  id: number;
  guid: string;
  text: string | null;
  dateCreated: number | null;
  isFromMe: number;
  chatGuid: string;
  chatDisplayName: string | null;
  chatIdentifier: string | null;
  senderName: string | null;
}

/**
 * FTS5 search enriched with chat + sender context for a results screen.
 * Excludes reaction rows; newest-first for parity with the Flutter search.
 */
export async function searchMessagesEnriched(
  db: AppDatabase,
  queryText: string,
  limit = 50,
): Promise<SearchResultRow[]> {
  const match = toFtsQuery(queryText);
  if (!match) return [];
  return db.all<SearchResultRow>(sql`
    SELECT m.id, m.guid, m.text, m.date_created AS dateCreated, m.is_from_me AS isFromMe,
           c.guid AS chatGuid, c.display_name AS chatDisplayName,
           c.chat_identifier AS chatIdentifier,
           COALESCE(h.display_name, h.address) AS senderName
    FROM messages_fts f
    JOIN messages m ON m.id = f.rowid
    JOIN chats c ON c.id = m.chat_id
    LEFT JOIN handles h ON h.id = m.handle_id
    WHERE messages_fts MATCH ${match}
      AND m.associated_message_type IS NULL
    ORDER BY m.date_created DESC
    LIMIT ${limit}
  `);
}

/** Newest received (inbound) message guid in a chat — the correct mark-read target. */
export async function getNewestReceivedGuid(
  db: AppDatabase,
  chatId: number,
): Promise<string | null> {
  const rows = await db.all<{ guid: string }>(sql`
    SELECT guid FROM messages
    WHERE chat_id = ${chatId} AND is_from_me = 0
    ORDER BY date_created DESC, id DESC LIMIT 1
  `);
  return rows[0]?.guid ?? null;
}

/** A message row enriched with its sender handle, ready to render a bubble. */
export interface MessageRow {
  id: number;
  guid: string;
  chatId: number;
  handleId: number | null;
  text: string | null;
  attributedBody: string | null;
  subject: string | null;
  isFromMe: number;
  dateCreated: number | null;
  dateRead: number | null;
  dateDelivered: number | null;
  dateEdited: number | null;
  dateRetracted: number | null;
  hasAttachments: number;
  error: number;
  sendState: string;
  wasDeliveredQuietly: number;
  didNotifyRecipient: number;
  associatedMessageGuid: string | null;
  associatedMessageType: string | null;
  threadOriginatorGuid: string | null;
  expressiveSendStyleId: string | null;
  senderAddress: string | null;
  senderName: string | null;
  senderAvatar: string | null;
  senderService: string | null;
}

/** Messages for a chat, newest-first (the inverted list wants index 0 = newest). */
export async function listMessagesWithSenders(
  db: AppDatabase,
  chatId: number,
  limit = 100,
  beforeDate?: number,
): Promise<MessageRow[]> {
  const cursor = beforeDate != null ? sql`AND m.date_created < ${beforeDate}` : sql``;
  return db.all<MessageRow>(sql`
    SELECT
      m.id, m.guid, m.chat_id AS chatId, m.handle_id AS handleId,
      m.text, m.attributed_body AS attributedBody,
      m.subject, m.is_from_me AS isFromMe, m.date_created AS dateCreated,
      m.date_read AS dateRead, m.date_delivered AS dateDelivered, m.date_edited AS dateEdited,
      m.date_retracted AS dateRetracted,
      m.has_attachments AS hasAttachments, m.error, m.send_state AS sendState,
      m.was_delivered_quietly AS wasDeliveredQuietly,
      m.did_notify_recipient AS didNotifyRecipient,
      m.associated_message_guid AS associatedMessageGuid,
      m.associated_message_type AS associatedMessageType,
      m.thread_originator_guid AS threadOriginatorGuid,
      m.expressive_send_style_id AS expressiveSendStyleId,
      h.address AS senderAddress,
      COALESCE(h.display_name, h.address) AS senderName,
      h.avatar AS senderAvatar,
      h.service AS senderService
    FROM messages m
    LEFT JOIN handles h ON h.id = m.handle_id
    WHERE m.chat_id = ${chatId} ${cursor}
      AND m.associated_message_type IS NULL
    ORDER BY m.date_created DESC, m.id DESC
    LIMIT ${limit}
  `);
}

export interface MessagePreview {
  guid: string;
  text: string | null;
  senderName: string | null;
  isFromMe: number;
  hasAttachments: number;
}

/** A compact preview of a message by guid (for the reply quote). */
export async function getMessagePreviewByGuid(
  db: AppDatabase,
  guid: string,
): Promise<MessagePreview | null> {
  const rows = await db.all<MessagePreview>(sql`
    SELECT m.guid, m.text, m.is_from_me AS isFromMe, m.has_attachments AS hasAttachments,
           COALESCE(h.display_name, h.address) AS senderName
    FROM messages m LEFT JOIN handles h ON h.id = m.handle_id
    WHERE m.guid = ${guid} LIMIT 1
  `);
  return rows[0] ?? null;
}

/** Delete a message by guid (used to clear an errored temp row before retry). */
export async function deleteMessageByGuid(db: AppDatabase, guid: string): Promise<void> {
  await db.delete(messages).where(eq(messages.guid, guid));
  await db.delete(outgoingQueue).where(eq(outgoingQueue.tempGuid, guid));
}

// ---- Edit / Unsend (operate on real guids; mutate in place, reactive watcher updates UI) ----

/** Optimistically apply a local edit: new text + dateEdited marker (UI shows "Edited"). */
export async function applyLocalEdit(
  db: AppDatabase,
  guid: string,
  newText: string,
  now: number,
): Promise<void> {
  await db.update(messages).set({ text: newText, dateEdited: now }).where(eq(messages.guid, guid));
}

/** Optimistically mark a message retracted (UI shows the unsent tombstone). */
export async function applyLocalUnsend(db: AppDatabase, guid: string, now: number): Promise<void> {
  await db.update(messages).set({ dateRetracted: now }).where(eq(messages.guid, guid));
}

/** Clear a retraction (revert an optimistic unsend on POST failure). */
export async function clearLocalUnsend(db: AppDatabase, guid: string): Promise<void> {
  await db.update(messages).set({ dateRetracted: null }).where(eq(messages.guid, guid));
}

/** Read a message's current text + edit marker (to revert an optimistic edit on failure). */
export async function getMessageTextByGuid(
  db: AppDatabase,
  guid: string,
): Promise<{ text: string | null; dateEdited: number | null } | null> {
  const rows = await db.all<{ text: string | null; dateEdited: number | null }>(
    sql`SELECT text, date_edited AS dateEdited FROM messages WHERE guid = ${guid} LIMIT 1`,
  );
  return rows[0] ?? null;
}

/**
 * Resolve the GUID of the chat a message belongs to (via its chat_id → chats.guid). The
 * edit/unsend server routes require `chatGuid`, which the UI doesn't always have in scope.
 */
export async function getChatGuidByMessageGuid(
  db: AppDatabase,
  messageGuid: string,
): Promise<string | null> {
  const rows = await db.all<{ guid: string }>(
    sql`SELECT c.guid AS guid FROM messages m JOIN chats c ON c.id = m.chat_id
        WHERE m.guid = ${messageGuid} LIMIT 1`,
  );
  return rows[0]?.guid ?? null;
}
