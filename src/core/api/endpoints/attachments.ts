import { Message } from '@core/models';
import type { HttpClient } from '../http';

/** Authed URL for downloading an attachment's binary (consumed by the file downloader). */
export function attachmentDownloadUrl(http: HttpClient, guid: string): string {
  return http.buildUrl(`/attachment/${encodeURIComponent(guid)}/download`);
}

export interface SendAttachmentParams {
  chatGuid: string;
  /** Message temp guid (also the attachment temp guid server-side). */
  tempGuid: string;
  file: { uri: string; name: string; type: string };
}

/**
 * POST /api/v1/message/attachment (multipart/form-data) → server Message with the
 * attachment. On React Native, FormData accepts a `{ uri, name, type }` file part.
 * Native-free (FormData exists in Node + RN), so it is Node-testable with a fake http.
 */
export function sendAttachment(http: HttpClient, p: SendAttachmentParams): Promise<Message> {
  const form = new FormData();
  form.append('attachment', {
    uri: p.file.uri,
    name: p.file.name,
    type: p.file.type,
  } as unknown as Blob);
  form.append('chatGuid', p.chatGuid);
  form.append('tempGuid', p.tempGuid);
  form.append('name', p.file.name);
  form.append('method', 'private-api');
  return http.post('/message/attachment', Message, { form });
}
