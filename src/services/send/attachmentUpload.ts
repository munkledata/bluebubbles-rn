import * as FileSystem from 'expo-file-system/legacy';
import { SendAck } from '@core/api/endpoints/messages';
import { ApiError } from '@core/api/errors';
import { parseServerErrorBody } from '@core/api/serverErrorDetail';
import { apiResponse } from '@core/models/common';
import {
  MAX_IMESSAGE_ATTACHMENT_UPLOAD_BYTES,
  MAX_SEND_ATTACHMENT_TEXT_BYTES,
  isSupportedImessageAttachmentType,
} from '@core/models/serverInfo';
import { logger } from '@core/secure';
import { MessageTargetUnavailableError } from '@db/repositories';
import { DbCommitGuardRejectedError } from '@db/transaction';
import { uploadStoreSink } from '@state/uploadStore';
import { isRcsChatGuid } from '@utils/chat';
import { utf8Encode } from '@utils/bytes';
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
 * The form fields (chatGuid/tempGuid, optional caption text, plus RCS-only name/attempt generation)
 * ride as multipart `parameters` alongside the file part (fieldName `attachment`).
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
  clientAttemptGeneration,
  text,
  service,
  assertNetworkStart,
  attachmentGuid,
  name,
  uri,
  mimeType,
  totalBytes,
  signal,
  timeoutMs,
}) => {
  // An explicit, capability-fenced one-to-one file path is the sole iMessage exception. The
  // existing RCS uploader remains unchanged, and a stale queue row cannot infer this mode.
  const imessageAttachment = service === 'iMessage';
  if (imessageAttachment) {
    if (
      text !== undefined &&
      (text.trim().length === 0 || utf8Encode(text).byteLength > MAX_SEND_ATTACHMENT_TEXT_BYTES)
    ) {
      throw new Error('iMessage attachment caption is blank or exceeds the 65,536-byte limit.');
    }
    if (
      !/^(?:any|iMessage);-;.+$/.test(chatGuid) ||
      clientAttemptGeneration !== undefined ||
      assertNetworkStart === undefined ||
      !Number.isSafeInteger(totalBytes) ||
      totalBytes! < 0 ||
      totalBytes! > MAX_IMESSAGE_ATTACHMENT_UPLOAD_BYTES ||
      !isSupportedImessageAttachmentType(mimeType, name)
    ) {
      throw new Error('Only one bounded JPEG/PNG/PDF iMessage attachment is available.');
    }
  } else if (!isRcsChatGuid(chatGuid)) {
    throw new Error('iMessage attachments require the narrow attachment-only capability.');
  }
  if (
    timeoutMs !== undefined &&
    (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_MS)
  ) {
    throw new RangeError(
      `timeoutMs must be a positive safe integer no greater than ${MAX_TIMER_MS}`,
    );
  }
  if (signal?.aborted) {
    throw new ApiError('cancelled', 'Attachment upload was cancelled', undefined, signal.reason);
  }

  // Send entry points pass a pinned client. Reject a transport already superseded before even the
  // native file stat begins; a live, unpinned client treats this as a no-op.
  http.assertTransportCurrent();

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
  const abortFromOwner = (): void => stopAttempt('cancelled');
  signal?.addEventListener('abort', abortFromOwner, { once: true });
  // Close the check/listener race before the first native file await.
  if (signal?.aborted) abortFromOwner();
  if (timeoutMs !== undefined) {
    // Starts before the first native stat and covers the uploader's own preflight, FIFO gate wait,
    // transfer, and response. The queue passes only the remainder of its wider attempt deadline.
    timeout = setTimeout(() => stopAttempt('timeout'), timeoutMs);
  }

  try {
    // Pre-flight: a missing local file is NOT a network problem, and saying so up front keeps the
    // failed bubble from reading "Connection Refused" for a file the user can plainly see is gone.
    const fileInfo = await withinAttempt(FileSystem.getInfoAsync(uri).catch(() => null));
    if (stopReason !== null) throw stoppedError();
    if (!fileInfo?.exists) {
      logger.warn('[upload] attachment file is missing before upload');
      throw new ApiError('local_file', 'Attachment file is no longer available');
    }
    if (
      imessageAttachment &&
      (!Number.isSafeInteger(fileInfo.size) ||
        fileInfo.size <= 0 ||
        fileInfo.size > MAX_IMESSAGE_ATTACHMENT_UPLOAD_BYTES)
    ) {
      throw new ApiError('local_file', 'Choose a JPEG, PNG, or PDF file no larger than 10 MiB');
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
            // The approved origin can rotate while file stat or the FIFO gate is pending. This is
            // the last await-free boundary before native code opens the socket.
            assertNetworkStart?.();
            http.assertTransportCurrent();
            const started = FileSystem.createUploadTask(
              url,
              uri,
              {
                httpMethod: 'POST',
                uploadType: FileSystem.FileSystemUploadType.MULTIPART,
                fieldName: 'attachment',
                mimeType,
                parameters: {
                  chatGuid,
                  tempGuid,
                  // Expo names the multipart file part from the on-disk URI. Android's Files
                  // picker often caches it under a UUID, so a separate original `name` would
                  // disagree and the narrow iMessage server route would reject it before send.
                  // With no override, the server uses the actual file-part filename.
                  ...(imessageAttachment ? {} : { name }),
                  ...(text === undefined ? {} : { text }),
                  ...(clientAttemptGeneration == null
                    ? {}
                    : { clientAttemptGeneration: String(clientAttemptGeneration) }),
                },
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
      if (
        err instanceof MessageTargetUnavailableError ||
        err instanceof DbCommitGuardRejectedError
      ) {
        throw err;
      }
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
    signal?.removeEventListener('abort', abortFromOwner);
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
    // Only the validated machine type may enter diagnostics; private server prose stays on the
    // typed failure for the encrypted-row/UI path and is never logged.
    const serverError = parseServerErrorBody(result.body ?? '');
    logger.warn(
      `[upload] server rejected status=${result.status}${serverError?.type ? ` type=${serverError.type}` : ''}`,
    );
    throw ApiError.fromStatus(
      result.status,
      'attachment upload failed',
      serverError?.detail,
      serverError?.type,
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
  if (
    imessageAttachment &&
    (typeof parsed.data.data.guid !== 'string' ||
      parsed.data.data.guid.trim().length === 0 ||
      parsed.data.data.guid.length > 256 ||
      parsed.data.data.viaPrivateApi !== true)
  ) {
    throw new ApiError('parse_error', 'iMessage attachment acknowledgement was incomplete');
  }
  return parsed.data.data;
};
