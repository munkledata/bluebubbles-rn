import { mapWithConcurrency } from '@core/async/pool';
import { SYNC_BATCH_SIZE } from '@core/config';
import { advanceMarker, buildSyncCursor, GuidDeduper, type SyncMarker } from '@core/sync';
import {
  getChatIdByGuid,
  getSyncMarker,
  maxMessageMarker,
  setSyncMarker,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
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
    for (const chat of batch) {
      const chatId = chatMap.get(chat.guid);
      if (chatId != null) stored.push({ guid: chat.guid, chatId });
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
    await upsertMessages(db, msgs, () => chatId, handleMap);
    total += msgs.length;
    offset += msgs.length;
    if (msgs.length < pageSize) break;
    if (total >= cap) break;
  }
  return total;
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

    marker = advanceMarker(
      marker,
      batch.map((m) => ({ rowId: m.originalROWID ?? null, timestamp: m.dateCreated ?? null })),
    );
    await setSyncMarker(db, marker);

    // Per-page tick: this page's writes are already committed + flushed above, so
    // surfacing progress here lets the reactive inbox catch up immediately.
    opts.onProgress?.({ chats: seenChats.size, messages });

    if (batch.length < batchSize) break;
  }

  return { chats: seenChats.size, messages };
}
