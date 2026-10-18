import { sql, type SQL } from 'drizzle-orm';
import {
  isAggregateRetractionTombstone,
  isExactMessagePartTopology,
} from '@core/messages/retraction';
import { parseMessagePartTopology } from '@core/models';
import { REACTION_BASE_TYPES, STICKER_ASSOCIATED_TYPE } from '@core/reactions/reactionType';
import type { AppDatabase } from '../types';
import { toFtsQuery } from './_shared';
// The ONE definition of "this chat is not under a local deletion tombstone" — search is a reader
// of it like the inbox is. Import the owning rule rather than restating it; chats.ts does not import
// message queries, so this dependency stays acyclic.
import {
  attachmentIsUserFileSql,
  chatUnreadMessagePredicateSql,
  chatVisible,
  messageHasVisibleContentSql,
} from './chatVisibility';

export const CHAT_SEARCH_PAGE_SIZE = 50;

export interface ChatSearchCursor {
  dateCreated: number | null;
  id: number;
  /** Highest matching local row id observed by the initial page. */
  maxMessageId: number;
}

export interface ChatSearchResultRow {
  id: number;
  guid: string;
  /** Epoch milliseconds, or null when the server supplied no timestamp. */
  dateCreated: number | null;
  text: string | null;
  /** A short, match-centered excerpt for display in the in-chat result list. */
  snippet: string | null;
  isFromMe: number;
  senderName: string | null;
  senderAddress: string | null;
}

export interface ChatSearchPage {
  results: ChatSearchResultRow[];
  nextCursor: ChatSearchCursor | null;
  hasMore: boolean;
  /** Present on the initial page; later pages avoid repeating the full count. */
  totalCount: number | null;
}

interface ChatSearchQueryRow extends ChatSearchResultRow {
  totalCount: number | null;
  maxMessageId: number | null;
}

/**
 * Search one chat's complete local FTS history in fixed-size, newest-first pages.
 *
 * The `(dateCreated, id)` keyset cursor gives equal-timestamp messages a deterministic order. Its
 * initial max-id snapshot prevents newly inserted rows from shifting later pages. Null dates live
 * in an explicit final bucket instead of being conflated with a real timestamp.
 */
export async function searchMessagesInChat(
  db: AppDatabase,
  chatGuid: string,
  queryText: string,
  cursor: ChatSearchCursor | null = null,
): Promise<ChatSearchPage> {
  const match = toFtsQuery(queryText);
  if (!match || !chatGuid) {
    return { results: [], nextCursor: null, hasMore: false, totalCount: cursor ? null : 0 };
  }

  const eligible = sql`
    messages_fts MATCH ${match}
    AND c.guid = ${chatGuid}
    AND ${notAnOverlayMessage()}
    AND ${messageHasVisibleContentSql('m')}
    AND m.date_deleted IS NULL
    AND ${chatVisible('c')}
  `;
  const cursorPredicate = !cursor
    ? sql``
    : cursor.dateCreated == null
      ? sql`AND m.date_created IS NULL AND m.id < ${cursor.id}`
      : sql`AND (
          m.date_created IS NULL
          OR m.date_created < ${cursor.dateCreated}
          OR (m.date_created = ${cursor.dateCreated} AND m.id < ${cursor.id})
        )`;
  // FTS5 auxiliary functions such as snippet() cannot share a SELECT context with window
  // functions. Compute the initial count/fence in a CTE so this remains one coherent read statement
  // without putting COUNT/MAX windows beside the outer snippet(). Later pages reuse the fence.
  const metadata = cursor
    ? sql`SELECT ${cursor.maxMessageId} AS maxMessageId, NULL AS totalCount`
    : sql`
        SELECT MAX(m.id) AS maxMessageId, COUNT(*) AS totalCount
        FROM messages_fts
        JOIN messages m ON m.id = messages_fts.rowid
        JOIN chats c ON c.id = m.chat_id
        WHERE ${eligible}
      `;

  const rows = await db.all<ChatSearchQueryRow>(sql`
    WITH search_metadata AS (${metadata})
    SELECT m.id, m.guid, m.date_created AS dateCreated,
           m.text, snippet(messages_fts, 0, '', '', '…', 12) AS snippet,
           m.is_from_me AS isFromMe,
           COALESCE(h.display_name, h.address) AS senderName,
           h.address AS senderAddress,
           search_metadata.maxMessageId, search_metadata.totalCount
    FROM messages_fts
    JOIN messages m ON m.id = messages_fts.rowid
    JOIN chats c ON c.id = m.chat_id
    LEFT JOIN handles h ON h.id = m.handle_id
    CROSS JOIN search_metadata
    WHERE ${eligible}
      AND m.id <= search_metadata.maxMessageId
      ${cursorPredicate}
    ORDER BY (m.date_created IS NULL) ASC, m.date_created DESC, m.id DESC
    LIMIT ${CHAT_SEARCH_PAGE_SIZE + 1}
  `);

  const hasMore = rows.length > CHAT_SEARCH_PAGE_SIZE;
  const pageRows = hasMore ? rows.slice(0, CHAT_SEARCH_PAGE_SIZE) : rows;
  const results: ChatSearchResultRow[] = pageRows.map((row: ChatSearchQueryRow) => {
    const { totalCount: _totalCount, maxMessageId: _maxMessageId, ...result } = row;
    return result;
  });
  const last = results.at(-1);
  const maxMessageId = cursor?.maxMessageId ?? Number(rows[0]?.maxMessageId ?? 0);

  return {
    results,
    hasMore,
    nextCursor:
      hasMore && last ? { dateCreated: last.dateCreated, id: last.id, maxMessageId } : null,
    totalCount: cursor ? null : Number(rows[0]?.totalCount ?? 0),
  };
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

export const SEARCH_RESULT_SNIPPET_MAX_CODE_POINTS = 240;

interface SearchResultQueryRow extends SearchResultRow {
  text: string | null;
}

export const SEARCH_LITERAL_SCAN_CHUNK_CODE_UNITS = 64 * 1024;
const SEARCH_LITERAL_MAX_QUERY_CODE_UNITS = 256;

function foldAsciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function foldAsciiUpper(value: string): string {
  return value.replace(/[a-z]/g, (character) => character.toUpperCase());
}

/** SQLite's default LIKE comparison is case-insensitive for ASCII and exact for other code units. */
export function findSqliteLikeLiteral(
  text: string,
  rawQuery: string,
): { index: number; length: number } | null {
  if (!rawQuery || rawQuery.length > SEARCH_LITERAL_MAX_QUERY_CODE_UNITS) return null;
  const query = rawQuery.normalize('NFC').trim();
  // Both app and server reject a raw query above 256 UTF-16 code units before normalization. Keep
  // that contract here too so the overlap, folded query and every temporary allocation stay fixed.
  if (!query || query.length > SEARCH_LITERAL_MAX_QUERY_CODE_UNITS || query.length > text.length) {
    return null;
  }

  const exactIndex = text.indexOf(query);
  if (exactIndex >= 0) return { index: exactIndex, length: query.length };

  const lowerQuery = foldAsciiLower(query);
  if (lowerQuery !== query) {
    const lowerIndex = text.indexOf(lowerQuery);
    if (lowerIndex >= 0) return { index: lowerIndex, length: query.length };
  }
  const upperQuery = foldAsciiUpper(query);
  if (upperQuery !== query) {
    const upperIndex = text.indexOf(upperQuery);
    if (upperIndex >= 0) return { index: upperIndex, length: query.length };
  }
  // With no ASCII letters, SQLite has no case variant to recover; the exact search was complete.
  if (lowerQuery === upperQuery) return null;

  // A body can use mixed ASCII casing that none of the three native searches above represents.
  // Fold one fixed-size window at a time. The query-length overlap catches a literal spanning two
  // windows, ASCII folding preserves UTF-16 length, and `chunkStart` advances by the full chunk on
  // every iteration, giving linear work with bounded temporary memory.
  const foldedQuery = lowerQuery;
  const overlap = query.length - 1;
  for (
    let chunkStart = 0;
    chunkStart < text.length;
    chunkStart += SEARCH_LITERAL_SCAN_CHUNK_CODE_UNITS
  ) {
    const windowStart = Math.max(0, chunkStart - overlap);
    const windowEnd = Math.min(text.length, chunkStart + SEARCH_LITERAL_SCAN_CHUNK_CODE_UNITS);
    const foldedWindow = foldAsciiLower(text.slice(windowStart, windowEnd));
    const localIndex = foldedWindow.indexOf(foldedQuery);
    if (localIndex >= 0) return { index: windowStart + localIndex, length: query.length };
  }
  return null;
}

/**
 * Hard-limit a search-result excerpt while keeping the server's literal substring match visible.
 * Only a small local slice is converted to Unicode code points, so slicing cannot split an emoji
 * surrogate pair and a near-16 MiB body never becomes a whole-message character array. If a stale
 * body no longer contains the server query, the deterministic fallback is its leading excerpt.
 */
export function boundSearchResultSnippet(text: string | null, queryText: string): string | null {
  if (text == null) return null;
  const localRadius = SEARCH_RESULT_SNIPPET_MAX_CODE_POINTS * 2;
  const match = findSqliteLikeLiteral(text, queryText);
  const matchIndex = match?.index ?? 0;
  const matchLength = match?.length ?? 0;
  let localStart = Math.max(0, matchIndex - localRadius);
  let localEnd = Math.min(text.length, matchIndex + matchLength + localRadius);

  // Move a UTF-16 boundary outward by one code unit when it would bisect a surrogate pair.
  if (
    localStart > 0 &&
    text.charCodeAt(localStart) >= 0xdc00 &&
    text.charCodeAt(localStart) <= 0xdfff
  ) {
    localStart--;
  }
  if (
    localEnd < text.length &&
    text.charCodeAt(localEnd - 1) >= 0xd800 &&
    text.charCodeAt(localEnd - 1) <= 0xdbff
  ) {
    localEnd++;
  }

  const localCodePoints = Array.from(text.slice(localStart, localEnd));
  if (
    localStart === 0 &&
    localEnd === text.length &&
    localCodePoints.length <= SEARCH_RESULT_SNIPPET_MAX_CODE_POINTS
  ) {
    return text;
  }

  const matchStart = Array.from(text.slice(localStart, matchIndex)).length;
  const matchCodePointLength = Array.from(text.slice(matchIndex, matchIndex + matchLength)).length;

  const contextBudget = Math.max(
    0,
    SEARCH_RESULT_SNIPPET_MAX_CODE_POINTS -
      Math.min(matchCodePointLength, SEARCH_RESULT_SNIPPET_MAX_CODE_POINTS),
  );
  const idealStart = matchStart - Math.floor(contextBudget / 2);
  const maxStart = Math.max(0, localCodePoints.length - SEARCH_RESULT_SNIPPET_MAX_CODE_POINTS);
  const start = Math.max(0, Math.min(idealStart, maxStart));
  const end = start + SEARCH_RESULT_SNIPPET_MAX_CODE_POINTS;
  const snippet = localCodePoints.slice(start, end);
  if (localStart > 0 || start > 0) snippet[0] = '…';
  if (localEnd < text.length || end < localCodePoints.length) snippet[snippet.length - 1] = '…';
  return snippet.join('');
}

function toPresentationSearchResults(
  rows: SearchResultQueryRow[],
  queryText: string,
): SearchResultRow[] {
  return rows.map((row) => ({
    ...row,
    // Never pass the full body to React. Navigation re-reads the authoritative full text by GUID.
    text: null,
    snippet: boundSearchResultSnippet(row.snippet ?? row.text, queryText),
  }));
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
  const rows = await db.all<SearchResultQueryRow>(sql`
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
      AND ${notAnOverlayMessage()}
      AND ${messageHasVisibleContentSql('m')}
      AND m.date_deleted IS NULL
      AND ${chatVisible('c')}
    ORDER BY m.date_created DESC, m.guid ASC
    LIMIT ${limit}
  `);
  return toPresentationSearchResults(rows, queryText);
}

/**
 * Read a bounded set of already-adopted server hits through the same visibility rules and enriched
 * projection as local FTS search. GUID is the local/server identity; callers merge these rows with
 * local hits only after this read proves the message and owning chat committed successfully.
 */
export async function searchMessagesEnrichedByGuids(
  db: AppDatabase,
  guids: readonly string[],
  queryText = '',
): Promise<SearchResultRow[]> {
  const boundedGuids = [...new Set(guids.filter((guid) => guid.length > 0))].slice(0, 50);
  if (boundedGuids.length === 0) return [];
  const guidList = sql.join(
    boundedGuids.map((guid) => sql`${guid}`),
    sql`, `,
  );

  const rows = await db.all<SearchResultQueryRow>(sql`
    SELECT m.id, m.guid, m.text, m.date_created AS dateCreated, m.is_from_me AS isFromMe,
           m.text AS snippet,
           c.guid AS chatGuid, c.display_name AS chatDisplayName, c.custom_name AS chatCustomName,
           c.chat_identifier AS chatIdentifier, c.style AS chatStyle,
           (SELECT group_concat(COALESCE(h2.display_name, h2.address), ', ' ORDER BY h2.id)
              FROM chat_handles ch JOIN handles h2 ON h2.id = ch.handle_id
             WHERE ch.chat_id = c.id) AS chatParticipantNames,
           COALESCE(h.display_name, h.address) AS senderName
    FROM messages m
    JOIN chats c ON c.id = m.chat_id
    LEFT JOIN handles h ON h.id = m.handle_id
    WHERE m.guid IN (${guidList})
      AND ${notAnOverlayMessage()}
      AND ${messageHasVisibleContentSql('m')}
      AND m.date_deleted IS NULL
      AND ${chatVisible('c')}
    ORDER BY m.date_created DESC, m.guid ASC
  `);
  return toPresentationSearchResults(rows, queryText);
}

/**
 * All messages of a reply thread: the originator plus every reply targeting it, chronological.
 * Powers the "View Thread" popup (the bubble's reply quote shows only the immediate parent).
 */
export async function listThreadMessages(
  db: AppDatabase,
  chatGuid: string,
  originatorGuid: string,
): Promise<MessageRow[]> {
  return db.all<MessageRow>(sql`
    ${MESSAGE_ROW_SELECT}
    WHERE m.chat_id = (SELECT id FROM chats WHERE guid = ${chatGuid} LIMIT 1)
      AND EXISTS (
        SELECT 1 FROM messages originator
         WHERE originator.guid = ${originatorGuid}
           AND originator.chat_id = m.chat_id
           AND originator.associated_message_type IS NULL
           AND originator.date_deleted IS NULL
      )
      AND (m.guid = ${originatorGuid} OR m.thread_originator_guid = ${originatorGuid})
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
          AND mm.associated_message_type IS NULL AND ${messageHasVisibleContentSql('mm')}
          AND mm.date_deleted IS NULL) AS count
    FROM messages
    WHERE chat_id = ${chatId} AND is_from_me = 0 AND date_created > ${readDate}
      AND associated_message_type IS NULL AND ${messageHasVisibleContentSql('messages')}
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
/**
 * kv key prefix for this device's own unsend whose result is unknown (device-local, never backed
 * up). Its value holds what a later restore needs; it counts only while the message's own unsend
 * fence (pending_retraction_part_index) is still set, which the server's echo clears.
 */
export const UNSEND_UNCONFIRMED_KV_PREFIX = 'unsend.unconfirmed.';

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
  /** 1 while this device's own unsend has an unknown result (see UNSEND_UNCONFIRMED_KV_PREFIX). */
  unsendUnconfirmed?: number;
  /** Durable shared aggregate classification; null on migrated legacy/intact rows. */
  retractionState?: string | null;
  /** Raw bounded topology JSON, parsed only by part-aware consumers. */
  messagePartTopology?: string | null;
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
  /** Apple Messages extension identifier, used only to select a safe local fallback label. */
  balloonBundleId?: string | null;
  /** Server aggregate part count, used only by the strict action-target resolver. */
  partCount?: number | null;
  /** 1 when at least one non-hidden attachment can actually render in the message UI. */
  hasVisibleAttachments?: number;
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
  /** Exact reply target part when the server supplied it. */
  threadOriginatorPart?: number | null;
  expressiveSendStyleId: string | null;
  senderAddress: string | null;
  senderName: string | null;
  senderAvatar: string | null;
  /** Device-owned color for the exact sender handle identity. */
  senderColor?: string | null;
  senderService: string | null;
  /** 1 when the sender's handle matched a saved contact (the same rule as known-sender chats). */
  senderKnown?: number | null;
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
    m.retraction_state AS retractionState,
    CASE WHEN m.pending_retraction_part_index IS NULL OR m.is_from_me = 0 THEN 0
         ELSE EXISTS(SELECT 1 FROM kv WHERE kv.key = ${UNSEND_UNCONFIRMED_KV_PREFIX} || m.guid)
    END AS unsendUnconfirmed,
    m.message_part_topology AS messagePartTopology,
    m.is_scheduled AS isScheduled,
    m.is_sent AS isSent,
    m.message_summary_info AS messageSummaryInfo,
    m.payload_data AS payloadData,
    m.balloon_bundle_id AS balloonBundleId,
    m.part_count AS partCount,
    m.has_attachments AS hasAttachments, m.error, m.error_message AS errorMessage,
    m.send_state AS sendState,
    m.was_delivered_quietly AS wasDeliveredQuietly,
    m.did_notify_recipient AS didNotifyRecipient,
    m.associated_message_guid AS associatedMessageGuid,
    m.associated_message_type AS associatedMessageType,
    m.associated_message_emoji AS associatedMessageEmoji,
    m.thread_originator_guid AS threadOriginatorGuid,
    m.thread_originator_part AS threadOriginatorPart,
    m.expressive_send_style_id AS expressiveSendStyleId,
    m.item_type AS itemType,
    m.group_action_type AS groupActionType,
    m.group_title AS groupTitle,
    m.other_handle AS otherHandle,
    (SELECT COALESCE(h2.display_name, h2.address) FROM handles h2
       WHERE h2.original_row_id = m.other_handle LIMIT 1) AS otherHandleName,
    (SELECT a.emoji_image_short_description FROM attachments a
       WHERE a.message_id = m.id
         AND ${attachmentIsUserFileSql('a', 'm')}
         AND a.hide_attachment = 0
         AND a.is_retracted = 0
         AND a.emoji_image_short_description IS NOT NULL
       ORDER BY a.id ASC LIMIT 1) AS attachmentDescription,
    EXISTS(SELECT 1 FROM attachments a
             WHERE a.message_id = m.id AND a.hide_attachment = 0 AND a.is_retracted = 0
               AND ${attachmentIsUserFileSql('a', 'm')}) AS hasVisibleAttachments,
    h.address AS senderAddress,
    COALESCE(h.display_name, h.address) AS senderName,
    h.avatar AS senderAvatar,
    h.color AS senderColor,
    NULLIF(h.service, '') AS senderService,
    CASE WHEN h.contact_id IS NOT NULL OR h.contact_ambiguous = 1 THEN 1 ELSE 0 END AS senderKnown
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
export const notAnOverlayMessage = (): SQL => {
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

export interface MessageWindowAnchor {
  guid: string;
  /** Local row id is available for in-chat hits; global deep links resolve by guid alone. */
  id?: number;
}

interface ResolvedMessageWindowAnchor {
  id: number;
  dateCreated: number | null;
}

/**
 * Messages in a WINDOW centered on one exact message: up to `before` older messages (plus the
 * target) and up to `after` newer messages. The stable `(date_created, id)` comparisons guarantee
 * the target is included even when its date is null or more than a full window shares its timestamp.
 */
export async function listMessagesAround(
  db: AppDatabase,
  chatId: number,
  anchor: MessageWindowAnchor,
  before = 150,
  after = 150,
): Promise<MessageRow[]> {
  const identityPredicate =
    anchor.id != null ? sql`m.id = ${anchor.id}` : sql`m.guid = ${anchor.guid}`;
  const anchors = await db.all<ResolvedMessageWindowAnchor>(sql`
    SELECT m.id, m.date_created AS dateCreated
    FROM messages m
    WHERE m.chat_id = ${chatId}
      AND ${identityPredicate}
      AND ${notAnOverlayMessage()}
      AND m.date_deleted IS NULL
    ORDER BY m.id DESC
    LIMIT 1
  `);
  const target = anchors[0];
  if (!target) return [];

  const olderPredicate =
    target.dateCreated == null
      ? sql`AND m.date_created IS NULL AND m.id <= ${target.id}`
      : sql`AND (
          m.date_created IS NULL
          OR m.date_created < ${target.dateCreated}
          OR (m.date_created = ${target.dateCreated} AND m.id <= ${target.id})
        )`;
  const newerPredicate =
    target.dateCreated == null
      ? sql`AND (
          m.date_created IS NOT NULL
          OR (m.date_created IS NULL AND m.id > ${target.id})
        )`
      : sql`AND m.date_created IS NOT NULL AND (
          m.date_created > ${target.dateCreated}
          OR (m.date_created = ${target.dateCreated} AND m.id > ${target.id})
        )`;

  const older = await queryMessageRows(
    db,
    chatId,
    olderPredicate,
    sql`ORDER BY (m.date_created IS NULL) ASC, m.date_created DESC, m.id DESC`,
    before + 1, // +1 so the anchor row itself is included alongside `before` older ones
  );
  const newer = await queryMessageRows(
    db,
    chatId,
    newerPredicate,
    sql`ORDER BY (m.date_created IS NULL) DESC, m.date_created ASC, m.id ASC`,
    after,
  );
  // Newest-first: the newer set is read closest-first then reversed; older already starts at target.
  return [...newer.reverse(), ...older];
}

/**
 * The conditions a full-text hit must meet to count as a chat match: a visible, non-deleted, non-
 * overlay message in a visible chat. The inbox search and the folder search batches share this one
 * rule, so their scopes cannot drift apart. Aliases are `m` (messages) and `c` (chats).
 */
function visibleMessageMatchSql(): SQL {
  return sql`${notAnOverlayMessage()}
      AND ${messageHasVisibleContentSql('m')}
      AND m.date_deleted IS NULL
      AND ${chatVisible('c')}`;
}

/**
 * Distinct chat GUIDs that have at least one message matching the FTS query. Powers the inbox
 * top-bar so it filters chats by message CONTENT (incl. decoded edited/SMS text), keeping it
 * consistent with the dedicated search page instead of matching only chat names + the latest preview.
 * Locally-deleted chats are excluded here too.
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
      AND ${visibleMessageMatchSql()}
    LIMIT ${limit}
  `);
  return rows.map((r: { guid: string }) => r.guid);
}

/** How many full-text matches one folder-search batch reads (review M060). */
export const CUSTOM_FOLDER_MESSAGE_MATCH_BATCH = 2_000;

export interface CustomFolderMessageMatchBatch {
  /** Visible folder chats with a matching message among this batch's matches. */
  readonly chatGuids: readonly string[];
  /** Continue below this message rowid, or null once every match has been read. */
  readonly nextBeforeRowid: number | null;
}

/**
 * One bounded slice of a folder's message search (review M060). The first statement finds the
 * newest CUSTOM_FOLDER_MESSAGE_MATCH_BATCH full-text matches below `beforeRowid` in every chat; the
 * second keeps the visible ones in the folder among exactly those. Neither statement reads more
 * than one batch of matches, so a broad search no longer holds the app's single database thread
 * for the whole message history at once.
 */
export async function queryCustomFolderMessageMatchBatch(
  db: AppDatabase,
  folderId: number,
  match: string,
  beforeRowid: number | null,
): Promise<CustomFolderMessageMatchBatch> {
  const below = beforeRowid == null ? sql`` : sql`AND rowid < ${beforeRowid}`;
  const window = await db.all<{ low: number | null; count: number }>(sql`
    SELECT MIN(rowid) AS low, COUNT(*) AS count
      FROM (SELECT rowid FROM messages_fts
             WHERE messages_fts MATCH ${match} ${below}
             ORDER BY rowid DESC
             LIMIT ${CUSTOM_FOLDER_MESSAGE_MATCH_BATCH})
  `);
  const low = window[0]?.low ?? null;
  const count = window[0]?.count ?? 0;
  if (low == null || count === 0) return { chatGuids: [], nextBeforeRowid: null };
  const upper = beforeRowid == null ? sql`` : sql`AND f.rowid < ${beforeRowid}`;
  const rows = await db.all<{ guid: string }>(sql`
    SELECT DISTINCT c.guid AS guid
      FROM messages_fts f
      JOIN messages m ON m.id = f.rowid
      JOIN chats c ON c.id = m.chat_id
     WHERE messages_fts MATCH ${match}
       AND f.rowid >= ${low} ${upper}
       AND ${visibleMessageMatchSql()}
       AND EXISTS (
         SELECT 1 FROM custom_folder_members cfm
          WHERE cfm.folder_id = ${folderId} AND cfm.chat_guid = c.guid
       )
  `);
  return {
    chatGuids: rows.map((row: { guid: string }) => row.guid),
    nextBeforeRowid: count < CUSTOM_FOLDER_MESSAGE_MATCH_BATCH ? null : low,
  };
}

export interface MessagePreview {
  guid: string;
  text: string | null;
  subject?: string | null;
  senderName: string | null;
  /** Stable sender address used when a lean update must replace an existing notification. */
  senderAddress?: string | null;
  /** Persisted message time used when a lean update must replace an existing notification. */
  dateCreated?: number | null;
  isFromMe: number;
  hasAttachments: number;
  // Genmoji description of the message's first Genmoji attachment (or null) — the reply-quote /
  // reply-composer fallback text in place of the generic "📎 Attachment". Optional so hand-built
  // test literals need not set it; the SELECT below always provides it at runtime.
  attachmentDescription?: string | null;
  /** Apple Messages extension identifier, never shown verbatim. */
  balloonBundleId?: string | null;
  /** Server aggregate part count for preserving a selected reply target. */
  partCount?: number | null;
  /** Resolved target carried only while this preview is the active reply selection. */
  targetPartIndex?: number;
  /** 1 when at least one non-hidden attachment can render. */
  hasVisibleAttachments?: number;
  /** The exact requested part, or the whole legacy aggregate, is no longer safely visible. */
  isRetracted?: boolean;
}

/** A compact preview of a message by guid (for the reply quote). */
export async function getMessagePreviewByGuid(
  db: AppDatabase,
  chatGuid: string,
  guid: string,
  partIndex?: number | null,
): Promise<MessagePreview | null> {
  // `undefined` means the caller wants the aggregate preview. An explicit null means the caller
  // needs one exact part but its identity is unknown, which must fail closed for partial messages.
  const exactPartRequested = partIndex !== undefined;
  const boundedPartIndex =
    partIndex != null && Number.isSafeInteger(partIndex) && partIndex >= 0 && partIndex <= 10_000
      ? partIndex
      : null;
  const partFilter =
    boundedPartIndex == null
      ? sql``
      : sql`AND (
          m.message_part_topology IS NULL
          OR a.message_part_index IS ${boundedPartIndex}
        )`;
  const rows = await db.all<
    MessagePreview & {
      dateRetracted: number | null;
      retractionState: string | null;
      messagePartTopology: string | null;
    }
  >(sql`
    SELECT m.guid, m.text, m.subject, m.is_from_me AS isFromMe,
           m.date_created AS dateCreated,
           m.has_attachments AS hasAttachments,
           m.balloon_bundle_id AS balloonBundleId,
           m.part_count AS partCount,
           m.date_retracted AS dateRetracted,
           m.retraction_state AS retractionState,
           m.message_part_topology AS messagePartTopology,
           COALESCE(h.display_name, h.address) AS senderName,
           h.address AS senderAddress,
           (SELECT a.emoji_image_short_description FROM attachments a
              WHERE a.message_id = m.id
                AND ${attachmentIsUserFileSql('a', 'm')}
                AND a.hide_attachment = 0
                AND a.is_retracted = 0
                ${partFilter}
                AND a.emoji_image_short_description IS NOT NULL
              ORDER BY a.id ASC LIMIT 1) AS attachmentDescription,
           EXISTS(SELECT 1 FROM attachments a
                    WHERE a.message_id = m.id AND a.hide_attachment = 0
                      AND a.is_retracted = 0 ${partFilter}
                      AND ${attachmentIsUserFileSql('a', 'm')}) AS hasVisibleAttachments
    FROM messages m LEFT JOIN handles h ON h.id = m.handle_id
    WHERE m.chat_id = (SELECT id FROM chats WHERE guid = ${chatGuid} LIMIT 1)
      AND m.guid = ${guid} AND m.date_deleted IS NULL LIMIT 1
  `);
  const row = rows[0];
  if (!row) return null;
  const aggregateRetracted = isAggregateRetractionTombstone({
    retractionState: row.retractionState,
    dateRetracted: row.dateRetracted,
  });
  const topology = parseMessagePartTopology(row.messagePartTopology);
  const exactTopology = isExactMessagePartTopology(topology) ? topology : null;
  const requestedPart =
    exactPartRequested && boundedPartIndex != null
      ? exactTopology?.currentParts.find((part) => part.index === boundedPartIndex)
      : null;
  const requestedPartUnavailable =
    exactPartRequested &&
    ((row.retractionState === 'partial' && (boundedPartIndex == null || requestedPart == null)) ||
      (exactTopology != null && (boundedPartIndex == null || requestedPart == null)));
  const isRetracted = aggregateRetracted || requestedPartUnavailable;
  const {
    dateRetracted: _dateRetracted,
    retractionState: _state,
    messagePartTopology: _topology,
    ...preview
  } = row;
  if (isRetracted) {
    return {
      ...preview,
      text: null,
      subject: null,
      balloonBundleId: null,
      attachmentDescription: null,
      hasVisibleAttachments: 0,
      isRetracted: true,
    };
  }
  if (requestedPart?.kind === 'attachment') {
    return { ...preview, text: null, subject: null, balloonBundleId: null };
  }
  if (
    requestedPart?.kind === 'text' &&
    exactTopology != null &&
    exactTopology.currentParts.filter((part) => part.kind === 'text').length !== 1
  ) {
    // The wire has only aggregate surviving text. With multiple text parts it cannot prove which
    // words belong to this exact reply target, so show a generic quote instead of another part.
    return {
      ...preview,
      text: null,
      subject: null,
      balloonBundleId: null,
      attachmentDescription: null,
      hasVisibleAttachments: 0,
    };
  }
  return preview;
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
 * in that gap the user can read/delete the message or the sender can retract it. Uses the same
 * unread rule as the inbox filters and badges (`chatUnreadMessagePredicateSql`).
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
         AND ${chatUnreadMessagePredicateSql('c', 'm')}
    ) AS eligible`);
  return rows[0]?.eligible === 1;
}
