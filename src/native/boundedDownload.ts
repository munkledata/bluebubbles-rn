import { requireOptionalNativeModule } from 'expo';

export type NativeBoundedDownloadFailure =
  'cancelled' | 'missing' | 'network' | 'size' | 'timeout' | 'unavailable';

interface NativeProgressEvent {
  requestId: string;
  loaded: number;
  total: number;
}

interface NativeDownloadResult {
  ok: boolean;
  bytes?: number;
  reason?: NativeBoundedDownloadFailure;
}

interface NativeSyncedBackgroundPruneResult {
  ok: boolean;
  withinQuota?: boolean;
  deletedFiles?: number;
  deletedBytes?: number;
  remainingFiles?: number;
  remainingBytes?: number;
}

interface NativeAttachmentCacheStatResult {
  ok?: boolean;
  exists?: boolean;
  bytes?: number;
}

interface NativeAttachmentCacheDeleteResult {
  ok?: boolean;
  status?: string;
  bytes?: number;
}

interface NativeAttachmentCacheAvailableBytesResult {
  ok?: boolean;
  availableBytes?: number;
}

interface NativeAdoptedPastedAttachmentResult {
  ok?: boolean;
  uri?: string;
  bytes?: number;
}

interface NativeAttachmentCacheScanBeginResult {
  ok?: boolean;
  scanId?: string;
}

interface NativeAttachmentCacheScanFileResult {
  uri?: string;
  bytes?: number;
  mtimeMs?: number;
}

interface NativeAttachmentCacheScanPageResult {
  ok?: boolean;
  done?: boolean;
  overflow?: boolean;
  files?: NativeAttachmentCacheScanFileResult[];
}

interface NativeAttachmentCacheScanCloseResult {
  ok?: boolean;
  closed?: boolean;
}

interface NativeSubscription {
  remove(): void;
}

interface GatorBoundedDownloadNative {
  prepare(requestId: string): void;
  cancel(requestId: string): void;
  releasePrepared(requestId: string): void;
  download(
    requestId: string,
    url: string,
    destinationUri: string,
    headers: Record<string, string>,
    maxBytes: number,
    timeoutMs: number,
    maxImagePixels: number,
  ): Promise<NativeDownloadResult>;
  pruneSyncedBackgroundCache(keepUri: string | null): Promise<NativeSyncedBackgroundPruneResult>;
  deleteSyncedBackgroundCacheFile(uri: string): Promise<boolean>;
  statAttachmentCacheFile(uri: string): Promise<NativeAttachmentCacheStatResult>;
  deleteAttachmentCacheFile(uri: string): Promise<NativeAttachmentCacheDeleteResult>;
  adoptPastedAttachment(
    sourceUri: string,
    destinationUri: string,
    expectedBytes: number,
  ): Promise<NativeAdoptedPastedAttachmentResult>;
  getAttachmentCacheAvailableBytes(): Promise<NativeAttachmentCacheAvailableBytesResult>;
  beginAttachmentCacheScan(): Promise<NativeAttachmentCacheScanBeginResult>;
  nextAttachmentCacheScanPage(scanId: string): Promise<NativeAttachmentCacheScanPageResult>;
  closeAttachmentCacheScan(scanId: string): Promise<NativeAttachmentCacheScanCloseResult>;
  addListener(
    eventName: 'onProgress',
    listener: (event: NativeProgressEvent) => void,
  ): NativeSubscription;
}

export class NativeBoundedDownloadError extends Error {
  constructor(readonly reason: NativeBoundedDownloadFailure) {
    super(`native bounded download rejected: ${reason}`);
    this.name = 'NativeBoundedDownloadError';
  }
}

export interface NativeBoundedDownloadOptions {
  url: string;
  destinationUri: string;
  headers?: Record<string, string>;
  maxBytes: number;
  timeoutMs: number;
  /** Optional decoded-image pixel cap; zero/omitted accepts non-image payloads. */
  maxImagePixels?: number;
  signal?: AbortSignal;
  onProgress?: (loaded: number, total: number) => void;
}

export interface SyncedBackgroundPruneResult {
  readonly withinQuota: boolean;
  readonly deletedFiles: number;
  readonly deletedBytes: number;
  readonly remainingFiles: number;
  readonly remainingBytes: number;
}

export interface AttachmentCacheFileStat {
  readonly exists: boolean;
  readonly bytes: number;
}

export type AttachmentCacheDeleteStatus = 'deleted' | 'missing';

export interface AttachmentCacheDeleteResult {
  readonly status: AttachmentCacheDeleteStatus;
  readonly bytes: number;
}

export interface AdoptedPastedAttachment {
  readonly uri: string;
  readonly bytes: number;
}

export interface AttachmentCacheScanFile {
  readonly uri: string;
  readonly bytes: number;
  readonly mtimeMs: number;
}

const ATTACHMENT_CACHE_SCAN_MAX_ID_CHARS = 80;
const ATTACHMENT_CACHE_SCAN_MAX_URI_CHARS = 4096;
const ATTACHMENT_CACHE_SCAN_MAX_FILES_PER_PAGE = 100;
const ATTACHMENT_CACHE_SCAN_MAX_TOTAL_FILES = 8192;
// Native consumes at least one of its 32,768 bounded nodes on every non-complete page. Keep an
// independent JavaScript ceiling too, so a malformed bridge can never make startup loop forever.
const ATTACHMENT_CACHE_SCAN_MAX_PAGES = 32769;

let requestSequence = 0;

function nextRequestId(): string {
  requestSequence += 1;
  return `bounded-${Date.now()}-${requestSequence}`;
}

function getNative(): GatorBoundedDownloadNative | null {
  try {
    return requireOptionalNativeModule<GatorBoundedDownloadNative>('GatorBoundedDownload');
  } catch {
    return null;
  }
}

/**
 * Invoke the owned Android streaming boundary. There is deliberately no Expo DownloadTask
 * fallback: a JS progress callback is too late to enforce an actual-byte security limit.
 */
export async function downloadNativeBoundedFile(
  options: NativeBoundedDownloadOptions,
): Promise<{ bytes: number }> {
  const native = getNative();
  if (!native) throw new NativeBoundedDownloadError('unavailable');
  if (options.signal?.aborted) throw new NativeBoundedDownloadError('cancelled');

  const requestId = nextRequestId();
  native.prepare(requestId);
  let subscription: NativeSubscription | null = null;
  let downloadInvoked = false;
  const abort = (): void => native.cancel(requestId);
  try {
    subscription = native.addListener('onProgress', (event) => {
      if (event.requestId === requestId) options.onProgress?.(event.loaded, event.total);
    });
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) native.cancel(requestId);
    const download = native.download(
      requestId,
      options.url,
      options.destinationUri,
      options.headers ? { ...options.headers } : {},
      options.maxBytes,
      options.timeoutMs,
      options.maxImagePixels ?? 0,
    );
    downloadInvoked = true;
    const result = await download;
    if (!result.ok) {
      throw new NativeBoundedDownloadError(result.reason ?? 'unavailable');
    }
    if (!Number.isSafeInteger(result.bytes) || (result.bytes ?? 0) <= 0) {
      throw new NativeBoundedDownloadError('size');
    }
    return { bytes: result.bytes! };
  } finally {
    options.signal?.removeEventListener('abort', abort);
    try {
      subscription?.remove();
    } catch {
      // Event-emitter teardown is independent from request-state teardown below.
    }
    try {
      if (downloadInvoked) {
        native.cancel(requestId);
      } else {
        // Listener setup or the bridge call itself failed before native `download()` could own its
        // cleanup. Release only that prepared (not-yet-running) slot.
        native.releasePrepared(requestId);
      }
    } catch {
      // An invoked operation also owns a native `finally`. If a prepared-slot release itself is
      // unreachable, there is no second bridge path to recover it; never mask the original result.
    }
  }
}

/**
 * Enforce the native-owned global synced-wallpaper quota.
 *
 * No root or budget crosses the bridge: Android pins both values and accepts only an optional
 * exact cache file to protect. That keeps this from becoming a general app-private delete API.
 */
export async function pruneNativeSyncedBackgroundCache(
  keepUri: string | null,
): Promise<SyncedBackgroundPruneResult> {
  const native = getNative();
  if (!native) throw new NativeBoundedDownloadError('unavailable');

  const result = await native.pruneSyncedBackgroundCache(keepUri);
  const stats = [
    result.deletedFiles,
    result.deletedBytes,
    result.remainingFiles,
    result.remainingBytes,
  ];
  if (
    !result.ok ||
    typeof result.withinQuota !== 'boolean' ||
    stats.some((value) => !Number.isSafeInteger(value) || (value ?? -1) < 0)
  ) {
    throw new NativeBoundedDownloadError('unavailable');
  }

  return {
    withinQuota: result.withinQuota,
    deletedFiles: result.deletedFiles!,
    deletedBytes: result.deletedBytes!,
    remainingFiles: result.remainingFiles!,
    remainingBytes: result.remainingBytes!,
  };
}

/** Delete one exact current/legacy wallpaper through Android's fixed, canonical namespace gate. */
export async function deleteNativeSyncedBackgroundCacheFile(uri: string): Promise<boolean> {
  const native = getNative();
  if (!native) throw new NativeBoundedDownloadError('unavailable');
  const deleted = await native.deleteSyncedBackgroundCacheFile(uri);
  if (typeof deleted !== 'boolean') throw new NativeBoundedDownloadError('unavailable');
  return deleted;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Inspect one exact file through Android's fixed attachment-cache ownership boundary. */
export async function statNativeAttachmentCacheFile(uri: string): Promise<AttachmentCacheFileStat> {
  const native = getNative();
  if (!native) throw new NativeBoundedDownloadError('unavailable');

  const result = await native.statAttachmentCacheFile(uri);
  if (
    result?.ok !== true ||
    typeof result.exists !== 'boolean' ||
    !isNonNegativeSafeInteger(result.bytes) ||
    (!result.exists && result.bytes !== 0)
  ) {
    throw new NativeBoundedDownloadError('unavailable');
  }

  return { exists: result.exists, bytes: result.bytes };
}

/** Delete one exact file through Android's fixed, non-recursive attachment-cache gate. */
export async function deleteNativeAttachmentCacheFile(
  uri: string,
): Promise<AttachmentCacheDeleteResult> {
  const native = getNative();
  if (!native) throw new NativeBoundedDownloadError('unavailable');

  const result = await native.deleteAttachmentCacheFile(uri);
  if (
    result?.ok !== true ||
    (result.status !== 'deleted' && result.status !== 'missing') ||
    !isNonNegativeSafeInteger(result.bytes) ||
    (result.status === 'missing' && result.bytes !== 0)
  ) {
    throw new NativeBoundedDownloadError('unavailable');
  }

  return { status: result.status, bytes: result.bytes };
}

/**
 * Move one exact native-owned rich-paste file into one reserved ordinary-cache destination.
 *
 * Android fixes and validates both roots and refuses legacy/noncanonical destination layouts;
 * JavaScript supplies the expected URI only so it can reserve the same ledger identity first.
 */
export async function adoptNativePastedAttachment(
  sourceUri: string,
  destinationUri: string,
  expectedBytes: number,
): Promise<AdoptedPastedAttachment> {
  const native = getNative();
  if (!native) throw new NativeBoundedDownloadError('unavailable');
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) {
    throw new NativeBoundedDownloadError('size');
  }

  let result: NativeAdoptedPastedAttachmentResult;
  try {
    result = await native.adoptPastedAttachment(sourceUri, destinationUri, expectedBytes);
  } catch {
    throw new NativeBoundedDownloadError('unavailable');
  }
  if (
    result?.ok !== true ||
    result.uri !== destinationUri ||
    result.bytes !== expectedBytes ||
    !Number.isSafeInteger(result.bytes)
  ) {
    throw new NativeBoundedDownloadError('unavailable');
  }
  return { uri: result.uri, bytes: result.bytes };
}

/** Read free storage for the native-owned attachment-cache volume. */
export async function getNativeAttachmentCacheAvailableBytes(): Promise<number> {
  const native = getNative();
  if (!native) throw new NativeBoundedDownloadError('unavailable');

  const result = await native.getAttachmentCacheAvailableBytes();
  if (result?.ok !== true || !isNonNegativeSafeInteger(result.availableBytes)) {
    throw new NativeBoundedDownloadError('unavailable');
  }
  return result.availableBytes;
}

/**
 * Collect one complete native-owned attachment-cache manifest before callers reconcile anything.
 *
 * The scanner root and all resource limits are fixed in Android. This wrapper validates every
 * bridge page, applies its own total/page ceilings, rejects duplicate URIs, and returns no partial
 * manifest when any later page fails. The opaque native session is always closed best-effort.
 */
export async function scanNativeAttachmentCacheFiles(): Promise<AttachmentCacheScanFile[]> {
  const native = getNative();
  if (!native) throw new NativeBoundedDownloadError('unavailable');

  const begin = await native.beginAttachmentCacheScan();
  if (
    begin?.ok !== true ||
    typeof begin.scanId !== 'string' ||
    begin.scanId.length === 0 ||
    begin.scanId.length > ATTACHMENT_CACHE_SCAN_MAX_ID_CHARS
  ) {
    throw new NativeBoundedDownloadError('unavailable');
  }

  const scanId = begin.scanId;
  const files: AttachmentCacheScanFile[] = [];
  const seen = new Set<string>();
  try {
    for (let pageNumber = 0; pageNumber < ATTACHMENT_CACHE_SCAN_MAX_PAGES; pageNumber += 1) {
      const page = await native.nextAttachmentCacheScanPage(scanId);
      if (
        page?.ok !== true ||
        typeof page.done !== 'boolean' ||
        page.overflow !== false ||
        !Array.isArray(page.files) ||
        page.files.length > ATTACHMENT_CACHE_SCAN_MAX_FILES_PER_PAGE
      ) {
        throw new NativeBoundedDownloadError('unavailable');
      }

      for (const candidate of page.files) {
        if (
          candidate == null ||
          typeof candidate !== 'object' ||
          typeof candidate.uri !== 'string' ||
          candidate.uri.length === 0 ||
          candidate.uri.length > ATTACHMENT_CACHE_SCAN_MAX_URI_CHARS ||
          !isNonNegativeSafeInteger(candidate.bytes) ||
          !isNonNegativeSafeInteger(candidate.mtimeMs) ||
          seen.has(candidate.uri) ||
          files.length >= ATTACHMENT_CACHE_SCAN_MAX_TOTAL_FILES
        ) {
          throw new NativeBoundedDownloadError('unavailable');
        }
        seen.add(candidate.uri);
        files.push({
          uri: candidate.uri,
          bytes: candidate.bytes,
          mtimeMs: candidate.mtimeMs,
        });
      }

      if (page.done) return files;
    }
    throw new NativeBoundedDownloadError('unavailable');
  } finally {
    try {
      await native.closeAttachmentCacheScan(scanId);
    } catch {
      // A complete native scan auto-closes itself. On failure, the native TTL is the final cleanup
      // backstop; never mask the page validation error with a best-effort close error.
    }
  }
}
