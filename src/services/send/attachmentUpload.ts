import * as FileSystem from 'expo-file-system/legacy';
import { SendAck } from '@core/api/endpoints/messages';
import { ApiError } from '@core/api/errors';
import { apiResponse } from '@core/models/common';
import { logger } from '@core/secure';
import type { AttachmentUploader } from './sendAttachmentService';

/**
 * Production attachment uploader: streams the file to the server's multipart route via
 * `expo-file-system`'s `uploadAsync` (native, RFC-2387 multipart). The native layer reads the
 * file straight off disk and streams it, so even a 1 GB video uploads with flat JS memory — this
 * is why we do NOT use `fetch`/FormData here: Expo's `fetch` can't stream a file-URI FormData part
 * (it needs an in-memory Blob), which threw "Unsupported FormDataPart implementation".
 *
 * The form fields (chatGuid/tempGuid/name/method) ride as multipart `parameters` alongside the
 * file part (fieldName `attachment`); the server reads them the same as the JSON path did.
 */
export const expoAttachmentUploader: AttachmentUploader = async ({
  http,
  chatGuid,
  tempGuid,
  name,
  uri,
  mimeType,
}) => {
  const url = http.buildUrl('/message/attachment/upload');
  let result: FileSystem.FileSystemUploadResult;
  try {
    result = await FileSystem.uploadAsync(url, uri, {
      httpMethod: 'POST',
      uploadType: FileSystem.FileSystemUploadType.MULTIPART,
      fieldName: 'attachment',
      mimeType,
      parameters: { chatGuid, tempGuid, name, method: 'private-api' },
      headers: http.buildHeaders(),
    });
  } catch (err) {
    logger.warn(
      `[upload] streaming upload failed err=${err instanceof Error ? err.message : String(err)}`,
    );
    throw new ApiError('no_connection', 'Upload request failed', undefined, err);
  }

  if (result.status < 200 || result.status >= 300) {
    // Log the server's exact status + error body (the daemon's own log is too buffered to read
    // live). This surfaces e.g. "helper not connected" (iMessage) vs an RCS bridge error.
    logger.warn(
      `[upload] server rejected status=${result.status} body=${(result.body ?? '').slice(0, 300)}`,
    );
    throw ApiError.fromStatus(result.status, 'attachment upload failed');
  }

  let json: unknown;
  try {
    json = JSON.parse(result.body);
  } catch (err) {
    throw new ApiError('parse_error', 'Upload response was not valid JSON', result.status, err);
  }
  const parsed = apiResponse(SendAck).safeParse(json);
  if (!parsed.success) {
    throw new ApiError(
      'parse_error',
      'Upload response did not match schema',
      result.status,
      parsed.error,
    );
  }
  return parsed.data.data;
};
