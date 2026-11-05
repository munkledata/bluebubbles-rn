import { Directory, File, Paths } from 'expo-file-system';
import { attachmentsApi, type HttpTransportSnapshot } from '@core/api';
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
 * Longest side requested from the server. A Shared Media tile is 72 dp, about 250 px on today's
 * phones, and fills its square by cropping, so a 16:9 poster needs a long side near 450 px to stay
 * sharp. 512 is also the server's default.
 */
export const VIDEO_POSTER_WIDTH = 512;
/** A 512 px JPEG is tens of kilobytes; anything near this size is broken or hostile. */
export const VIDEO_POSTER_MAX_BYTES = 1024 * 1024; // 1 MiB
export const VIDEO_POSTER_TIMEOUT_MS = 30_000;
export const VIDEO_POSTER_MAX_PIXELS = 1024 * 1024;
/** Once this many posters are saved the account's folder is cleared; they are cheap to re-fetch. */
export const VIDEO_POSTER_MAX_FILES = 300;
/** The Mac makes at most two posters at once (it answers 503 to a third), so the phone matches. */
export const VIDEO_POSTER_MAX_CONCURRENT = 2;
/**
 * Requests waiting for a slot beyond this are dropped (the tile keeps its blurhash/▶ look and
 * asks again when it is shown again). Only mounted tiles wait, and a tile that goes away (a closed
 * screen, or a grid row scrolled out of the list's window) withdraws its request, so one Details
 * strip (at most 60 videos) or the mounted part of the All Attachments grid fits.
 */
export const VIDEO_POSTER_MAX_WAITING = 256;
/** First wait after a temporary failure (busy server, timeout); it doubles up to the maximum. */
export const VIDEO_POSTER_FIRST_RETRY_MS = 30_000;
export const VIDEO_POSTER_MAX_RETRY_MS = 10 * 60_000;
/** Bound on the remembered outcomes; past it they are forgotten and simply asked again. */
const MAX_REMEMBERED_OUTCOMES = 2_000;
const VIDEO_POSTER_DIRECTORY = 'video-posters';

/** One shared request per guid; every caller that still wants its answer counts once. */
interface SharedRequest {
  promise: Promise<string | null>;
  wanted: number;
  /** Aborted when no caller wants the answer any more; a still-queued request then gives up. */
  readonly withdraw: AbortController;
  /** Its download began; a withdraw no longer stops it, so a new caller can still share it. */
  started: boolean;
}

/**
 * What this account generation already learned. Keyed by attachment guid; dropped the moment the
 * generation is retired (Disconnect), so nothing about account A is consulted for account B.
 */
interface GenerationState {
  readonly generation: number;
  /** The server said this attachment has no poster (404), or sent a broken one: never ask again. */
  readonly noPoster: Set<string>;
  /** Temporary failures: do not ask again before `until`; `failures` doubles the next wait. */
  readonly retryAfter: Map<string, { readonly until: number; readonly failures: number }>;
  readonly inFlight: Map<string, SharedRequest>;
  /** Posters in this generation's folder; null until counted (only ever counted while idle). */
  savedFiles: number | null;
  /** The folder reached the cap; it is cleared the next time no poster is downloading. */
  clearDue: boolean;
}

let state: GenerationState | null = null;
/** Process-wide, like the Mac's own limit. A stale account's waiter exits without downloading. */
let activeDownloads = 0;
const waiting: Array<{ readonly start: () => void }> = [];

function stateFor(lease: RealtimeDeliveryLease): GenerationState {
  if (state?.generation === lease.generation) return state;
  const next: GenerationState = {
    generation: lease.generation,
    noPoster: new Set(),
    retryAfter: new Map(),
    inFlight: new Map(),
    savedFiles: null,
    clearDue: false,
  };
  state = next;
  subscribeRealtimeGenerationInvalidation(lease.generation, () => {
    if (state === next) state = null;
  });
  return next;
}

function posterDirectory(generation: number): Directory {
  return new Directory(
    Paths.document,
    VIDEO_POSTER_DIRECTORY,
    mediaGenerationPathSegment(generation),
  );
}

/** Where one attachment's poster is saved for this account generation. */
function posterDestination(guid: string, generation: number): { dir: Directory; file: File } {
  const dir = posterDirectory(generation);
  const name = encodedMediaPathSegment(JSON.stringify([guid, VIDEO_POSTER_WIDTH]));
  return { dir, file: new File(dir, `${name}.jpg`) };
}

/** A zero-byte or oversized file is never a cache hit. */
function isUsable(file: File): boolean {
  try {
    return (
      file.exists &&
      Number.isSafeInteger(file.size) &&
      file.size > 0 &&
      file.size <= VIDEO_POSTER_MAX_BYTES
    );
  } catch {
    return false;
  }
}

/**
 * Local `file://` URI of a video attachment's poster, fetching it from the server when needed.
 * Resolves `null` (never rejects) when there is no poster yet: the caller keeps its blurhash/▶
 * tile. Abort `signal` when the tile goes away; a request nobody wants any more gives up its place
 * in the queue. Pass `replace` when the URI this returned earlier failed to load (its file was
 * cleared, or is unreadable): the old file is dropped and the poster fetched again. Only call this
 * while the server reports `supports_video_poster`, never for RCS.
 */
export function loadVideoPoster(
  guid: string,
  signal?: AbortSignal,
  replace = false,
): Promise<string | null> {
  try {
    if (!guid || signal?.aborted) return Promise.resolve(null);
    const lease = captureRealtimeDeliveryLease();
    if (!lease.isCurrent()) return Promise.resolve(null);
    const current = stateFor(lease);
    const { dir, file } = posterDestination(guid, lease.generation);
    const existing = current.inFlight.get(guid);
    // A download already under way will overwrite the file itself; never delete under it.
    if (replace && !existing?.started) deleteOwnedFile(file);
    if (isUsable(file)) return Promise.resolve(file.uri);
    if (current.noPoster.has(guid)) return Promise.resolve(null);
    const retry = current.retryAfter.get(guid);
    if (retry && Date.now() < retry.until) return Promise.resolve(null);
    // A request withdrawn before its download began will fetch nothing, so a tile that comes
    // back (or remounts at once) starts a fresh one instead of sharing its empty answer.
    const request =
      existing && (existing.started || !existing.withdraw.signal.aborted)
        ? existing
        : startRequest(guid, dir, file, current, lease);
    if (!request) return Promise.resolve(null);
    return follow(request, signal);
  } catch (error) {
    // A guid the filesystem cannot name (too long, invalid Unicode) simply has no poster.
    logger.warn('[video-poster] could not prepare a poster request', error);
    return Promise.resolve(null);
  }
}

function follow(request: SharedRequest, signal: AbortSignal | undefined): Promise<string | null> {
  request.wanted += 1;
  if (!signal) return request.promise;
  const leave = (): void => {
    request.wanted -= 1;
    if (request.wanted === 0) request.withdraw.abort();
  };
  signal.addEventListener('abort', leave, { once: true });
  return request.promise.finally(() => signal.removeEventListener('abort', leave));
}

function startRequest(
  guid: string,
  dir: Directory,
  file: File,
  current: GenerationState,
  lease: RealtimeDeliveryLease,
): SharedRequest | null {
  if (
    activeDownloads >= VIDEO_POSTER_MAX_CONCURRENT &&
    waiting.length >= VIDEO_POSTER_MAX_WAITING
  ) {
    return null;
  }
  clearIfDue(current);
  // Pin before the first await so a late answer can never pair this account's request with
  // another account's server or credential.
  const http = sharedHttp.pinTransport();
  const ownsRun = (): boolean => lease.isCurrent() && http.isTransportCurrent();
  const request = { wanted: 0, withdraw: new AbortController(), started: false } as SharedRequest;
  request.promise = (async (): Promise<string | null> => {
    if (!(await acquireSlot(request.withdraw.signal))) return null;
    try {
      if (!ownsRun() || request.withdraw.signal.aborted) return null;
      request.started = true;
      return await fetchPoster(guid, dir, file, current, http.snapshotTransport(), ownsRun);
    } finally {
      releaseSlot();
    }
  })()
    .catch(() => null)
    .finally(() => {
      if (current.inFlight.get(guid) === request) current.inFlight.delete(guid);
    });
  current.inFlight.set(guid, request);
  return request;
}

async function fetchPoster(
  guid: string,
  dir: Directory,
  file: File,
  current: GenerationState,
  transport: HttpTransportSnapshot,
  ownsRun: () => boolean,
): Promise<string | null> {
  // Another request may have saved it while this one waited for a slot.
  if (isUsable(file)) return file.uri;
  try {
    if (file.exists) deleteOwnedFile(file);
    dir.create({ intermediates: true, idempotent: true });
    await downloadBoundedNativeFile({
      url: attachmentsApi.attachmentPosterUrl(transport, guid, VIDEO_POSTER_WIDTH),
      destination: file,
      headers: { ...transport.headers },
      maxBytes: VIDEO_POSTER_MAX_BYTES,
      timeoutMs: VIDEO_POSTER_TIMEOUT_MS,
      maxImagePixels: VIDEO_POSTER_MAX_PIXELS,
      shouldContinue: ownsRun,
    });
    if (!ownsRun()) {
      deleteOwnedFile(file);
      return null;
    }
    current.retryAfter.delete(guid);
    if (current.savedFiles !== null) {
      current.savedFiles += 1;
      if (current.savedFiles >= VIDEO_POSTER_MAX_FILES) current.clearDue = true;
    }
    return file.uri;
  } catch (error) {
    if (!ownsRun()) return null;
    if (!(error instanceof BoundedDownloadError)) {
      // A problem on the phone, not an answer from the server: nothing is remembered, so the
      // tile asks again the next time it is shown.
      logger.warn('[video-poster] download failed', error);
      return null;
    }
    // 404/410 means the server has no poster for this attachment (including a video it cannot
    // read). An oversized or undecodable answer will not fix itself either.
    if (error.reason === 'missing' || error.reason === 'size') {
      if (current.noPoster.size >= MAX_REMEMBERED_OUTCOMES) current.noPoster.clear();
      current.noPoster.add(guid);
      return null;
    }
    // The native downloader reports every other non-200 answer (503 busy included) as `network`.
    // That and a timeout are worth asking again later; `cancelled` and the phone-side
    // `unavailable` are not the server's answer, so they are not remembered.
    if (error.reason === 'network' || error.reason === 'timeout') rememberFailure(current, guid);
    return null;
  }
}

function rememberFailure(current: GenerationState, guid: string): void {
  const failures = (current.retryAfter.get(guid)?.failures ?? 0) + 1;
  const wait = Math.min(
    VIDEO_POSTER_FIRST_RETRY_MS * 2 ** Math.min(failures - 1, 20),
    VIDEO_POSTER_MAX_RETRY_MS,
  );
  if (current.retryAfter.size >= MAX_REMEMBERED_OUTCOMES && !current.retryAfter.has(guid)) {
    current.retryAfter.clear();
  }
  current.retryAfter.set(guid, { until: Date.now() + wait, failures });
}

/**
 * Keep the folder bounded without scanning it on every save: it is counted once per generation,
 * and once a save brings it to the cap the whole folder is cleared. Clearing (and counting) only
 * happens while no poster is downloading, so it can never pull the folder out from under a
 * request: either just before a request starts while idle, or when the last download finishes.
 * The folder therefore never holds more than the cap plus one queue's worth of posters.
 */
function clearIfDue(current: GenerationState): void {
  if (activeDownloads !== 0 || current !== state) return;
  const dir = posterDirectory(current.generation);
  if (current.savedFiles === null) {
    try {
      current.savedFiles = dir.exists ? dir.list().length : 0;
    } catch {
      current.savedFiles = 0;
    }
    if (current.savedFiles >= VIDEO_POSTER_MAX_FILES) current.clearDue = true;
  }
  if (!current.clearDue) return;
  try {
    if (dir.exists) dir.delete();
    current.savedFiles = 0;
    current.clearDue = false;
  } catch (error) {
    logger.warn('[video-poster] could not clear the poster folder', error);
  }
}

/**
 * Take a download slot, or wait in line for one. Resolves false if `withdraw` aborts while still
 * waiting: the request leaves the line at once, so a closed screen never holds places in it.
 */
function acquireSlot(withdraw: AbortSignal): Promise<boolean> {
  if (withdraw.aborted) return Promise.resolve(false);
  if (activeDownloads < VIDEO_POSTER_MAX_CONCURRENT) {
    activeDownloads += 1;
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const giveUp = (): void => {
      const index = waiting.indexOf(waiter);
      if (index < 0) return;
      waiting.splice(index, 1);
      resolve(false);
    };
    const waiter = {
      start: (): void => {
        withdraw.removeEventListener('abort', giveUp);
        resolve(true);
      },
    };
    withdraw.addEventListener('abort', giveUp, { once: true });
    waiting.push(waiter);
  });
}

/** Hand a freed slot straight to the next waiter so the limit can never be overshot. */
function releaseSlot(): void {
  const next = waiting.shift();
  if (next) {
    next.start();
    return;
  }
  activeDownloads -= 1;
  if (activeDownloads === 0 && state) clearIfDue(state);
}

/** Test seam: forget every remembered outcome and slot. */
export function resetVideoPostersForTests(): void {
  state = null;
  activeDownloads = 0;
  waiting.length = 0;
}
