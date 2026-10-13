import { sql, type SQL } from 'drizzle-orm';
import { normalizeInboxFilters, type InboxFilters, type InboxSenderFilter } from '@core/models';
import { APPLE_EXTENSION_PAYLOAD_SUFFIX } from '@utils/attachment';

/** Shared chat-list visibility policy, isolated so commands and queries can depend on it. */

export type InboxArchiveFilter = 'active' | 'archived' | 'all';
export type { InboxSenderFilter } from '@core/models';

/**
 * SQL form of `isUserFileAttachment`: every attachment of an ordinary message, or on an iMessage
 * app message only a typed file that is not Apple's payload file. Callers keep their own
 * `hide_attachment` check. Aliases are fixed internal literals at every caller.
 */
export function attachmentIsUserFileSql(attachmentAlias: string, messageAlias: string) {
  const a = sql.raw(attachmentAlias);
  const m = sql.raw(messageAlias);
  return sql`(
    ${m}.balloon_bundle_id IS NULL
    OR (
      COALESCE(${a}.mime_type, '') <> ''
      AND ${a}.transfer_name IS NOT NULL
      AND LOWER(${a}.transfer_name) NOT LIKE ${`%${APPLE_EXTENSION_PAYLOAD_SUFFIX}`}
    )
  )`;
}

/**
 * Shared content-visibility rule for inbox/search/unread/notification readers.
 *
 * Migrated legacy rows fall back to the old date marker. A proven partial retraction stays visible;
 * full and uncertain aggregates fail closed even if their historical body still exists locally.
 */
export function messageHasVisibleContentSql(alias: string) {
  const m = sql.raw(alias);
  return sql`(
    CASE
      WHEN ${m}.retraction_state IN ('intact', 'partial') THEN 1
      WHEN ${m}.retraction_state IN ('fully-retracted', 'unknown') THEN 0
      ELSE ${m}.date_retracted IS NULL
    END
  )`;
}

/**
 * One load-bearing definition of a qualifying unread message.
 *
 * The local-deletion floor prevents re-synced pre-delete history from becoming unread when its
 * original read marker no longer resolves. It remains necessary even though ordinary ingress
 * retires superseded tombstones: optimistic outgoing sends do not take that ingress path, so a
 * temporarily un-hidden chat can still retain `deleted_at`. `marked_unread_at` is deliberately not
 * another cutoff; Mark as Unread clears `last_read_message_guid`, which makes the existing stored
 * incoming messages count again.
 */
export function chatUnreadMessagePredicateSql(chatAlias: string, messageAlias: string) {
  const c = sql.raw(chatAlias);
  const m = sql.raw(messageAlias);
  return sql`${m}.chat_id = ${c}.id AND ${m}.is_from_me = 0
    AND ${m}.associated_message_type IS NULL
    AND ${messageHasVisibleContentSql(messageAlias)}
    AND ${m}.date_deleted IS NULL
    AND ${m}.date_created > COALESCE(
      (SELECT lm.date_created FROM messages lm WHERE lm.guid = ${c}.last_read_message_guid),
      0
    )
    AND (${c}.deleted_at IS NULL OR ${m}.date_created > ${c}.deleted_at)`;
}

/**
 * A chat's inbox sort date: its newest visible non-reaction message, or its newest visible message
 * of any kind when it holds only reactions. Every writer that changes message visibility
 * recomputes `chats.latest_message_date` with this one rule, so a chat never jumps between a
 * delete and the next sync. `chatId` is a correlated column (`sql.raw('chats.id')`) or a bound id.
 */
export function chatLatestMessageDateSql(chatId: SQL | number) {
  return sql`COALESCE(
    (SELECT MAX(sm.date_created) FROM messages sm
      WHERE sm.chat_id = ${chatId} AND sm.date_deleted IS NULL
        AND sm.associated_message_type IS NULL),
    (SELECT MAX(sm.date_created) FROM messages sm
      WHERE sm.chat_id = ${chatId} AND sm.date_deleted IS NULL)
  )`;
}

/** One shared answer for unread-chat filters and folder badges. */
export function chatHasUnreadSql(alias: string) {
  return sql`EXISTS(
    SELECT 1 FROM messages um WHERE ${chatUnreadMessagePredicateSql(alias, 'um')}
  )`;
}

/** Exact qualifying message count for the existing per-conversation badge. */
export function chatUnreadCountSql(alias: string) {
  return sql`(
    SELECT COUNT(*) FROM messages um WHERE ${chatUnreadMessagePredicateSql(alias, 'um')}
  )`;
}

/** Shared inbox filter fragments used by both paging queries and pinned-order commands. */
export function inboxFilterSql(options: {
  archive: InboxArchiveFilter;
  sender: InboxSenderFilter;
  filters?: InboxFilters;
}) {
  const filters = normalizeInboxFilters(options.filters);
  const archive =
    options.archive === 'all'
      ? sql``
      : options.archive === 'archived'
        ? sql`AND c.is_archived = 1`
        : sql`AND c.is_archived = 0`;
  const known = sql`EXISTS(
    SELECT 1 FROM chat_handles ck JOIN handles hk ON hk.id = ck.handle_id
     WHERE ck.chat_id = c.id AND (hk.contact_id IS NOT NULL OR hk.contact_ambiguous = 1)
  )`;
  // Fixed routes may supply a sender scope without a FEAT-01 filter object. When both exist, the
  // fixed route wins so Archived/Unknown Senders cannot accidentally become cross-filtered.
  const senderChoice = options.sender === 'any' ? filters.sender : options.sender;
  const sender =
    senderChoice === 'known'
      ? sql`AND ${known}`
      : senderChoice === 'unknown'
        ? sql`AND NOT ${known}`
        : sql``;

  // Filtering the decorated alias after LIMIT would make sparse unread pages incomplete.
  const unread = filters.read === 'unread' ? sql`AND ${chatHasUnreadSql('c')}` : sql``;

  // Mirror isGroupRow: a present chat.style is authoritative (43 = group); only an unknown style
  // falls back to participant count.
  const isGroup = sql`(
    CASE WHEN c.style IS NOT NULL
      THEN c.style = 43
      ELSE (SELECT COUNT(*) FROM chat_handles cg WHERE cg.chat_id = c.id) > 1
    END
  )`;
  const kind =
    filters.kind === 'group'
      ? sql`AND ${isGroup}`
      : filters.kind === 'direct'
        ? sql`AND NOT ${isGroup}`
        : sql``;

  // The current action sheet defines muted as the exact persisted 'mute' state. Other future
  // mute modes must not silently join this filter.
  const mute =
    filters.mute === 'muted'
      ? sql`AND c.mute_type = 'mute'`
      : filters.mute === 'unmuted'
        ? sql`AND (c.mute_type IS NULL OR c.mute_type <> 'mute')`
        : sql``;

  // Mirror resolveChatService. RCS/SMS GUIDs win. An iMessage-shaped/opaque GUID is SMS only when
  // it has at least one non-empty handle service and every non-empty service is exactly 'SMS'.
  const hasServiceGuid = sql`LENGTH(c.guid) > 0`;
  const isRcs = sql`(${hasServiceGuid} AND substr(c.guid, 1, 6) = 'RCS;-;')`;
  const isSms = sql`(
    ${hasServiceGuid}
    AND (
      substr(c.guid, 1, 6) = 'SMS;-;'
      OR (
        substr(c.guid, 1, 6) <> 'RCS;-;'
        AND substr(c.guid, 1, 6) <> 'SMS;-;'
        AND EXISTS(
          SELECT 1 FROM chat_handles cs
          JOIN handles hs ON hs.id = cs.handle_id
          WHERE cs.chat_id = c.id AND TRIM(COALESCE(hs.service, '')) <> ''
        )
        AND NOT EXISTS(
          SELECT 1 FROM chat_handles cs
          JOIN handles hs ON hs.id = cs.handle_id
          WHERE cs.chat_id = c.id
            AND TRIM(COALESCE(hs.service, '')) <> ''
            AND TRIM(hs.service) <> 'SMS'
        )
      )
    )
  )`;
  const service =
    filters.service === 'rcs'
      ? sql`AND ${isRcs}`
      : filters.service === 'sms'
        ? sql`AND ${isSms}`
        : filters.service === 'imessage'
          ? sql`AND ${hasServiceGuid} AND NOT ${isRcs} AND NOT ${isSms}`
          : sql``;

  return { archive, sender, criteria: sql`${unread} ${kind} ${mute} ${service}` };
}

/**
 * SQL predicate for "this chat belongs in a list" — i.e. it is not sitting under a local deletion
 * tombstone. `alias` is the name the surrounding query gives the chats table.
 *
 * A tombstoned chat comes BACK on its own the moment genuinely new activity arrives. The predicate
 * is a safety net that answers correctly even before
 * `clearSupersededTombstonesWithinTransaction` has retired the stamp; that write is what makes the
 * un-hide durable.
 *
 * "GENUINELY NEW ACTIVITY" MUST MEAN THE SAME THING HERE AS IT DOES IN THE PREVIEW AND THE UNREAD
 * COUNT — hence the three extra filters, which are exactly the ones `listChatsForInbox`'s `last`
 * CTE and its `unreadCount` sub-select already apply. A reaction (`associated_message_type` set) and
 * an unsent message (`date_retracted` set) both store a row with a fresh `date_created` and NO
 * visible content: with a looser predicate here, someone tapping a heart on an old message in a
 * thread you deleted resurrected the whole conversation, rendering its ORIGINAL pre-deletion
 * preview and timestamp with a 0 badge — a chat that un-hides must have something to show.
 *
 * Re-synced HISTORY can't un-hide anything either, because `deleteChatLocal` floors the stamp at
 * the chat's newest stored message, so every re-inserted row is `<=` it by construction.
 */
export function chatVisible(alias: string) {
  const t = sql.raw(alias);
  return sql`(${t}.deleted_at IS NULL OR EXISTS (
    SELECT 1 FROM messages dm
     WHERE dm.chat_id = ${t}.id AND dm.date_deleted IS NULL
       AND dm.associated_message_type IS NULL AND ${messageHasVisibleContentSql('dm')}
       AND dm.date_created > ${t}.deleted_at))`;
}
