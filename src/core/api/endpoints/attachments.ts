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
