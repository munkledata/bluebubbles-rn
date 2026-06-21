import { getDatabase } from '@db/database';
import type { AttachmentRow } from '@db/repositories';
import { useDownloadStore } from '@state/downloadStore';
import { http } from '@/services';
import { ensureDownloaded, type AttachmentFetcher } from './downloadService';
import { expoFetcher } from './expoFetcher';

export type { AttachmentFetcher } from './downloadService';
export { ensureDownloaded } from './downloadService';

let fetcher: AttachmentFetcher = expoFetcher(http);

/** DEV/test hook to swap the fetcher (e.g. a real-URL progress stub). */
export function setAttachmentFetcher(f: AttachmentFetcher): void {
  fetcher = f;
}

/**
 * Ensure an attachment is downloaded locally (UI-bound). Reports progress into
 * `useDownloadStore` so the bubble can show a ring / retry. Returns the local
 * path or null. Re-invoking after a failure retries (ensureDownloaded dedupes
 * concurrent calls and clears its in-flight entry on settle).
 */
export function download(att: AttachmentRow): Promise<string | null> {
  const { start, setProgress, finish, fail } = useDownloadStore.getState();
  start(att.guid);
  return ensureDownloaded(getDatabase(), fetcher, att, (loaded, total) =>
    setProgress(att.guid, loaded, total),
  ).then((path) => {
    if (path) finish(att.guid);
    else fail(att.guid);
    return path;
  });
}
