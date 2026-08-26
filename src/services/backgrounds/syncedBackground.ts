import { Directory, File, Paths } from 'expo-file-system';
import { chatsApi } from '@core/api';
import type { EventDeliveryContext } from '@core/realtime';
import { logger } from '@core/secure';
import {
  getChatTheme,
  getSyncedBackgroundState,
  persistServerChat,
  setSyncedBackgroundLuminanceIfCurrentWithinTransaction,
  setSyncedBackgroundUriIfCurrentWithinTransaction,
} from '@db/repositories';
import { DbCommitGuardRejectedError, withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import {
  deleteNativeSyncedBackgroundCacheFile,
  pruneNativeSyncedBackgroundCache,
} from '@native/boundedDownload';
import type { HttpClient } from '@core/api';
import { computeBackgroundIsLight } from './luminance';
import {
  BoundedDownloadError,
  deleteOwnedFile,
  downloadBoundedNativeFile,
} from '../download/boundedNativeDownload';
import { encodedMediaPathSegment, mediaGenerationPathSegment } from '../download/pathSafety';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
  type RealtimeDeliveryLease,
} from '../realtime/deliveryCoordinator';

/** A 4K JPEG wallpaper fits comfortably; larger/slow responses are treated as hostile/broken. */
export const SYNCED_BACKGROUND_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB
export const SYNCED_BACKGROUND_TIMEOUT_MS = 60_000;
export const SYNCED_BACKGROUND_MAX_PIXELS = 16 * 1024 * 1024;
// Serialize promotion → DB commit → prune so the native policy can enforce a hard global quota
// without a rolling "recent file" exemption that a fast local server could otherwise inflate.
export const SYNCED_BACKGROUND_MAX_CONCURRENT = 1;
/** Mirrored in the owned Android policy; JavaScript cannot raise either native hard limit. */
export const SYNCED_BACKGROUND_CACHE_MAX_BYTES = 100 * 1024 * 1024; // 100 MiB
export const SYNCED_BACKGROUND_CACHE_MAX_FILES = 256;
export const SYNCED_BACKGROUND_CACHE_RECENT_GRACE_MS = 0;
export const SYNCED_BACKGROUND_CACHE_REPAIR_DELAY_MS =
  SYNCED_BACKGROUND_CACHE_RECENT_GRACE_MS + 1_000;
const SYNCED_BACKGROUND_CACHE_REPAIR_MAX_ATTEMPTS = 2;

interface SyncedBackgroundRequest {
  http: HttpClient;
  db: AppDatabase;
  guid: string;
  lease: RealtimeDeliveryLease;
  revision: number;
}

interface PerChatWork {
  latest: SyncedBackgroundRequest;
  completedRevision: number;
  running: Promise<void>;
}

let nextRevision = 0;
let activeWork = 0;
const workWaiters: Array<() => void> = [];
const perChatWork = new Map<string, PerChatWork>();
let quotaRepairTimer: ReturnType<typeof setTimeout> | null = null;
let quotaRepairAttemptsRemaining = 0;
let quotaRepairGeneration = 0;

async function withBackgroundWorkSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeWork < SYNCED_BACKGROUND_MAX_CONCURRENT) {
    activeWork += 1;
  } else {
    // A release transfers its occupied slot directly to this waiter, so activeWork never briefly
    // drops below the real owner count (which could otherwise admit an extra concurrent caller).
    await new Promise<void>((resolve) => workWaiters.push(resolve));
  }
  try {
    return await task();
  } finally {
    const next = workWaiters.shift();
    if (next) next();
    else activeWork -= 1;
  }
}

/**
 * Ensure a chat's macOS 26 synced "transcript background" is downloaded locally, so the chat
 * screen can render it (via `useChatBackgroundUri` → local `background_uri` ?? this synced uri).
 *
 * The server exposes the current `backgroundChannelGuid` on each chat (persisted by upsertChats
 * into `synced_background_channel` — the version key). This compares that to the file already on
 * disk and only downloads when it changed. URL and auth come from one immutable transport
 * snapshot — same pattern as server contact avatars. Files sit beneath the captured account
 * generation so a late old-account transfer cannot be reused after Disconnect; Forget still
 * sweeps the shared `synced-backgrounds` parent. Best-effort: any failure is logged and swallowed
 * (a missing background must never break opening a chat).
 *
 * - no channel  → clear any stale local uri (the background was removed).
 * - channel set → download its collision-safe encoded JPEG if not already present, then point the
 *   DB at it.
 */
export function ensureSyncedBackground(
  http: HttpClient,
  db: AppDatabase,
  guid: string,
  context?: EventDeliveryContext,
): Promise<void> {
  const lease: RealtimeDeliveryLease = context ?? captureRealtimeDeliveryLease();
  const request: SyncedBackgroundRequest = {
    http,
    db,
    guid,
    lease,
    revision: ++nextRevision,
  };
  const existing = perChatWork.get(guid);
  if (existing) {
    // One queued rerun per chat: repeated socket/FCM/chat-open triggers collapse into the newest
    // request, while its revision immediately disowns any older network/native continuation.
    existing.latest = request;
    return existing.running;
  }

  const work: PerChatWork = {
    latest: request,
    completedRevision: 0,
    // Replaced before this entry becomes visible in the map; the initial value only lets the
    // object close over itself without a nullable promise state.
    running: Promise.resolve(),
  };
  const running = Promise.resolve()
    .then(async () => {
      while (work.completedRevision < work.latest.revision) {
        const current = work.latest;
        await withBackgroundWorkSlot(() =>
          runSyncedBackgroundRequest(current, () => work.latest.revision === current.revision),
        );
        work.completedRevision = current.revision;
      }
    })
    .finally(() => {
      if (perChatWork.get(guid) === work) perChatWork.delete(guid);
    });
  work.running = running;
  perChatWork.set(guid, work);
  return running;
}

async function runSyncedBackgroundRequest(
  request: SyncedBackgroundRequest,
  isLatest: () => boolean,
): Promise<void> {
  const { http, db, guid, lease } = request;
  // Bind every native URL/header pair to the account generation that started this operation.
  // The lease checks below prevent that generation from committing after Disconnect.
  const ownsRequest = (): boolean => lease.isCurrent() && isLatest();
  const commit = async (
    task: () => Promise<unknown>,
    onGuardRollback?: () => void,
  ): Promise<boolean> => {
    if (!ownsRequest()) return false;
    let accepted = false;
    const status = await runTrackedRealtimeWork(lease, async () => {
      if (!ownsRequest()) return;
      try {
        accepted = (await task()) !== false;
      } catch (error) {
        if (!(error instanceof DbCommitGuardRejectedError)) throw error;
        // Keep known-rollback cleanup inside the admitted slot so Disconnect cannot sweep the
        // account while a just-rejected candidate still exists. Ordinary failures retain their
        // uncertain outcome and continue to the outer best-effort handler unchanged.
        onGuardRollback?.();
      }
    });
    return status === 'delivered' && accepted;
  };
  try {
    if (!ownsRequest()) return;
    const transport = http.snapshotTransport();
    // Refresh THIS chat's metadata FIRST. The version key (server `backgroundChannelGuid` →
    // `synced_background_channel`) is written ONLY by upsertChats, which the chat-open path never
    // runs (it syncs messages only). Without this, a background a participant set/changed after the
    // last full sync is invisible on open — a null/stale channel makes the compare below a no-op —
    // until some unrelated sync happens. The server always serializes the channel on the chat, so
    // one small GET refreshes it; the `alreadyCurrent` check still skips a redundant re-download.
    try {
      const chat = await chatsApi.getChat(http, guid);
      if (!ownsRequest() || !(await commit(() => persistServerChat(db, chat)))) return;
    } catch {
      // best-effort: proceed with whatever channel we already have if the refresh fails.
    }

    if (!ownsRequest()) return;
    const stateResult: {
      value: Awaited<ReturnType<typeof getSyncedBackgroundState>>;
    } = { value: null };
    let stateReadCompleted = false;
    const stateRead = await runTrackedRealtimeWork(lease, async () => {
      if (!ownsRequest()) return;
      stateResult.value = await getSyncedBackgroundState(db, guid);
      stateReadCompleted = true;
    });
    if (stateRead === 'paused' || !stateReadCompleted || !ownsRequest()) return;
    const state = stateResult.value;
    const channel = state?.channel ?? null;

    // Background removed on the server → drop the local reference, then remove the persistent
    // app-owned file. `Paths.document` is not an OS-managed cache, so leaving it behind on every
    // channel removal would allow background churn to grow storage forever.
    if (!channel) {
      if (
        state?.uri &&
        (await commit(() =>
          withDbTransaction(
            db,
            (context) =>
              setSyncedBackgroundUriIfCurrentWithinTransaction(
                context,
                guid,
                null,
                state.uri,
                null,
              ),
            ownsRequest,
          ),
        ))
      ) {
        await deletePreviousSyncedBackground(state.uri);
      }
      return;
    }

    // Reuse only a file from THIS channel AND THIS account generation. Checking the generation is
    // what makes a late A-account file harmless even when its best-effort deletion failed: B never
    // treats A's destination as its cache hit.
    const generationNamespace = mediaGenerationPathSegment(lease.generation);
    const expectedFileName = `${encodedMediaPathSegment(JSON.stringify([guid, channel]))}.jpg`;
    const dir = new Directory(Paths.document, 'synced-backgrounds', generationNamespace);
    const dest = new File(dir, expectedFileName);
    let alreadyCurrent = state?.uri === dest.uri;
    if (alreadyCurrent && state?.uri) {
      const cached = new File(state.uri);
      if (!isReusableBackground(cached)) {
        deleteOwnedFile(cached);
        alreadyCurrent = false;
      }
    }

    let effectiveUri = state?.uri ?? null;
    if (!alreadyCurrent) {
      dir.create({ intermediates: true, idempotent: true });
      if (dest.exists && !isReusableBackground(dest)) deleteOwnedFile(dest);
      if (!dest.exists) {
        if (!ownsRequest()) return;
        await downloadBoundedNativeFile({
          url: chatsApi.chatBackgroundUrl(transport, guid),
          destination: dest,
          headers: { ...transport.headers },
          maxBytes: SYNCED_BACKGROUND_MAX_BYTES,
          timeoutMs: SYNCED_BACKGROUND_TIMEOUT_MS,
          maxImagePixels: SYNCED_BACKGROUND_MAX_PIXELS,
          shouldContinue: ownsRequest,
        });
        if (!ownsRequest()) {
          deleteOwnedFile(dest);
          return;
        }
      }
      let candidateDeletedAfterGuardRollback = false;
      const promoted = await commit(
        () =>
          withDbTransaction(
            db,
            (context) =>
              setSyncedBackgroundUriIfCurrentWithinTransaction(
                context,
                guid,
                channel,
                state?.uri ?? null,
                dest.uri,
              ),
            ownsRequest,
          ),
        () => {
          deleteOwnedFile(dest);
          candidateDeletedAfterGuardRollback = true;
        },
      );
      if (!promoted) {
        if (!candidateDeletedAfterGuardRollback) deleteOwnedFile(dest);
        return;
      }
      effectiveUri = dest.uri;
      if (state?.uri !== dest.uri) await deletePreviousSyncedBackground(state?.uri ?? null);
      // This service serializes promotion through DB commit and native pruning, so `dest` is the
      // only final that can be between those stages. Keep it explicitly and evict immediately to
      // the native-owned global byte/file caps.
      await pruneSyncedBackgroundCacheBestEffort(dest.uri);
      if (!ownsRequest()) return;
    }

    // Wallpaper luminance (for legible overlay text). The LOCAL background (the user's own pick)
    // takes precedence and owns its own luminance (set in chat-settings), so only manage the
    // synced one when there's no local override. Recompute when we just downloaded a new channel,
    // or when it's still unknown for an already-cached file (e.g. a background from before this column).
    if (effectiveUri) {
      if (!ownsRequest()) return;
      const themeResult: { value: Awaited<ReturnType<typeof getChatTheme>> } = { value: null };
      let themeReadCompleted = false;
      const themeRead = await runTrackedRealtimeWork(lease, async () => {
        if (!ownsRequest()) return;
        themeResult.value = await getChatTheme(db, guid);
        themeReadCompleted = true;
      });
      if (themeRead === 'paused' || !themeReadCompleted || !ownsRequest()) return;
      const theme = themeResult.value;
      if (!theme?.backgroundUri && (!alreadyCurrent || theme?.backgroundIsLight == null)) {
        const isLight = await computeBackgroundIsLight(effectiveUri);
        if (isLight !== null && ownsRequest()) {
          await commit(() =>
            withDbTransaction(
              db,
              (context) =>
                setSyncedBackgroundLuminanceIfCurrentWithinTransaction(
                  context,
                  guid,
                  channel,
                  effectiveUri,
                  isLight,
                ),
              ownsRequest,
            ),
          );
        }
      }
    }
  } catch (e) {
    if (!ownsRequest()) return;
    if (e instanceof BoundedDownloadError && e.reason === 'missing') return;
    logger.warn('[background] synced-background fetch failed', e);
  }
}

/** Expo reports zero for missing/unreadable files, so only a bounded positive stat is reusable. */
function isReusableBackground(file: File): boolean {
  try {
    return (
      Number.isSafeInteger(file.size) && file.size > 0 && file.size <= SYNCED_BACKGROUND_MAX_BYTES
    );
  } catch {
    return false;
  }
}

/**
 * Delete through Android's fixed-root, canonical, regular-file-only boundary. In particular, do
 * not construct an Expo `File` from a DB URI here: its URL normalization plus recursive directory
 * delete would make encoded traversal or fragments dangerous before JavaScript could re-check it.
 */
async function deletePreviousSyncedBackground(uri: string | null): Promise<void> {
  if (!uri) return;
  try {
    await deleteNativeSyncedBackgroundCacheFile(uri);
  } catch {
    // The account-wide media sweep remains the best-effort fallback.
  }
}

async function pruneSyncedBackgroundCacheBestEffort(keepUri: string | null): Promise<void> {
  try {
    const result = await pruneNativeSyncedBackgroundCache(keepUri);
    if (!result.withinQuota) scheduleSyncedBackgroundQuotaRepair();
  } catch (error) {
    // Cache eviction must never make a chat fail to open. The next successful commit or process
    // start retries the same native-owned global sweep; also reserve two delayed attempts so a
    // transient native/filesystem failure does not leave an overage for the rest of this process.
    logger.warn('[background] synced-background cache prune failed', error);
    scheduleSyncedBackgroundQuotaRepair();
  }
}

/**
 * A failed native delete can make a prune honestly report an overage. Keep exactly one timer,
 * restart its deadline when a newer commit reports the same condition, and retry a bounded two
 * times. Synced-background promotion itself is serialized above, so repair never needs a rolling
 * recent-file exemption.
 */
function scheduleSyncedBackgroundQuotaRepair(): void {
  quotaRepairGeneration += 1;
  quotaRepairAttemptsRemaining = SYNCED_BACKGROUND_CACHE_REPAIR_MAX_ATTEMPTS;
  if (quotaRepairTimer !== null) {
    clearTimeout(quotaRepairTimer);
    quotaRepairTimer = null;
  }
  armSyncedBackgroundQuotaRepair(quotaRepairGeneration);
}

function armSyncedBackgroundQuotaRepair(generation: number): void {
  if (generation !== quotaRepairGeneration) return;
  if (quotaRepairTimer !== null || quotaRepairAttemptsRemaining <= 0) return;
  quotaRepairTimer = setTimeout(() => {
    quotaRepairTimer = null;
    if (generation !== quotaRepairGeneration) return;
    quotaRepairAttemptsRemaining -= 1;
    // A repair must share the promotion → DB commit work slot. With a zero grace period, an
    // independent prune could otherwise delete a newly promoted file before its DB row commits.
    void withBackgroundWorkSlot(async () => {
      if (generation !== quotaRepairGeneration) return null;
      return pruneNativeSyncedBackgroundCache(null);
    })
      .then((result) => {
        if (generation !== quotaRepairGeneration || result === null) return;
        if (!result.withinQuota && quotaRepairAttemptsRemaining > 0) {
          armSyncedBackgroundQuotaRepair(generation);
        } else if (result.withinQuota) {
          quotaRepairAttemptsRemaining = 0;
        }
      })
      .catch((error: unknown) => {
        if (generation !== quotaRepairGeneration) return;
        logger.warn('[background] delayed synced-background cache repair failed', error);
        if (quotaRepairAttemptsRemaining > 0) armSyncedBackgroundQuotaRepair(generation);
      });
  }, SYNCED_BACKGROUND_CACHE_REPAIR_DELAY_MS);
}

// The service barrel is imported during app startup. This restart pass repairs stale generations
// even when the user never re-opens the chat whose old wallpaper pushed the cache over quota. It
// shares the same slot as promotion; the postcommit prune above stays direct because it is already
// inside that slot and nesting would deadlock the one-slot queue.
void withBackgroundWorkSlot(() => pruneSyncedBackgroundCacheBestEffort(null));
