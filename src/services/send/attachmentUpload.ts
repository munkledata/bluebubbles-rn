import * as FileSystem from 'expo-file-system/legacy';
import { SendAck } from '@core/api/endpoints/messages';
import { ApiError } from '@core/api/errors';
import { parseServerErrorDetailBody } from '@core/api/serverErrorDetail';
import { apiResponse } from '@core/models/common';
import { logger } from '@core/secure';
import { uploadStoreSink } from '@state/uploadStore';
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

const MAX_TIMER_MS = 2_147_483_647;
type UploadStopReason = 'cancelled' | 'timeout';

export const expoAttachmentUploader: AttachmentUploader = async ({
  http,
  chatGuid,
  tempGuid,
  attachmentGuid,
  name,
  uri,
  mimeType,
  totalBytes,
  timeoutMs,
}) => {
  if (
    timeoutMs !== undefined &&
    (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_MS)
  ) {
    throw new RangeError(
      `timeoutMs must be a positive safe integer no greater than ${MAX_TIMER_MS}`,
    );
  }

  // Capture BEFORE the file pre-flight and concurrency wait. A queued upload may not open its
  // native request for minutes; reading live headers there could pair this old URL with a newly
  // connected account's password.
  const transport = http.snapshotTransport();
  const url = transport.buildUrl('/message/attachment/upload');

  let task: FileSystem.UploadTask | null = null;
  const nativeTransfer: {
    current?: Promise<FileSystem.FileSystemUploadResult | null | undefined>;
  } = {};
  let stopReason: UploadStopReason | null = null;
  let result: FileSystem.FileSystemUploadResult | null | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const stopController = new AbortController();
  const timeoutError = new ApiError('timeout', 'Attachment upload timed out');
  const cancelledError = new ApiError('cancelled', 'Attachment upload was cancelled');
  let rejectStopped!: (error: ApiError) => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    rejectStopped = reject;
  });
  const stoppedError = (): ApiError => (stopReason === 'timeout' ? timeoutError : cancelledError);
  const stopAttempt = (reason: UploadStopReason): void => {
    // First reason wins: a user/Disconnect cancellation at 59.9 s must never be relabelled as a
    // timeout when the native null settlement happens to lose the race with the 60 s timer.
    const firstStop = stopReason === null;
    if (firstStop) {
      stopReason = reason;
      stopController.abort();
      if (reason === 'cancelled' && timeout !== undefined) {
        clearTimeout(timeout);
        timeout = undefined;
      }
    }
    // Keep retrying the exact handle when a later account sweep reaches a native task that ignored
    // its first cancellation. Classification remains the first reason above.
    if (task) void task.cancelAsync().catch(() => undefined);
    if (firstStop) rejectStopped(reason === 'timeout' ? timeoutError : cancelledError);
  };
  const withinAttempt = <T>(operation: Promise<T>): Promise<T> =>
    Promise.race([operation, stopped]);

  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });

  // Register BEFORE the very first await, including the file pre-flight. Disconnect calls
  // `cancelAll()` synchronously; registering later let an old-account operation appear after the
  // sweep and start a native upload that teardown could no longer see.
  const releaseCancelHandle = uploadRegistry.add(tempGuid, {
    cancel: () => stopAttempt('cancelled'),
    settled,
  });
  let handleReleased = false;
  const releaseHandleOnce = (): void => {
    if (handleReleased) return;
    handleReleased = true;
    releaseCancelHandle();
    resolveSettled();
  };
  if (timeoutMs !== undefined) {
    // Starts before the first native stat and covers the uploader's own preflight, FIFO gate wait,
    // transfer, and response. The queue passes only the remainder of its wider attempt deadline.
    timeout = setTimeout(() => stopAttempt('timeout'), timeoutMs);
  }

  try {
    // Pre-flight: a missing local file is NOT a network problem, and saying so up front keeps the
    // failed bubble from reading "Connection Refused" for a file the user can plainly see is gone.
    const fileExists = await withinAttempt(expoFileExists(uri));
    if (stopReason !== null) throw stoppedError();
    if (!fileExists) {
      logger.warn('[upload] attachment file is missing before upload');
      throw new ApiError('local_file', 'Attachment file is no longer available');
    }

    try {
      // The tracked wrapper publishes byte progress under the ATTACHMENT guid (what the bubble
      // renders under) and guarantees the entry is cleared however this attempt ends. The control
      // race belongs INSIDE its callback so a timeout settles the UI immediately, while the
      // underlying active native transfer retains its gate slot until cancelAsync actually settles.
      result = await runTrackedUpload(
        uploadStoreSink,
        attachmentGuid,
        { chatGuid, name, total: totalBytes ?? 0 },
        async (onProgress) => {
          const transfer = uploadGate.run(async () => {
            // Cancelled during pre-flight or while queued — never open a socket at all.
            if (stopReason !== null) return null;
            const started = FileSystem.createUploadTask(
              url,
              uri,
              {
                httpMethod: 'POST',
                uploadType: FileSystem.FileSystemUploadType.MULTIPART,
                fieldName: 'attachment',
                mimeType,
                parameters: { chatGuid, tempGuid, name, method: 'private-api' },
                headers: { ...transport.headers },
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
          }, stopController.signal);
          nativeTransfer.current = transfer;
          return withinAttempt(transfer);
        },
      );
    } catch (err) {
      logger.warn(
        `[upload] streaming upload failed err=${err instanceof Error ? err.message : String(err)}`,
      );
      if (stopReason !== null) throw stoppedError();
      if (err instanceof ApiError && (err.kind === 'timeout' || err.kind === 'cancelled')) {
        throw err;
      }
      // The native uploader throws a plain IOException for both an unreadable local file and a
      // dead network — classify so the bubble names the right problem.
      if (isLocalFileFailure(err)) {
        throw new ApiError('local_file', 'Attachment file could not be read', undefined, err);
      }
      throw new ApiError('no_connection', 'Upload request failed', undefined, err);
    }
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    // A timed-out active native task still owns a real socket and a gate slot until Expo settles
    // it. Keep the exact cancellation handle registered for that lifetime so a later account sweep
    // can retry cancellation; queued waits abort immediately and release on the next microtask.
    const pendingTransfer = nativeTransfer.current;
    if (pendingTransfer && stopReason !== null) {
      void pendingTransfer.finally(releaseHandleOnce).catch(() => undefined);
    } else {
      // Identity-checked by the registry, so a late old release cannot remove a new-account handle.
      releaseHandleOnce();
    }
  }

  if (stopReason !== null) throw stoppedError();
  // A cancelled task resolves with NO response object rather than rejecting (the native side
  // resolves null once okhttp reports the call cancelled). Reaching the status check with that
  // would throw on a null deref, so name it — `handleSendFailure` maps this kind to "Manually
  // Canceled" instead of blaming the network.
  if (!result) {
    throw cancelledError;
  }

  if (result.status < 200 || result.status >= 300) {
    // Status only: server prose is untrusted and must never enter diagnostics. The projector keeps
    // the reviewed nested error message solely on the typed failure for encrypted-row/UI handling.
    logger.warn(`[upload] server rejected status=${result.status}`);
    throw ApiError.fromStatus(
      result.status,
      'attachment upload failed',
      parseServerErrorDetailBody(result.body ?? ''),
    );
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
