import { sql } from 'drizzle-orm';
import {
  isUrlPreviewImageDataUrl,
  MAX_URL_PREVIEW_IMAGE_DATA_URL_CHARS,
} from '@core/api/endpoints/urlPreviews';
import { urlPreviews } from '../schema';
import { runInTransactionContext, type DbTransactionContext } from '../transaction';
import type { AppDatabase } from '../types';

// ---- URL preview cache ----

/** Positive previews remain reusable for one day; failures retry after a short quiet period. */
export const URL_PREVIEW_SUCCESS_TTL_MS = 24 * 60 * 60 * 1_000;
export const URL_PREVIEW_NEGATIVE_TTL_MS = 15 * 60 * 1_000;
export const URL_PREVIEW_CACHE_MAX_ENTRIES = 128;
export const URL_PREVIEW_CACHE_MAX_BYTES = 16 * 1024 * 1024;

export interface UrlPreviewRow {
  url: string;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
  fetchedAt: number | null;
  error: number;
}

/**
 * Accept only the server contract's bounded, canonical Base64 image form. In particular, legacy
 * http(s) image URLs remain inert and can never reach React Native's image loader through cache.
 */
export function sanitizeUrlPreviewImageUrl(value: string | null | undefined): string | null {
  if (!value || value.length > MAX_URL_PREVIEW_IMAGE_DATA_URL_CHARS) return null;
  return isUrlPreviewImageDataUrl(value) ? value : null;
}

/** The exact wall-clock instant when a positive or negative preview stops being reusable. */
export function urlPreviewCacheExpiresAt(row: UrlPreviewRow | null): number | null {
  if (!row || !Number.isSafeInteger(row.fetchedAt) || row.fetchedAt === null || row.fetchedAt < 0) {
    return null;
  }
  const ttl = row.error !== 0 ? URL_PREVIEW_NEGATIVE_TTL_MS : URL_PREVIEW_SUCCESS_TTL_MS;
  const expiresAt = row.fetchedAt + ttl;
  return Number.isSafeInteger(expiresAt) ? expiresAt : null;
}

/** A cache row is reusable only inside its own positive/negative lifetime. */
export function isUrlPreviewCacheFresh(
  row: UrlPreviewRow | null,
  now = Date.now(),
): row is UrlPreviewRow {
  if (!row || !Number.isSafeInteger(now) || now < 0) return false;
  const expiresAt = urlPreviewCacheExpiresAt(row);
  const fetchedAt = row.fetchedAt;
  if (expiresAt === null || fetchedAt === null || fetchedAt > now || now >= expiresAt) return false;
  if (
    row.error === 0 &&
    !row.title?.trim() &&
    !row.description?.trim() &&
    !row.siteName?.trim() &&
    !sanitizeUrlPreviewImageUrl(row.imageUrl)
  ) {
    return false;
  }
  return true;
}

export async function getUrlPreview(db: AppDatabase, url: string): Promise<UrlPreviewRow | null> {
  const rows = await db.all<UrlPreviewRow>(sql`
    SELECT url, title, description, image_url AS imageUrl, site_name AS siteName,
           fetched_at AS fetchedAt, error FROM url_previews WHERE url = ${url} LIMIT 1`);
  const row = rows[0];
  return row ? { ...row, imageUrl: sanitizeUrlPreviewImageUrl(row.imageUrl) } : null;
}

interface UrlPreviewWriteData {
  title?: string;
  description?: string;
  imageUrl?: string;
  siteName?: string;
  error?: boolean;
}

function assertValidPreviewTimestamp(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new RangeError('URL preview timestamp must be a non-negative safe integer');
  }
}

/** Publish and prune one preview inside an already-owned short database transaction. */
export function setUrlPreviewWithinTransaction(
  context: DbTransactionContext,
  url: string,
  data: UrlPreviewWriteData,
  now: number,
): Promise<void> {
  return runInTransactionContext(context, async (db) => {
    assertValidPreviewTimestamp(now);
    const imageUrl = sanitizeUrlPreviewImageUrl(data.imageUrl);
    await db
      .insert(urlPreviews)
      .values({
        url,
        title: data.title ?? null,
        description: data.description ?? null,
        imageUrl,
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

    // Keep age, entry count, and actual UTF-8/blob bytes bounded in the same transaction that
    // publishes the replacement. Newest live rows win; expired/future-dated rows are removed.
    await db.run(sql`
        WITH measured AS (
          SELECT
            url,
            fetched_at,
            CASE
              WHEN fetched_at IS NULL OR fetched_at < 0 OR fetched_at > ${now} THEN 1
              WHEN COALESCE(error, 1) <> 0
                AND fetched_at <= ${now - URL_PREVIEW_NEGATIVE_TTL_MS} THEN 1
              WHEN COALESCE(error, 1) = 0
                AND fetched_at <= ${now - URL_PREVIEW_SUCCESS_TTL_MS} THEN 1
              ELSE 0
            END AS expired,
            COALESCE(length(CAST(url AS BLOB)), 0)
              + COALESCE(length(CAST(title AS BLOB)), 0)
              + COALESCE(length(CAST(description AS BLOB)), 0)
              + COALESCE(length(CAST(image_url AS BLOB)), 0)
              + COALESCE(length(CAST(site_name AS BLOB)), 0) AS byte_size
          FROM url_previews
        ), ranked AS (
          SELECT
            url,
            expired,
            ROW_NUMBER() OVER (
              ORDER BY expired ASC, fetched_at DESC, url DESC
            ) AS entry_rank,
            SUM(byte_size) OVER (
              ORDER BY expired ASC, fetched_at DESC, url DESC
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            ) AS cumulative_bytes
          FROM measured
        )
        DELETE FROM url_previews
        WHERE url IN (
          SELECT url
          FROM ranked
          WHERE expired <> 0
             OR entry_rank > ${URL_PREVIEW_CACHE_MAX_ENTRIES}
             OR cumulative_bytes > ${URL_PREVIEW_CACHE_MAX_BYTES}
        )
      `);
  });
}
