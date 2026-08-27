import { sql } from 'drizzle-orm';

/** Shared chat-list visibility policy, isolated so commands and queries can depend on it. */

export type InboxArchiveFilter = 'active' | 'archived' | 'all';
export type InboxSenderFilter = 'any' | 'known' | 'unknown';

/** Shared inbox filter fragments used by both paging queries and pinned-order commands. */
export function inboxFilterSql(options: {
  archive: InboxArchiveFilter;
  sender: InboxSenderFilter;
}) {
  const archive =
    options.archive === 'all'
      ? sql``
      : options.archive === 'archived'
        ? sql`AND c.is_archived = 1`
        : sql`AND c.is_archived = 0`;
  const known = sql`EXISTS(
    SELECT 1 FROM chat_handles ck JOIN handles hk ON hk.id = ck.handle_id
     WHERE ck.chat_id = c.id AND hk.contact_id IS NOT NULL
  )`;
  const sender =
    options.sender === 'known'
      ? sql`AND ${known}`
      : options.sender === 'unknown'
        ? sql`AND NOT ${known}`
        : sql``;
  return { archive, sender };
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
       AND dm.associated_message_type IS NULL AND dm.date_retracted IS NULL
       AND dm.date_created > ${t}.deleted_at))`;
}
