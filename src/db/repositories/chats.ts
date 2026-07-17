import { eq, sql } from 'drizzle-orm';
import type { Chat, ChatSummary } from '@core/models';
import { chatHandles, chats, messages, outgoingQueue } from '../schema';
import type { AppDatabase } from '../types';
import { dedupeBy } from './_shared';
import { handleMapKey, upsertHandles } from './handles';

/**
 * Upsert chats by guid and link participants; returns guid → row id.
 * `handleIdByKey` is the map `upsertHandles` returned for these chats' participants
 * (keyed by `handleMapKey`, i.e. address + service).
 */
export async function upsertChats(
  db: AppDatabase,
  items: Array<Chat | ChatSummary>,
  handleIdByKey: Map<string, number>,
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
        syncedBackgroundChannel:
          ('backgroundChannelGuid' in c ? c.backgroundChannelGuid : null) ?? null,
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
      const handleId = handleIdByKey.get(handleMapKey(p));
      if (handleId != null) links.push({ chatId, handleId });
    }
  }
  if (links.length > 0) {
    await db.insert(chatHandles).values(links).onConflictDoNothing();
  }

  // Reconcile Mac-side read state (schema gap 7): a full `Chat` (chat query / sync path) may carry
  // `lastReadMessageTimestamp` (Unix ms) from the macOS `chat.last_read_message_timestamp` column.
  // Map it into our guid-based read marker — monotonically (see reconcileReadMarkersFromTimestamps).
  // Presence-driven: absent on `ChatSummary` (live message events + incremental-sync embedded
  // chats never model it) and on old-macOS rows, so guard with `in` (mirrors the
  // backgroundChannelGuid access above). This is the single chokepoint for chat ingestion, so
  // every full-Chat path is reconciled here without per-caller wiring. Collected across the batch
  // and reconciled in as few queries as possible (not a couple of SELECTs per chat) — see the fn.
  const readMarkerPairs: { chatId: number; timestampMs: number }[] = [];
  for (const c of deduped) {
    const ts = 'lastReadMessageTimestamp' in c ? c.lastReadMessageTimestamp : null;
    const chatId = map.get(c.guid);
    if (ts != null && chatId != null) readMarkerPairs.push({ chatId, timestampMs: ts });
  }
  await reconcileReadMarkersFromTimestamps(db, readMarkerPairs);
  return map;
}

/**
 * Reconcile Mac-side read watermarks into the local guid-based read marker for a BATCH of chats.
 *
 * macOS syncs `chat.last_read_message_timestamp` (Unix ms) on the chat query/sync paths. Our read
 * model is guid-based (`lastReadMessageGuid`; the unread count is received messages newer than that
 * marker's `date_created`), so map each timestamp to the newest LOCAL received message at/before that
 * instant and advance the marker to it. Marker semantics mirror `getNewestReceivedGuid` (the target
 * the existing `chat-read-status-changed` reconcile uses): received (`is_from_me = 0`), non-deleted;
 * a retracted or reaction row CAN be the marker — only its `date_created` matters as the unread
 * threshold. MONOTONIC: advance only when the resolved message is strictly newer than the current
 * marker's message date, so a marker the user has read FURTHER on this device is never regressed. A
 * null timestamp, empty chat, unresolvable timestamp (nothing received at/before it), or a target no
 * newer than the current marker → no-op. Idempotent: re-running with the same timestamp is a no-op.
 *
 * Batched to avoid the old ~2-SELECTs-PER-CHAT cost (≈2N reads on every N-chat sync page — ~800 for a
 * 400-chat account, on EVERY sync): ONE query loads every chat's current marker date; a cheap
 * pre-filter drops chats whose watermark cannot advance the marker (`ts <= markerDate` ⇒ the
 * candidate, itself `<= ts`, can never be strictly newer — the common steady-state case, so most
 * chats do zero work); and each surviving chat takes ONE combined UPDATE that finds the candidate and
 * re-applies the monotonic guard atomically. Behavior is byte-identical to the per-chat version (same
 * strictly-greater advance, same `date_created DESC, id DESC` tie-break, same received/non-deleted
 * eligibility) — the readReconcile suite pins every branch.
 */
async function reconcileReadMarkersFromTimestamps(
  db: AppDatabase,
  pairs: { chatId: number; timestampMs: number }[],
): Promise<void> {
  if (pairs.length === 0) return;

  // One query for every chat's current marker message date — 0 when never read or the marker row
  // isn't local (mirrors the inbox unread query's COALESCE(..., 0)).
  const inList = sql.join(
    pairs.map((p) => sql`${p.chatId}`),
    sql`, `,
  );
  // Annotate the variable (not the db.all generic) — the loose AppDatabase types db.all's result as
  // `any`, so `.map` below would otherwise trip noImplicitAny (mirrors upsertMessages' `existing`).
  const markerRows: Array<{ chatId: number; markerDate: number }> = await db.all(sql`
    SELECT c.id AS chatId, COALESCE(lm.date_created, 0) AS markerDate
      FROM chats c LEFT JOIN messages lm ON lm.guid = c.last_read_message_guid
     WHERE c.id IN (${inList})
  `);
  const markerDate = new Map(markerRows.map((r) => [r.chatId, r.markerDate]));

  for (const { chatId, timestampMs } of pairs) {
    const current = markerDate.get(chatId) ?? 0;
    // Pre-filter: the candidate (newest received at/before ts) has date_created <= ts, so if ts is
    // already <= the current marker date it can never be strictly newer — skip the per-chat write.
    if (timestampMs <= current) continue;
    // One combined statement (db.run — a non-returning UPDATE): point the marker at the newest
    // received, non-deleted message at/before the watermark, but only when that candidate is strictly
    // newer than the current marker (the monotonic guard). `date_created <= ts` also drops NULL-dated
    // rows; a chat with no such candidate yields NULL from MAX(...) → the guard is false → no-op.
    await db.run(sql`
      UPDATE chats SET last_read_message_guid = (
        SELECT m.guid FROM messages m
         WHERE m.chat_id = ${chatId} AND m.is_from_me = 0 AND m.date_deleted IS NULL
           AND m.date_created <= ${timestampMs}
         ORDER BY m.date_created DESC, m.id DESC LIMIT 1
      )
      WHERE id = ${chatId}
        AND (SELECT MAX(m.date_created) FROM messages m
              WHERE m.chat_id = ${chatId} AND m.is_from_me = 0 AND m.date_deleted IS NULL
                AND m.date_created <= ${timestampMs}) > ${current}
    `);
  }
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
 * Pin / unpin a chat. Client-local — Gator pin is a device state, not a server
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
  // Genmoji description of the latest message's first Genmoji attachment (or null) — the inbox
  // preview fallback in place of "📎 Attachment". Optional so hand-built InboxRow test literals need
  // not set it; the query below always provides it at runtime.
  lastAttachmentDescription?: string | null;
  participantCount: number;
  participantNames: string | null;
  participantAvatars: string | null;
  /** Comma-joined participant handle services ('iMessage'/'SMS'), for `resolveChatService`. */
  handleServices: string | null;
  unreadCount: number;
  /** 1 when any participant matched a device contact — the "unknown senders" filter signal. */
  hasKnownSender: number;
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
          AND m2.date_deleted IS NULL
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
      (SELECT group_concat(COALESCE(h.service, ''), ',' ORDER BY h.id)
         FROM chat_handles ch JOIN handles h ON h.id = ch.handle_id
        WHERE ch.chat_id = c.id) AS handleServices,
      (SELECT COUNT(*) FROM messages um
         WHERE um.chat_id = c.id AND um.is_from_me = 0 AND um.associated_message_type IS NULL
           AND um.date_retracted IS NULL
           AND um.date_deleted IS NULL
           AND um.date_created > COALESCE(
             (SELECT lm.date_created FROM messages lm WHERE lm.guid = c.last_read_message_guid), 0)
      ) AS unreadCount,
      EXISTS(SELECT 1 FROM chat_handles ck JOIN handles hk ON hk.id = ck.handle_id
              WHERE ck.chat_id = c.id AND hk.contact_id IS NOT NULL) AS hasKnownSender
    FROM chats c
    LEFT JOIN last l ON l.chat_id = c.id
    ${whereArchived}
    ORDER BY c.is_pinned DESC, c.latest_message_date DESC
  `);
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
  /** Comma-joined participant handle services ('iMessage'/'SMS'), for `resolveChatService`. */
  handleServices: string | null;
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
        WHERE ch.chat_id = c.id) AS participantAvatars,
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
