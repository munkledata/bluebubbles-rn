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
import { withDbTransaction } from '@db/transaction';
import type { Chat, Message } from '@core/models';
import type { AppDatabase } from '@db/types';
import type { SyncApi } from './types';

export interface SyncProgress {
  chats: number;
  messages: number;
}

/** A chat this sync stored, plus enough of its payload to finish reconciling it. */
export interface StoredChat {
  guid: string;
  chatId: number;
  /**
   * The chat's server payload with `participants`/`lastMessage` dropped — both were consumed by
   * the pass that stored it, and holding them for every chat until a full sync ends is real memory
   * on a phone. What remains is what re-applying the read watermark needs
   * (see {@link reapplyReadWatermarks}).
   */
  chat: Chat;
}

/** Chats per re-apply statement — mirrors the chat page size, so it is never a bigger batch than
 *  the one `upsertChats` already handles in a single INSERT. */
const WATERMARK_REAPPLY_CHUNK = 200;

/**
 * Re-apply the macOS read watermarks (`Chat.lastReadMessageTimestamp`) of chats we have ALREADY
 * stored, now that their messages exist locally.
 *
 * WHY THIS IS NEEDED AT ALL: the watermark reconcile lives inside `upsertChats` and resolves each
 * timestamp against the LOCAL `messages` table — but a chat row is necessarily written BEFORE the
 * messages that hang off it, so on a first sync it resolved against an EMPTY table: the monotonic
 * guard `MAX(m.date_created) > current` evaluated NULL > 0, every UPDATE matched zero rows, and the
 * Mac's read state was fetched and silently thrown away. A fresh install (and every reconnect after
 * Disconnect) then opened with a full unread badge on every conversation the user had already read.
 *
 * Cheap to repeat: the reconcile is monotonic (it only ever advances a marker) and idempotent, so a
 * chat whose watermark already landed does no work at all. Chats carrying no watermark are dropped,
 * and the participants list is stripped from the re-run payload — `upsertChats` treats an absent
 * participants list as "no information" and skips the per-chat link reconcile, which is the
 * expensive part (one DELETE per chat). Every other value is the same object the first pass wrote,
 * so the conflict clause re-writes identical values.
 */
async function reapplyReadWatermarks(db: AppDatabase, items: Chat[]): Promise<void> {
  const carrying = items.filter((c) => c.lastReadMessageTimestamp != null);
  if (carrying.length === 0) return;
  // Participants are stripped, so the handle map is never read.
  const noHandles = new Map<string, number>();
  for (let i = 0; i < carrying.length; i += WATERMARK_REAPPLY_CHUNK) {
    const slice = carrying
      .slice(i, i + WATERMARK_REAPPLY_CHUNK)
      .map((c) => ({ ...c, participants: null }));
    await upsertChats(db, slice, noHandles);
  }
}

export interface FullSyncOptions {
  chatPageSize?: number;
  messagePageSize?: number;
  /** Cap messages fetched per chat during the initial sync (0/undefined = all). */
  maxMessagesPerChat?: number;
  onProgress?: (p: SyncProgress) => void;
  /**
   * "Is the session this run started under still the current one?" — asked before the closing
   * phases, which are the only ones that write WITHOUT first fetching (see the call site in
   * `fullSync`). Injected rather than read from the session store here so this module stays
   * store-free and node-testable; `runSync` supplies it.
   */
  shouldAbort?: () => boolean;
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
): Promise<StoredChat[]> {
  const stored: StoredChat[] = [];
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
      stored.push({
        guid: chat.guid,
        chatId,
        chat: { ...chat, participants: null, lastMessage: null },
      });
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
      // The chats above were written BEFORE these messages, so their read-watermark reconcile had
      // nothing to resolve against — re-run it now that this page's newest message per chat exists.
      await reapplyReadWatermarks(db, batch);
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

  // EVERYTHING BELOW WRITES WITHOUT FETCHING FIRST, which is what makes this check load-bearing.
  // A Disconnect landing mid-sync is neutralised everywhere else by the credential clear: with the
  // origin gone every request fails, so a fetch-then-write phase persists nothing. Phase 3 replays
  // the phase-1 snapshot from memory and phase 4 reads the local messages table, so neither is
  // reached by that. `forget()` does wait for this run, but only for a bounded 20s, and phase 2 on
  // a large account outlives that easily (every chat's fetch burns its full retry ladder now that
  // the origin is gone) — so by here the wipe may already have emptied `chats`. `upsertChats` is an
  // INSERT … ON CONFLICT, so re-applying watermarks would RE-CREATE every chat of the account the
  // user just disconnected from; connect to a different server and they appear in ITS inbox. Bail.
  //
  // The check is "is the origin still the one this run started under", not "is there an origin":
  // a Disconnect followed by connecting to a NEW server before this point is the worse version of
  // the same bug, and a session exists in that case. A tunnel rotation (`applyNewServerUrl`)
  // rewrites the origin for the SAME server and so trips this too — that costs one skipped
  // watermark pass, redone by the next sync, which is the cheap side of the trade.
  if (opts.shouldAbort?.()) {
    logger.warn(
      '[sync] the session ended mid-full-sync — skipping the read-watermark re-apply and the marker write',
    );
    return { chats, messages };
  }

  // Phase 3: re-apply the Mac's read watermarks. THIS is the run that matters on a fresh install —
  // phase 1 could only resolve a watermark against each chat's single `lastMessage` (and against
  // nothing at all when that message is one the user sent), so the marker it can reach is far
  // behind what the backfill above just made available. One batched pass over the chats that carry
  // a watermark; monotonic, so it can only move markers forward.
  await reapplyReadWatermarks(
    db,
    stored.map((s) => s.chat),
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

/**
 * Messages per page TRANSACTION (see {@link incrementalSync}).
 *
 * A page is up to `SYNC_BATCH_SIZE` (250) messages, and storing one is nowhere near "a couple of
 * statements": `upsertHandles` runs a full contacts scan + an UPDATE per newly-linked handle,
 * `upsertChats` issues a DELETE per chat carrying participants, and `upsertMessages` runs 1-2
 * SELECTs per ATTACHMENT. A whole page in one transaction is therefore hundreds of round trips
 * held under a lock that is GLOBAL — `withDbTransaction` serializes every caller onto one shared
 * connection, so for that entire time a live message's write waits, and any plain autocommit write
 * (an optimistic send, a read marker, a download's local-path write) silently JOINS the page's
 * transaction and is destroyed with it if the page rolls back. Slicing bounds each lock to a few
 * tens of statements and lets those writers interleave between slices.
 */
export const INCREMENTAL_TX_CHUNK = 50;

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
 * WRITES ARE TRANSACTIONAL IN SLICES OF {@link INCREMENTAL_TX_CHUNK}, never one transaction per
 * page and never one spanning the loop. Each slice is self-contained (its handles, its chats, its
 * messages), and the marker rides the LAST slice's commit — so the invariant the slicing is FOR
 * holds (the cursor can never become durable ahead of a slice that failed to write) without any
 * single lock being long. Stated precisely because it is narrower than "ahead of the rows it
 * claims we have": a row `upsertMessages` itself DECLINES — a message whose embedded chat list is
 * empty has no thread to attach it to — is skipped, while `nextMarker` is computed from the whole
 * page, so the cursor does move past it. That is the right behaviour (holding the marker back for
 * a permanently chat-less row would refetch the same page forever), but it must not be silent, so
 * the slice logs the count. Never wider than a slice, because `withDbTransaction` is a global mutex on one
 * shared connection: a long transaction stalls live-message writes behind it and drags every
 * concurrent autocommit writer into a rollback that has nothing to do with them. Each commit also
 * flushes op-sqlite's reactive queries, which is what lets the inbox render as data arrives.
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
    // Page-level, for the progress counters only — the writes below work slice by slice.
    const embeddedChats = fresh.flatMap((m) => m.chats ?? []);
    const prevMarker = marker;
    // Computed BEFORE the writes so no transaction below holds anything but SQL. Pure function.
    const nextMarker = advanceMarker(
      marker,
      batch.map((m) => ({ rowId: m.originalROWID ?? null, timestamp: m.dateCreated ?? null })),
    );

    // The rows and the marker that says "we already have them" must never diverge. There is ONE
    // shared connection, so a plain autocommit write silently JOINS whatever transaction another
    // writer (DbEventSink wraps every live message in one) happens to have open — and a rollback
    // THERE takes those rows with it. The marker would still commit, because it is computed from
    // what the SERVER returned rather than from what persisted, and `buildSyncCursor` is a strict
    // forward cursor: those messages are never fetched again, and nothing ever notices.
    //
    // So every write owns a transaction — but a SLICE-sized one, not a page-sized one (see
    // INCREMENTAL_TX_CHUNK for why the difference matters to every other writer on the
    // connection). A slice carries its own handles and chats rather than sharing one hoisted pass,
    // because each level hands row ids to the next: handles/chats written outside the lock could
    // be rolled back as a bystander, leaving this slice inserting messages against ids that no
    // longer exist.
    if (fresh.length === 0) {
      // An all-duplicate page still advances the cursor (that is what guarantees forward
      // progress), and with no rows written there is nothing for the marker to outrun.
      await setSyncMarker(db, nextMarker);
    } else {
      for (let i = 0; i < fresh.length; i += INCREMENTAL_TX_CHUNK) {
        const slice = fresh.slice(i, i + INCREMENTAL_TX_CHUNK);
        const isLastSlice = i + INCREMENTAL_TX_CHUNK >= fresh.length;
        const sliceChats = slice.flatMap((m) => m.chats ?? []);
        await withDbTransaction(db, async () => {
          const handleMap = await upsertHandles(db, [
            ...sliceChats.flatMap((c) => c.participants ?? []),
            ...slice.flatMap((m) => (m.handle ? [m.handle] : [])),
          ]);
          const chatMap = await upsertChats(db, sliceChats, handleMap);
          const stored = await upsertMessages(
            db,
            slice,
            (m) => {
              const guid = m.chats?.[0]?.guid;
              return guid ? chatMap.get(guid) : undefined;
            },
            handleMap,
          );
          // `upsertMessages` drops any message whose chat it cannot resolve, and the cursor still
          // advances past it (see the note on this function) — so this is the only place the drop
          // is observable at all. Expected to be zero: the trigger we know of is a server row with
          // an empty `chats` array, which has no thread to render in either way. A non-zero count
          // against rows that DO have a thread would be real, invisible message loss.
          if (stored.size < slice.length) {
            logger.warn(
              `[sync] ${slice.length - stored.size} message(s) in this page had no resolvable chat and were skipped`,
            );
          }
          // The marker becomes durable ONLY with the last slice, so it can never claim a page an
          // earlier slice failed to write. The other direction is deliberately allowed: slices
          // committing without the marker just means the next run re-fetches the page, and every
          // upsert here is idempotent, so the cost is one redundant request.
          if (isLastSlice) await setSyncMarker(db, nextMarker);
        });
      }
    }

    // Only count what actually committed — the throw above propagates instead of reaching here.
    marker = nextMarker;
    messages += fresh.length;
    for (const c of embeddedChats) seenChats.add(c.guid);

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
