import { mapWithConcurrency } from '@core/async/pool';
import { SYNC_BATCH_SIZE } from '@core/config';
import { logger } from '@core/secure';
import { advanceMarker, buildSyncCursor, GuidDeduper, type SyncMarker } from '@core/sync';
import {
  getChatIdByGuid,
  getSyncMarker,
  kvGet,
  kvSet,
  markMessageDeleted,
  maxMessageMarker,
  reconcileOutgoingAttachmentByContent,
  setSyncMarker,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import type { Message } from '@core/models';
import type { AppDatabase } from '@db/types';
import type { SyncApi } from './types';

export interface SyncProgress {
  chats: number;
  messages: number;
}

export interface FullSyncOptions {
  chatPageSize?: number;
  messagePageSize?: number;
  /** Cap messages fetched per chat during the initial sync (0/undefined = all). */
  maxMessagesPerChat?: number;
  onProgress?: (p: SyncProgress) => void;
}

/**
 * Fetch + store EVERY chat (the list + participants only, no messages), paging `chat/query`.
 * Returns the stored chats so a caller can page their messages. Cheap (a couple of requests for
 * hundreds of chats), so it runs on every sync — that's what surfaces conversations (e.g. older
 * SMS threads) that an interrupted first sync never reached; their history backfills on demand.
 */
export async function syncAllChats(
  db: AppDatabase,
  api: SyncApi,
  chatPageSize = 200,
): Promise<{ guid: string; chatId: number }[]> {
  const stored: { guid: string; chatId: number }[] = [];
  let offset = 0;
  for (;;) {
    const batch = await api.fetchChats(offset, chatPageSize);
    if (batch.length === 0) break;
    const handleMap = await upsertHandles(
      db,
      batch.flatMap((c) => c.participants ?? []),
    );
    const chatMap = await upsertChats(db, batch, handleMap);
    // Also persist each chat's lastMessage (chat/query returns it via `with:['lastMessage']`) so
    // EVERY chat gets a preview + a denormalized latest_message_date. Without this, a chat whose
    // messages the incremental sync can't page — notably RCS, whose messages carry NO server
    // rowid and are skipped by the rowid-cursor incremental pass — stays message-less and sinks to
    // the bottom of the inbox with no date/preview. upsertMessages refreshes latest_message_date,
    // and is idempotent, so a chat that later backfills its full history is unaffected.
    const lastMsgs: Message[] = [];
    const chatIdByMsgGuid = new Map<string, number>();
    for (const chat of batch) {
      const chatId = chatMap.get(chat.guid);
      if (chatId == null) continue;
      stored.push({ guid: chat.guid, chatId });
      if (chat.lastMessage != null) {
        lastMsgs.push(chat.lastMessage);
        chatIdByMsgGuid.set(chat.lastMessage.guid, chatId);
      }
    }
    if (lastMsgs.length > 0) {
      const msgHandleMap = await upsertHandles(
        db,
        lastMsgs.flatMap((m) => (m.handle ? [m.handle] : [])),
      );
      // Reconcile our own optimistic attachment sends (notably RCS — no server rowid, so it's
      // materialized here on reconnect rather than by the live echo) BEFORE the upsert, so a
      // just-sent picture's on-disk local_path is preserved instead of duplicated as an image-less
      // bubble. Sync-safe: only a still-pending temp send that owns a local attachment can match.
      for (const m of lastMsgs) {
        const cid = chatIdByMsgGuid.get(m.guid);
        if (m.isFromMe && cid != null) await reconcileOutgoingAttachmentByContent(db, m, cid);
      }
      await upsertMessages(db, lastMsgs, (m) => chatIdByMsgGuid.get(m.guid), msgHandleMap);
    }
    offset += batch.length;
    if (batch.length < chatPageSize) break;
  }
  return stored;
}

/**
 * Initial full sync: store all chats, then page bounded recent messages per chat into the DB.
 * Finishes by setting the incremental marker to the highest message rowid/date stored.
 */
export async function fullSync(
  db: AppDatabase,
  api: SyncApi,
  opts: FullSyncOptions = {},
): Promise<SyncProgress> {
  const messagePageSize = opts.messagePageSize ?? 100;
  // Cap per-chat history in the bulk pass so EVERY chat is reached (full history loads on demand
  // via ensureChatSynced when a thread opens). An unbounded per-chat pull made a busy chat
  // monopolize the whole sync, so on a slow/flaky link later chats — disproportionately older SMS
  // conversations — were never reached and never appeared.
  const maxPerChat = opts.maxMessagesPerChat ?? 100;
  let messages = 0;

  // Phase 1: store ALL chats first (fast — just the list + participants). This guarantees every
  // conversation shows in the inbox even if the message pass below is interrupted by a timeout.
  const stored = await syncAllChats(db, api, opts.chatPageSize ?? 200);
  const chats = stored.length;
  opts.onProgress?.({ chats, messages });

  // Phase 2: bounded recent messages per chat, PACED (small concurrency + a per-task delay) so the
  // bulk pull doesn't peg a single self-hosted server. Per-chat errors are isolated so one
  // unreachable chat (or a mid-sync drop) can't abort the rest — those chats backfill later.
  await mapWithConcurrency(
    stored,
    CHAT_BACKFILL_CONCURRENCY,
    async ({ guid, chatId }) => {
      let mOffset = 0;
      for (;;) {
        const msgs = await api.fetchChatMessages(guid, mOffset, messagePageSize);
        if (msgs.length === 0) break;
        const msgHandleMap = await upsertHandles(
          db,
          msgs.flatMap((m) => (m.handle ? [m.handle] : [])),
        );
        await upsertMessages(db, msgs, () => chatId, msgHandleMap);
        messages += msgs.length;
        opts.onProgress?.({ chats, messages });
        mOffset += msgs.length;
        if (msgs.length < messagePageSize || mOffset >= maxPerChat) break;
      }
    },
    { delayMs: CHAT_BACKFILL_DELAY_MS },
  );

  await setSyncMarker(db, await maxMessageMarker(db));
  return { chats, messages };
}

/** Full-sync message pass pacing — the server runs queries synchronously (one core), so keep
 *  concurrency low and leave a gap so it stays responsive to other requests. */
export const CHAT_BACKFILL_CONCURRENCY = 2;
export const CHAT_BACKFILL_DELAY_MS = 75;

/**
 * On-demand backfill of ONE chat's messages from the server, independent of the global
 * full/incremental sync. Opening a thread calls this so its history is present even when the
 * large initial sync hasn't reached that chat yet (or was interrupted) — pages
 * `/chat/:guid/message` (newest-first) and upserts each page until exhausted or `maxMessages`.
 * Idempotent (upsert COALESCE), so re-opening a thread re-confirms without duplicating.
 */
export async function syncChatMessages(
  db: AppDatabase,
  api: SyncApi,
  chatGuid: string,
  opts: { pageSize?: number; maxMessages?: number } = {},
): Promise<number> {
  const chatId = await getChatIdByGuid(db, chatGuid);
  if (chatId == null) return 0; // chat not synced yet — nothing to attach messages to
  const pageSize = opts.pageSize ?? 100;
  const cap = opts.maxMessages ?? 500;
  let offset = 0;
  let total = 0;
  for (;;) {
    const msgs = await api.fetchChatMessages(chatGuid, offset, pageSize);
    if (msgs.length === 0) break;
    const handleMap = await upsertHandles(
      db,
      msgs.flatMap((m) => (m.handle ? [m.handle] : [])),
    );
    // Reconcile our own optimistic attachment sends (notably RCS — no server rowid, so it's
    // materialized here on thread re-open / pull-to-refresh rather than by the live echo) BEFORE the
    // upsert, so a just-sent picture's on-disk local_path is preserved instead of duplicated as an
    // image-less bubble. Sync-safe: only a still-pending temp send that owns a local attachment matches.
    for (const m of msgs) {
      if (m.isFromMe) await reconcileOutgoingAttachmentByContent(db, m, chatId);
    }
    await upsertMessages(db, msgs, () => chatId, handleMap);
    total += msgs.length;
    offset += msgs.length;
    if (msgs.length < pageSize) break;
    if (total >= cap) break;
  }
  return total;
}

/** kv key holding the deletion-catch-up watermark: the max `dateDeleted` (Unix ms) already applied. */
export const DELETIONS_SYNCED_AT_KEY = 'sync.deletionsSyncedAt';
/** Server page cap for GET /message/deleted — a FULL page means more rows may remain. */
export const DELETION_SYNC_PAGE_SIZE = 500;
/** Bounded catch-up: at most this many pages per sync (any remainder catches up next sync). */
export const DELETION_SYNC_MAX_PAGES = 5;

export interface DeletionSyncOptions {
  /** The server's `supports_message_deleted` capability (sessionAccessors.messageDeletedSupported()). */
  supported: boolean;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Page cap per sync (default {@link DELETION_SYNC_MAX_PAGES}). */
  maxPages?: number;
  /** Full-page threshold (default {@link DELETION_SYNC_PAGE_SIZE}; overridable so tests can page small). */
  pageSize?: number;
}

/**
 * R1 deletion catch-up sync: apply `message-deleted` events the app MISSED while dead or
 * app-locked (the locked FCM path never touches the DB, so a live-only deletion is lost and the
 * deleted message lingers forever). Pages `GET /message/deleted?after=<watermark>` and re-applies
 * each row through the SAME `markMessageDeleted` tombstone the live event uses (idempotent — rows
 * sharing the watermark's exact ms may legitimately re-emit).
 *
 * Watermark (`sync.deletionsSyncedAt`, kv): the max `dateDeleted` already applied. FIRST RUN seeds
 * it to now() WITHOUT fetching — mirroring the server's own seeding argument: a fresh install has
 * no missed events, and replaying the server's whole deletion history would tombstone-spam rows
 * the user never saw. A row with a null `dateDeleted` is still tombstoned (now() fallback, same as
 * the live sink) but never advances the watermark. A full page whose max `dateDeleted` does NOT
 * advance the watermark stops the loop (re-fetching the identical page would spin).
 *
 * Returns the number of deletion rows applied. Callers gate on `supported` (older servers 404).
 */
export async function syncDeletedMessages(
  db: AppDatabase,
  api: SyncApi,
  opts: DeletionSyncOptions,
): Promise<number> {
  if (!opts.supported) return 0;
  const now = opts.now ?? Date.now;
  const maxPages = opts.maxPages ?? DELETION_SYNC_MAX_PAGES;
  const pageSize = opts.pageSize ?? DELETION_SYNC_PAGE_SIZE;

  const raw = await kvGet(db, DELETIONS_SYNCED_AT_KEY);
  let watermark = raw == null ? Number.NaN : Number(raw);
  if (!Number.isFinite(watermark)) {
    // First supported run (or a corrupt value): seed to now and do NOT replay history.
    await kvSet(db, DELETIONS_SYNCED_AT_KEY, String(now()));
    return 0;
  }

  let applied = 0;
  for (let page = 0; page < maxPages; page++) {
    const rows = await api.fetchDeletedAfter(watermark);
    if (rows.length === 0) break;

    let pageMax = watermark;
    for (const row of rows) {
      if (!row.guid) continue;
      // Unknown guid (never synced / already hard-gone) is a safe no-op inside markMessageDeleted.
      await markMessageDeleted(db, row.guid, row.dateDeleted ?? now());
      applied++;
      if (row.dateDeleted != null && row.dateDeleted > pageMax) pageMax = row.dateDeleted;
    }

    const advanced = pageMax > watermark;
    if (advanced) {
      watermark = pageMax;
      await kvSet(db, DELETIONS_SYNCED_AT_KEY, String(watermark));
    }
    // Loop ONLY on a full page that moved the watermark; a stuck watermark would refetch the
    // identical page forever (e.g. a full page of null-dateDeleted rows).
    if (rows.length < pageSize || !advanced) break;
  }
  return applied;
}

export interface IncrementalSyncOptions {
  serverVersion: string;
  batchSize?: number;
  /** Shared deduper (e.g. with the live socket path) to avoid double-processing. */
  deduper?: GuidDeduper;
  /**
   * Fired after EACH page is persisted (not just at the end) so a DB-reactive
   * inbox hydrates mid-sync. `chats` is the running count of distinct chats
   * seen, `messages` the running count of fresh messages stored.
   */
  onProgress?: (p: SyncProgress) => void;
}

/**
 * Incremental sync: fetch messages after the stored cursor (rowid on server
 * >= 1.6.0, else timestamp), dedup by guid, upsert their embedded chats +
 * handles + the messages, and advance the marker. Port of
 * incremental_sync_manager.dart. The marker advances on every batch (even
 * all-duplicate ones) to guarantee forward progress.
 *
 * Each page is committed by its own `upsertChats`/`upsertMessages` calls (NOT
 * batched into one transaction spanning the whole loop), so the drizzle adapter
 * flushes op-sqlite's reactive queries per page and `onProgress` ticks per page
 * — letting the inbox render as data arrives.
 */
export async function incrementalSync(
  db: AppDatabase,
  api: SyncApi,
  opts: IncrementalSyncOptions,
): Promise<SyncProgress> {
  const batchSize = opts.batchSize ?? SYNC_BATCH_SIZE;
  const deduper = opts.deduper ?? new GuidDeduper();
  let marker: SyncMarker = await getSyncMarker(db);
  let messages = 0;
  const seenChats = new Set<string>();

  for (;;) {
    const cursor = buildSyncCursor(opts.serverVersion, marker);
    const batch = await api.fetchMessagesAfter(cursor, batchSize);
    if (batch.length === 0) break;

    const fresh = batch.filter((m) => deduper.markIfNew(m.guid));
    if (fresh.length > 0) {
      const embeddedChats = fresh.flatMap((m) => m.chats ?? []);
      const handleMap = await upsertHandles(db, [
        ...embeddedChats.flatMap((c) => c.participants ?? []),
        ...fresh.flatMap((m) => (m.handle ? [m.handle] : [])),
      ]);
      const chatMap = await upsertChats(db, embeddedChats, handleMap);
      await upsertMessages(
        db,
        fresh,
        (m) => {
          const guid = m.chats?.[0]?.guid;
          return guid ? chatMap.get(guid) : undefined;
        },
        handleMap,
      );
      messages += fresh.length;
      for (const c of embeddedChats) seenChats.add(c.guid);
    }

    const prevMarker = marker;
    marker = advanceMarker(
      marker,
      batch.map((m) => ({ rowId: m.originalROWID ?? null, timestamp: m.dateCreated ?? null })),
    );
    await setSyncMarker(db, marker);

    // Per-page tick: this page's writes are already committed + flushed above, so
    // surfacing progress here lets the reactive inbox catch up immediately.
    opts.onProgress?.({ chats: seenChats.size, messages });

    if (batch.length < batchSize) break;

    // TERMINATION GUARD. `advanceMarker` takes a STRICT max, so a full page in which no row is
    // newer than the marker leaves it unchanged — and `buildSyncCursor` then rebuilds a
    // byte-identical cursor, refetching the identical page forever. The dedupe makes `fresh`
    // empty on the repeat, so there are no DB writes and no error: the loop just spins on the
    // network, silently, until the process dies.
    //
    // Reachable in timestamp mode (chosen whenever lastSyncedRowId is null — the first page after
    // install, and permanently if the server omits originalROWID) when a full page's rows all sit
    // at or below the marker: >= batchSize messages sharing a timestamp inside TIMESTAMP_OVERLAP_MS,
    // or a page whose dateCreated values are all null.
    //
    // If the marker can't advance we cannot make progress with this cursor at all, so stopping is
    // strictly better than looping — any remainder is picked up by the next sync run.
    if (
      marker.lastSyncedRowId === prevMarker.lastSyncedRowId &&
      marker.lastSyncedTimestamp === prevMarker.lastSyncedTimestamp
    ) {
      logger.warn(
        `[sync] incremental cursor stalled after a full page (${batch.length} rows, marker rowId=${
          marker.lastSyncedRowId ?? 'none'
        } ts=${marker.lastSyncedTimestamp ?? 'none'}) — stopping to avoid refetching it forever`,
      );
      break;
    }
  }

  return { chats: seenChats.size, messages };
}
