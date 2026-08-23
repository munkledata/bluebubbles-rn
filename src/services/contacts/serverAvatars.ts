import { Directory, File, Paths } from 'expo-file-system';
import { contactsApi } from '@core/api';
import { logger } from '@core/secure';
import { emailKey, handleKey, phoneKey } from '@utils/contactMatch';
import { handlesNeedingAvatar, setHandleServerAvatar } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import type { HttpClient } from '@core/api';
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

export const SERVER_AVATAR_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB
export const SERVER_AVATAR_TIMEOUT_MS = 30_000;
export const SERVER_AVATAR_MAX_PIXELS = 16 * 1024 * 1024;
export const SERVER_AVATAR_MAX_FILES_PER_RUN = contactsApi.CONTACT_QUERY_MAX_ADDRESSES;
export const SERVER_AVATAR_MAX_TOTAL_DOWNLOAD_BYTES = 32 * 1024 * 1024; // 32 MiB

/**
 * Backfill server-sourced avatars onto handles the DEVICE address book didn't supply a photo
 * for (e.g. a contact on the Mac but not the phone). Best-effort + additive: it only writes a
 * photo onto handles whose `avatar` is null — device photos are never touched — so a failure
 * here can't affect the primary device-contact sync. Avatars download beneath the captured
 * account-generation directory as `file://` uris. A late old-account file therefore cannot be
 * reused by the next account even when best-effort deletion fails; Forget still sweeps the shared
 * `server-contact-avatars` parent. Within one generation the client caches by contact id + etag.
 *
 * Returns the number of handles a server avatar was written to.
 */
export async function backfillServerAvatars(
  db: AppDatabase,
  http: HttpClient,
  lease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<number> {
  if (!lease.isCurrent()) return 0;
  let needing: Awaited<ReturnType<typeof handlesNeedingAvatar>> = [];
  const readStatus = await runTrackedRealtimeWork(lease, async (activeLease) => {
    if (!activeLease.isCurrent()) return;
    needing = await handlesNeedingAvatar(db, SERVER_AVATAR_MAX_FILES_PER_RUN);
  });
  if (readStatus === 'paused') return 0;
  if (!lease.isCurrent() || needing.length === 0) return 0;
  const candidates = needing;

  // The contact query and every follow-up native avatar request belong to one account. Capture
  // immediately before the first NETWORK await: the preceding DB read may overlap Disconnect,
  // while the query below snapshots the same live HttpClient in this same synchronous turn.
  const transport = http.snapshotTransport();
  const contacts = await contactsApi.queryContactsByAddress(
    http,
    candidates.map((h) => h.address),
  );
  if (!lease.isCurrent() || contacts.length === 0) return 0;

  // Index address-key → contact-with-photo (last-10-digits phone / lowercased email — the
  // same keys the device-contact matcher uses).
  const byKey = new Map<string, contactsApi.ServerContact>();
  for (const c of contacts) {
    if (!c.hasAvatar || !c.id) continue;
    for (const p of c.phoneNumbers ?? []) byKey.set(phoneKey(p), c);
    for (const e of c.emails ?? []) byKey.set(emailKey(e), c);
  }
  if (byKey.size === 0) return 0;

  const dir = new Directory(
    Paths.document,
    'server-contact-avatars',
    mediaGenerationPathSegment(lease.generation),
  );
  dir.create({ intermediates: true, idempotent: true });
  let written = 0;
  let downloadedBytes = 0;
  for (const h of candidates) {
    if (!lease.isCurrent()) return written;
    const c = byKey.get(handleKey(h.address));
    if (!c || !c.id) continue;
    let downloadedNow = false;
    let aggregateBoundWasTighter = false;
    try {
      // Name the file by (id, etag) so a changed photo re-downloads; reuse an existing file.
      const dest = new File(
        dir,
        `${encodedMediaPathSegment(JSON.stringify([c.id, c.avatarEtag ?? 'v0']))}.img`,
      );
      if (dest.exists && !isReusableAvatar(dest)) discardFile(dest);
      if (!dest.exists) {
        const remainingDownloadBytes = SERVER_AVATAR_MAX_TOTAL_DOWNLOAD_BYTES - downloadedBytes;
        if (remainingDownloadBytes <= 0) return written;
        const downloadMaxBytes = Math.min(SERVER_AVATAR_MAX_BYTES, remainingDownloadBytes);
        aggregateBoundWasTighter = downloadMaxBytes < SERVER_AVATAR_MAX_BYTES;
        const result = await downloadBoundedNativeFile({
          url: contactsApi.contactAvatarUrl(transport, c.id, 'thumb'),
          destination: dest,
          headers: { ...transport.headers },
          maxBytes: downloadMaxBytes,
          timeoutMs: SERVER_AVATAR_TIMEOUT_MS,
          maxImagePixels: SERVER_AVATAR_MAX_PIXELS,
          shouldContinue: () => lease.isCurrent(),
        });
        downloadedBytes += result.bytes;
        downloadedNow = true;
      }
      if (!lease.isCurrent()) {
        if (downloadedNow) discardFile(dest);
        return written;
      }
      let avatarWritten = false;
      const commitStatus = await runTrackedRealtimeWork(lease, async () => {
        avatarWritten = await setHandleServerAvatar(db, h.id, dest.uri);
      });
      if (commitStatus === 'paused' || !lease.isCurrent()) {
        if (downloadedNow) discardFile(dest);
        return written;
      }
      // A device-contact refresh can install a photo while this network download is in flight.
      // The repository's compare-and-swap preserves that device photo; do not report a write that
      // deliberately did not happen.
      if (avatarWritten) written += 1;
    } catch (e) {
      if (!lease.isCurrent()) return written;
      if (e instanceof BoundedDownloadError && e.reason === 'missing') continue;
      logger.warn('[contacts] server-avatar backfill failed for a handle', e);
      // The final aggregate-budget slot may be smaller than one ordinary avatar. Once a response
      // crosses that remaining allowance, trying later rows could only repeat the same hostile
      // over-budget work without increasing the verified aggregate budget.
      if (aggregateBoundWasTighter && e instanceof BoundedDownloadError && e.reason === 'size') {
        return written;
      }
    }
  }
  return written;
}

/** Best-effort cleanup for a native download invalidated by an account transition. */
function discardFile(file: File): void {
  deleteOwnedFile(file);
}

/** A zero-byte `File.size` also means unreadable in Expo, so it is never a valid cache hit. */
function isReusableAvatar(file: File): boolean {
  try {
    return Number.isSafeInteger(file.size) && file.size > 0 && file.size <= SERVER_AVATAR_MAX_BYTES;
  } catch {
    return false;
  }
}
