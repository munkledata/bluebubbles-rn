import { sql } from 'drizzle-orm';
import { urlPreviews } from '../schema';
import type { AppDatabase } from '../types';

// ---- URL preview cache ----

export interface UrlPreviewRow {
  url: string;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
  fetchedAt: number | null;
  error: number;
}

export async function getUrlPreview(db: AppDatabase, url: string): Promise<UrlPreviewRow | null> {
  const rows = await db.all<UrlPreviewRow>(sql`
    SELECT url, title, description, image_url AS imageUrl, site_name AS siteName,
           fetched_at AS fetchedAt, error FROM url_previews WHERE url = ${url} LIMIT 1`);
  return rows[0] ?? null;
}

export async function setUrlPreview(
  db: AppDatabase,
  url: string,
  data: {
    title?: string;
    description?: string;
    imageUrl?: string;
    siteName?: string;
    error?: boolean;
  },
  now: number,
): Promise<void> {
  await db
    .insert(urlPreviews)
    .values({
      url,
      title: data.title ?? null,
      description: data.description ?? null,
      imageUrl: data.imageUrl ?? null,
      siteName: data.siteName ?? null,
      fetchedAt: now,
      error: data.error ? 1 : 0,
    })
    .onConflictDoUpdate({
      target: urlPreviews.url,
      set: {
        title: sql`excluded.title`,
        description: sql`excluded.description`,
        imageUrl: sql`excluded.image_url`,
        siteName: sql`excluded.site_name`,
        fetchedAt: sql`excluded.fetched_at`,
        error: sql`excluded.error`,
      },
    });
}
