import { getDatabase } from '@db/database';
import { getUrlPreview, type UrlPreviewRow } from '@db/repositories';
import { useReactiveQuery } from '@db/useReactiveQuery';

const TABLES = ['url_previews'];

/**
 * Read-only URL-preview cache lookup.
 *
 * NET-00 containment deliberately performs no HTML or image request on a cache miss. Existing
 * text metadata may still render, but remote image URLs are removed before they reach React
 * Native's <Image> component because mounting one would itself make an automatic network request.
 */
export function useUrlPreview(url: string | null): UrlPreviewRow | null {
  const { data } = useReactiveQuery<UrlPreviewRow | null>(
    async () => {
      if (!url) return null;
      const cached = await getUrlPreview(getDatabase(), url);
      if (!cached) return null;
      // Preserve the fact that an image-only cache row had useful metadata before removing the
      // remote URL. Otherwise UrlPreviewCard sees neither title nor image and silently removes a
      // card that is meant to degrade to a safe, text-only domain link.
      const title = cached.title ?? (cached.imageUrl?.trim() ? previewDomain(url) : null);
      return { ...cached, title, imageUrl: null };
    },
    TABLES,
    [url],
    // No URL → no query AND no url_previews subscription (every bubble mounts this hook).
    { enabled: url != null },
  );
  return data ?? null;
}

function previewDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
