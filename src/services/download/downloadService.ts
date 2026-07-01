import { updateAttachmentLocalPath } from '@db/repositories';
import type { AppDatabase } from '@db/types';

/** Filesystem/network boundary, injected so the orchestration is Node-testable. */
export interface AttachmentFetcher {
  exists(localPath: string | null): boolean;
  download(
    guid: string,
    transferName: string,
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<string>;
}

/** Default parallel-download cap; user-configurable (Settings → Downloads). */
export const DEFAULT_MAX_CONCURRENT_DOWNLOADS = 2;
export const MAX_CONCURRENT_DOWNLOADS_LIMIT = 6;

let maxConcurrent = DEFAULT_MAX_CONCURRENT_DOWNLOADS;
let active = 0;
const waiters: Array<() => void> = [];
const inFlight = new Map<string, Promise<string | null>>();

/**
 * Set the parallel-download cap at runtime (from the persisted setting). Clamped to
 * [1, {@link MAX_CONCURRENT_DOWNLOADS_LIMIT}]. If the cap GROWS, wake queued downloads to
 * fill the new slots immediately.
 */
export function setMaxConcurrentDownloads(n: number): void {
  maxConcurrent = Math.max(1, Math.min(MAX_CONCURRENT_DOWNLOADS_LIMIT, Math.floor(n)));
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
  waiters.shift()?.();
}

/**
 * Download an attachment to local storage (once), persist its `localPath`, and
 * return the path. Skips if already present; dedupes concurrent calls per guid;
 * caps concurrency. The DB write fires the reactive `attachments` watcher, so the
 * conversation view swaps placeholder → image automatically.
 */
export async function ensureDownloaded(
  db: AppDatabase,
  fetcher: AttachmentFetcher,
  att: { guid: string; transferName: string | null; localPath: string | null },
  onProgress?: (loaded: number, total: number) => void,
): Promise<string | null> {
  if (att.localPath && fetcher.exists(att.localPath)) return att.localPath;
  const existing = inFlight.get(att.guid);
  if (existing) return existing;

  const task = (async (): Promise<string | null> => {
    await acquire();
    try {
      const path = await fetcher.download(att.guid, att.transferName ?? att.guid, onProgress);
      await updateAttachmentLocalPath(db, att.guid, path);
      return path;
    } catch {
      return null;
    } finally {
      release();
      inFlight.delete(att.guid);
    }
  })();
  inFlight.set(att.guid, task);
  return task;
}
