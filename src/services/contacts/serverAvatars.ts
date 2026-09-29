import { Directory, File, Paths } from 'expo-file-system';
import { contactsApi } from '@core/api';
import { logger } from '@core/secure';
import {
  contactEmailMatchKey,
  contactHandleMatchKey,
  contactPhoneMatchKey,
} from '@utils/contactMatch';
import { handlesNeedingAvatar, setHandleServerAvatarWithinTransaction } from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
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
 * Backfill server-sourced avatars onto handles the DEVICE address book didn't supply a photo for
 * (e.g. a contact on the Mac but not the phone). It also revalidates only its own previously stored
 * avatar paths, clearing one when the endpoint becomes ambiguous; device photos are never selected
 * or touched. Avatars download beneath the captured account-generation directory as `file://`
 * uris. A late old-account file therefore cannot be reused by the next account even when
 * best-effort deletion fails; Forget still sweeps the shared `server-contact-avatars` parent.
 * Within one generation the client caches by contact id + etag.
 *
 * Returns the number of handles a server avatar was written to.
 */
export async function backfillServerAvatars(
  db: AppDatabase,
  http: HttpClient,
  lease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<number> {
  if (!lease.isCurrent()) return 0;
  const serverAvatarRoot = new Directory(Paths.document, 'server-contact-avatars');
  let needing: Awaited<ReturnType<typeof handlesNeedingAvatar>> = [];
  const readStatus = await runTrackedRealtimeWork(lease, async (activeLease) => {
    if (!activeLease.isCurrent()) return;
    needing = await handlesNeedingAvatar(db, SERVER_AVATAR_MAX_FILES_PER_RUN, serverAvatarRoot.uri);
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

  // Index address-key → one stable server contact (last-10-digits phone / lowercased email — the
  // same keys the device-contact matcher uses). Two different contact ids claiming one key make
  // that key ambiguous, even when only one has a photo; an arbitrary avatar is worse than none.
  const byKey = new Map<string, contactsApi.ServerContact>();
  const ambiguousKeys = new Set<string>();
  for (const c of contacts) {
    const keys = new Set([
      ...(c.phoneNumbers ?? []).map(contactPhoneMatchKey).filter(Boolean),
      ...(c.emails ?? []).map(contactEmailMatchKey).filter(Boolean),
    ]);
    for (const key of keys) {
      if (ambiguousKeys.has(key)) continue;
      const existing = byKey.get(key);
      if (!c.id?.trim() || (existing && existing.id !== c.id)) {
        byKey.delete(key);
        ambiguousKeys.add(key);
      } else {
        // Repeated rows for one stable server contact are not an identity conflict. Keep the last
        // representation of that same owner, matching the endpoint response's normal semantics.
        byKey.set(key, c);
      }
    }
  }

  // An avatar written by an older last-row-wins run must not survive once the same endpoint has
  // multiple contact owners. Clear only the exact app-owned path read above; a concurrent device
  // photo makes the compare-and-swap fail and is preserved.
  for (const h of candidates) {
    if (!h.avatar || !lease.isCurrent()) continue;
    const key = contactHandleMatchKey(h.address);
    const unique = byKey.get(key);
    if (!ambiguousKeys.has(key) && unique?.hasAvatar) continue;
    if (!ambiguousKeys.has(key) && unique === undefined) continue;
    const commitStatus = await runTrackedRealtimeWork(lease, async (activeLease) => {
      if (!activeLease.isCurrent()) return;
      await withDbTransaction(
        db,
        (context) => setHandleServerAvatarWithinTransaction(context, h.id, null, h.avatar),
        () => activeLease.isCurrent(),
      );
    });
    if (commitStatus === 'paused' || !lease.isCurrent()) return 0;
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
    const c = byKey.get(contactHandleMatchKey(h.address));
    if (!c?.hasAvatar || !c.id) continue;
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
      if (h.avatar === dest.uri) continue;
      let avatarWritten = false;
      const commitStatus = await runTrackedRealtimeWork(lease, async (activeLease) => {
        if (!activeLease.isCurrent()) return;
        const handleId = h.id;
        const avatarUri = dest.uri;
        try {
          avatarWritten = await withDbTransaction(
            db,
            (context) =>
              setHandleServerAvatarWithinTransaction(context, handleId, avatarUri, h.avatar),
            () => activeLease.isCurrent(),
          );
        } catch (error) {
          // Keep stale-file cleanup inside the tracked lifetime so Disconnect cannot finish
          // between rolling back the old account's pointer and discarding this run's download.
          if (!activeLease.isCurrent() && downloadedNow) discardFile(dest);
          throw error;
        }
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
