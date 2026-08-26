import { mapWithConcurrency } from '@core/async/pool';
import { DELETED_MESSAGE_PAGE_LIMIT, type DeletedMessage } from '@core/api/endpoints/messages';
import { SYNC_BATCH_SIZE } from '@core/config';
import { logger } from '@core/secure';
import { advanceMarker, buildSyncCursor, GuidDeduper, type SyncMarker } from '@core/sync';
import {
  getChatIdByGuid,
  getSyncMarker,
  kvGet,
  kvSetWithinTransaction,
  linkHandlesToContacts,
  markMessageDeletedWithinTransaction,
  maxMessageMarker,
  reconcileOutgoingAttachmentByContent,
  setSyncMarkerWithinTransaction,
  upsertChatsWithinTransaction,
  upsertHandlesWithinTransaction,
  upsertMessagesWithinTransaction,
} from '@db/repositories';
import {
  type DbCommitGuard,
  type DbTransactionContext,
  DbCommitGuardRejectedError,
  runInTransactionContext,
  withDbTransaction,
} from '@db/transaction';
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

/**
 * Chat rows per transaction. `upsertChats` can issue participant-prune and read-watermark
 * statements per chat, so this is intentionally much smaller than a 200-chat server page.
 */
const CHAT_TX_CHUNK = 5;
const WATERMARK_REAPPLY_CHUNK = CHAT_TX_CHUNK;

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
async function reapplyReadWatermarksWithinTransaction(
  transactionContext: DbTransactionContext,
  items: Chat[],
): Promise<void> {
  await runInTransactionContext(transactionContext, async () => {
    const carrying = items.filter((c) => c.lastReadMessageTimestamp != null);
    if (carrying.length === 0) return;
    // Participants are stripped, so the handle map is never read.
    const noHandles = new Map<string, number>();
    for (let i = 0; i < carrying.length; i += WATERMARK_REAPPLY_CHUNK) {
      const slice = carrying
        .slice(i, i + WATERMARK_REAPPLY_CHUNK)
        .map((c) => ({ ...c, participants: null }));
      await upsertChatsWithinTransaction(transactionContext, slice, noHandles);
    }
  });
}

/** Public-owner shape: one bounded chat slice per guarded transaction. */
async function reapplyReadWatermarks(
  db: AppDatabase,
  items: Chat[],
  commitGuard?: DbCommitGuard,
): Promise<void> {
  for (let i = 0; i < items.length; i += WATERMARK_REAPPLY_CHUNK) {
    const slice = items.slice(i, i + WATERMARK_REAPPLY_CHUNK);
    await withDbTransaction(
      db,
      (transactionContext) => reapplyReadWatermarksWithinTransaction(transactionContext, slice),
      commitGuard,
    );
  }
}

export interface FullSyncOptions {
  chatPageSize?: number;
  messagePageSize?: number;
  /** Cap messages fetched per chat during the initial sync (`0` = all; default = 100). */
  maxMessagesPerChat?: number;
  onProgress?: (p: SyncProgress) => void;
  /**
   * "Is the session this run started under still the current one?" Checked around every network
   * response and again at transaction admission/commit. Injected rather than read from the session
   * store here so this module stays store-free and node-testable; `runSync` supplies it.
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
  shouldAbort?: () => boolean,
): Promise<StoredChat[]> {
  const boundedPageSize =
    Number.isFinite(chatPageSize) && chatPageSize > 0 ? Math.min(Math.floor(chatPageSize), 200) : 0;
  if (boundedPageSize === 0 || shouldAbort?.()) return [];
  const shouldContinue = (): boolean => !(shouldAbort?.() ?? false);
  const commitGuard = shouldAbort ? shouldContinue : undefined;
  const stored: StoredChat[] = [];
  let offset = 0;
  for (;;) {
    if (!shouldContinue()) break;
    const batch = await api.fetchChats(offset, boundedPageSize);
    if (!shouldContinue()) break;
    if (batch.length === 0) break;
    const pageRows = batch.slice(0, boundedPageSize);
    const pageContactAddresses = new Set<string>();
    for (let i = 0; i < pageRows.length; i += CHAT_TX_CHUNK) {
      const slice = pageRows.slice(i, i + CHAT_TX_CHUNK);
      const participantHandles = slice.flatMap((chat) => chat.participants ?? []);
      for (const handle of participantHandles) pageContactAddresses.add(handle.address);
      let chatMap = new Map<string, number>();
      await withDbTransaction(
        db,
        async (transactionContext) => {
          const handleMap = await upsertHandlesWithinTransaction(
            transactionContext,
            participantHandles,
          );
          chatMap = await upsertChatsWithinTransaction(transactionContext, slice, handleMap);
        },
        commitGuard,
      );
      if (!shouldContinue()) return stored;

      // Also persist each chat's lastMessage (chat/query returns it via `with:['lastMessage']`) so
      // EVERY chat gets a preview + a denormalized latest_message_date. Without this, a chat whose
      // messages the incremental sync can't page — notably RCS — stays message-less and sinks to
      // the bottom of the inbox with no date/preview.
      const lastMsgs: Message[] = [];
      const chatIdByMsgGuid = new Map<string, number>();
      const storedSlice: StoredChat[] = [];
      for (const chat of slice) {
        const chatId = chatMap.get(chat.guid);
        if (chatId == null) continue;
        storedSlice.push({
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
        const messageHandles = lastMsgs.flatMap((message) =>
          message.handle ? [message.handle] : [],
        );
        for (const handle of messageHandles) pageContactAddresses.add(handle.address);
        // The content reconciler deliberately owns its own short transaction and therefore runs
        // before, never inside, the message-slice transaction.
        for (const message of lastMsgs) {
          if (!shouldContinue()) return stored;
          const chatId = chatIdByMsgGuid.get(message.guid);
          if (message.isFromMe && chatId != null) {
            await reconcileOutgoingAttachmentByContent(db, message, chatId, commitGuard);
          }
        }
        await withDbTransaction(
          db,
          async (transactionContext) => {
            const msgHandleMap = await upsertHandlesWithinTransaction(
              transactionContext,
              messageHandles,
            );
            await upsertMessagesWithinTransaction(
              transactionContext,
              lastMsgs,
              (m) => chatIdByMsgGuid.get(m.guid),
              msgHandleMap,
            );
            // The chats were written before these messages, so their watermark could not resolve
            // until now. Keep that final write in this same bounded domain transaction.
            await reapplyReadWatermarksWithinTransaction(transactionContext, slice);
          },
          commitGuard,
        );
        if (!shouldContinue()) return stored;
      }
      stored.push(...storedSlice);
    }
    await linkHandlesAfterCommit(db, [...pageContactAddresses], commitGuard);
    if (!shouldContinue()) return stored;
    offset += pageRows.length;
    if (batch.length < boundedPageSize) break;
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
  const messagePageSize =
    opts.messagePageSize == null
      ? CHAT_MESSAGE_PAGE_SIZE
      : Number.isFinite(opts.messagePageSize) && opts.messagePageSize > 0
        ? Math.min(Math.floor(opts.messagePageSize), CHAT_MESSAGE_PAGE_SIZE)
        : 0;
  // Cap per-chat history in the bulk pass so EVERY chat is reached (full history loads on demand
  // via ensureChatSynced when a thread opens). An unbounded per-chat pull made a busy chat
  // monopolize the whole sync, so on a slow/flaky link later chats — disproportionately older SMS
  // conversations — were never reached and never appeared.
  const maxPerChat =
    opts.maxMessagesPerChat == null
      ? CHAT_MESSAGE_PAGE_SIZE
      : opts.maxMessagesPerChat === 0
        ? Number.POSITIVE_INFINITY
        : Number.isFinite(opts.maxMessagesPerChat) && opts.maxMessagesPerChat > 0
          ? Math.min(Math.floor(opts.maxMessagesPerChat), CHAT_MESSAGE_MAX)
          : 0;
  const shouldContinue = (): boolean => !(opts.shouldAbort?.() ?? false);
  const commitGuard = opts.shouldAbort ? shouldContinue : undefined;
  let messages = 0;

  // Phase 1: store ALL chats first (fast — just the list + participants). This guarantees every
  // conversation shows in the inbox even if the message pass below is interrupted by a timeout.
  const stored = await syncAllChats(db, api, opts.chatPageSize ?? 200, opts.shouldAbort);
  const chats = stored.length;
  if (shouldContinue()) opts.onProgress?.({ chats, messages });
  if (!shouldContinue() || messagePageSize === 0 || maxPerChat === 0) {
    return { chats, messages };
  }

  // Phase 2: bounded recent messages per chat, PACED (small concurrency + a per-task delay) so the
  // bulk pull doesn't peg a single self-hosted server. Per-chat errors are isolated so one
  // unreachable chat (or a mid-sync drop) can't abort the rest — those chats backfill later.
  await mapWithConcurrency(
    stored,
    CHAT_BACKFILL_CONCURRENCY,
    async ({ guid, chatId }) => {
      let mOffset = 0;
      const seenPageFingerprints = new Set<string>();
      for (;;) {
        if (!shouldContinue()) return;
        const requestSize = Math.min(messagePageSize, maxPerChat - mOffset);
        if (requestSize <= 0) break;
        const msgs = await api.fetchChatMessages(guid, mOffset, requestSize);
        if (!shouldContinue()) return;
        if (msgs.length === 0) break;
        const pageRows = msgs.slice(0, requestSize);
        const pageFingerprint = pageRows.map((message) => message.guid).join('\u0000');
        if (seenPageFingerprints.has(pageFingerprint)) {
          logger.warn(
            `[sync] full-sync page repeated for chat ${guid} at offset ${mOffset} — stopping to avoid refetching it forever`,
          );
          break;
        }
        seenPageFingerprints.add(pageFingerprint);
        const pageHandles = pageRows.flatMap((message) => (message.handle ? [message.handle] : []));
        for (let i = 0; i < pageRows.length; i += INCREMENTAL_TX_CHUNK) {
          const slice = pageRows.slice(i, i + INCREMENTAL_TX_CHUNK);
          const sliceHandles = slice.flatMap((message) => (message.handle ? [message.handle] : []));
          await withDbTransaction(
            db,
            async (transactionContext) => {
              const msgHandleMap = await upsertHandlesWithinTransaction(
                transactionContext,
                sliceHandles,
              );
              await upsertMessagesWithinTransaction(
                transactionContext,
                slice,
                () => chatId,
                msgHandleMap,
              );
            },
            commitGuard,
          );
          messages += slice.length;
          if (!shouldContinue()) return;
        }
        await linkHandlesAfterCommit(
          db,
          pageHandles.map((handle) => handle.address),
          commitGuard,
        );
        if (!shouldContinue()) return;
        opts.onProgress?.({ chats, messages });
        mOffset += pageRows.length;
        if (msgs.length < requestSize || mOffset >= maxPerChat) break;
      }
    },
    { delayMs: CHAT_BACKFILL_DELAY_MS },
  );

  // EVERYTHING BELOW WRITES WITHOUT FETCHING FIRST, which makes this extra check load-bearing even
  // though every fetch-shaped phase above also checks account ownership around its request and at
  // transaction commit. Phase 3 replays the phase-1 snapshot from memory and phase 4 reads the local
  // messages table. If `forget()` reaches its bounded timeout and wipes while this run is queued,
  // `upsertChats` could otherwise RE-CREATE the disconnected account's chats. Bail.
  //
  // The check is "is this still the session this run started under", not "is there a session":
  // a Disconnect followed by connecting to another server before this point is the worse version
  // of the same bug, and a session exists in that case — as it does when the user reconnects to the
  // SAME server, which is why `runSync` identifies the session by a counter that never repeats
  // rather than by its URL. A tunnel rotation (`applyNewServerUrl`) re-points the same session at a
  // new URL and deliberately does NOT trip this: the account and the local DB are unchanged, so
  // there is nothing to protect and a skipped watermark pass would be pure loss.
  if (!shouldContinue()) {
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
    commitGuard,
  );

  await withDbTransaction(
    db,
    async (context) => setSyncMarkerWithinTransaction(context, await maxMessageMarker(db)),
    commitGuard,
  );
  return { chats, messages };
}

/** Full-sync message pass pacing — the server runs queries synchronously (one core), so keep
 *  concurrency low and leave a gap so it stays responsive to other requests. */
export const CHAT_BACKFILL_CONCURRENCY = 2;
export const CHAT_BACKFILL_DELAY_MS = 75;
const CHAT_MESSAGE_PAGE_SIZE = 100;
const CHAT_MESSAGE_MAX = 500;

/** Contact names/photos are presentation-only and must be matched after a domain commit. */
async function linkHandlesAfterCommit(
  db: AppDatabase,
  addresses: string[],
  commitGuard?: DbCommitGuard,
): Promise<void> {
  const unique = [...new Set(addresses.filter((address) => address.length > 0))];
  if (unique.length === 0 || (commitGuard && !commitGuard())) return;
  try {
    await linkHandlesToContacts(db, unique, undefined, commitGuard);
  } catch (error) {
    if (error instanceof DbCommitGuardRejectedError && commitGuard && !commitGuard()) return;
    logger.debug('[sync] post-commit contact linking skipped', error);
  }
}

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
  opts: { pageSize?: number; maxMessages?: number; shouldAbort?: () => boolean } = {},
): Promise<number> {
  if (opts.shouldAbort?.()) return 0;
  const chatId = await getChatIdByGuid(db, chatGuid);
  if (opts.shouldAbort?.()) return 0;
  if (chatId == null) return 0; // chat not synced yet — nothing to attach messages to
  const pageSize =
    opts.pageSize == null
      ? CHAT_MESSAGE_PAGE_SIZE
      : Number.isFinite(opts.pageSize) && opts.pageSize > 0
        ? Math.min(Math.floor(opts.pageSize), CHAT_MESSAGE_PAGE_SIZE)
        : 0;
  const cap =
    opts.maxMessages == null
      ? CHAT_MESSAGE_MAX
      : Number.isFinite(opts.maxMessages) && opts.maxMessages > 0
        ? Math.min(Math.floor(opts.maxMessages), CHAT_MESSAGE_MAX)
        : 0;
  if (pageSize === 0 || cap === 0) return 0;
  const shouldContinue = (): boolean => !(opts.shouldAbort?.() ?? false);
  const commitGuard = opts.shouldAbort ? shouldContinue : undefined;
  let offset = 0;
  let total = 0;
  for (;;) {
    if (!shouldContinue()) break;
    const msgs = await api.fetchChatMessages(chatGuid, offset, pageSize);
    // HttpClient deliberately keeps one immutable account-A transport snapshot for an entire
    // request/retry ladder. Resetting the live session therefore cannot cancel a request already
    // on the wire; re-check after every network await before any returned A row reaches the DB.
    if (!shouldContinue()) break;
    if (msgs.length === 0) break;
    // Preserve the established page-granular cap: once a page has been requested, store its whole
    // bounded prefix and then stop when `total >= cap`. A cap that is not divisible by pageSize can
    // therefore include at most one partial-page overage (never more than 99 rows).
    const pageRows = msgs.slice(0, pageSize);
    const pageHandles = pageRows.flatMap((message) => (message.handle ? [message.handle] : []));
    for (let i = 0; i < pageRows.length; i += INCREMENTAL_TX_CHUNK) {
      const slice = pageRows.slice(i, i + INCREMENTAL_TX_CHUNK);
      const sliceHandles = slice.flatMap((m) => (m.handle ? [m.handle] : []));
      try {
        // Reconcile our own optimistic attachment sends (notably RCS — no server rowid, so it's
        // materialized here on thread re-open / pull-to-refresh rather than by the live echo) BEFORE
        // the upsert. Each helper owns its own guarded short transaction, so it cannot be composed
        // inside the slice transaction below.
        for (const m of slice) {
          if (!shouldContinue()) return total;
          if (m.isFromMe) await reconcileOutgoingAttachmentByContent(db, m, chatId, commitGuard);
        }
        if (!shouldContinue()) return total;
        await withDbTransaction(
          db,
          async (transactionContext) => {
            const handleMap = await upsertHandlesWithinTransaction(
              transactionContext,
              sliceHandles,
            );
            await upsertMessagesWithinTransaction(
              transactionContext,
              slice,
              () => chatId,
              handleMap,
            );
          },
          commitGuard,
        );
      } catch (error) {
        if (error instanceof DbCommitGuardRejectedError && !shouldContinue()) return total;
        throw error;
      }
      total += slice.length;
      if (!shouldContinue()) return total;
    }
    await linkHandlesAfterCommit(
      db,
      pageHandles.map((handle) => handle.address),
      commitGuard,
    );
    if (!shouldContinue()) return total;
    offset += pageRows.length;
    if (msgs.length < pageSize) break;
    if (total >= cap) break;
  }
  return total;
}

/** kv key holding the deletion-catch-up watermark: the max `dateDeleted` (Unix ms) already applied. */
export const DELETIONS_SYNCED_AT_KEY = 'sync.deletionsSyncedAt';
/** Server page cap for GET /message/deleted — a FULL page means more rows may remain. */
export const DELETION_SYNC_PAGE_SIZE = DELETED_MESSAGE_PAGE_LIMIT;
/** Bounded catch-up: at most this many pages per sync (any remainder catches up next sync). */
export const DELETION_SYNC_MAX_PAGES = 5;

export type DeletionSyncProtocolErrorCode =
  | 'page-over-cap'
  | 'invalid-guid'
  | 'invalid-timestamp'
  | 'timestamp-before-watermark'
  | 'timestamp-out-of-order';

/**
 * A server response violated the deletion cursor contract. The message and code deliberately name
 * only the rule: never include a message guid, timestamp, or other response payload in logs.
 */
export class DeletionSyncProtocolError extends Error {
  constructor(readonly code: DeletionSyncProtocolErrorCode) {
    super(`Deletion sync protocol violation: ${code}`);
    this.name = 'DeletionSyncProtocolError';
  }
}

interface ValidatedDeletionPage {
  hasNullTimestamp: boolean;
  maxTimestamp: number;
}

/** Validate the COMPLETE response before its first tombstone or watermark write. */
function validateDeletionPage(
  rows: readonly DeletedMessage[],
  requestedWatermark: number,
  pageSize: number,
): ValidatedDeletionPage {
  if (rows.length > pageSize) throw new DeletionSyncProtocolError('page-over-cap');

  let previousTimestamp = requestedWatermark;
  let maxTimestamp = requestedWatermark;
  let hasNullTimestamp = false;
  for (const row of rows) {
    if (typeof row.guid !== 'string' || row.guid.length === 0) {
      throw new DeletionSyncProtocolError('invalid-guid');
    }
    if (row.dateDeleted == null) {
      hasNullTimestamp = true;
      continue;
    }
    if (!Number.isFinite(row.dateDeleted)) {
      throw new DeletionSyncProtocolError('invalid-timestamp');
    }
    if (row.dateDeleted < requestedWatermark) {
      throw new DeletionSyncProtocolError('timestamp-before-watermark');
    }
    if (row.dateDeleted < previousTimestamp) {
      throw new DeletionSyncProtocolError('timestamp-out-of-order');
    }
    previousTimestamp = row.dateDeleted;
    maxTimestamp = row.dateDeleted;
  }
  return { hasNullTimestamp, maxTimestamp };
}

export interface DeletionSyncOptions {
  /** The server's `supports_message_deleted` capability (sessionAccessors.messageDeletedSupported()). */
  supported: boolean;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Page cap per sync (default {@link DELETION_SYNC_MAX_PAGES}). */
  maxPages?: number;
  /** Full-page threshold (default {@link DELETION_SYNC_PAGE_SIZE}; overridable so tests can page small). */
  pageSize?: number;
  /** Stop before the next request/write when this account no longer owns the run. */
  shouldAbort?: () => boolean;
}

/**
 * R1 deletion catch-up sync: apply `message-deleted` events the app MISSED while dead or
 * app-locked (the locked FCM path never touches the DB, so a live-only deletion is lost and the
 * deleted message lingers forever). Pages `GET /message/deleted?after=<watermark>` and re-applies
 * each row through the SAME transaction-only tombstone helper the live event uses (idempotent —
 * rows sharing the watermark's exact ms may legitimately re-emit).
 *
 * Watermark (`sync.deletionsSyncedAt`, kv): the max `dateDeleted` already applied. FIRST RUN seeds
 * it to now() WITHOUT fetching to avoid replaying unbounded deletion history for rows this install
 * never stored. That containment is not a consistent snapshot: normal history sync runs first and
 * can ingest a row the server already considers deleted, and device clock skew can move the seed.
 * A server-issued snapshot cursor (or deleted-row metadata/exclusion in the history response) is
 * still required. Every response is validated in full before its first write: over-cap,
 * pre-watermark, or decreasing timestamps fail closed. Equal timestamps are valid. A row with a
 * null `dateDeleted` is still tombstoned (now() fallback, same as the live sink), but a FULL page
 * containing one cannot advance safely and stops without moving the watermark.
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
  const maxPages =
    opts.maxPages == null
      ? DELETION_SYNC_MAX_PAGES
      : Number.isFinite(opts.maxPages) && opts.maxPages > 0
        ? Math.min(Math.floor(opts.maxPages), DELETION_SYNC_MAX_PAGES)
        : 0;
  const pageSize =
    opts.pageSize == null
      ? DELETION_SYNC_PAGE_SIZE
      : Number.isFinite(opts.pageSize) && opts.pageSize > 0
        ? Math.min(Math.floor(opts.pageSize), DELETION_SYNC_PAGE_SIZE)
        : 0;
  const shouldContinue = (): boolean => !(opts.shouldAbort?.() ?? false);
  const commitGuard = opts.shouldAbort ? shouldContinue : undefined;
  if (!shouldContinue()) return 0;

  // Read and conditionally seed under one short lock. A bare read on the shared connection can see
  // a neighbouring transaction's uncommitted watermark; seeding from that phantom state can skip
  // this account's deletion window. No network work runs in this callback.
  const initial = await withDbTransaction(
    db,
    async (transactionContext) => {
      const raw = await kvGet(db, DELETIONS_SYNCED_AT_KEY);
      const parsed = raw == null ? Number.NaN : Number(raw);
      if (Number.isFinite(parsed)) return { seeded: false, watermark: parsed };
      const watermark = now();
      await kvSetWithinTransaction(transactionContext, DELETIONS_SYNCED_AT_KEY, String(watermark));
      return { seeded: true, watermark };
    },
    commitGuard,
  );
  if (initial.seeded || maxPages === 0 || pageSize === 0) return 0;
  let watermark = initial.watermark;

  let applied = 0;
  for (let page = 0; page < maxPages; page++) {
    if (!shouldContinue()) break;
    const rows = await api.fetchDeletedAfter(watermark);
    // HttpClient keeps an immutable request snapshot through retries. A Disconnect cannot cancel
    // that already-running request, so reject its old-account result before any DB transaction.
    if (!shouldContinue()) break;
    if (rows.length === 0) break;
    const validated = validateDeletionPage(rows, watermark, pageSize);

    for (const row of rows) {
      if (!shouldContinue()) return applied;
      // Unknown / hard-gone rows still leave a durable ledger marker so later backfill is born
      // hidden. Keep that marker, the message tombstone, and chat sort-key recompute together.
      const dateDeleted = row.dateDeleted ?? now();
      await withDbTransaction(
        db,
        (transactionContext) =>
          markMessageDeletedWithinTransaction(transactionContext, row.guid, dateDeleted),
        commitGuard,
      );
      applied++;
    }

    const isFullPage = rows.length === pageSize;
    const cursorIsSafe = !(isFullPage && validated.hasNullTimestamp);
    const advanced = cursorIsSafe && validated.maxTimestamp > watermark;
    if (advanced) {
      if (!shouldContinue()) return applied;
      await withDbTransaction(
        db,
        (transactionContext) =>
          kvSetWithinTransaction(
            transactionContext,
            DELETIONS_SYNCED_AT_KEY,
            String(validated.maxTimestamp),
          ),
        commitGuard,
      );
      // Only advertise the cursor in memory after the durable commit succeeds.
      watermark = validated.maxTimestamp;
    }
    // Loop ONLY on a full page that moved the watermark; a stuck watermark would refetch the
    // identical page forever. A full page containing a null timestamp is also cursor-ambiguous:
    // apply its durable markers, but do not skip past it or request a continuation from bad state.
    if (!isFullPage || !advanced) break;
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
  /** Maximum server pages to persist in this run (undefined = normal foreground-unbounded run). */
  maxPages?: number;
  /** Stop before the next request/write when this account no longer owns the run. */
  shouldAbort?: () => boolean;
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
  const maxPages =
    opts.maxPages == null
      ? Number.POSITIVE_INFINITY
      : Number.isFinite(opts.maxPages) && opts.maxPages > 0
        ? Math.floor(opts.maxPages)
        : 0;
  const shouldContinue = (): boolean => !(opts.shouldAbort?.() ?? false);
  const commitGuard = opts.shouldAbort ? shouldContinue : undefined;
  const deduper = opts.deduper ?? new GuidDeduper();
  let marker: SyncMarker = await getSyncMarker(db);
  let messages = 0;
  let pages = 0;
  const seenChats = new Set<string>();

  for (;;) {
    if (!shouldContinue() || pages >= maxPages) break;
    const cursor = buildSyncCursor(opts.serverVersion, marker);
    const batch = await api.fetchMessagesAfter(cursor, batchSize);
    // A request can finish after Disconnect. Do not turn that old response into writes against a
    // newly opened account DB; a transaction guard below closes the later lock-wait/commit race.
    if (!shouldContinue()) break;
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
      // progress). It still owns a short transaction: otherwise this bare marker UPDATE could
      // silently join an unrelated writer's transaction and be erased by that writer's rollback.
      await withDbTransaction(
        db,
        (context) => setSyncMarkerWithinTransaction(context, nextMarker),
        commitGuard,
      );
    } else {
      for (let i = 0; i < fresh.length; i += INCREMENTAL_TX_CHUNK) {
        const slice = fresh.slice(i, i + INCREMENTAL_TX_CHUNK);
        const isLastSlice = i + INCREMENTAL_TX_CHUNK >= fresh.length;
        const sliceChats = slice.flatMap((m) => m.chats ?? []);
        const sliceHandles = [
          ...sliceChats.flatMap((c) => c.participants ?? []),
          ...slice.flatMap((m) => (m.handle ? [m.handle] : [])),
        ];
        await withDbTransaction(
          db,
          async (transactionContext) => {
            const handleMap = await upsertHandlesWithinTransaction(
              transactionContext,
              sliceHandles,
            );
            const chatMap = await upsertChatsWithinTransaction(
              transactionContext,
              sliceChats,
              handleMap,
            );
            const stored = await upsertMessagesWithinTransaction(
              transactionContext,
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
            if (isLastSlice) {
              await setSyncMarkerWithinTransaction(transactionContext, nextMarker);
            }
          },
          commitGuard,
        );
      }
    }

    if (fresh.length > 0) {
      await linkHandlesAfterCommit(
        db,
        [
          ...embeddedChats.flatMap((chat) => chat.participants ?? []),
          ...fresh.flatMap((message) => (message.handle ? [message.handle] : [])),
        ].map((handle) => handle.address),
        commitGuard,
      );
    }

    // Only count what actually committed — the throw above propagates instead of reaching here.
    marker = nextMarker;
    messages += fresh.length;
    pages += 1;
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
