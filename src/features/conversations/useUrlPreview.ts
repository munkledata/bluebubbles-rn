import { getDatabase } from '@db/database';
import { getUrlPreview, setUrlPreview, type UrlPreviewRow } from '@db/repositories';
import { useReactiveQuery } from '@db/useReactiveQuery';
import { fetchOgMetadata } from '@/services/urlPreview';

const TABLES = ['url_previews'];

/**
 * Cache-first Open Graph preview for a message URL. On a miss it fetches once
 * and writes `url_previews` (the write re-fires the reactive query, rendering the
 * card). Negative results are cached so dead URLs aren't re-fetched.
 */
export function useUrlPreview(url: string | null): UrlPreviewRow | null {
  const { data } = useReactiveQuery<UrlPreviewRow | null>(
    async () => {
      if (!url) return null;
      const db = getDatabase();
      const cached = await getUrlPreview(db, url);
      if (cached) return cached;
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
  );
  return data ?? null;
}
