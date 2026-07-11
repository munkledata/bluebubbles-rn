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

// RCS media often 404s only TRANSIENTLY: the picture frame can reach the server before its
// decryption key does (the key rides a later bridge frame), so the first fetch has no key and
// fails. A small, BOUNDED backoff retry recovers it once the server caches the key — WITHOUT the
// old "re-download on every reactive flush" storm (ImageAttachment blocks that by not auto-firing
// once status is set; this drives the retry itself instead). iMessage media is NOT auto-retried —
// a 404 there is usually permanent, so its tap-to-retry button appears immediately as before.
const MAX_RCS_AUTO_RETRIES = 3;
const RCS_RETRY_BACKOFF_MS = [2500, 6000, 12000];
const rcsRetries = new Map<string, number>();

/**
 * Ensure an attachment is downloaded locally (UI-bound). Reports progress into
 * `useDownloadStore` so the bubble can show a ring / retry. Returns the local
 * path or null. Re-invoking after a failure retries (ensureDownloaded dedupes
 * concurrent calls and clears its in-flight entry on settle). RCS media gets a
 * bounded automatic backoff retry (see above); a fresh call resets that backoff.
 */
export function download(att: AttachmentRow): Promise<string | null> {
  rcsRetries.delete(att.guid); // fresh auto/manual intent → start the backoff over
  return runDownload(att);
}

function runDownload(att: AttachmentRow): Promise<string | null> {
  const { start, setProgress, finish, fail } = useDownloadStore.getState();
  start(att.guid);
  return ensureDownloaded(getDatabase(), fetcher, att, (loaded, total) =>
    setProgress(att.guid, loaded, total),
  ).then((path) => {
    if (path) {
      rcsRetries.delete(att.guid);
      finish(att.guid);
      return path;
    }
    if (att.service === 'RCS') {
      const n = rcsRetries.get(att.guid) ?? 0;
      if (n < MAX_RCS_AUTO_RETRIES) {
        rcsRetries.set(att.guid, n + 1);
        const delay = RCS_RETRY_BACKOFF_MS[Math.min(n, RCS_RETRY_BACKOFF_MS.length - 1)] ?? 12000;
        start(att.guid); // hold the spinner (not the reload button) through the backoff wait
        setTimeout(() => void runDownload(att), delay);
        return null;
      }
      rcsRetries.delete(att.guid);
    }
    fail(att.guid);
    return path;
  });
}
