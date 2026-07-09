import { eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Attachment, Message } from '@core/models';
import { plainTextFromAttributedBody } from '@core/richtext';
import { chatHandles, chats, messages, outgoingQueue } from '../schema';
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
      withChat.map(({ m, chatId }) => {
        // Edited and SMS messages arrive with an empty `text` column — their body lives in the
        // attributedBody typedstream. Decode it into `text` so the message is full-text searchable
        // (FTS indexes only `text`) and previews/replies show the words. The server-side decode now
        // populates `m.text` directly; this is the local fallback for anything it didn't.
        const attributedBody = m.attributedBody ? JSON.stringify(m.attributedBody) : null;
        const text =
          m.text && m.text.length > 0
            ? m.text
            : plainTextFromAttributedBody(attributedBody) || null;
        return {
          guid: m.guid,
          originalRowId: m.originalROWID ?? null,
          chatId,
          handleId: m.handle?.address ? (handleIdByAddress.get(m.handle.address) ?? null) : null,
          text,
          subject: m.subject ?? null,
          attributedBody,
          isFromMe: m.isFromMe ?? false,
          dateCreated: m.dateCreated ?? null,
          dateRead: m.dateRead ?? null,
          dateDelivered: m.dateDelivered ?? null,
          dateEdited: m.dateEdited ?? null,
          dateRetracted: m.dateRetracted ?? null,
          // The server omits `hasAttachments`; infer it from the hydrated attachments array so the
          // flag stays accurate for reply-quote previews (the image read path no longer relies on it).
          hasAttachments: m.hasAttachments ?? (m.attachments?.length ?? 0) > 0,
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
        };
      }),
    )
    .onConflictDoUpdate({
      target: messages.guid,
      set: {
        // An EDIT empties the text column and re-fills it (server-side decode, or our local
        // attributedBody fallback above), so `excluded.text` carries the new body on a re-sync.
        // COALESCE-preserve so a later event that legitimately omits text (e.g. a delivery/read
        // receipt) can't blank out a good body — text is never intentionally cleared to empty.
        text: sql`COALESCE(NULLIF(excluded.text, ''), ${messages.text})`,
        // Repair the sender on a later hydrated re-sync (a message first inserted via a
        // handle-less fetch had handle_id NULL → "?" avatar). COALESCE so a fetch that OMITS
        // the handle (excluded = NULL) can never wipe an already-resolved sender.
        handleId: sql`COALESCE(excluded.handle_id, ${messages.handleId})`,
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
        // A later hydrated re-sync can flip a stale 0 → 1; never downgrade 1 → 0 when a fetch
        // omits attachments (excluded = 0), so MAX with the already-stored value.
        hasAttachments: sql`MAX(excluded.has_attachments, ${messages.hasAttachments})`,
      },
    })
    .returning({ id: messages.id, guid: messages.guid });

  for (const r of rows) map.set(r.guid, r.id);

  // Link message SENDERS into chat_handles (additive) so a chat shows participant names even
  // when its participants were never synced via chat/query — e.g. a realtime-created group that
  // would otherwise render as "Group" / a raw chat-guid. Only received messages carry a sender
  // handle (sent/own messages have none). onConflictDoNothing keeps it idempotent and never
  // disturbs a canonical participant list that upsertChats may have set from a participants payload.
  const participantLinks = new Map<string, { chatId: number; handleId: number }>();
  for (const { m, chatId } of withChat) {
    const addr = m.handle?.address;
    const handleId = addr ? handleIdByAddress.get(addr) : undefined;
    if (handleId != null) participantLinks.set(`${chatId}:${handleId}`, { chatId, handleId });
  }
  if (participantLinks.size > 0) {
    await db
      .insert(chatHandles)
      .values([...participantLinks.values()])
      .onConflictDoNothing();
  }

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
  /**
   * An FTS5 snippet centered on the match, with the matched term(s) wrapped in U+0002…U+0003 so the
   * UI can highlight them. This is what to display — the raw `text` start may not contain the match
   * (the word can be deep in a long message), which looks like a wrong result.
   */
  snippet: string | null;
  dateCreated: number | null;
  isFromMe: number;
  chatGuid: string;
  // Enough chat fields to run `resolveTitle` so a hit's title matches the inbox (a group shows its
  // name/participants or "Group", never a raw chat-guid; a 1:1 shows the contact name).
  chatDisplayName: string | null;
  chatCustomName: string | null;
  chatIdentifier: string | null;
  chatStyle: number | null;
  chatParticipantNames: string | null;
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
  // `snippet()` needs the FTS table referenced by name (not an alias), so this query joins on
  // `messages_fts` directly. No mark args — it just centers the text on the match; the UI bolds the
  // query terms in JS (control-char marks don't reliably survive the native bridge).
  return db.all<SearchResultRow>(sql`
    SELECT m.id, m.guid, m.text, m.date_created AS dateCreated, m.is_from_me AS isFromMe,
           snippet(messages_fts, 0, '', '', '…', 12) AS snippet,
           c.guid AS chatGuid, c.display_name AS chatDisplayName, c.custom_name AS chatCustomName,
           c.chat_identifier AS chatIdentifier, c.style AS chatStyle,
           (SELECT group_concat(COALESCE(h2.display_name, h2.address), ', ' ORDER BY h2.id)
              FROM chat_handles ch JOIN handles h2 ON h2.id = ch.handle_id
             WHERE ch.chat_id = c.id) AS chatParticipantNames,
           COALESCE(h.display_name, h.address) AS senderName
    FROM messages_fts
    JOIN messages m ON m.id = messages_fts.rowid
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

// Shared SELECT (columns + sender join) for message-row reads. Kept in ONE place so the
// recent-window and anchored-window queries below can't drift apart. Nested into each query.
const MESSAGE_ROW_SELECT = sql`
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
  LEFT JOIN handles h ON h.id = m.handle_id`;

/** Run the shared message SELECT with extra WHERE conditions + an ORDER BY + LIMIT. */
function queryMessageRows(
  db: AppDatabase,
  chatId: number,
  where: SQL,
  order: SQL,
  limit: number,
): Promise<MessageRow[]> {
  return db.all<MessageRow>(sql`
    ${MESSAGE_ROW_SELECT}
    WHERE m.chat_id = ${chatId} ${where}
      AND m.associated_message_type IS NULL
    ${order}
    LIMIT ${limit}
  `);
}

/** Messages for a chat, newest-first (the inverted list wants index 0 = newest).
 *  `beforeDate` is a paginate-older cursor (strictly older than that date); `sinceDate` widens the
 *  load downward (>= that date). To open ON a search hit with context around it, use
 *  {@link listMessagesAround} instead. */
export async function listMessagesWithSenders(
  db: AppDatabase,
  chatId: number,
  limit = 100,
  beforeDate?: number,
  sinceDate?: number,
): Promise<MessageRow[]> {
  const cursor = beforeDate != null ? sql`AND m.date_created < ${beforeDate}` : sql``;
  const floor = sinceDate != null ? sql`AND m.date_created >= ${sinceDate}` : sql``;
  return queryMessageRows(
    db,
    chatId,
    sql`${cursor} ${floor}`,
    sql`ORDER BY m.date_created DESC, m.id DESC`,
    limit,
  );
}

/**
 * Messages in a WINDOW centered on `anchorDate` (a search/jump target's date_created): up to
 * `before` messages older-or-equal (including the target itself) AND up to `after` messages newer,
 * so the thread shows context on BOTH sides of the hit. Returns newest-first (the list contract),
 * with the target roughly in the middle. This is the fix for "jump to a search hit shows nothing
 * around it" — the old path loaded the target and everything NEWER only, so a hit near the tail
 * (e.g. a recent RCS code) opened to just the one message.
 */
export async function listMessagesAround(
  db: AppDatabase,
  chatId: number,
  anchorDate: number,
  before = 150,
  after = 150,
): Promise<MessageRow[]> {
  const older = await queryMessageRows(
    db,
    chatId,
    sql`AND m.date_created <= ${anchorDate}`,
    sql`ORDER BY m.date_created DESC, m.id DESC`,
    before + 1, // +1 so the anchor row itself is included alongside `before` older ones
  );
  const newer = await queryMessageRows(
    db,
    chatId,
    sql`AND m.date_created > ${anchorDate}`,
    sql`ORDER BY m.date_created ASC, m.id ASC`,
    after,
  );
  // Newest-first: the newer set (ASC) reversed to DESC, then the older set (already DESC, with
  // the anchor first). The two sides are disjoint (<= vs >), so no row appears twice.
  return [...newer.reverse(), ...older];
}

/**
 * Distinct chat GUIDs that have at least one message matching the FTS query. Powers the inbox
 * top-bar so it filters chats by message CONTENT (incl. decoded edited/SMS text), keeping it
 * consistent with the dedicated search page instead of matching only chat names + the latest preview.
 */
export async function searchChatGuidsByMessage(
  db: AppDatabase,
  queryText: string,
  limit = 300,
): Promise<string[]> {
  const match = toFtsQuery(queryText);
  if (!match) return [];
  const rows = await db.all<{ guid: string }>(sql`
    SELECT DISTINCT c.guid AS guid
    FROM messages_fts f
    JOIN messages m ON m.id = f.rowid
    JOIN chats c ON c.id = m.chat_id
    WHERE messages_fts MATCH ${match}
      AND m.associated_message_type IS NULL
    LIMIT ${limit}
  `);
  return rows.map((r: { guid: string }) => r.guid);
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
