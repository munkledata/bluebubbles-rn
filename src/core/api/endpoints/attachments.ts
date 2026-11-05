import type { HttpUrlBuilder } from '../http';

/**
 * Authed URL for downloading an attachment's binary (consumed by the file downloader).
 *
 * RCS attachment bytes live on a SEPARATE server route (`/rcs/attachment/{mediaID}/download`,
 * served by the Gator RCS bridge via its sidecar) — NOT the iMessage `/attachment/…` route — so
 * branch on the owning chat/message service. The guid is the attachment guid (= the RCS mediaID);
 * everything else (header auth, streaming) is identical.
 */
export function attachmentDownloadUrl(
  http: HttpUrlBuilder,
  guid: string,
  service?: string,
): string {
  const enc = encodeURIComponent(guid);
  return http.buildUrl(
    service === 'RCS' ? `/rcs/attachment/${enc}/download` : `/attachment/${enc}/download`,
  );
}

/** The server clamps a poster's longest side to this range; the app never asks outside it. */
export const VIDEO_POSTER_MIN_WIDTH = 64;
export const VIDEO_POSTER_MAX_WIDTH = 1024;

/**
 * Authed URL for a still JPEG taken from an iMessage/SMS video attachment (behind the server's
 * `supports_video_poster`). `width` is the picture's longest side in pixels. The route never sends
 * the video itself: 200 is a JPEG, 404 means this attachment has no poster, and anything else is a
 * temporary failure. There is no RCS poster route.
 */
export function attachmentPosterUrl(http: HttpUrlBuilder, guid: string, width: number): string {
  if (
    !Number.isSafeInteger(width) ||
    width < VIDEO_POSTER_MIN_WIDTH ||
    width > VIDEO_POSTER_MAX_WIDTH
  ) {
    throw new RangeError('poster width is outside the server range');
  }
  return http.buildUrl(`/attachment/${encodeURIComponent(guid)}/poster?width=${String(width)}`);
}
