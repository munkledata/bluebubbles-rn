import { ApiError } from '@core/api/errors';
import type { AttachmentUploader } from './sendAttachmentService';
import {
  createConcurrencyGate,
  uploadRegistry,
  UploadGateCancelledError,
  type ConcurrencyGate,
  type UploadRegistry,
} from './uploadControl';

/**
 * RCS media pacing (owner phone session 2026-10-21). The server hands one RCS media file to Google
 * at a time and refuses any other upload in that window at once with a retryable 503
 * `rcs_dispatch_busy`. Gator sends a multi-file share in parallel, so all but one file showed
 * "Code 503" until the retry queue picked them up minutes later.
 *
 * For RCS-bridge uploads (every upload without `service: 'iMessage'`):
 * - Files take turns through one app-wide slot, normally in the order the send reached it. A file
 *   that has waited {@link RCS_SLOT_WAIT_CAP_MS} goes ahead without the slot, so one slow upload
 *   cannot hold every other RCS file indefinitely.
 * - A busy refusal is retried after 2, 4, 8 and 15 seconds (±20% jitter), counted from the file's
 *   turn, instead of being reported as a failure. The server reads the whole file before it says
 *   busy, so each retry re-sends it: a file is not retried in place once the re-sent data would
 *   pass {@link RCS_BUSY_MAX_RESENT_BYTES}. After that, or after the fourth retry, or at the
 *   caller's `timeoutMs`, the busy error is reported exactly as before and the ordinary retry path
 *   takes over. The server drops a refused upload's idempotency entry, so re-sending under the same
 *   temp guid cannot duplicate the message.
 * - The temp guid stays registered in the upload registry from the start of the slot wait until
 *   the last attempt settles, like the uploader's own handle: the retry drain skips a registered
 *   temp guid, so it cannot start a second attempt of a file that is only waiting here, and
 *   "Cancel Sending" or an account teardown stops a waiting file without opening another socket.
 *
 * iMessage uploads pass straight through. Every limit handed to the uploader is a whole number of
 * milliseconds, which the uploader requires.
 */

/** Waits before each busy retry; their count is the retry limit. */
export const RCS_BUSY_RETRY_DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000, 15_000];
/** Most data one file may re-send because of busy refusals. */
export const RCS_BUSY_MAX_RESENT_BYTES = 20 * 1024 * 1024;
/** Longest a file waits for the RCS slot before it uploads anyway. */
export const RCS_SLOT_WAIT_CAP_MS = 60_000;

const RCS_BUSY_SERVER_ERROR_TYPE = 'rcs_dispatch_busy';

/** True only for the server's typed, retryable "one RCS media send at a time" refusal. */
export function isRcsDispatchBusy(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 503 &&
    error.serverErrorType === RCS_BUSY_SERVER_ERROR_TYPE
  );
}

export interface RcsUploadPacingDeps {
  /** One RCS media upload at a time across the app. */
  readonly gate: ConcurrencyGate;
  /** The live-upload registry the retry drain and "Cancel Sending" consult. */
  readonly registry: Pick<UploadRegistry, 'add'>;
  /** Resolves after `ms`; rejects with a cancelled ApiError if `signal` aborts first. */
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly now: () => number;
  /** Jitter source in [0, 1). */
  readonly random: () => number;
  readonly slotWaitCapMs: number;
}

function cancelledError(): ApiError {
  return new ApiError('cancelled', 'Attachment upload was cancelled');
}

function timeoutError(): ApiError {
  return new ApiError('timeout', 'Attachment upload timed out');
}

function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelledError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(cancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Wrap `upload` so RCS uploads take turns and ride out the server's busy refusals. */
export function createRcsPacedUploader(
  upload: AttachmentUploader,
  overrides: Partial<RcsUploadPacingDeps> = {},
): AttachmentUploader {
  const deps: RcsUploadPacingDeps = {
    gate: overrides.gate ?? createConcurrencyGate(1),
    registry: overrides.registry ?? uploadRegistry,
    sleep: overrides.sleep ?? sleepFor,
    now: overrides.now ?? Date.now,
    random: overrides.random ?? Math.random,
    slotWaitCapMs: overrides.slotWaitCapMs ?? RCS_SLOT_WAIT_CAP_MS,
  };

  return async (args) => {
    if (args.service === 'iMessage') return upload(args);

    const deadline = args.timeoutMs === undefined ? null : deps.now() + args.timeoutMs;
    // One stop signal for this file: the caller's lifetime, "Cancel Sending" and account teardown
    // (through the registry), or the caller's time limit while the file waits for the slot.
    const stop = new AbortController();
    let timedOut = false;
    let markSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    const release = deps.registry.add(args.tempGuid, { cancel: () => stop.abort(), settled });
    const onCallerAbort = (): void => stop.abort();
    args.signal?.addEventListener('abort', onCallerAbort, { once: true });
    if (args.signal?.aborted) stop.abort();

    // The slot wait also ends when it reaches the cap; the file then goes ahead without the slot.
    const slotWait = new AbortController();
    let waitCapped = false;
    const onStop = (): void => slotWait.abort();
    stop.signal.addEventListener('abort', onStop, { once: true });
    if (stop.signal.aborted) slotWait.abort();
    const timers: ReturnType<typeof setTimeout>[] = [
      setTimeout(() => {
        waitCapped = true;
        slotWait.abort();
      }, deps.slotWaitCapMs),
    ];
    if (args.timeoutMs !== undefined) {
      timers.push(
        setTimeout(() => {
          timedOut = true;
          stop.abort();
        }, args.timeoutMs),
      );
    }
    const clearWaitTimers = (): void => {
      for (const timer of timers.splice(0)) clearTimeout(timer);
    };

    const uploadWithBusyRetry = async (): ReturnType<AttachmentUploader> => {
      // The file's turn: from here each attempt is bounded by the time that is left.
      clearWaitTimers();
      const size = args.totalBytes ?? 0;
      for (let retry = 0; ; retry += 1) {
        if (stop.signal.aborted) throw cancelledError();
        const remaining = deadline === null ? undefined : Math.floor(deadline - deps.now());
        if (remaining !== undefined && remaining <= 0) throw timeoutError();
        try {
          return await upload(remaining === undefined ? args : { ...args, timeoutMs: remaining });
        } catch (error) {
          if (!isRcsDispatchBusy(error)) throw error;
          const base = RCS_BUSY_RETRY_DELAYS_MS[retry];
          if (base === undefined) throw error;
          if (size > 0 && (retry + 1) * size > RCS_BUSY_MAX_RESENT_BYTES) throw error;
          const delay = Math.round(base * (0.8 + 0.4 * deps.random()));
          if (deadline !== null && deps.now() + delay >= deadline) throw error;
          await deps.sleep(delay, stop.signal);
        }
      }
    };

    try {
      try {
        return await deps.gate.run(uploadWithBusyRetry, slotWait.signal);
      } catch (error) {
        if (!(error instanceof UploadGateCancelledError)) throw error;
        if (waitCapped && !stop.signal.aborted) return await uploadWithBusyRetry();
        throw timedOut ? timeoutError() : cancelledError();
      }
    } finally {
      clearWaitTimers();
      stop.signal.removeEventListener('abort', onStop);
      args.signal?.removeEventListener('abort', onCallerAbort);
      release();
      markSettled();
    }
  };
}
