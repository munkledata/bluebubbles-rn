import * as FileSystem from 'expo-file-system/legacy';
import { z } from 'zod/v4';
import { ApiError } from '@core/api/errors';
import { logger } from '@core/secure';
import type { HttpClient } from '@core/api/http';

/**
 * Set / remove a group chat's photo via the server's group-icon endpoints (Private API
 * `update-group-photo` under the hood). Set STREAMS the image as multipart (field `icon`) the same
 * way attachments upload — the native layer reads the file off disk so a large photo never sits in
 * JS memory. Remove is a plain DELETE.
 */
export async function uploadGroupIcon(
  http: HttpClient,
  chatGuid: string,
  file: { uri: string; name: string; mimeType: string },
): Promise<void> {
  const url = http.buildUrl(`/chat/${encodeURIComponent(chatGuid)}/icon`);
  let result: FileSystem.FileSystemUploadResult;
  try {
    result = await FileSystem.uploadAsync(url, file.uri, {
      httpMethod: 'POST',
      uploadType: FileSystem.FileSystemUploadType.MULTIPART,
      fieldName: 'icon',
      mimeType: file.mimeType,
      parameters: { name: file.name },
      headers: http.buildHeaders(),
    });
  } catch (err) {
    logger.warn(
      `[group-icon] upload failed err=${err instanceof Error ? err.message : String(err)}`,
    );
    throw new ApiError('no_connection', 'Group icon upload failed', undefined, err);
  }
  if (result.status < 200 || result.status >= 300) {
    throw ApiError.fromStatus(result.status, 'group icon upload failed');
  }
}

/** Remove a group chat's photo. */
export function removeGroupIcon(http: HttpClient, chatGuid: string): Promise<unknown> {
  return http.delete(`/chat/${encodeURIComponent(chatGuid)}/icon`, z.unknown());
}
