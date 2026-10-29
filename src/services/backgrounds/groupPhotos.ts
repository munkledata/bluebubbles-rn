import { Directory, File, Paths } from 'expo-file-system';
import { chatsApi } from '@core/api';
import type { HttpClient } from '@core/api';
import { logger } from '@core/secure';
import {
  isGroupPhotoUriReferenced,
  listGroupPhotoStates,
  setGroupPhotoUriIfCurrentWithinTransaction,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
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
import { http as sharedHttp } from '../clients';
import { ensureDatabase } from '../databaseControl';

/** The server sends at most a 512 px JPEG; anything far larger is broken or hostile. */
export const GROUP_PHOTO_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB
export const GROUP_PHOTO_TIMEOUT_MS = 30_000;
export const GROUP_PHOTO_MAX_PIXELS = 4 * 1024 * 1024;
/** Groups are few; one run looks at no more than this many chats. */
export const GROUP_PHOTO_MAX_CHATS_PER_RUN = 64;
const GROUP_PHOTO_DIRECTORY = 'group-photos';

let running: Promise<number> | null = null;

/**
 * Best-effort entry point after a sync or when a group opens: acquire the database and one pinned
 * transport for the current account, then bring every group's photo file in line with its server
 * photo id. Overlapping calls share one run.
 */
export function syncGroupPhotos(
  lease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<number> {
  running ??= (async () => {
    try {
      const opened: { db?: AppDatabase } = {};
      const status = await runTrackedRealtimeWork(lease, async (activeLease) => {
        if (!activeLease.isCurrent()) return;
        opened.db = await ensureDatabase();
      });
      const db = opened.db;
      if (status === 'paused' || !db || !lease.isCurrent()) return 0;
      const taskHttp = sharedHttp.pinTransport();
      if (!taskHttp.isTransportCurrent()) return 0;
      return await refreshGroupPhotos(db, taskHttp, lease);
    } catch (error) {
      if (lease.isCurrent()) logger.warn('[group-photo] refresh failed', error);
      return 0;
    } finally {
      running = null;
    }
  })();
  return running;
}

/**
 * Download each group's photo (server `GET /chat/:guid/icon`, versioned by `groupPhotoGuid`) under
 * the account generation's folder, point the chat at it, and delete replaced or removed files.
 * Every DB write is a compare-and-set, so a sync that changes the photo meanwhile wins. Returns
 * the number of chats whose photo reference changed.
 */
export async function refreshGroupPhotos(
  db: AppDatabase,
  http: HttpClient,
  lease: RealtimeDeliveryLease,
): Promise<number> {
  const ownsRun = (): boolean => lease.isCurrent() && http.isTransportCurrent();
  if (!ownsRun()) return 0;
  const root = new Directory(Paths.document, GROUP_PHOTO_DIRECTORY);
  const read: { states: Awaited<ReturnType<typeof listGroupPhotoStates>> } = { states: [] };
  const readStatus = await runTrackedRealtimeWork(lease, async (activeLease) => {
    if (!activeLease.isCurrent()) return;
    read.states = await listGroupPhotoStates(db, GROUP_PHOTO_MAX_CHATS_PER_RUN);
  });
  if (readStatus === 'paused' || !ownsRun()) return 0;

  const transport = http.snapshotTransport();
  const dir = new Directory(root, mediaGenerationPathSegment(lease.generation));
  let changed = 0;
  for (const state of read.states) {
    if (!ownsRun()) return changed;
    try {
      if (state.photoGuid == null) {
        // The photo was removed on the Mac: drop the reference, then the file.
        if (state.uri && (await commitUri(db, lease, state, null))) {
          changed += 1;
          await deleteIfUnreferenced(db, root.uri, state.uri, lease);
        }
        continue;
      }
      const dest = new File(
        dir,
        `${encodedMediaPathSegment(JSON.stringify([state.guid, state.photoGuid]))}.jpg`,
      );
      if (state.uri === dest.uri && isUsable(dest)) continue;
      let downloadedNow = false;
      if (!isUsable(dest)) {
        if (dest.exists) deleteOwnedFile(dest);
        dir.create({ intermediates: true, idempotent: true });
        await downloadBoundedNativeFile({
          url: chatsApi.chatGroupPhotoUrl(transport, state.guid),
          destination: dest,
          headers: { ...transport.headers },
          maxBytes: GROUP_PHOTO_MAX_BYTES,
          timeoutMs: GROUP_PHOTO_TIMEOUT_MS,
          maxImagePixels: GROUP_PHOTO_MAX_PIXELS,
          shouldContinue: ownsRun,
        });
        downloadedNow = true;
      }
      if (!ownsRun()) {
        if (downloadedNow) deleteOwnedFile(dest);
        return changed;
      }
      if (!(await commitUri(db, lease, state, dest.uri))) {
        if (downloadedNow) deleteOwnedFile(dest);
        continue;
      }
      changed += 1;
      if (state.uri) await deleteIfUnreferenced(db, root.uri, state.uri, lease);
    } catch (error) {
      if (!ownsRun()) return changed;
      // An older server has no icon route, and a photo still on its way to the Mac is not found.
      if (error instanceof BoundedDownloadError && error.reason === 'missing') continue;
      logger.warn('[group-photo] download failed for a group', error);
    }
  }
  return changed;
}

async function commitUri(
  db: AppDatabase,
  lease: RealtimeDeliveryLease,
  state: { guid: string; photoGuid: string | null; uri: string | null },
  nextUri: string | null,
): Promise<boolean> {
  let written = false;
  const status = await runTrackedRealtimeWork(lease, async (activeLease) => {
    if (!activeLease.isCurrent()) return;
    written = await withDbTransaction(
      db,
      (context) =>
        setGroupPhotoUriIfCurrentWithinTransaction(
          context,
          state.guid,
          state.photoGuid,
          state.uri,
          nextUri,
        ),
      () => activeLease.isCurrent(),
    );
  });
  return status === 'delivered' && written;
}

/** A zero-byte or oversized file is never a cache hit. */
function isUsable(file: File): boolean {
  try {
    return (
      file.exists &&
      Number.isSafeInteger(file.size) &&
      file.size > 0 &&
      file.size <= GROUP_PHOTO_MAX_BYTES
    );
  } catch {
    return false;
  }
}

/**
 * Delete a replaced or removed photo once no chat shows it. Only a `media-….jpg` file directly in
 * a `generation-N` folder of this module's root is ever deleted; anything else waits for the
 * Disconnect sweep.
 */
async function deleteIfUnreferenced(
  db: AppDatabase,
  rootUri: string,
  uri: string,
  lease: RealtimeDeliveryLease,
): Promise<void> {
  const prefix = `${rootUri.replace(/\/+$/, '')}/`;
  if (!uri.startsWith(prefix)) return;
  const rest = uri.slice(prefix.length);
  if (!/^generation-\d+\/media-[^/\\]+\.jpg$/.test(rest) || /%(?:2f|5c)/i.test(rest)) return;
  try {
    await runTrackedRealtimeWork(lease, async (activeLease) => {
      if (!activeLease.isCurrent() || (await isGroupPhotoUriReferenced(db, uri))) return;
      if (activeLease.isCurrent()) deleteOwnedFile(new File(uri));
    });
  } catch {
    logger.warn('[group-photo] could not check whether a replaced group photo is still shown');
  }
}
