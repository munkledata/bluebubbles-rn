import { SendAck } from './messages';
import type { HttpClient } from '../http';

/** Authed URL for downloading an attachment's binary (consumed by the file downloader). */
export function attachmentDownloadUrl(http: HttpClient, guid: string): string {
  return http.buildUrl(`/attachment/${encodeURIComponent(guid)}/download`);
}

export interface SendAttachmentParams {
  chatGuid: string;
  /** Message temp guid (also the attachment temp guid server-side). */
  tempGuid: string;
  /** Display/transfer name of the file. */
  name: string;
  /** The file bytes, base64-encoded (read at the uri by the caller). */
  data: string;
  /** Send method; 'private-api' for stock attachment sends. */
  method?: string;
}

/**
 * POST /api/v1/message/attachment (application/json) → the send ack `{ guid? }` (the real
 * message GUID; attachment sends require the Private API, so it's present on success), NOT a
 * Message — see {@link SendAck}. The attachment's own server guid is not acked here; the
 * optimistic attachment row keeps its local guid until the socket `new-message` echo carries
 * the real one.
 *
 * Server contract: it has NO multipart parser — it accepts JSON `{ chatGuid, name, data,
 * tempGuid, method }` with the file bytes base64-encoded in `data` (the old multipart body
 * was silently rejected). The caller reads the base64 (expo-file-system) and passes it in, so
 * this stays Node-pure / unit-testable with a fake http.
 */
export function sendAttachment(http: HttpClient, p: SendAttachmentParams): Promise<SendAck> {
  return http.post('/message/attachment', SendAck, {
    json: {
      chatGuid: p.chatGuid,
      tempGuid: p.tempGuid,
      name: p.name,
      data: p.data,
      method: p.method ?? 'private-api',
    },
  });
}
