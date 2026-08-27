import { eq, sql, type SQL } from 'drizzle-orm';
import { REACTION_BASE_TYPES, STICKER_ASSOCIATED_TYPE } from '@core/reactions/reactionType';
import { messages } from '../schema';
import type { AppDatabase } from '../types';
import { toFtsQuery } from './_shared';
// The ONE definition of "this chat is not under a local deletion tombstone" — search is a reader
// of it like the inbox is. Import the owning rule rather than restating it; chats.ts does not import
// message queries, so this dependency stays acyclic.
import { chatVisible } from './chatVisibility';

/** Read-only message queries kept separate from mutation and transaction ownership. */

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
    // The FTS index still holds a tombstoned message's text (setting date_deleted only re-indexes
    // the unchanged text), so a deleted message must be excluded at QUERY time — it VANISHES.
    sql`SELECT m.* FROM messages_fts f JOIN messages m ON m.id = f.rowid WHERE messages_fts MATCH ${match} AND m.date_deleted IS NULL ORDER BY rank LIMIT ${limit}`,
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
 *
 * Hits in a locally-deleted conversation are excluded (`chatVisible`) — the search page renders
 * these rows DIRECTLY, so without it a message from a deleted thread was listed under that thread's
 * name and tapping it opened the hidden conversation, whose `ensureChatSynced` then re-paged up to
 * 500 of its messages back into the DB. The individual message rows are gone at delete time, but
 * the next `syncAllChats` re-inserts each chat's `lastMessage` — straight back into the FTS index.
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
      AND m.date_deleted IS NULL
      AND ${chatVisible('c')}
    ORDER BY m.date_created DESC
    LIMIT ${limit}
  `);
}

/**
 * All messages of a reply thread: the originator plus every reply targeting it, chronological.
 * Powers the "View Thread" popup (the bubble's reply quote shows only the immediate parent).
 */
export async function listThreadMessages(
  db: AppDatabase,
  originatorGuid: string,
): Promise<MessageRow[]> {
  return db.all<MessageRow>(sql`
    ${MESSAGE_ROW_SELECT}
    WHERE (m.guid = ${originatorGuid} OR m.thread_originator_guid = ${originatorGuid})
      AND m.associated_message_type IS NULL
      AND m.date_deleted IS NULL
    ORDER BY m.date_created ASC, m.id ASC
  `);
}

/**
 * The OLDEST unread received message in a chat + how many are unread — for the "jump to oldest
 * unread" chip. Unread = received (not mine) and newer than the last-read marker's message; a
 * never-read chat counts every received message. Reactions and retracted rows are excluded.
 * Call BEFORE markRead (which moves the marker to the newest message).
 */
export async function getFirstUnreadInChat(
  db: AppDatabase,
  chatId: number,
): Promise<{ guid: string; dateCreated: number; count: number } | null> {
  const marker = await db.all<{ lastReadMessageGuid: string | null; deletedAt: number | null }>(
    sql`SELECT last_read_message_guid AS lastReadMessageGuid, deleted_at AS deletedAt
        FROM chats WHERE id = ${chatId} LIMIT 1`,
  );
  const lastReadGuid = marker[0]?.lastReadMessageGuid ?? null;
  let readDate = 0;
  if (lastReadGuid) {
    const r = await db.all<{ d: number | null }>(
      sql`SELECT date_created AS d FROM messages WHERE guid = ${lastReadGuid} LIMIT 1`,
    );
    readDate = r[0]?.d ?? 0;
  }
  // Floor the scan at a tombstone: a deleted chat that came back (a message newer than the deletion
  // arrived) must count only that NEW activity as unread. Without this the inbox badge says 1 while
  // the in-chat "jump to N unread" chip offers to scroll back through the whole restored history —
  // the same floor `chatVisible`/the inbox unread count already apply.
  readDate = Math.max(readDate, marker[0]?.deletedAt ?? 0);
  const rows = await db.all<{ guid: string; dateCreated: number; count: number }>(sql`
    SELECT guid, date_created AS dateCreated,
      (SELECT COUNT(*) FROM messages mm
        WHERE mm.chat_id = ${chatId} AND mm.is_from_me = 0 AND mm.date_created > ${readDate}
          AND mm.associated_message_type IS NULL AND mm.date_retracted IS NULL
          AND mm.date_deleted IS NULL) AS count
    FROM messages
    WHERE chat_id = ${chatId} AND is_from_me = 0 AND date_created > ${readDate}
      AND associated_message_type IS NULL AND date_retracted IS NULL
      AND date_deleted IS NULL
    ORDER BY date_created ASC, id ASC LIMIT 1
  `);
  return rows[0] ?? null;
}

/** Newest received (inbound) message guid in a chat — the correct mark-read target. */
export async function getNewestReceivedGuid(
  db: AppDatabase,
  chatId: number,
): Promise<string | null> {
  const rows = await db.all<{ guid: string }>(sql`
    SELECT guid FROM messages
    WHERE chat_id = ${chatId} AND is_from_me = 0 AND date_deleted IS NULL
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
  // Apple "Send Later" flag (1 for a scheduled row — pending OR sent; NULL/absent otherwise).
  // Optional so hand-built test literals need not set it; the SELECT above always provides it.
  isScheduled?: number | null;
  // Apple is_sent (1 = sent, 0 = not yet, NULL/undefined = unknown on a pre-migration row). Gates the
  // "Scheduled" badge with isScheduled. Optional so hand-built test literals need not set it; the
  // SELECT above always provides it at runtime.
  isSent?: number | null;
  // Apple edit history / unsent parts as the RAW JSON TEXT blob (or null). Kept as a string here —
  // like `attributedBody` — and parsed lazily by the consumer via parseMessageSummaryInfo (only the
  // long-press "View Edit History" path needs the structured form). Optional so hand-built test
  // literals need not set it; the SELECT below always provides it at runtime.
  messageSummaryInfo?: string | null;
  // Apple rich-link preview metadata as the RAW JSON TEXT blob (or null) — like
  // messageSummaryInfo, parsed lazily by the consumer via parsePayloadData (only MessageBubble's
  // preview card needs the structured form). Optional so hand-built test literals need not set
  // it; the SELECT below always provides it at runtime.
  payloadData?: string | null;
  error: number;
  /** Already-bounded/redacted server detail for the failed-message sheet. */
  errorMessage?: string | null;
  sendState: string;
  wasDeliveredQuietly: number;
  didNotifyRecipient: number;
  associatedMessageGuid: string | null;
  associatedMessageType: string | null;
  associatedMessageEmoji: string | null;
  threadOriginatorGuid: string | null;
  expressiveSendStyleId: string | null;
  senderAddress: string | null;
  senderName: string | null;
  senderAvatar: string | null;
  /** Last known valid server-supplied handle color. */
  senderColor?: string | null;
  senderService: string | null;
  // Group/chat-event fields (utils/groupEvent.ts). Optional so hand-built test literals need not
  // set them; the SELECT below always provides them at runtime. `otherHandleName` is resolved from
  // `other_handle` (a server ROWID) to the affected participant's display name.
  itemType?: number | null;
  groupActionType?: number | null;
  groupTitle?: string | null;
  otherHandle?: number | null;
  otherHandleName?: string | null;
  // Genmoji (macOS 15.1+) natural-language description of this message's first Genmoji attachment,
  // or null. Used as the thread-row fallback text in place of the generic "📎 Attachment". Optional
  // so hand-built test literals need not set it; the SELECT below always provides it at runtime.
  attachmentDescription?: string | null;
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
    m.is_scheduled AS isScheduled,
    m.is_sent AS isSent,
    m.message_summary_info AS messageSummaryInfo,
    m.payload_data AS payloadData,
    m.has_attachments AS hasAttachments, m.error, m.error_message AS errorMessage,
    m.send_state AS sendState,
    m.was_delivered_quietly AS wasDeliveredQuietly,
    m.did_notify_recipient AS didNotifyRecipient,
    m.associated_message_guid AS associatedMessageGuid,
    m.associated_message_type AS associatedMessageType,
    m.associated_message_emoji AS associatedMessageEmoji,
    m.thread_originator_guid AS threadOriginatorGuid,
    m.expressive_send_style_id AS expressiveSendStyleId,
    m.item_type AS itemType,
    m.group_action_type AS groupActionType,
    m.group_title AS groupTitle,
    m.other_handle AS otherHandle,
    (SELECT COALESCE(h2.display_name, h2.address) FROM handles h2
       WHERE h2.original_row_id = m.other_handle LIMIT 1) AS otherHandleName,
    (SELECT a.emoji_image_short_description FROM attachments a
       WHERE a.message_id = m.id AND a.emoji_image_short_description IS NOT NULL
       ORDER BY a.id ASC LIMIT 1) AS attachmentDescription,
    h.address AS senderAddress,
    COALESCE(h.display_name, h.address) AS senderName,
    h.avatar AS senderAvatar,
    h.color AS senderColor,
    NULLIF(h.service, '') AS senderService
  FROM messages m
  LEFT JOIN handles h ON h.id = m.handle_id`;

/**
 * Associated-message types the UI draws as an OVERLAY on the target bubble, so they must not also
 * appear as messages of their own. Derived from the core constants (both directions) so this can
 * never drift from `isOverlayAssociatedType`.
 */
const OVERLAY_ASSOCIATED_TYPES: string[] = [
  ...REACTION_BASE_TYPES,
  'emoji',
  STICKER_ASSOCIATED_TYPE,
].flatMap((t) => [t, `-${t}`]);

/**
 * Exclude only the types we render as an overlay — NOT every associated message.
 *
 * The old blanket `associated_message_type IS NULL` was doing two jobs with one test: it correctly
 * hid reactions, and it silently swallowed STICKERS, which is why a received sticker rendered
 * nowhere at all. It would also swallow any future associated type, including the raw numeric Apple
 * codes the server emits for anything its own map doesn't recognise. Anything not in this list now
 * falls through and renders as an ordinary message — the safe direction to fail.
 */
const notAnOverlayMessage = (): SQL => {
  const list = sql.join(
    OVERLAY_ASSOCIATED_TYPES.map((t) => sql`${t}`),
    sql`, `,
  );
  return sql`(m.associated_message_type IS NULL OR m.associated_message_type NOT IN (${list}))`;
};

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
      AND ${notAnOverlayMessage()}
      AND m.date_deleted IS NULL
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
 *
 * Locally-deleted chats are excluded here too. The caller intersects this with the (already
 * filtered) chat list, so today it changes nothing — but a guid list that includes hidden chats is
 * a trap for the next caller that trusts it, and the rule is one line.
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
      AND m.date_deleted IS NULL
      AND ${chatVisible('c')}
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
  // Genmoji description of the message's first Genmoji attachment (or null) — the reply-quote /
  // reply-composer fallback text in place of the generic "📎 Attachment". Optional so hand-built
  // test literals need not set it; the SELECT below always provides it at runtime.
  attachmentDescription?: string | null;
}

/** A compact preview of a message by guid (for the reply quote). */
export async function getMessagePreviewByGuid(
  db: AppDatabase,
  guid: string,
): Promise<MessagePreview | null> {
  const rows = await db.all<MessagePreview>(sql`
    SELECT m.guid, m.text, m.is_from_me AS isFromMe, m.has_attachments AS hasAttachments,
           COALESCE(h.display_name, h.address) AS senderName,
           (SELECT a.emoji_image_short_description FROM attachments a
              WHERE a.message_id = m.id AND a.emoji_image_short_description IS NOT NULL
              ORDER BY a.id ASC LIMIT 1) AS attachmentDescription
    FROM messages m LEFT JOIN handles h ON h.id = m.handle_id
    WHERE m.guid = ${guid} AND m.date_deleted IS NULL LIMIT 1
  `);
  return rows[0] ?? null;
}

/**
 * The message's dateCreated (epoch ms) by guid, or null when the message is absent or has no
 * date. Used to center the chat on a reminded message when its notification is tapped (the
 * `?focusDate` deep-link loads a window around the message so scroll-to-message works even for
 * an old message not in the recent window).
 */
export async function getMessageDateByGuid(db: AppDatabase, guid: string): Promise<number | null> {
  const rows = await db.all<{ dateCreated: number | null }>(
    sql`SELECT date_created AS dateCreated FROM messages WHERE guid = ${guid} LIMIT 1`,
  );
  return rows[0]?.dateCreated ?? null;
}

/** Read a message's current text + edit marker. */
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

/**
 * Re-check whether one stored message is still unread and present before (re)presenting its
 * notification. Durable delivery may replay presentation minutes after the DB phase committed;
 * in that gap the user can read/delete the message or the sender can retract it.
 *
 * Keep this predicate byte-for-byte aligned with the inbox unread filters in
 * `listChatsForInbox`: received, ordinary, non-retracted/non-deleted content newer than both the
 * read marker and a local chat-deletion floor.
 */
export async function isMessageNotificationEligible(
  db: AppDatabase,
  messageGuid: string,
): Promise<boolean> {
  const rows = await db.all<{ eligible: number }>(sql`
    SELECT EXISTS(
      SELECT 1
        FROM messages m JOIN chats c ON c.id = m.chat_id
       WHERE m.guid = ${messageGuid}
         AND m.is_from_me = 0
         AND m.associated_message_type IS NULL
         AND m.date_retracted IS NULL
         AND m.date_deleted IS NULL
         AND m.date_created > COALESCE(
           (SELECT lm.date_created FROM messages lm WHERE lm.guid = c.last_read_message_guid), 0)
         AND (c.deleted_at IS NULL OR m.date_created > c.deleted_at)
    ) AS eligible`);
  return rows[0]?.eligible === 1;
}
