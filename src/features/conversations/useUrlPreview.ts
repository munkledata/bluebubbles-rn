import { getDatabase } from '@db/database';
import { getUrlPreview, setUrlPreview, type UrlPreviewRow } from '@db/repositories';
import { useReactiveQuery } from '@db/useReactiveQuery';
import { fetchOgMetadata } from '@/services/urlPreview';

const TABLES = ['url_previews'];

// A successful preview is cached for a week; a failed/empty one for only a few hours so a
// TRANSIENT failure (a moment offline, a flaky server, a timeout) doesn't blank that link
// forever — the old code cached negatives permanently, which is why previews stayed blank.
const SUCCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ERROR_TTL_MS = 6 * 60 * 60 * 1000;

/** A cached row is still usable if it hasn't aged past its TTL (shorter for failures). */
function isFresh(row: UrlPreviewRow, now: number): boolean {
  const usable = row.error !== 1 && (!!row.title || !!row.imageUrl);
  const age = now - (row.fetchedAt ?? 0);
  return age < (usable ? SUCCESS_TTL_MS : ERROR_TTL_MS);
}

/**
 * Cache-first Open Graph preview for a message URL. On a miss (or a stale cache row) it fetches
 * once and writes `url_previews` (the write re-fires the reactive query, rendering the card).
 * Failures are cached only briefly (see {@link ERROR_TTL_MS}) so a transient error self-heals.
 */
export function useUrlPreview(url: string | null): UrlPreviewRow | null {
  const { data } = useReactiveQuery<UrlPreviewRow | null>(
    async () => {
      if (!url) return null;
      const db = getDatabase();
      const cached = await getUrlPreview(db, url);
      if (cached && isFresh(cached, Date.now())) return cached;
      const meta = await fetchOgMetadata(url);
      await setUrlPreview(
        db,
        url,
        {
          title: meta?.title,
          description: meta?.description,
          imageUrl: meta?.image,
          siteName: meta?.siteName,
          error: !meta,
        },
        Date.now(),
      );
      return getUrlPreview(db, url);
    },
    TABLES,
    [url],
    // No URL → no query AND no url_previews subscription (every bubble mounts this hook).
    { enabled: url != null },
  );
  return data ?? null;
}
