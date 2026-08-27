import { and, eq, sql } from 'drizzle-orm';
import { chats } from '../schema';
import type { AppDatabase } from '../types';
import {
  chatVisible,
  inboxFilterSql,
  type InboxArchiveFilter,
  type InboxSenderFilter,
} from './chatVisibility';

export type { InboxArchiveFilter, InboxSenderFilter } from './chatVisibility';

/** Read-only inbox and conversation queries, separate from chat mutation ownership. */

// ---- Queries ---------------------------------------------------------------

/** Inbox: non-archived chats, most-recent first. Locally deleted chats are hidden (chatVisible). */
export function listChats(db: AppDatabase, opts: { includeArchived?: boolean } = {}) {
  const visible = chatVisible('chats');
  if (opts.includeArchived) {
    return db
      .select()
      .from(chats)
      .where(visible)
      .orderBy(sql`${chats.latestMessageDate} DESC NULLS LAST`);
  }
  return db
    .select()
    .from(chats)
    .where(and(eq(chats.isArchived, false), visible))
    .orderBy(sql`${chats.latestMessageDate} DESC NULLS LAST`);
}

/**
 * One row per chat, ready to render a conversation tile: chat metadata, the
 * latest message preview, participant names/count, and an unread count — in a
 * single query. Raw SQL via db.all so it runs identically on op-sqlite (device)
 * and better-sqlite3 (tests). Booleans come back as 0/1 integers.
 */
export interface InboxRow {
  id: number;
  guid: string;
  chatIdentifier: string | null;
  displayName: string | null;
  customName: string | null;
  customColor: string | null;
  style: number | null;
  isPinned: number;
  /** Production inbox queries always provide the persisted manual rank. */
  pinOrder?: number | null;
  isArchived: number;
  muteType: string | null;
  latestMessageDate: number | null;
  lastReadMessageGuid: string | null;
  lastText: string | null;
  lastSubject: string | null;
  lastIsFromMe: number | null;
  lastHasAttachments: number | null;
  lastDate: number | null;
  lastGuid: string | null;
  lastAssociatedType: string | null;
  lastError: number | null;
  // Genmoji description of the latest message's first Genmoji attachment (or null) — the inbox
  // preview fallback in place of "📎 Attachment". Optional so hand-built InboxRow test literals need
  // not set it; the query below always provides it at runtime.
  lastAttachmentDescription?: string | null;
  participantCount: number;
  participantNames: string | null;
  participantAvatars: string | null;
  /** `|||`-joined handle colors, positionally aligned with participant names/avatars. */
  participantColors?: string | null;
  /** Comma-joined participant handle services ('iMessage'/'SMS'), for `resolveChatService`. */
  handleServices: string | null;
  unreadCount: number;
  /** 1 when any participant matched a device contact — the "unknown senders" filter signal. */
  hasKnownSender: number;
}

export interface InboxPageOptions {
  limit?: number;
  archive?: InboxArchiveFilter;
  sender?: InboxSenderFilter;
}

export interface InboxPage {
  rows: InboxRow[];
  hasMore: boolean;
}

async function queryChatsForInbox(
  db: AppDatabase,
  options: {
    archive: InboxArchiveFilter;
    sender: InboxSenderFilter;
    limit?: number;
  },
): Promise<InboxRow[]> {
  const filters = inboxFilterSql(options);
  const limit = options.limit == null ? sql`` : sql`LIMIT ${options.limit}`;
  return db.all<InboxRow>(sql`
    -- Bound the chat identities FIRST. Pinned rows use their device-local manual rank; unpinned
    -- rows retain newest-first ordering. Splitting the branches lets each use its own index and
    -- keeps the final merge bounded, while new pinned activity cannot perturb the manual order.
    WITH pinned AS (
      SELECT c.id, c.is_pinned,
             COALESCE(c.pin_order, 9223372036854775807) AS pin_sort,
             NULL AS date_sort
        FROM chats c
       WHERE ${chatVisible('c')} ${filters.archive} ${filters.sender} AND c.is_pinned = 1
       ORDER BY pin_sort ASC, c.id DESC
       ${limit}
    ),
    unpinned AS (
      SELECT c.id, c.is_pinned, NULL AS pin_sort, c.latest_message_date AS date_sort
        FROM chats c
       WHERE ${chatVisible('c')} ${filters.archive} ${filters.sender} AND c.is_pinned = 0
       ORDER BY c.latest_message_date DESC, c.id DESC
       ${limit}
    ),
    page AS (
      SELECT id, is_pinned, pin_sort, date_sort FROM pinned
      UNION ALL
      SELECT id, is_pinned, pin_sort, date_sort FROM unpinned
      ORDER BY is_pinned DESC, pin_sort ASC, date_sort DESC, id DESC
      ${limit}
    )
    SELECT
      c.id, c.guid, c.chat_identifier AS chatIdentifier, c.display_name AS displayName,
      c.custom_name AS customName, c.custom_color AS customColor,
      c.style, c.is_pinned AS isPinned, c.pin_order AS pinOrder,
      c.is_archived AS isArchived, c.mute_type AS muteType,
      c.latest_message_date AS latestMessageDate, c.last_read_message_guid AS lastReadMessageGuid,
      l.text AS lastText, l.subject AS lastSubject, l.is_from_me AS lastIsFromMe,
      l.has_attachments AS lastHasAttachments, l.date_created AS lastDate, l.guid AS lastGuid,
      l.associated_message_type AS lastAssociatedType, l.error AS lastError,
      (SELECT a.emoji_image_short_description FROM attachments a
         WHERE a.message_id = l.id AND a.emoji_image_short_description IS NOT NULL
         ORDER BY a.id ASC LIMIT 1) AS lastAttachmentDescription,
      (SELECT COUNT(*) FROM chat_handles ch WHERE ch.chat_id = c.id) AS participantCount,
      (SELECT group_concat(COALESCE(h.display_name, h.address), ', ' ORDER BY h.id)
         FROM chat_handles ch JOIN handles h ON h.id = ch.handle_id
        WHERE ch.chat_id = c.id) AS participantNames,
      (SELECT group_concat(COALESCE(h.avatar, ''), '|||' ORDER BY h.id)
         FROM chat_handles ch JOIN handles h ON h.id = ch.handle_id
        WHERE ch.chat_id = c.id) AS participantAvatars,
      (SELECT group_concat(COALESCE(h.color, ''), '|||' ORDER BY h.id)
         FROM chat_handles ch JOIN handles h ON h.id = ch.handle_id
        WHERE ch.chat_id = c.id) AS participantColors,
      (SELECT group_concat(COALESCE(h.service, ''), ',' ORDER BY h.id)
         FROM chat_handles ch JOIN handles h ON h.id = ch.handle_id
        WHERE ch.chat_id = c.id) AS handleServices,
      (SELECT COUNT(*) FROM messages um
         WHERE um.chat_id = c.id AND um.is_from_me = 0 AND um.associated_message_type IS NULL
           AND um.date_retracted IS NULL
           AND um.date_deleted IS NULL
           AND um.date_created > COALESCE(
             (SELECT lm.date_created FROM messages lm WHERE lm.guid = c.last_read_message_guid), 0)
           -- A chat the user deleted and that later came back counts only what arrived AFTER the
           -- deletion. Its marker points at a message that went with the delete, so it resolves to
           -- 0 and the whole re-synced history would otherwise land as one enormous unread badge.
           -- STILL LOAD-BEARING even though clearSupersededTombstonesWithinTransaction now hands the floor to the
           -- read marker: that handover only runs from message/chat INGESTION, and the optimistic
           -- send path (insertOutgoingText/Attachment) routes through neither. Sending into a
           -- hidden thread therefore makes it visible with its stamp still set — the one state
           -- where this clause is the only thing between the user and a badge carrying their whole
           -- re-synced history.
           AND (c.deleted_at IS NULL OR um.date_created > c.deleted_at)
      ) AS unreadCount,
      EXISTS(SELECT 1 FROM chat_handles ck JOIN handles hk ON hk.id = ck.handle_id
              WHERE ck.chat_id = c.id AND hk.contact_id IS NOT NULL) AS hasKnownSender
    FROM page p
    JOIN chats c ON c.id = p.id
    LEFT JOIN messages l ON l.id = (
      SELECT m.id FROM messages m
       WHERE m.chat_id = c.id AND m.associated_message_type IS NULL
         AND m.date_retracted IS NULL AND m.date_deleted IS NULL
       ORDER BY m.date_created DESC, m.id DESC LIMIT 1
    )
    ORDER BY p.is_pinned DESC, p.pin_sort ASC, p.date_sort DESC, p.id DESC
  `);
}

/**
 * Inbox rows for the conversation list: manually ordered pins first, then unpinned chats by newest
 * message. The "last message" is resolved dedupe-safely (max date, then max id) so chats never
 * appear twice.
 */
export async function listChatsForInbox(
  db: AppDatabase,
  opts: { includeArchived?: boolean } = {},
): Promise<InboxRow[]> {
  return queryChatsForInbox(db, {
    archive: opts.includeArchived ? 'all' : 'active',
    sender: 'any',
  });
}

/** One growing-prefix page; the extra row is consumed only as the `hasMore` sentinel. */
export async function listChatsForInboxPage(
  db: AppDatabase,
  opts: InboxPageOptions = {},
): Promise<InboxPage> {
  const requested = opts.limit ?? 50;
  const limit = Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : 50;
  const rows = await queryChatsForInbox(db, {
    archive: opts.archive ?? 'active',
    sender: opts.sender ?? 'any',
    limit: limit + 1,
  });
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
}

/** Lightweight exact count for page-external affordances such as the Unknown Senders footer. */
export async function countChatsForInbox(
  db: AppDatabase,
  opts: Omit<InboxPageOptions, 'limit'> = {},
): Promise<number> {
  const filters = inboxFilterSql({
    archive: opts.archive ?? 'active',
    sender: opts.sender ?? 'any',
  });
  const rows = await db.all<{ count: number }>(sql`
    SELECT COUNT(*) AS count FROM chats c
     WHERE ${chatVisible('c')} ${filters.archive} ${filters.sender}
  `);
  return rows[0]?.count ?? 0;
}

/**
 * True when any participant of the chat matched a device contact. The "unknown senders"
 * feature treats contact-less chats as unknown (separate list + muted notifications).
 */
export async function chatHasKnownSender(db: AppDatabase, guid: string): Promise<boolean> {
  const rows = await db.all<{ known: number }>(sql`
    SELECT EXISTS(
      SELECT 1 FROM chat_handles ch JOIN handles h ON h.id = ch.handle_id
       WHERE ch.chat_id = (SELECT id FROM chats WHERE guid = ${guid} LIMIT 1)
         AND h.contact_id IS NOT NULL
    ) AS known
  `);
  return rows[0]?.known === 1;
}

/** Resolve a chat's local integer id from its server guid. */
export async function getChatIdByGuid(db: AppDatabase, guid: string): Promise<number | null> {
  const rows = await db.all<{ id: number }>(sql`SELECT id FROM chats WHERE guid = ${guid} LIMIT 1`);
  return rows[0]?.id ?? null;
}

/** Minimal chat row for the conversation header (title + avatar + group state). */
export interface ChatHeaderRow {
  id: number;
  guid: string;
  chatIdentifier: string | null;
  displayName: string | null;
  customName: string | null;
  customColor: string | null;
  muteType: string | null;
  style: number | null;
  participantCount: number;
  participantNames: string | null;
  participantAvatars: string | null;
  /** `|||`-joined handle colors, positionally aligned with participant names/avatars. */
  participantColors?: string | null;
  /**
   * `|||`-joined participant handle ADDRESSES (the raw phone/email), positionally aligned with
   * `participantNames`/`participantAvatars`. Distinct from the names, which are
   * `COALESCE(display_name, address)` — for a SAVED contact the name is the contact's name, so the
   * address is the only place the actual number survives. The chat header shows it under the name.
   *
   * `|||` (not `, `) because an address must round-trip exactly. Optional so hand-built
   * `ChatHeaderRow` test literals need not set it; the query below always provides it at runtime.
   */
  participantAddresses?: string | null;
  /** Comma-joined participant handle services ('iMessage'/'SMS'), for `resolveChatService`. */
  handleServices: string | null;
  /**
   * The local deletion tombstone (ms) or null — REPORTED, not filtered on (see the fn). The
   * notification-intent builder needs it to decide whether an arriving message is one that would
   * bring the chat back. Optional so hand-built `ChatHeaderRow` test literals need not set it; the
   * query below always provides it at runtime.
   */
  deletedAt?: number | null;
}

/**
 * Identity + preferences for ONE chat, by guid. Deliberately NOT filtered by `chatVisible`.
 *
 * This is a lookup, not a list: its two callers are the open conversation's own header and the
 * notification-intent builder, and neither is deciding what to enumerate. Hiding a tombstoned chat
 * here returns null, and null is indistinguishable from "no such chat" — which silently turned OFF
 * the per-chat MUTE (`header?.muteType === 'mute'`, so an absent header reads as "not muted") and
 * degraded the notification title to the sender's name. A chat can be tombstoned while messages are
 * still arriving in it, so a muted-and-deleted conversation started buzzing. Suppression decisions
 * must never treat "unknown" as "allowed"; and the chat screen is reachable for a tombstoned chat
 * (deep link, notification tap), where a null header rendered the literal fallback title.
 * Visibility belongs on the genuine LIST queries above.
 *
 * It DOES report `deleted_at`, which is a different thing from filtering on it: the caller that
 * must not be lied to about mute is also the caller that must not raise a notification for an event
 * which can never make the chat findable again (a tapback in a deleted thread). Reporting the stamp
 * lets it apply the tombstone itself; filtering on it would take mute down with it.
 */
export async function getChatHeader(db: AppDatabase, guid: string): Promise<ChatHeaderRow | null> {
  const rows = await db.all<ChatHeaderRow>(sql`
    SELECT c.id, c.guid, c.chat_identifier AS chatIdentifier, c.display_name AS displayName,
      c.custom_name AS customName, c.custom_color AS customColor, c.mute_type AS muteType, c.style,
      c.deleted_at AS deletedAt,
      (SELECT COUNT(*) FROM chat_handles ch WHERE ch.chat_id = c.id) AS participantCount,
      (SELECT group_concat(COALESCE(h.display_name, h.address), ', ' ORDER BY h.id)
         FROM chat_handles ch JOIN handles h ON h.id = ch.handle_id
        WHERE ch.chat_id = c.id) AS participantNames,
      (SELECT group_concat(COALESCE(h.avatar, ''), '|||' ORDER BY h.id)
         FROM chat_handles ch JOIN handles h ON h.id = ch.handle_id
        WHERE ch.chat_id = c.id) AS participantAvatars,
      (SELECT group_concat(COALESCE(h.color, ''), '|||' ORDER BY h.id)
         FROM chat_handles ch JOIN handles h ON h.id = ch.handle_id
        WHERE ch.chat_id = c.id) AS participantColors,
      (SELECT group_concat(COALESCE(h.address, ''), '|||' ORDER BY h.id)
         FROM chat_handles ch JOIN handles h ON h.id = ch.handle_id
        WHERE ch.chat_id = c.id) AS participantAddresses,
      (SELECT group_concat(COALESCE(h.service, ''), ',' ORDER BY h.id)
         FROM chat_handles ch JOIN handles h ON h.id = ch.handle_id
        WHERE ch.chat_id = c.id) AS handleServices
    FROM chats c WHERE c.guid = ${guid} LIMIT 1
  `);
  return rows[0] ?? null;
}

/** Normalize an address for participant-set comparison: emails lowercased, phones to last 10
 *  digits (so +1 (555) 123-4567 matches 5551234567). */
function normalizeAddr(a: string): string {
  return a.includes('@') ? a.trim().toLowerCase() : a.replace(/\D/g, '').slice(-10);
}

/**
 * Find an existing chat whose participant set EXACTLY equals `addresses` (order-independent,
 * phone-suffix/email-normalized) — so the new-chat screen can offer "continue existing
 * conversation" instead of spawning a duplicate thread. Returns the chat guid or null.
 */
export async function findChatByParticipantAddresses(
  db: AppDatabase,
  addresses: string[],
): Promise<string | null> {
  const want = new Set(addresses.map(normalizeAddr).filter(Boolean));
  if (want.size === 0) return null;
  const rows = await db.all<{ guid: string; address: string }>(sql`
    SELECT c.guid AS guid, h.address AS address
      FROM chats c
      JOIN chat_handles ch ON ch.chat_id = c.id
      JOIN handles h ON h.id = ch.handle_id
     WHERE ${chatVisible('c')}
  `);
  const byChat = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = byChat.get(r.guid) ?? new Set<string>();
    set.add(normalizeAddr(r.address));
    byChat.set(r.guid, set);
  }
  for (const [guid, set] of byChat) {
    if (set.size === want.size && [...want].every((a) => set.has(a))) return guid;
  }
  return null;
}

/** A chat's participants with their addresses — for group add/remove (needs the address). */
export async function getChatParticipants(
  db: AppDatabase,
  guid: string,
): Promise<{ address: string; name: string }[]> {
  return db.all<{ address: string; name: string }>(sql`
    SELECT h.address AS address, COALESCE(h.display_name, h.address) AS name
      FROM chat_handles ch
      JOIN handles h ON h.id = ch.handle_id
      JOIN chats c ON c.id = ch.chat_id
     WHERE c.guid = ${guid}
     ORDER BY h.id
  `);
}
