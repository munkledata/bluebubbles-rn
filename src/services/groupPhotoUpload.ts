import * as FileSystem from 'expo-file-system/legacy';
import {
  parseIMessageGroupPhotoSetResponse,
  type IMessageGroupPhotoSetAck,
} from '@core/api/endpoints/chats';
import { ApiError } from '@core/api/errors';
import { parseServerErrorBody } from '@core/api/serverErrorDetail';
import {
  MAX_IMESSAGE_GROUP_PHOTO_BYTES,
  isSupportedImessageGroupPhotoType,
} from '@core/models/serverInfo';
import type { GroupPhotoUploader } from './groupPhotoService';
import { UploadGateCancelledError, uploadGate } from './send/uploadControl';

function releaseProgressSubscription(task: FileSystem.UploadTask): void {
  try {
    (task as unknown as { removeSubscription?: () => void }).removeSubscription?.();
  } catch {
    // Cleanup must never replace the upload's result.
  }
}

/** Native streaming transport for the dedicated group-photo multipart route. */
export const expoGroupPhotoUploader: GroupPhotoUploader = async ({
  http,
  chatGuid,
  tempGuid,
  image,
  signal,
  assertNetworkStart,
  onDispatch,
}): Promise<IMessageGroupPhotoSetAck> => {
  if (!isSupportedImessageGroupPhotoType(image.mimeType, image.name)) {
    throw new ApiError('local_file', 'Choose a JPEG or PNG group photo.');
  }
  if (signal.aborted) {
    throw new ApiError('cancelled', 'Group photo upload was cancelled', undefined, signal.reason);
  }

  http.assertTransportCurrent();
  // Capture one immutable origin/auth/custom-header tuple before the native file preflight.
  const transport = http.snapshotTransport();
  const url = transport.buildUrl(`/chat/${encodeURIComponent(chatGuid)}/icon`);
  let task: FileSystem.UploadTask | null = null;
  const cancelNative = (): void => {
    if (task) void task.cancelAsync().catch(() => undefined);
  };
  signal.addEventListener('abort', cancelNative, { once: true });
  if (signal.aborted) cancelNative();

  try {
    const info = await FileSystem.getInfoAsync(image.uri).catch(() => null);
    if (signal.aborted) {
      throw new ApiError('cancelled', 'Group photo upload was cancelled', undefined, signal.reason);
    }
    if (
      !info?.exists ||
      !Number.isSafeInteger(info.size) ||
      info.size <= 0 ||
      info.size > MAX_IMESSAGE_GROUP_PHOTO_BYTES
    ) {
      throw new ApiError('local_file', 'Choose a JPEG or PNG group photo no larger than 20 MiB.');
    }

    let result: FileSystem.FileSystemUploadResult | null | undefined;
    try {
      result = await uploadGate.run(async () => {
        if (signal.aborted) throw new UploadGateCancelledError();
        assertNetworkStart();
        http.assertTransportCurrent();
        const started = FileSystem.createUploadTask(url, image.uri, {
          httpMethod: 'POST',
          uploadType: FileSystem.FileSystemUploadType.MULTIPART,
          fieldName: 'icon',
          mimeType: image.mimeType,
          parameters: { tempGuid },
          headers: { ...transport.headers },
        });
        task = started;
        try {
          if (signal.aborted) {
            void started.cancelAsync().catch(() => undefined);
            throw new UploadGateCancelledError();
          }
          // `uploadAsync` is the first native dispatch call. From this marker onward, a missing
          // response cannot prove non-delivery, so the service reports uncertainty and never retries.
          onDispatch();
          return await started.uploadAsync();
        } finally {
          releaseProgressSubscription(started);
        }
      }, signal);
    } catch (error) {
      if (signal.aborted || error instanceof UploadGateCancelledError) {
        throw new ApiError(
          'cancelled',
          'Group photo upload was cancelled',
          undefined,
          signal.reason ?? error,
        );
      }
      if (error instanceof ApiError) throw error;
      throw new ApiError('no_connection', 'Group photo upload request failed', undefined, error);
    }

    if (!result) {
      throw new ApiError(
        signal.aborted ? 'cancelled' : 'no_connection',
        signal.aborted
          ? 'Group photo upload was cancelled'
          : 'Group photo upload returned no response',
        undefined,
        signal.reason,
      );
    }
    if (result.status < 200 || result.status >= 300) {
      const serverError = parseServerErrorBody(result.body ?? '');
      throw ApiError.fromStatus(
        result.status,
        'Group photo upload failed',
        serverError?.detail,
        serverError?.type,
      );
    }
    return parseIMessageGroupPhotoSetResponse(result.body ?? '', result.status, {
      chatGuid,
      tempGuid,
    });
  } finally {
    signal.removeEventListener('abort', cancelNative);
  }
};
