import { logger } from '@core/secure';
import type { EventDeliveryContext } from '@core/realtime';
import type { HttpClient } from '@core/api';
import { enqueueAttachmentMediaExport, listAttachmentsByMessageIds } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
import { shouldAutoDownload } from '@utils';
import {
  captureRealtimeDeliveryLease,
  type RealtimeDeliveryLease,
} from '../realtime/deliveryCoordinator';

export const MAX_AUTO_DOWNLOAD_FILES_PER_MESSAGE = 16;
export const MAX_AUTO_DOWNLOAD_BYTES_PER_MESSAGE = 40 * 1024 * 1024; // 40 MiB

export interface AutoDownloadOutcome {
  readonly savedImages: number;
  readonly destination: 'album' | 'gallery' | null;
}

const NO_SAVED_IMAGES: AutoDownloadOutcome = { savedImages: 0, destination: null };

interface AutoDownloadExecutionOptions {
  /** Native Photos writes have no cancellation signal and are therefore foreground-only. */
  readonly allowExternalMediaSave?: boolean;
}

/**
 * Auto-download an incoming message's image attachments on the INGESTION path (called from
 * DbEventSink after a new/updated message is persisted), so pictures are ready before the chat is
 * opened. Bounded to images via {@link shouldAutoDownload}; honors the "Only on Wi-Fi" flag; and,
 * per the `autoDownloadDestination` setting, files a copy into the device gallery / a "Gator" album
 * and returns a typed save count for the mounted UI to present. A bounded background-FCM caller
 * disables the external Photos copy because expo-media-library offers no cancellation signal; it
 * persists a destination-bound receipt plus the app-cache file and returns no presentation
 * outcome. The next eligible foreground activation drains that receipt.
 *
 * Native modules (expo-network / the download fetcher / media-export worker) are LAZILY imported
 * only after the early returns, so this module's static import graph stays Node-safe (DbEventSink is
 * unit-tested in Node) and nothing is pulled unless there's actually an image to fetch.
 */
export async function autoDownloadMessageAttachments(
  db: AppDatabase,
  messageId: number,
  context?: EventDeliveryContext,
  taskHttp?: HttpClient,
  options: AutoDownloadExecutionOptions = {},
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
          excludeRetractedAttachments: true,
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

    if (taskHttp) {
      // Normal foreground boot repairs the persistent cache ledger before downloads. Killed-process
      // FCM ingestion skips that gate, so join the same bounded recovery only after settings,
      // attachment eligibility, and network policy prove that this message needs a transfer.
      const { isAttachmentCacheRecoveryReady, recoverAttachmentCache } =
        await import('./attachmentCacheRecovery');
      if (!isAttachmentCacheRecoveryReady(lease)) {
        try {
          const recovery = await recoverAttachmentCache(db, lease);
          if (recovery.status !== 'ready' || !lease.isCurrent()) return NO_SAVED_IMAGES;
        } catch (error) {
          if (lease.isCurrent()) {
            logger.debug('[autoDownload] attachment cache recovery unavailable', error);
          }
          return NO_SAVED_IMAGES;
        }
      }
      if (!lease.isCurrent()) return NO_SAVED_IMAGES;
    }

    const { download, downloadWithClient } = await import('./index');
    const galleryDestination: AutoDownloadOutcome['destination'] =
      autoDownloadDestination === 'app' ? null : autoDownloadDestination;

    let actualDownloadedBytes = 0;
    for (const att of eligible) {
      if (!lease.isCurrent()) return NO_SAVED_IMAGES;
      if (actualDownloadedBytes >= MAX_AUTO_DOWNLOAD_BYTES_PER_MESSAGE) break;
      let exportPending = false;
      // Persist the destination-bound intent BEFORE native download work. A killed/background
      // delivery can then finish with only attachments.local_path committed; the next unlocked
      // foreground activation will still discover and fulfill the outside Photos copy.
      if (galleryDestination !== null && !att.isSticker) {
        try {
          const receipt = await enqueueAttachmentMediaExport(
            db,
            { attachmentGuid: att.guid, destination: galleryDestination },
            () => lease.isCurrent(),
          );
          exportPending =
            receipt.status === 'enqueued' ||
            (receipt.status === 'duplicate' &&
              receipt.state === 'pending' &&
              receipt.destination === galleryDestination);
        } catch (error) {
          if (lease.isCurrent()) {
            logger.debug('[autoDownload] media export receipt unavailable', error);
          }
        }
      }
      if (!lease.isCurrent()) return NO_SAVED_IMAGES;
      const remainingBytes = MAX_AUTO_DOWNLOAD_BYTES_PER_MESSAGE - actualDownloadedBytes;
      let verifiedBytes = 0;
      const onVerifiedBytes = (bytes: number): void => {
        verifiedBytes = bytes;
      };
      const path = await (
        taskHttp
          ? downloadWithClient(taskHttp, att, 'automatic', lease, onVerifiedBytes, remainingBytes)
          : download(att, 'automatic', lease, onVerifiedBytes, remainingBytes)
      ).catch(() => null);
      if (path) actualDownloadedBytes += verifiedBytes;
      // Stickers are still DOWNLOADED — the in-bubble overlay needs the file — but they are never
      // filed into the user's Photos. A tapback sticker is not a picture they received; before the
      // overlay existed this was the only visible trace of a sticker at all, which is how a stray
      // image plus a "Downloaded 1 image" toast became the sole symptom of an invisible message.
      if (path && lease.isCurrent() && exportPending && options.allowExternalMediaSave !== false) {
        const { fulfillAttachmentMediaExport } = await import('./attachmentMediaExportQueue');
        const exportResult = await fulfillAttachmentMediaExport(db, att.guid, lease);
        if (exportResult.savedImages > 0 && lease.isCurrent()) {
          savedImages += exportResult.savedImages;
          savedDestination = exportResult.destination;
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

/** Resolve a task-local transport for a detached socket/FCM ingestion auto-download. */
export async function autoDownloadMessageAttachmentsForRealtimeEvent(
  db: AppDatabase,
  messageId: number,
  expectedAccountGeneration: number,
  options: {
    readonly isEffectCurrent?: () => boolean;
    readonly allowExternalMediaSave?: boolean;
  } = {},
): Promise<AutoDownloadOutcome> {
  if (options.isEffectCurrent?.() === false) return NO_SAVED_IMAGES;
  // Keep the durable-session/native imports out of this module's static graph. DbEventSink's host
  // tests import the base orchestration without ever needing an Android background transport.
  const { resolveAuthorizedRealtimeTransport } =
    await import('../background/authorizedRealtimeTransport');
  const transport = await resolveAuthorizedRealtimeTransport(expectedAccountGeneration);
  if (!transport || options.isEffectCurrent?.() === false) return NO_SAVED_IMAGES;
  const effectCurrent = options.isEffectCurrent;
  const lease: RealtimeDeliveryLease = effectCurrent
    ? Object.freeze({
        generation: transport.lease.generation,
        isCurrent: () => transport.lease.isCurrent() && effectCurrent(),
      })
    : transport.lease;
  return autoDownloadMessageAttachments(db, messageId, lease, transport.http, {
    allowExternalMediaSave: options.allowExternalMediaSave,
  });
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
