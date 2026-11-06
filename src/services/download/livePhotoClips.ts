import { Directory, File, Paths } from 'expo-file-system';
import { attachmentsApi } from '@core/api';
import { logger } from '@core/secure';
import {
  BoundedDownloadError,
  deleteOwnedFile,
  downloadBoundedNativeFile,
} from './boundedNativeDownload';
import { encodedMediaPathSegment, mediaGenerationPathSegment } from './pathSafety';
import {
  captureRealtimeDeliveryLease,
  subscribeRealtimeGenerationInvalidation,
  type RealtimeDeliveryLease,
} from '../realtime/deliveryCoordinator';
import { http as sharedHttp } from '../clients';

/**
 * A Live Photo clip is about three seconds of video: on a real Mac, 287 clips had a median of
 * 3.5 MB and a largest of 7.2 MB. Anything far past that is broken or hostile.
 */
export const LIVE_PHOTO_CLIP_MAX_BYTES = 24 * 1024 * 1024; // 24 MiB
export const LIVE_PHOTO_CLIP_TIMEOUT_MS = 60_000;
/** Once this many clips are saved the account's folder is cleared; they are cheap to re-fetch. */
export const LIVE_PHOTO_CLIP_MAX_FILES = 20;
/** Bound on the remembered "no clip" answers; past it they are forgotten and asked again. */
const MAX_REMEMBERED_MISSING = 2_000;
const LIVE_PHOTO_CLIP_DIRECTORY = 'live-photo-clips';

/**
 * What this account generation already learned. Dropped the moment the generation is retired
 * (Disconnect), so nothing about account A is consulted for account B.
 */
interface GenerationState {
  readonly generation: number;
  /** The server said this still has no clip (404), or sent an oversized one: never ask again. */
  readonly noClip: Set<string>;
  /** One shared download per still; a second hold while it runs waits for the same answer. */
  readonly inFlight: Map<string, Promise<string | null>>;
  /** Clips in this generation's folder; null until counted (only ever counted while idle). */
  savedFiles: number | null;
}

let state: GenerationState | null = null;

function stateFor(lease: RealtimeDeliveryLease): GenerationState {
  if (state?.generation === lease.generation) return state;
  const next: GenerationState = {
    generation: lease.generation,
    noClip: new Set(),
    inFlight: new Map(),
    savedFiles: null,
  };
  state = next;
  // Disconnect deletes the whole clip folder (bootstrap WIPED_MEDIA_DIRS) after bounded downloads
  // drain; here the retired account's remembered answers are simply dropped.
  subscribeRealtimeGenerationInvalidation(lease.generation, () => {
    if (state === next) state = null;
  });
  return next;
}

function clipDirectory(generation: number): Directory {
  return new Directory(
    Paths.document,
    LIVE_PHOTO_CLIP_DIRECTORY,
    mediaGenerationPathSegment(generation),
  );
}

/** Where one still's clip is saved for this account generation. */
function clipDestination(guid: string, generation: number): { dir: Directory; file: File } {
  const dir = clipDirectory(generation);
  return { dir, file: new File(dir, `${encodedMediaPathSegment(guid)}.mov`) };
}

/** A zero-byte or oversized file is never a cache hit. */
function isUsable(file: File): boolean {
  try {
    return (
      file.exists &&
      Number.isSafeInteger(file.size) &&
      file.size > 0 &&
      file.size <= LIVE_PHOTO_CLIP_MAX_BYTES
    );
  } catch {
    return false;
  }
}

/**
 * Local `file://` URI of a Live Photo's motion clip, by the still's attachment guid, fetching it
 * from the server when needed. Resolves `null` (never rejects) when there is no clip to play: the
 * viewer just keeps showing the still. Pass `replace` when the URI this returned earlier failed to
 * play: the old file is dropped and fetched again. Only call this for an iMessage/SMS still that
 * carries `hasLivePhoto`, while the server reports `supports_live_photo`; never for RCS.
 */
export function loadLivePhotoClip(guid: string, replace = false): Promise<string | null> {
  try {
    if (!guid) return Promise.resolve(null);
    const lease = captureRealtimeDeliveryLease();
    if (!lease.isCurrent()) return Promise.resolve(null);
    const current = stateFor(lease);
    const { dir, file } = clipDestination(guid, lease.generation);
    const existing = current.inFlight.get(guid);
    if (existing) return existing;
    if (replace) deleteOwnedFile(file);
    if (isUsable(file)) return Promise.resolve(file.uri);
    if (current.noClip.has(guid)) return Promise.resolve(null);
    clearIfFull(current);
    // Pin before the first await so a late answer can never pair this account's request with
    // another account's server or credential.
    const http = sharedHttp.pinTransport();
    const ownsRun = (): boolean => lease.isCurrent() && http.isTransportCurrent();
    const request = fetchClip(guid, dir, file, current, http.snapshotTransport(), ownsRun)
      .catch(() => null)
      .finally(() => {
        if (current.inFlight.get(guid) === request) current.inFlight.delete(guid);
      });
    current.inFlight.set(guid, request);
    return request;
  } catch (error) {
    // A guid the filesystem cannot name (too long, invalid Unicode) simply has no clip.
    logger.warn('[live-photo] could not prepare a clip request', error);
    return Promise.resolve(null);
  }
}

async function fetchClip(
  guid: string,
  dir: Directory,
  file: File,
  current: GenerationState,
  transport: ReturnType<ReturnType<typeof sharedHttp.pinTransport>['snapshotTransport']>,
  ownsRun: () => boolean,
): Promise<string | null> {
  try {
    if (file.exists) deleteOwnedFile(file);
    dir.create({ intermediates: true, idempotent: true });
    await downloadBoundedNativeFile({
      url: attachmentsApi.attachmentLivePhotoUrl(transport, guid),
      destination: file,
      headers: { ...transport.headers },
      maxBytes: LIVE_PHOTO_CLIP_MAX_BYTES,
      timeoutMs: LIVE_PHOTO_CLIP_TIMEOUT_MS,
      shouldContinue: ownsRun,
    });
    if (!ownsRun()) {
      deleteOwnedFile(file);
      return null;
    }
    if (current.savedFiles !== null) current.savedFiles += 1;
    return file.uri;
  } catch (error) {
    if (!ownsRun()) return null;
    if (
      error instanceof BoundedDownloadError &&
      (error.reason === 'missing' || error.reason === 'size')
    ) {
      // 404/410 means this still has no clip; an oversized answer will not fix itself either.
      if (current.noClip.size >= MAX_REMEMBERED_MISSING) current.noClip.clear();
      current.noClip.add(guid);
      return null;
    }
    // Busy, offline, a timeout, or a problem on the phone: nothing is remembered, so the next
    // hold simply asks again.
    logger.warn('[live-photo] clip download failed', error);
    return null;
  }
}

/**
 * Keep the folder bounded without scanning it on every save: it is counted once per generation,
 * and once it reaches the cap it is cleared, but only while no clip is downloading, so it can
 * never pull the folder out from under a request. A clip already handed to a player keeps
 * playing: Android keeps a deleted file readable through an open descriptor.
 */
function clearIfFull(current: GenerationState): void {
  if (current.inFlight.size !== 0 || current !== state) return;
  const dir = clipDirectory(current.generation);
  if (current.savedFiles === null) {
    try {
      current.savedFiles = dir.exists ? dir.list().length : 0;
    } catch {
      current.savedFiles = 0;
    }
  }
  if (current.savedFiles < LIVE_PHOTO_CLIP_MAX_FILES) return;
  try {
    if (dir.exists) dir.delete();
    current.savedFiles = 0;
  } catch (error) {
    logger.warn('[live-photo] could not clear the clip folder', error);
  }
}

/** Test seam: forget every remembered outcome. */
export function resetLivePhotoClipsForTests(): void {
  state = null;
}
