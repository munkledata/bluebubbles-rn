import { SendAck } from './messages';
import type { HttpClient } from '../http';

/**
 * Authed URL for downloading an attachment's binary (consumed by the file downloader).
 *
 * RCS attachment bytes live on a SEPARATE server route (`/rcs/attachment/{mediaID}/download`,
 * served by the Gator RCS bridge via its sidecar) — NOT the iMessage `/attachment/…` route — so
 * branch on the owning chat/message service. The guid is the attachment guid (= the RCS mediaID);
 * everything else (header auth, streaming) is identical.
 */
export function attachmentDownloadUrl(http: HttpClient, guid: string, service?: string): string {
  const enc = encodeURIComponent(guid);
  return http.buildUrl(
    service === 'RCS' ? `/rcs/attachment/${enc}/download` : `/attachment/${enc}/download`,
  );
}

/** The request body for an attachment send — a streamed multipart form (production). */
export interface AttachmentRequestBody {
  /** Multipart form with the file part + fields (RN streams the file from disk). */
  form?: FormData;
  /** JSON body (test/legacy shape) — inspected by tests; production uses `form`. */
  json?: unknown;
}

/**
 * POST /api/v1/message/attachment/upload (multipart/form-data) → the send ack `{ guid? }` (the
 * real message GUID; attachment sends require the Private API, so it's present on success), NOT a
 * Message — see {@link SendAck}. The attachment's own server guid is not acked here; the optimistic
 * attachment row keeps its local guid until the socket `new-message` echo carries the real one.
 *
 * The file is STREAMED as a multipart upload (RN reads it from disk during the request), so large
 * videos are never held in JS memory — restoring the original app's large-file support that the
 * base64-in-JSON path had capped. The caller builds the body (multipart form in production, an
 * inspectable JSON object in tests), keeping this Node-pure / unit-testable with a fake http.
 */
export function sendAttachment(http: HttpClient, body: AttachmentRequestBody): Promise<SendAck> {
  return http.post('/message/attachment/upload', SendAck, body);
}
