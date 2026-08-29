import { logger } from '@core/secure';
import type { EventDeliveryContext } from '@core/realtime';
import { listAttachmentsByMessageIds } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
import { shouldAutoDownload } from '@utils';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
  type RealtimeDeliveryLease,
} from '../realtime/deliveryCoordinator';

export const MAX_AUTO_DOWNLOAD_FILES_PER_MESSAGE = 16;
export const MAX_AUTO_DOWNLOAD_BYTES_PER_MESSAGE = 40 * 1024 * 1024; // 40 MiB

export interface AutoDownloadOutcome {
  readonly savedImages: number;
  readonly destination: 'album' | 'gallery' | null;
}

const NO_SAVED_IMAGES: AutoDownloadOutcome = { savedImages: 0, destination: null };

/**
 * Auto-download an incoming message's image attachments on the INGESTION path (called from
 * DbEventSink after a new/updated message is persisted), so pictures are ready before the chat is
 * opened. Bounded to images via {@link shouldAutoDownload}; honors the "Only on Wi-Fi" flag; and,
 * per the `autoDownloadDestination` setting, files a copy into the device gallery / a "Gator" album
 * and returns a typed save count for the mounted UI to present. Headless delivery simply ignores
 * that presentation-only result.
 *
 * Native modules (expo-network / the download fetcher / expo-media-library) are LAZILY imported and
 * only after the early returns, so this module's static import graph stays Node-safe (DbEventSink is
 * unit-tested in Node) and nothing is pulled unless there's actually an image to fetch.
 */
export async function autoDownloadMessageAttachments(
  db: AppDatabase,
  messageId: number,
  context?: EventDeliveryContext,
): Promise<AutoDownloadOutcome> {
  const lease: RealtimeDeliveryLease = context ?? captureRealtimeDeliveryLease();
  let savedImages = 0;
  let savedDestination: AutoDownloadOutcome['destination'] = null;
  try {
    if (!lease.isCurrent()) return NO_SAVED_IMAGES;
    const store = useFeatureSettingsStore.getState();
    // Headless FCM wake runs no boot effect, so the store may be at defaults — hydrate once so the
    // user's persisted Wi-Fi-only / destination choices are honored (no-op when already hydrated).
    if (!store.hydrated) {
      await store.hydrate({
        shouldCommit: () => lease.isCurrent(),
        onError: (error) => logger.debug('[autoDownload] feature settings unavailable', error),
      });
    }
    if (!lease.isCurrent()) return NO_SAVED_IMAGES;
    const { hydrated, autoDownloadAttachments, autoDownloadOnWifiOnly, autoDownloadDestination } =
      useFeatureSettingsStore.getState();
    // A killed-app FCM wake has no Bootstrap gate. If encrypted preferences could not be read,
    // never turn the permissive module default into an unconfirmed background download.
    if (!hydrated || !autoDownloadAttachments) return NO_SAVED_IMAGES;

    const rows =
      (
        await listAttachmentsByMessageIds(db, [messageId], MAX_AUTO_DOWNLOAD_FILES_PER_MESSAGE, {
          excludeDeletedMessages: true,
          excludePluginPayloads: true,
        })
      ).get(messageId) ?? [];
    if (!lease.isCurrent()) return NO_SAVED_IMAGES;
    const eligible: typeof rows = [];
    let selectedBytes = 0;
    for (const attachment of rows) {
      if (eligible.length >= MAX_AUTO_DOWNLOAD_FILES_PER_MESSAGE) break;
      // The query excludes extension-owned rows at the message boundary. Keep the per-row hidden
      // bit as a second fail-closed guard for ordinary rich-link payloads without a balloon id.
      if (
        attachment.hideAttachment ||
        attachment.localPath != null ||
        !shouldAutoDownload(attachment)
      ) {
        continue;
      }
      const bytes = attachment.totalBytes;
      // `shouldAutoDownload` already guarantees a positive safe integer, but keep this boundary
      // self-contained so a future eligibility change cannot silently remove the aggregate cap.
      if (bytes == null || !Number.isSafeInteger(bytes) || bytes <= 0) continue;
      if (selectedBytes + bytes > MAX_AUTO_DOWNLOAD_BYTES_PER_MESSAGE) continue;
      eligible.push(attachment);
      selectedBytes += bytes;
    }
    if (eligible.length === 0) return NO_SAVED_IMAGES;

    if (autoDownloadOnWifiOnly && !(await onWifi())) return NO_SAVED_IMAGES;
    if (!lease.isCurrent()) return NO_SAVED_IMAGES;

    const { download } = await import('./index');
    // Only pull expo-media-library when we actually need to save a copy outside the app.
    const galleryDestination: AutoDownloadOutcome['destination'] =
      autoDownloadDestination === 'app' ? null : autoDownloadDestination;
    const saveImageToLibrary =
      galleryDestination === null ? null : (await import('@/services/media')).saveImageToLibrary;

    let actualDownloadedBytes = 0;
    for (const att of eligible) {
      if (!lease.isCurrent()) return NO_SAVED_IMAGES;
      if (actualDownloadedBytes >= MAX_AUTO_DOWNLOAD_BYTES_PER_MESSAGE) break;
      const remainingBytes = MAX_AUTO_DOWNLOAD_BYTES_PER_MESSAGE - actualDownloadedBytes;
      let verifiedBytes = 0;
      const path = await download(
        att,
        'automatic',
        lease,
        (bytes) => {
          verifiedBytes = bytes;
        },
        remainingBytes,
      ).catch(() => null);
      if (path) actualDownloadedBytes += verifiedBytes;
      // Stickers are still DOWNLOADED — the in-bubble overlay needs the file — but they are never
      // filed into the user's Photos. A tapback sticker is not a picture they received; before the
      // overlay existed this was the only visible trace of a sticker at all, which is how a stray
      // image plus a "Downloaded 1 image" toast became the sole symptom of an invisible message.
      if (path && lease.isCurrent() && saveImageToLibrary && !att.isSticker) {
        let saveResult: Awaited<ReturnType<typeof saveImageToLibrary>> | undefined;
        // The download itself is long-lived and generation-guarded, but this final native gallery
        // copy is an account-visible commit. Admit it into the teardown drain so Disconnect cannot
        // activate account B while account A is still writing into Photos.
        await runTrackedRealtimeWork(lease, async (activeLease) => {
          if (!activeLease.isCurrent()) return;
          const result = await saveImageToLibrary(path, {
            album: galleryDestination === 'album',
          });
          if (activeLease.isCurrent()) saveResult = result;
        });
        if (saveResult === 'saved' && lease.isCurrent()) {
          savedImages += 1;
          savedDestination = galleryDestination;
        }
      }
    }
    return { savedImages, destination: savedDestination };
  } catch (e) {
    // Auto-download is best-effort; a failure must never break message ingestion.
    logger.debug('[autoDownload] ingest auto-download failed', e);
    return lease.isCurrent() ? { savedImages, destination: savedDestination } : NO_SAVED_IMAGES;
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
