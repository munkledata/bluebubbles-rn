import { Directory, File, Paths } from 'expo-file-system';
import { downloadNativeBoundedFile, NativeBoundedDownloadError } from '@native/boundedDownload';

const OWNERSHIP_POLL_MS = 100;
const PARTIAL_DIRECTORY_NAME = 'bounded-download-parts';
const activeDestinations = new Set<string>();
const activeBoundedTransfers = new Map<AbortController, Promise<unknown>>();
let partialRootPrepared = false;
let partialSequence = 0;

export type BoundedDownloadFailure =
  'cancelled' | 'missing' | 'network' | 'size' | 'timeout' | 'unavailable';

export class BoundedDownloadError extends Error {
  constructor(readonly reason: BoundedDownloadFailure) {
    super(`bounded download rejected: ${reason}`);
    this.name = 'BoundedDownloadError';
  }
}

export interface BoundedNativeDownloadOptions {
  readonly url: string;
  readonly destination: File;
  readonly headers?: Record<string, string>;
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly maxImagePixels?: number;
  readonly signal?: AbortSignal;
  readonly shouldContinue?: () => boolean;
  readonly onProgress?: (loaded: number, total: number) => void;
}

export interface BoundedNativeDownloadResult {
  readonly file: File;
  readonly bytes: number;
}

/**
 * Stream a native download into a request-unique app-cache file, enforce actual bytes + an
 * absolute deadline, verify the on-disk size, then atomically promote it to the caller's final
 * path. A per-destination lock is acquired before any cleanup or native work so two callers can
 * never erase or overwrite one another's in-progress transfer.
 */
export function downloadBoundedNativeFile(
  options: BoundedNativeDownloadOptions,
): Promise<BoundedNativeDownloadResult> {
  const controller = new AbortController();
  let tracked!: Promise<BoundedNativeDownloadResult>;
  tracked = runBoundedNativeFile(options, controller).finally(() => {
    activeBoundedTransfers.delete(controller);
  });
  activeBoundedTransfers.set(controller, tracked);
  return tracked;
}

async function runBoundedNativeFile(
  options: BoundedNativeDownloadOptions,
  controller: AbortController,
): Promise<BoundedNativeDownloadResult> {
  const destinationKey = options.destination.uri;
  if (activeDestinations.has(destinationKey)) throw new BoundedDownloadError('unavailable');
  // The bundle entry normally prepares this root. Retry here if the native filesystem was
  // unavailable during process-start cleanup; no request is registered yet, so cleanup cannot
  // race us.
  if (!partialRootPrepared) cleanupAbandonedBoundedDownloadPartials();
  activeDestinations.add(destinationKey);

  let partial: File | undefined;

  let rejectedForSize = false;
  let rejectedForOwnership = false;
  let timedOut = false;
  let promoted = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let ownershipPoll: ReturnType<typeof setInterval> | undefined;
  const abortFromCaller = (): void => controller.abort();

  try {
    partial = nextPartialFile();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener('abort', abortFromCaller, { once: true });
    const transfer = downloadNativeBoundedFile({
      url: options.url,
      destinationUri: partial.uri,
      headers: options.headers ? { ...options.headers } : undefined,
      signal: controller.signal,
      maxBytes: options.maxBytes,
      timeoutMs: options.timeoutMs,
      maxImagePixels: options.maxImagePixels,
      onProgress: (loaded, total) => {
        const invalidBytes = !Number.isSafeInteger(loaded) || loaded < 0;
        const streamedOverCap = loaded > options.maxBytes;
        const declaredOverCap = Number.isFinite(total) && total >= 0 && total > options.maxBytes;
        if (invalidBytes || streamedOverCap || declaredOverCap) {
          rejectedForSize = true;
          controller.abort();
          return;
        }
        if (options.shouldContinue && !options.shouldContinue()) {
          rejectedForOwnership = true;
          controller.abort();
          return;
        }
        options.onProgress?.(loaded, total);
      },
    });
    if (options.shouldContinue) {
      // A server can stall before producing its first progress event. Polling the cheap generation
      // predicate makes Disconnect cancel that no-progress native request promptly instead of
      // letting old credentials remain in flight until the full per-file deadline.
      ownershipPoll = setInterval(() => {
        if (options.shouldContinue?.()) return;
        rejectedForOwnership = true;
        controller.abort();
      }, OWNERSHIP_POLL_MS);
    }
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new BoundedDownloadError('timeout'));
      }, options.timeoutMs);
    });

    const nativeResult = await Promise.race([transfer, deadline]);
    const file = partial;
    if (
      options.signal?.aborted ||
      rejectedForOwnership ||
      (options.shouldContinue != null && !options.shouldContinue())
    ) {
      throw new BoundedDownloadError('cancelled');
    }
    const bytes = file.size;
    if (
      rejectedForSize ||
      !file.exists ||
      !Number.isSafeInteger(bytes) ||
      bytes <= 0 ||
      bytes > options.maxBytes ||
      bytes !== nativeResult.bytes
    ) {
      throw new BoundedDownloadError('size');
    }
    if (timedOut) throw new BoundedDownloadError('timeout');
    if (controller.signal.aborted) throw new BoundedDownloadError('cancelled');

    await file.move(options.destination, { overwrite: true });
    promoted = true;
    // Promotion itself is an await: a timeout/account handoff in that window must delete the newly
    // published final instead of returning it as a success owned by the next session.
    if (rejectedForSize) throw new BoundedDownloadError('size');
    if (timedOut) throw new BoundedDownloadError('timeout');
    if (
      options.signal?.aborted ||
      rejectedForOwnership ||
      controller.signal.aborted ||
      (options.shouldContinue != null && !options.shouldContinue())
    ) {
      throw new BoundedDownloadError('cancelled');
    }
    const finalBytes = options.destination.size;
    if (
      !options.destination.exists ||
      !Number.isSafeInteger(finalBytes) ||
      finalBytes <= 0 ||
      finalBytes !== bytes ||
      finalBytes > options.maxBytes
    ) {
      throw new BoundedDownloadError('size');
    }
    return { file: options.destination, bytes };
  } catch (error) {
    if (partial) deleteOwnedFile(partial);
    if (promoted) deleteOwnedFile(options.destination);
    if (rejectedForSize) throw new BoundedDownloadError('size');
    if (timedOut) throw new BoundedDownloadError('timeout');
    if (options.signal?.aborted || rejectedForOwnership || controller.signal.aborted) {
      throw new BoundedDownloadError('cancelled');
    }
    if (error instanceof NativeBoundedDownloadError) {
      throw new BoundedDownloadError(error.reason);
    }
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (ownershipPoll !== undefined) clearInterval(ownershipPoll);
    options.signal?.removeEventListener('abort', abortFromCaller);
    activeDestinations.delete(destinationKey);
  }
}

/**
 * Cancel every owned native transfer and wait a bounded time for its JS/native cleanup to settle.
 * Account teardown calls this before its final media-directory sweep, closing the race where a
 * late old-account move could recreate bytes after Disconnect had already confirmed deletion.
 */
export async function cancelAndDrainBoundedDownloads(timeoutMs: number): Promise<boolean> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) return false;
  const pending = [...activeBoundedTransfers.entries()];
  if (pending.length === 0) return true;
  pending.forEach(([controller]) => controller.abort());

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    await Promise.race([
      Promise.allSettled(pending.map(([, transfer]) => transfer)),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, timeoutMs);
      }),
    ]);
    return !timedOut && activeBoundedTransfers.size === 0;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Own one dedicated temporary namespace. Removing the whole app-private directory when a JS
 * runtime starts makes process-kill recovery constant-work: it cannot be starved by a large
 * attachment tree, and a legitimate completed filename ending in `.part` is never mistaken for a
 * temporary. The directory is flat and the native module admits at most eight requests, so this
 * startup sweep itself is bounded.
 */
export function cleanupAbandonedBoundedDownloadPartials(): void {
  // This export lets startup/integration tests re-run the idempotent sweep, but must never erase a
  // partial owned by this live runtime.
  if (activeDestinations.size > 0) return;
  const root = new Directory(Paths.cache, PARTIAL_DIRECTORY_NAME);
  if (root.exists) root.delete();
  root.create({ intermediates: true, idempotent: true });
  partialRootPrepared = true;
}

function nextPartialFile(): File {
  const root = new Directory(Paths.cache, PARTIAL_DIRECTORY_NAME);
  partialSequence += 1;
  return new File(root, `request-${Date.now()}-${partialSequence}.part`);
}

/** Remove one app-owned file without letting native stat/delete failures hide the real outcome. */
export function deleteOwnedFile(file: File): void {
  try {
    if (file.exists) file.delete();
  } catch {
    // A later retry/startup sweep gets another chance.
  }
}
