import * as FileSystem from 'expo-file-system/legacy';
import { SendAck } from '@core/api/endpoints/messages';
import { ApiError } from '@core/api/errors';
import { apiResponse } from '@core/models/common';
import { logger } from '@core/secure';
import { uploadStoreSink } from '@state/uploadStore';
import { showToast } from '@ui/toast/toastStore';
import type { AttachmentUploader } from './sendAttachmentService';
import { runTrackedUpload } from './trackedUpload';
import { uploadGate, uploadRegistry } from './uploadControl';
import { isLocalFileFailure } from './uploadErrors';

/**
 * Production attachment uploader: streams the file to the server's multipart route via
 * `expo-file-system`'s native RFC-2387 multipart upload. The native layer reads the file straight
 * off disk and streams it, so even a 1 GB video uploads with flat JS memory — this is why we do
 * NOT use `fetch`/FormData here: Expo's `fetch` can't stream a file-URI FormData part (it needs an
 * in-memory Blob), which threw "Unsupported FormDataPart implementation".
 *
 * The form fields (chatGuid/tempGuid/name/method) ride as multipart `parameters` alongside the
 * file part (fieldName `attachment`); the server reads them the same as the JSON path did.
 *
 * WHY `createUploadTask` AND NOT `uploadAsync`: they build the identical request (both go through
 * the native `createUploadRequest`), but `uploadAsync` passes a no-op body decorator while the
 * task form wraps the body in a counting one — so the task is the only variant that emits byte
 * progress, and it also gives us a handle to cancel. On Android the counting decorator wraps ONLY
 * the file part (`FileSystemLegacyModule.createRequestBody`), so the reported total is the file's
 * exact length rather than the multipart envelope. Native throttles the events to one per 100 ms.
 *
 * DELIBERATELY the LEGACY module, not SDK 57's `File.createUploadTask`: the new API round-trips
 * the source uri through `new URL()`, which mangles a non-special scheme (the same trap documented
 * for shared-in `content://` uris), and its own docs warn its multipart byte counts may include
 * framing overhead. The legacy task hands the uri string to native untouched.
 */
/**
 * Does the file at `uri` still exist on disk? Queue-retry pre-flight: a failed attachment
 * whose cached source file was evicted is retired instead of retried forever.
 */
export const expoFileExists = async (uri: string): Promise<boolean> => {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists === true;
  } catch {
    return false;
  }
};

/**
 * Detach the task's native progress listener.
 *
 * `UploadTask.uploadAsync()` calls `removeSubscription()` only on its SUCCESS path, so a rejected
 * upload leaves a dead listener attached for the life of the JS context — and every later
 * upload's progress events then walk past it. The method is `protected` in the type definitions
 * but present at runtime, and it self-guards on an already-removed subscription, so calling it
 * again on the success path is a no-op.
 */
function releaseProgressSubscription(task: FileSystem.UploadTask): void {
  try {
    (task as unknown as { removeSubscription?: () => void }).removeSubscription?.();
  } catch {
    // Cleanup must never mask the upload's own outcome.
  }
}

export const expoAttachmentUploader: AttachmentUploader = async ({
  http,
  chatGuid,
  tempGuid,
  attachmentGuid,
  name,
  uri,
  mimeType,
  totalBytes,
}) => {
  const url = http.buildUrl('/message/attachment/upload');

  // Pre-flight: a missing local file is NOT a network problem, and saying so up front keeps the
  // failed bubble from reading "Connection Refused" for a file the user can plainly see is gone.
  if (!(await expoFileExists(uri))) {
    logger.warn('[upload] attachment file is missing before upload');
    showToast("Couldn't read that file — try attaching it again.");
    throw new ApiError('local_file', 'Attachment file is no longer available');
  }

  let result: FileSystem.FileSystemUploadResult | null | undefined;
  try {
    // The tracked wrapper publishes byte progress under the ATTACHMENT guid (what the bubble
    // renders under) and guarantees the entry is cleared however this attempt ends.
    result = await runTrackedUpload(
      uploadStoreSink,
      attachmentGuid,
      { chatGuid, name, total: totalBytes ?? 0 },
      async (onProgress) => {
        let task: FileSystem.UploadTask | null = null;
        let cancelled = false;
        // Registered BEFORE the gate, not after: with a queue of files only two are transferring,
        // so a cancel handle that existed only for a running task would leave every waiting file
        // uncancellable — the exact case (a big batch) where the user most wants out.
        const releaseCancelHandle = uploadRegistry.add(tempGuid, {
          cancel: () => {
            cancelled = true;
            if (task) void task.cancelAsync();
          },
        });
        try {
          return await uploadGate.run(async () => {
            // Cancelled while queued — never open a socket at all. `runTrackedUpload` still
            // settles the progress entry, and the null flows to the cancelled branch below.
            if (cancelled) return null;
            const started = FileSystem.createUploadTask(
              url,
              uri,
              {
                httpMethod: 'POST',
                uploadType: FileSystem.FileSystemUploadType.MULTIPART,
                fieldName: 'attachment',
                mimeType,
                parameters: { chatGuid, tempGuid, name, method: 'private-api' },
                headers: http.buildHeaders(),
              },
              ({ totalBytesSent, totalBytesExpectedToSend }) =>
                onProgress(totalBytesSent, totalBytesExpectedToSend),
            );
            task = started;
            try {
              return await started.uploadAsync();
            } finally {
              releaseProgressSubscription(started);
            }
          });
        } finally {
          releaseCancelHandle();
        }
      },
    );
  } catch (err) {
    logger.warn(
      `[upload] streaming upload failed err=${err instanceof Error ? err.message : String(err)}`,
    );
    // The native uploader throws a plain IOException for both an unreadable local file and a
    // dead network — classify so the bubble names the right problem.
    if (isLocalFileFailure(err)) {
      showToast("Couldn't read that file — try attaching it again.");
      throw new ApiError('local_file', 'Attachment file could not be read', undefined, err);
    }
    throw new ApiError('no_connection', 'Upload request failed', undefined, err);
  }

  // A cancelled task resolves with NO response object rather than rejecting (the native side
  // resolves null once okhttp reports the call cancelled). Reaching the status check with that
  // would throw on a null deref, so name it — `handleSendFailure` maps this kind to "Manually
  // Canceled" instead of blaming the network.
  if (!result) {
    throw new ApiError('cancelled', 'Attachment upload was cancelled');
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
