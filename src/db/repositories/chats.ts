import { eq, sql } from 'drizzle-orm';
import type { Chat, ChatSummary } from '@core/models';
import { chatHandles, chats, messages, outgoingQueue } from '../schema';
import type { AppDatabase } from '../types';
import { dedupeBy } from './_shared';
import { upsertHandles } from './handles';

/** Upsert chats by guid and link participants; returns guid → row id. */
export async function upsertChats(
  db: AppDatabase,
  items: Array<Chat | ChatSummary>,
  handleIdByAddress: Map<string, number>,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const deduped = dedupeBy(
    items.filter((c) => !!c?.guid),
    (c) => c.guid,
  );
  if (deduped.length === 0) return map;

  const rows = await db
    .insert(chats)
    .values(
      deduped.map((c) => ({
        guid: c.guid,
        originalRowId: c.originalROWID ?? null,
        chatIdentifier: c.chatIdentifier ?? null,
        displayName: c.displayName ?? null,
        style: c.style ?? null,
        isArchived: c.isArchived ?? false,
        isPinned: c.isPinned ?? false,
        muteType: c.muteType ?? null,
        // Server-owned (macOS 26 synced background): the current channel GUID, or null when the
        // chat has no background. Refreshed on every sync (unlike the device-local columns below).
        syncedBackgroundChannel: ('backgroundChannelGuid' in c ? c.backgroundChannelGuid : null) ?? null,
      })),
    )
    .onConflictDoUpdate({
      target: chats.guid,
      set: {
        displayName: sql`excluded.display_name`,
        chatIdentifier: sql`excluded.chat_identifier`,
        style: sql`excluded.style`,
        // Server-owned → refreshed on re-sync (a changed/removed background propagates).
        syncedBackgroundChannel: sql`excluded.synced_background_channel`,
        // is_pinned, is_archived, mute_type, custom_name, custom_color are device-local:
        // SEEDED on first insert from the server, but NOT overwritten on a re-sync — the
        // user toggles them locally (pin / archive / mute / customization UI), so they
        // survive. (Pin/archive have no server round-trip in this client.)
      },
    })
    .returning({ id: chats.id, guid: chats.guid });

  for (const r of rows) map.set(r.guid, r.id);

  // Reconcile participant links per chat. When a chat's payload INCLUDES a participants
  // list, REPLACE its links so a removed member is pruned (not just additively kept — the
  // old additive insert left removed members in chat_handles forever). A payload WITHOUT
  // participants leaves the existing links untouched (a partial/list-only sync mustn't wipe).
  const links: { chatId: number; handleId: number }[] = [];
  for (const c of deduped) {
    const chatId = map.get(c.guid);
    if (chatId == null || c.participants == null) continue;
    await db.delete(chatHandles).where(eq(chatHandles.chatId, chatId));
    for (const p of c.participants) {
      const handleId = handleIdByAddress.get(p.address);
      if (handleId != null) links.push({ chatId, handleId });
    }
  }
  if (links.length > 0) {
    await db.insert(chatHandles).values(links).onConflictDoNothing();
  }
  return map;
}

/** Persist a server-returned chat (display name + participant links) locally. */
export async function persistServerChat(db: AppDatabase, chat: Chat): Promise<void> {
  const handleIds = await upsertHandles(db, chat.participants ?? []);
  await upsertChats(db, [chat], handleIds);
}

/** Set a chat's local mute preference ('mute' to mute, null to clear). */
export async function setChatMute(
  db: AppDatabase,
  guid: string,
  muteType: string | null,
): Promise<void> {
  await db.update(chats).set({ muteType }).where(eq(chats.guid, guid));
}

/**
 * Pin / unpin a chat. Client-local — BlueBubbles pin is a device state, not a server
 * concept; kept out of `upsertChats`' conflict set so a re-sync can't clobber it.
 * The inbox sorts pinned chats first (see `listChatsForInbox`).
 */
export async function setChatPin(db: AppDatabase, guid: string, pinned: boolean): Promise<void> {
  await db.update(chats).set({ isPinned: pinned }).where(eq(chats.guid, guid));
}

/** Archive / unarchive a chat (client-local). Archived chats drop out of the main inbox. */
export async function setChatArchive(
  db: AppDatabase,
  guid: string,
  archived: boolean,
): Promise<void> {
  await db.update(chats).set({ isArchived: archived }).where(eq(chats.guid, guid));
}

/**
 * Locally delete a chat: its messages, participant links, and any pending outgoing-queue
 * rows, then the chat itself. Does NOT delete on the server (iMessage threads aren't
 * server-deletable); a future re-sync could repopulate it.
 */
export async function deleteChatLocal(db: AppDatabase, guid: string): Promise<void> {
  const chatId = await getChatIdByGuid(db, guid);
  if (chatId == null) return;
  await db.delete(messages).where(eq(messages.chatId, chatId));
  await db.delete(chatHandles).where(eq(chatHandles.chatId, chatId));
  await db.delete(outgoingQueue).where(eq(outgoingQueue.chatGuid, guid));
  await db.delete(chats).where(eq(chats.id, chatId));
}

/**
 * Set a chat's local customizations. Pass a field as `undefined` to leave it
 * unchanged, or `null` to clear it (revert to default). Validates the color.
 */
export async function setChatCustomization(
  db: AppDatabase,
  guid: string,
  patch: { customName?: string | null; customColor?: string | null },
): Promise<void> {
  const set: { customName?: string | null; customColor?: string | null } = {};
  if (patch.customName !== undefined) {
    const trimmed = patch.customName?.trim();
    set.customName = trimmed ? trimmed : null;
  }
  if (patch.customColor !== undefined) {
    if (patch.customColor !== null && !/^#[0-9a-f]{6}$/i.test(patch.customColor)) {
      throw new Error(`invalid custom color: ${patch.customColor}`);
    }
    set.customColor = patch.customColor;
  }
  if (Object.keys(set).length === 0) return;
  await db.update(chats).set(set).where(eq(chats.guid, guid));
}

/**
 * Set a chat's per-chat theme override and/or chat-background image. Pass a field
 * as `undefined` to leave it unchanged, or `null` to clear it (revert to the global
 * theme / no background). Device-local — excluded from upsertChats' conflict set.
 */
export async function setChatTheme(
  db: AppDatabase,
  guid: string,
  patch: { themeTokens?: string | null; backgroundUri?: string | null },
): Promise<void> {
  const set: { themeTokens?: string | null; backgroundUri?: string | null } = {};
  if (patch.themeTokens !== undefined) set.themeTokens = patch.themeTokens;
  if (patch.backgroundUri !== undefined) set.backgroundUri = patch.backgroundUri;
  if (Object.keys(set).length === 0) return;
  await db.update(chats).set(set).where(eq(chats.guid, guid));
}

/**
 * A chat's per-chat theme override + background uris (null fields → inherit/none). Includes
 * both the device-local `backgroundUri` (the user's pick) and the macOS 26 `syncedBackgroundUri`
 * (downloaded from the server); the UI resolves the effective background as local ?? synced.
 */
export async function getChatTheme(
  db: AppDatabase,
  guid: string,
): Promise<{
  themeTokens: string | null;
  backgroundUri: string | null;
  syncedBackgroundUri: string | null;
  /** 1 = light wallpaper, 0 = dark, null = unknown/none (raw column value). */
  backgroundIsLight: number | null;
} | null> {
  const rows = await db.all<{
    themeTokens: string | null;
    backgroundUri: string | null;
    syncedBackgroundUri: string | null;
    backgroundIsLight: number | null;
  }>(
    sql`SELECT theme_tokens AS themeTokens, background_uri AS backgroundUri,
               synced_background_uri AS syncedBackgroundUri,
               background_is_light AS backgroundIsLight
          FROM chats WHERE guid = ${guid} LIMIT 1`,
  );
  return rows[0] ?? null;
}

/** Store the effective wallpaper's luminance (true = light → dark overlay text; null = unknown). */
export async function setBackgroundIsLight(
  db: AppDatabase,
  guid: string,
  isLight: boolean | null,
): Promise<void> {
  await db.update(chats).set({ backgroundIsLight: isLight }).where(eq(chats.guid, guid));
}

/**
 * The macOS 26 synced-background state for a chat: the server's current `channel` (the version)
 * and the `uri` of the local file already downloaded for it. The background-sync service compares
 * them to decide whether to (re)download.
 */
export async function getSyncedBackgroundState(
  db: AppDatabase,
  guid: string,
): Promise<{ channel: string | null; uri: string | null } | null> {
  const rows = await db.all<{ channel: string | null; uri: string | null }>(
    sql`SELECT synced_background_channel AS channel, synced_background_uri AS uri
          FROM chats WHERE guid = ${guid} LIMIT 1`,
  );
  return rows[0] ?? null;
}

/** Set (or clear, with null) the local file path of a chat's downloaded synced background. */
export async function setSyncedBackgroundUri(
  db: AppDatabase,
  guid: string,
  uri: string | null,
): Promise<void> {
  await db.update(chats).set({ syncedBackgroundUri: uri }).where(eq(chats.guid, guid));
}

// ---- Queries ---------------------------------------------------------------

/** Inbox: non-archived chats, most-recent first. */
export function listChats(db: AppDatabase, opts: { includeArchived?: boolean } = {}) {
  const query = db
    .select()
    .from(chats)
    .orderBy(sql`${chats.latestMessageDate} DESC NULLS LAST`);
  if (opts.includeArchived) return query;
  return db
    .select()
    .from(chats)
    .where(eq(chats.isArchived, false))
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
  participantCount: number;
  participantNames: string | null;
  participantAvatars: string | null;
  unreadCount: number;
}

/**
 * Inbox rows for the conversation list. Ordering mirrors Flutter Chat.sort:
 * pinned first, then most-recent message first. The "last message" is resolved
 * dedupe-safely (max date, then max id) so chats never appear twice.
 */
export async function listChatsForInbox(
  db: AppDatabase,
  opts: { includeArchived?: boolean } = {},
): Promise<InboxRow[]> {
  const whereArchived = opts.includeArchived ? sql`` : sql`WHERE c.is_archived = 0`;
  return db.all<InboxRow>(sql`
    WITH last AS (
      SELECT m.* FROM messages m
      WHERE m.id = (
        SELECT m2.id FROM messages m2
        WHERE m2.chat_id = m.chat_id AND m2.associated_message_type IS NULL
          AND m2.date_retracted IS NULL
        ORDER BY m2.date_created DESC, m2.id DESC LIMIT 1
      )
    )
    SELECT
      c.id, c.guid, c.chat_identifier AS chatIdentifier, c.display_name AS displayName,
      c.custom_name AS customName, c.custom_color AS customColor,
      c.style, c.is_pinned AS isPinned, c.is_archived AS isArchived, c.mute_type AS muteType,
      c.latest_message_date AS latestMessageDate, c.last_read_message_guid AS lastReadMessageGuid,
      l.text AS lastText, l.subject AS lastSubject, l.is_from_me AS lastIsFromMe,
      l.has_attachments AS lastHasAttachments, l.date_created AS lastDate, l.guid AS lastGuid,
      l.associated_message_type AS lastAssociatedType, l.error AS lastError,
      (SELECT COUNT(*) FROM chat_handles ch WHERE ch.chat_id = c.id) AS participantCount,
      (SELECT group_concat(COALESCE(h.display_name, h.address), ', ' ORDER BY h.id)
         FROM chat_handles ch JOIN handles h ON h.id = ch.handle_id
        WHERE ch.chat_id = c.id) AS participantNames,
      (SELECT group_concat(COALESCE(h.avatar, ''), '|||' ORDER BY h.id)
         FROM chat_handles ch JOIN handles h ON h.id = ch.handle_id
        WHERE ch.chat_id = c.id) AS participantAvatars,
      (SELECT COUNT(*) FROM messages um
         WHERE um.chat_id = c.id AND um.is_from_me = 0 AND um.associated_message_type IS NULL
           AND um.date_created > COALESCE(
             (SELECT lm.date_created FROM messages lm WHERE lm.guid = c.last_read_message_guid), 0)
      ) AS unreadCount
    FROM chats c
    LEFT JOIN last l ON l.chat_id = c.id
    ${whereArchived}
    ORDER BY c.is_pinned DESC, c.latest_message_date DESC
  `);
}

// ---- Conversation view -----------------------------------------------------

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
}

export async function getChatHeader(db: AppDatabase, guid: string): Promise<ChatHeaderRow | null> {
  const rows = await db.all<ChatHeaderRow>(sql`
    SELECT c.id, c.guid, c.chat_identifier AS chatIdentifier, c.display_name AS displayName,
      c.custom_name AS customName, c.custom_color AS customColor, c.mute_type AS muteType, c.style,
      (SELECT COUNT(*) FROM chat_handles ch WHERE ch.chat_id = c.id) AS participantCount,
      (SELECT group_concat(COALESCE(h.display_name, h.address), ', ' ORDER BY h.id)
         FROM chat_handles ch JOIN handles h ON h.id = ch.handle_id
        WHERE ch.chat_id = c.id) AS participantNames,
      (SELECT group_concat(COALESCE(h.avatar, ''), '|||' ORDER BY h.id)
         FROM chat_handles ch JOIN handles h ON h.id = ch.handle_id
        WHERE ch.chat_id = c.id) AS participantAvatars
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

/** Mark a chat read locally (clears the inbox unread badge via listChatsForInbox). */
export async function setLastReadMessageGuid(
  db: AppDatabase,
  chatGuid: string,
  lastMessageGuid: string,
): Promise<void> {
  await db
    .update(chats)
    .set({ lastReadMessageGuid: lastMessageGuid })
    .where(eq(chats.guid, chatGuid));
}

/**
 * Mark a chat UNREAD locally: clear the read marker so `unreadCount` (messages newer than the
 * marker) counts all received messages again and the inbox badge/bold-title returns. Local-only —
 * there is no server "mark unread". Opening the chat re-marks it read.
 */
export async function setChatUnreadLocal(db: AppDatabase, chatGuid: string): Promise<void> {
  await db.update(chats).set({ lastReadMessageGuid: null }).where(eq(chats.guid, chatGuid));
}

/**
 * Mark EVERY chat read locally in one pass: point each chat's read marker at its newest message so
 * all inbox badges clear. Local-only (does not send per-chat read receipts). Uses `db.run` for the
 * non-returning bulk UPDATE; the adapter flushes so the reactive inbox refreshes.
 */
export async function markAllChatsReadLocal(db: AppDatabase): Promise<void> {
  await db.run(sql`
    UPDATE chats SET last_read_message_guid = (
      SELECT m.guid FROM messages m WHERE m.chat_id = chats.id ORDER BY m.date_created DESC LIMIT 1
    ) WHERE id IN (SELECT DISTINCT chat_id FROM messages)
  `);
}
