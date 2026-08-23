import {
  commitAttachmentCacheReservation,
  updateAttachmentLocalPathWithinTransaction,
} from '@db/repositories';
import { withDbTransaction, type DbTransactionContext } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { attachmentFileName, AUTO_IMAGE_MAX_BYTES } from '@utils/attachment';
import type {
  AttachmentCacheAdmission,
  AttachmentCacheReservation,
  AttachmentCacheReuseResult,
} from './attachmentCacheCoordinator';

export type AttachmentDownloadMode = 'automatic' | 'manual';

/** An explicit user tap may fetch a large file, but never an unbounded one. */
export const MANUAL_ATTACHMENT_MAX_BYTES = 512 * 1024 * 1024; // 512 MiB
/**
 * A byte-small image can still expand into a hostile bitmap. This accommodates current 48 MP
 * phone photos while bounding the native decoder metadata accepted before the UI sees the file.
 */
export const ATTACHMENT_IMAGE_MAX_PIXELS = 64 * 1024 * 1024;
/** Automatic work gets a short absolute deadline; a tap may spend longer on a large attachment. */
export const AUTOMATIC_DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000;
export const MANUAL_DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const DOWNLOAD_SCOPE_POLL_MS = 100;

export interface AttachmentFetchRequest {
  readonly mode: AttachmentDownloadMode;
  readonly maxBytes: number;
  readonly timeoutMs: number;
  /** Native metadata-only decoded-image cap; omitted for non-image attachment kinds. */
  readonly maxImagePixels?: number;
  /** Aborted on timeout, streamed-byte overflow, malformed progress, or account revocation. */
  readonly signal: AbortSignal;
}

/** A fetcher may return a path only after it has verified the final file's real on-disk size. */
export interface AttachmentFetchResult {
  readonly localPath: string;
  readonly bytes: number;
}

export type AttachmentFetchFailure =
  'cancelled' | 'missing' | 'size' | 'timeout' | 'transient' | 'unavailable';

/** Explicit fetch-boundary failure used by injected/test fetchers and future transports. */
export class AttachmentFetchError extends Error {
  constructor(readonly reason: AttachmentFetchFailure) {
    super(`attachment fetch rejected: ${reason}`);
    this.name = 'AttachmentFetchError';
  }
}

export type AttachmentDownloadFailure =
  AttachmentFetchFailure | 'busy' | 'deleted' | 'stale' | 'storage';

export type AttachmentDownloadOutcome =
  | { readonly status: 'success'; readonly localPath: string; readonly bytes: number | null }
  | { readonly status: AttachmentDownloadFailure };

/** Filesystem/network boundary, injected so the orchestration is Node-testable. */
export interface AttachmentFetcher {
  exists(localPath: string | null): boolean;
  /**
   * Resolve the exact final URI without creating a directory or starting native work. The quota
   * coordinator reserves this path before the fetcher is allowed to touch the filesystem.
   */
  destinationUri?(guid: string, transferName: string, generation?: number): string;
  download(
    guid: string,
    transferName: string,
    onProgress?: (loaded: number, total: number) => void,
    /** Owning chat service ('RCS' → the byte-fetch uses the `/rcs/attachment/…` route). */
    service?: string | null,
    /** Captured account generation; absent callers share one stable `unscoped` namespace. */
    generation?: number,
    limits?: AttachmentFetchRequest,
  ): Promise<AttachmentFetchResult>;
  /** Best-effort cleanup when an account transition invalidates a completed transfer. */
  discard?(localPath: string): void | Promise<void>;
}

/** Generation-aware final-commit boundary supplied by the app service layer. */
export interface AttachmentDownloadScope {
  readonly generation: number;
  isCurrent(): boolean;
  /** `null` means the account generation was invalidated before the commit could be delivered. */
  runCommit(task: () => Promise<boolean>): Promise<boolean | null>;
  /** Present on the real persistent fetcher; test/in-memory fetchers may deliberately omit it. */
  reserveCache?(path: string, maxBytes: number): Promise<AttachmentCacheAdmission>;
  /** Protected exact-stat + ledger boundary for production persistent-cache reuse. */
  reuseCache?(path: string): Promise<AttachmentCacheReuseResult>;
}

/** Default parallel-download cap; user-configurable (Settings → Downloads). */
export const DEFAULT_MAX_CONCURRENT_DOWNLOADS = 2;
export const MAX_CONCURRENT_DOWNLOADS_LIMIT = 6;

let maxConcurrent = DEFAULT_MAX_CONCURRENT_DOWNLOADS;
let active = 0;
const waiters: Array<() => void> = [];

interface DownloadFlightObserver {
  readonly onProgress?: (loaded: number, total: number) => void;
  readonly onVerifiedBytes?: (bytes: number) => void;
}

interface DownloadFlight {
  readonly guid: string;
  readonly generation: number | 'unscoped';
  readonly mode: AttachmentDownloadMode;
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly observers: Set<DownloadFlightObserver>;
  task: Promise<AttachmentDownloadOutcome> | null;
  controller: AbortController | null;
  cancelledAs: 'deleted' | null;
}

/** At most one native flight exists per guid/generation; compatible callers share it. */
const inFlight = new Map<string, Set<DownloadFlight>>();
const ATTACHMENT_CACHE_RECORD_CONFLICT = Symbol('attachment-cache-record-conflict');
const ATTACHMENT_CACHE_TARGET_MISSING = Symbol('attachment-cache-target-missing');

export function downloadMaxBytes(mode: AttachmentDownloadMode): number {
  return mode === 'automatic' ? AUTO_IMAGE_MAX_BYTES : MANUAL_ATTACHMENT_MAX_BYTES;
}

export function downloadTimeoutMs(mode: AttachmentDownloadMode): number {
  return mode === 'automatic' ? AUTOMATIC_DOWNLOAD_TIMEOUT_MS : MANUAL_DOWNLOAD_TIMEOUT_MS;
}

/**
 * Metadata is only a pre-flight bound. Automatic work fails closed when the server omitted or
 * malformed it; manual work may discover an unknown length while streaming, within its hard cap.
 */
export function attachmentMetadataAllowsDownload(
  totalBytes: number | null | undefined,
  mode: AttachmentDownloadMode,
): boolean {
  if (totalBytes == null) return mode === 'manual';
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) return false;
  return totalBytes <= downloadMaxBytes(mode);
}

/**
 * Set the parallel-download cap at runtime (from the persisted setting). Clamped to
 * [1, {@link MAX_CONCURRENT_DOWNLOADS_LIMIT}]. If the cap GROWS, wake queued downloads to
 * fill the new slots immediately.
 */
export function setMaxConcurrentDownloads(n: number): void {
  const requested = Number.isFinite(n) ? Math.floor(n) : DEFAULT_MAX_CONCURRENT_DOWNLOADS;
  maxConcurrent = Math.max(1, Math.min(MAX_CONCURRENT_DOWNLOADS_LIMIT, requested));
  while (active < maxConcurrent && waiters.length > 0) {
    waiters.shift()!();
  }
}

function acquire(): Promise<void> {
  if (active < maxConcurrent) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waiters.push(() => {
      active += 1;
      resolve();
    });
  });
}

function release(): void {
  active -= 1;
  // Settings can lower the cap while several transfers are active. Do not wake a queued transfer
  // until enough old slots have drained to satisfy the NEW limit.
  if (active < maxConcurrent) waiters.shift()?.();
}

export interface AttachmentDownloadTarget {
  readonly guid: string;
  readonly transferName: string | null;
  readonly localPath: string | null;
  readonly totalBytes?: number | null;
  /** Only used to give a nameless attachment a file extension — see {@link attachmentFileName}. */
  readonly mimeType?: string | null;
  readonly service?: string | null;
}

/**
 * Download an attachment to local storage, persist its `localPath`, and return a typed outcome.
 * Compatible concurrent callers share one transfer only when its byte and time limits are at
 * least as strict as theirs; each joined caller receives future progress and verified-byte events.
 * A stricter caller does not start a second flight against the same destination: two native tasks
 * would otherwise write and promote the exact same `.part` file concurrently.
 */
export async function ensureDownloadedOutcome(
  db: AppDatabase,
  fetcher: AttachmentFetcher,
  att: AttachmentDownloadTarget,
  onProgress?: (loaded: number, total: number) => void,
  scope?: AttachmentDownloadScope,
  mode: AttachmentDownloadMode = 'manual',
  onVerifiedBytes?: (bytes: number) => void,
  maxBytesOverride?: number,
): Promise<AttachmentDownloadOutcome> {
  if (scope && !scope.isCurrent()) return { status: 'stale' };
  if (att.localPath) {
    if (scope?.reuseCache) {
      let reuse: AttachmentCacheReuseResult;
      try {
        reuse = await scope.reuseCache(att.localPath);
      } catch {
        return { status: scope.isCurrent() ? 'unavailable' : 'stale' };
      }
      if (reuse.status === 'hit') {
        return { status: 'success', localPath: att.localPath, bytes: null };
      }
      if (reuse.status !== 'missing') return { status: reuse.status };
      if (!scope.isCurrent()) return { status: 'stale' };
    } else if (fetcher.exists(att.localPath)) {
      // Compatibility for injected/in-memory fetchers. Production composition always supplies the
      // protected native-stat + ledger boundary above.
      return { status: 'success', localPath: att.localPath, bytes: null };
    }
  }
  if (!attachmentMetadataAllowsDownload(att.totalBytes, mode)) return { status: 'size' };
  if (
    maxBytesOverride !== undefined &&
    (!Number.isSafeInteger(maxBytesOverride) ||
      maxBytesOverride <= 0 ||
      (att.totalBytes != null && att.totalBytes > maxBytesOverride))
  ) {
    return { status: 'size' };
  }
  const maxBytes = Math.min(downloadMaxBytes(mode), maxBytesOverride ?? Number.MAX_SAFE_INTEGER);
  const timeoutMs = downloadTimeoutMs(mode);
  const transferName = attachmentFileName(att.transferName, att.guid, att.mimeType);
  const generation = scope?.generation ?? 'unscoped';
  const flightKey = JSON.stringify([generation, att.guid]);
  const observer: DownloadFlightObserver = { onProgress, onVerifiedBytes };
  const flights = inFlight.get(flightKey);
  const existing = [...(flights ?? [])].find(
    (flight) => flight.maxBytes <= maxBytes && flight.timeoutMs <= timeoutMs,
  );
  if (existing?.task) return observeFlight(existing, existing.task, observer);
  // The production fetcher writes every generation+guid to one final destination. Starting a
  // second, stricter transfer beside a looser one would race that path; fail this attempt closed
  // and let its caller retry after the existing flight settles.
  if (flights && flights.size > 0) return { status: 'busy' };

  const flight: DownloadFlight = {
    guid: att.guid,
    generation,
    mode,
    maxBytes,
    timeoutMs,
    observers: new Set(),
    task: null,
    controller: null,
    cancelledAs: null,
  };

  const task = (async (): Promise<AttachmentDownloadOutcome> => {
    await acquire();
    let completedPath: string | null = null;
    let timedOut = false;
    let rejectedProgress = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let scopePoll: ReturnType<typeof setInterval> | undefined;
    let transfer: Promise<AttachmentFetchResult> | null = null;
    let abortListener: (() => void) | undefined;
    let cacheReservation: AttachmentCacheReservation | null = null;
    let cacheProtectionHandoff = false;
    try {
      if (flight.cancelledAs) return { status: flight.cancelledAs };
      if (scope && !scope.isCurrent()) return { status: 'stale' };

      if (scope?.reserveCache) {
        if (!fetcher.destinationUri) return { status: 'unavailable' };
        let destination: string;
        try {
          destination = fetcher.destinationUri(att.guid, transferName, scope.generation);
        } catch {
          return { status: 'unavailable' };
        }
        const admission = await scope.reserveCache(destination, maxBytes);
        if (admission.status !== 'reserved') return { status: admission.status };
        cacheReservation = admission.reservation;
        if (flight.cancelledAs || !scope.isCurrent()) {
          return { status: flight.cancelledAs ?? 'stale' };
        }
      }

      const controller = new AbortController();
      flight.controller = controller;
      try {
        transfer = fetcher.download(
          att.guid,
          transferName,
          (loaded, total) => {
            const stale = scope != null && !scope.isCurrent();
            const invalidLoaded = !Number.isSafeInteger(loaded) || loaded < 0;
            const streamedOverCap = loaded > maxBytes;
            const declaredOverCap = Number.isFinite(total) && total >= 0 && total > maxBytes;
            if (stale || invalidLoaded || streamedOverCap || declaredOverCap) {
              rejectedProgress = rejectedProgress || !stale;
              controller.abort();
              return;
            }
            notifyProgress(flight, loaded, total);
          },
          att.service,
          scope?.generation,
          {
            mode,
            maxBytes,
            timeoutMs,
            signal: controller.signal,
            ...(att.mimeType?.startsWith('image/')
              ? { maxImagePixels: ATTACHMENT_IMAGE_MAX_PIXELS }
              : {}),
          },
        );
      } catch (error) {
        return failureOutcome(error, flight, scope, timedOut, rejectedProgress, controller.signal);
      }
      if (flight.cancelledAs) controller.abort();
      if (scope) {
        // A native request can stall before emitting progress. Do not leave account-A credentials
        // in flight until the long manual deadline merely because no callback arrived to notice
        // that Disconnect revoked its generation.
        scopePoll = setInterval(() => {
          if (!scope.isCurrent()) controller.abort();
        }, DOWNLOAD_SCOPE_POLL_MS);
      }
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new AttachmentFetchError('timeout'));
        }, timeoutMs);
      });
      const cancellation = new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(new AttachmentFetchError('cancelled'));
        controller.signal.addEventListener('abort', abortListener, { once: true });
        if (controller.signal.aborted) abortListener();
      });

      let fetched: AttachmentFetchResult;
      try {
        fetched = await Promise.race([transfer, deadline, cancellation]);
      } catch (error) {
        // An injected/native implementation that ignores AbortSignal must not be allowed to commit
        // later. This continuation cleans up a hostile late success after our bounded task settles.
        if (timedOut || rejectedProgress || controller.signal.aborted) {
          if (cacheReservation) {
            const heldReservation = cacheReservation;
            cacheReservation = null;
            // The UI-facing race may settle before an abort-ignoring native promise. Keep the
            // quota/path token charged until that underlying work and its cleanup truly settle.
            void transfer
              .then((late) => discard(fetcher, late.localPath))
              .catch(() => undefined)
              .then(() => heldReservation.release())
              .catch(() => undefined);
          } else {
            void transfer.then((late) => discard(fetcher, late.localPath)).catch(() => undefined);
          }
        }
        return failureOutcome(error, flight, scope, timedOut, rejectedProgress, controller.signal);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        if (scopePoll !== undefined) clearInterval(scopePoll);
        if (abortListener) controller.signal.removeEventListener('abort', abortListener);
      }

      const validResult =
        typeof fetched?.localPath === 'string' &&
        fetched.localPath.length > 0 &&
        Number.isSafeInteger(fetched.bytes) &&
        fetched.bytes > 0 &&
        (cacheReservation == null || fetched.localPath === cacheReservation.path);
      if (
        !validResult ||
        fetched.bytes > maxBytes ||
        rejectedProgress ||
        controller.signal.aborted
      ) {
        if (typeof fetched?.localPath === 'string') await discard(fetcher, fetched.localPath);
        if (cacheReservation && fetched?.localPath !== cacheReservation.path) {
          await discard(fetcher, cacheReservation.path);
        }
        return failureOutcome(
          new AttachmentFetchError('size'),
          flight,
          scope,
          timedOut,
          rejectedProgress || !validResult || fetched.bytes > maxBytes,
          controller.signal,
        );
      }
      completedPath = fetched.localPath;
      if (flight.cancelledAs || (scope && !scope.isCurrent())) {
        await discard(fetcher, completedPath);
        completedPath = null;
        return { status: flight.cancelledAs ?? 'stale' };
      }
      const verifiedPath = completedPath;
      const persistPathAndLedger = async (context: DbTransactionContext): Promise<boolean> => {
        if (cacheReservation) {
          const recorded = await commitAttachmentCacheReservation(context, {
            path: verifiedPath,
            bytes: fetched.bytes,
            lastUsedAt: Date.now(),
          });
          // Returning false would COMMIT local_path while the ledger says a delete owns the file.
          // Throwing this private sentinel rolls both statements back together.
          if (!recorded) throw ATTACHMENT_CACHE_RECORD_CONFLICT;
          // Updating local_path flushes reactive attachment readers. Open the exact
          // reservation's identity-checked consumer handoff BEFORE that write, while retaining the
          // reservation itself so overwrite, recovery, and retirement remain blocked.
          if (!cacheReservation.beginProtectionHandoff()) {
            throw ATTACHMENT_CACHE_RECORD_CONFLICT;
          }
          cacheProtectionHandoff = true;
        }
        const updated = await updateAttachmentLocalPathWithinTransaction(
          context,
          att.guid,
          verifiedPath,
        );
        // When a durable reservation was promoted above, returning false would COMMIT it as active
        // with no attachment reference. Throw so the outer transaction restores `reserved`; the
        // reservation release then owns exact cleanup through crash-safe recovery.
        if (!updated) {
          if (cacheReservation) throw ATTACHMENT_CACHE_TARGET_MISSING;
          return false;
        }
        return true;
      };
      let cacheRecordConflict = false;
      let cacheTargetMissing = false;
      let persisted: boolean | null;
      try {
        persisted = scope
          ? await scope.runCommit(() =>
              withDbTransaction(
                db,
                persistPathAndLedger,
                // Re-check after acquiring the process-wide lock AND immediately before COMMIT.
                // A queued old-account write must not land in a later empty database.
                () => scope.isCurrent() && flight.cancelledAs == null,
              ),
            )
          : await withDbTransaction(db, persistPathAndLedger, () => flight.cancelledAs == null);
      } catch (error) {
        if (error === ATTACHMENT_CACHE_RECORD_CONFLICT) cacheRecordConflict = true;
        else if (error === ATTACHMENT_CACHE_TARGET_MISSING) cacheTargetMissing = true;
        else throw error;
        persisted = false;
      }
      if (persisted !== true) {
        if (cacheReservation && cacheProtectionHandoff) {
          cacheReservation.rollbackProtectionHandoff();
          cacheProtectionHandoff = false;
        }
        await discard(fetcher, completedPath);
        completedPath = null;
        if (cacheRecordConflict) return { status: 'busy' };
        if (cacheTargetMissing) return { status: 'deleted' };
        return {
          status: persisted === null || (scope != null && !scope.isCurrent()) ? 'stale' : 'deleted',
        };
      }
      // A row-deletion cancellation can lose the race to a transaction that already COMMITTED.
      // In that case leave the now-owned file in place: the deleting service re-checks the DB and
      // removes it only if the row deletion itself succeeded. Discarding here would leave a live
      // row pointing at a missing file when the subsequent delete fails.
      if (scope && !scope.isCurrent()) {
        await discard(fetcher, completedPath);
        completedPath = null;
        return { status: 'stale' };
      }

      notifyVerifiedBytes(flight, fetched.bytes);
      return { status: 'success', localPath: completedPath, bytes: fetched.bytes };
    } catch (error) {
      if (cacheReservation && cacheProtectionHandoff) {
        cacheReservation.rollbackProtectionHandoff();
        cacheProtectionHandoff = false;
      }
      if (completedPath) await discard(fetcher, completedPath);
      return failureOutcome(
        error,
        flight,
        scope,
        timedOut,
        rejectedProgress,
        flight.controller?.signal,
      );
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (scopePoll !== undefined) clearInterval(scopePoll);
      flight.controller = null;
      if (cacheReservation) {
        await cacheReservation.release().catch(() => undefined);
        cacheReservation = null;
      }
      release();
    }
  })();
  const settled = task.finally(() => {
    const current = inFlight.get(flightKey);
    current?.delete(flight);
    if (current?.size === 0) inFlight.delete(flightKey);
  });
  flight.task = settled;
  const nextFlights = flights ?? new Set<DownloadFlight>();
  nextFlights.add(flight);
  inFlight.set(flightKey, nextFlights);
  return observeFlight(flight, settled, observer);
}

/** Compatibility wrapper retained for existing UI and tests that only need path-or-null. */
export async function ensureDownloaded(
  db: AppDatabase,
  fetcher: AttachmentFetcher,
  att: AttachmentDownloadTarget,
  onProgress?: (loaded: number, total: number) => void,
  scope?: AttachmentDownloadScope,
  mode: AttachmentDownloadMode = 'manual',
  onVerifiedBytes?: (bytes: number) => void,
  maxBytesOverride?: number,
): Promise<string | null> {
  const outcome = await ensureDownloadedOutcome(
    db,
    fetcher,
    att,
    onProgress,
    scope,
    mode,
    onVerifiedBytes,
    maxBytesOverride,
  );
  return outcome.status === 'success' ? outcome.localPath : null;
}

/** Stop transfers whose owning rows are about to be deleted. */
export function cancelAttachmentDownloads(guids: Iterable<string>, generation?: number): void {
  const targets = new Set(guids);
  if (targets.size === 0) return;
  for (const flights of inFlight.values()) {
    for (const flight of flights) {
      if (!targets.has(flight.guid)) continue;
      if (generation !== undefined && flight.generation !== generation) continue;
      flight.cancelledAs = 'deleted';
      flight.controller?.abort();
    }
  }
}

function observeFlight(
  flight: DownloadFlight,
  task: Promise<AttachmentDownloadOutcome>,
  observer: DownloadFlightObserver,
): Promise<AttachmentDownloadOutcome> {
  flight.observers.add(observer);
  return task.finally(() => flight.observers.delete(observer));
}

function notifyProgress(flight: DownloadFlight, loaded: number, total: number): void {
  for (const observer of flight.observers) {
    try {
      observer.onProgress?.(loaded, total);
    } catch {
      // Presentation observers cannot abort or poison a shared native transfer.
    }
  }
}

function notifyVerifiedBytes(flight: DownloadFlight, bytes: number): void {
  for (const observer of flight.observers) {
    try {
      observer.onVerifiedBytes?.(bytes);
    } catch {
      // Accounting/presentation observers cannot turn a committed download into a failure.
    }
  }
}

function failureOutcome(
  error: unknown,
  flight: DownloadFlight,
  scope: AttachmentDownloadScope | undefined,
  timedOut: boolean,
  rejectedProgress: boolean,
  signal?: AbortSignal,
): AttachmentDownloadOutcome {
  if (flight.cancelledAs) return { status: flight.cancelledAs };
  if (scope && !scope.isCurrent()) return { status: 'stale' };
  if (timedOut) return { status: 'timeout' };
  if (rejectedProgress) return { status: 'size' };

  const reason = fetchFailureReason(error);
  if (reason) return { status: reason };
  if (signal?.aborted) return { status: 'cancelled' };
  return { status: 'unavailable' };
}

function fetchFailureReason(error: unknown): AttachmentFetchFailure | null {
  const reason =
    error instanceof AttachmentFetchError
      ? error.reason
      : typeof error === 'object' && error !== null && 'reason' in error
        ? (error as { reason?: unknown }).reason
        : undefined;
  if (reason === 'network') return 'transient';
  if (
    reason === 'cancelled' ||
    reason === 'missing' ||
    reason === 'size' ||
    reason === 'timeout' ||
    reason === 'transient' ||
    reason === 'unavailable'
  ) {
    return reason;
  }
  return null;
}

/** Best-effort deletion shared by every post-transfer rejection path. */
async function discard(fetcher: AttachmentFetcher, localPath: string): Promise<void> {
  await Promise.resolve(fetcher.discard?.(localPath)).catch(() => undefined);
}
