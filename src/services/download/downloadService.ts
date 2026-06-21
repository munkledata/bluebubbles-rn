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

const MAX_CONCURRENT = 2;
let active = 0;
const waiters: Array<() => void> = [];
const inFlight = new Map<string, Promise<string | null>>();

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
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
