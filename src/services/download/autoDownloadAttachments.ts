import { logger } from '@core/secure';
import { listAttachmentsByMessageIds } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { useFeatureSettingsStore, type AutoDownloadDestination } from '@state/featureSettingsStore';
import { shouldAutoDownload } from '@utils';
import { showToast } from '@ui/toast/toastStore';

/**
 * Auto-download an incoming message's image attachments on the INGESTION path (called from
 * DbEventSink after a new/updated message is persisted), so pictures are ready before the chat is
 * opened. Bounded to images via {@link shouldAutoDownload}; honors the "Only on Wi-Fi" flag; and,
 * per the `autoDownloadDestination` setting, files a copy into the device gallery / a "Gator" album
 * and pops a single batched toast per burst.
 *
 * Native modules (expo-network / the download fetcher / expo-media-library) are LAZILY imported and
 * only after the early returns, so this module's static import graph stays Node-safe (DbEventSink is
 * unit-tested in Node) and nothing is pulled unless there's actually an image to fetch.
 */
export async function autoDownloadMessageAttachments(
  db: AppDatabase,
  messageId: number,
): Promise<void> {
  try {
    const store = useFeatureSettingsStore.getState();
    // Headless FCM wake runs no boot effect, so the store may be at defaults — hydrate once so the
    // user's persisted Wi-Fi-only / destination choices are honored (no-op when already hydrated).
    if (!store.hydrated) await store.hydrate();
    const { autoDownloadAttachments, autoDownloadOnWifiOnly, autoDownloadDestination } =
      useFeatureSettingsStore.getState();
    if (!autoDownloadAttachments) return;

    const rows = (await listAttachmentsByMessageIds(db, [messageId])).get(messageId) ?? [];
    const eligible = rows.filter((a) => a.localPath == null && shouldAutoDownload(a));
    if (eligible.length === 0) return;

    if (autoDownloadOnWifiOnly && !(await onWifi())) return;

    const { download } = await import('./index');
    // Only pull expo-media-library when we actually need to save a copy outside the app.
    const saveImageToLibrary =
      autoDownloadDestination === 'app'
        ? null
        : (await import('@/services/media')).saveImageToLibrary;

    for (const att of eligible) {
      const path = await download(att).catch(() => null);
      if (path && saveImageToLibrary) {
        const res = await saveImageToLibrary(path, { album: autoDownloadDestination === 'album' });
        if (res === 'saved') queueToast(autoDownloadDestination);
      }
    }
  } catch (e) {
    // Auto-download is best-effort; a failure must never break message ingestion.
    logger.debug('[autoDownload] ingest auto-download failed', e);
  }
}

/** True only on a Wi-Fi connection. Can't-determine (or no native module) → false, so an enabled
 *  "Only on Wi-Fi" setting fails CLOSED and respects the user's data-saving intent. */
async function onWifi(): Promise<boolean> {
  try {
    const Network = await import('expo-network');
    const state = await Network.getNetworkStateAsync();
    return state.type === Network.NetworkStateType.WIFI;
  } catch {
    return false;
  }
}

// --- Batched toast: one "Downloaded N images to …" per burst, not one per image ------------------
const TOAST_BATCH_MS = 1200;
let pendingCount = 0;
let pendingDest: AutoDownloadDestination = 'album';
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function queueToast(dest: AutoDownloadDestination): void {
  pendingCount += 1;
  pendingDest = dest;
  if (toastTimer != null) clearTimeout(toastTimer);
  toastTimer = setTimeout(flushToast, TOAST_BATCH_MS);
}

function flushToast(): void {
  const n = pendingCount;
  const dest = pendingDest;
  pendingCount = 0;
  toastTimer = null;
  if (n <= 0) return;
  const where = dest === 'album' ? 'to Gator album' : 'to Photos';
  showToast(`Downloaded ${n} ${n === 1 ? 'image' : 'images'} ${where}`);
}
