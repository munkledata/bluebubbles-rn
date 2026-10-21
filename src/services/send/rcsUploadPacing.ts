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
 * For RCS-bridge uploads (every upload without `service: 'iMessage'`), files take turns through
 * one app-wide slot in the order they arrive, and a busy refusal is retried after a short, growing,
 * jittered wait instead of being reported as a failure. A file keeps its turn while it waits, so a
 * multi-file share still arrives in order. The server drops a refused upload's idempotency entry,
 * so re-sending under the same temp guid cannot duplicate the message. Retries stay inside the
 * caller's `timeoutMs` and stop after {@link RCS_BUSY_RETRY_BUDGET_MS}; the last busy error is then
 * reported exactly as before. iMessage uploads pass straight through.
 *
 * The temp guid stays registered in the upload registry from the start of the slot wait until the
 * last attempt settles, like the uploader's own handle: the retry drain skips a registered temp
 * guid, so it cannot start a second attempt of a file that is only waiting here, and "Cancel
 * Sending" or an account teardown stops a waiting file without opening another socket.
 */

/** Waits before retrying a busy upload; the last value repeats. */
export const RCS_BUSY_RETRY_DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000, 15_000];
/** Longest time one upload keeps retrying busy refusals before it reports the failure. */
export const RCS_BUSY_RETRY_BUDGET_MS = 180_000;

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
  };

  return async (args) => {
    if (args.service === 'iMessage') return upload(args);

    const startedAt = deps.now();
    const deadline = args.timeoutMs === undefined ? null : startedAt + args.timeoutMs;
    // One stop signal for this file's waits: the caller's lifetime, "Cancel Sending" and account
    // teardown (through the registry), or the caller's time limit while queued for the slot.
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
    let slotTimer =
      args.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            stop.abort();
          }, args.timeoutMs);
    const clearSlotTimer = (): void => {
      if (slotTimer !== undefined) clearTimeout(slotTimer);
      slotTimer = undefined;
    };

    const uploadWithBusyRetry = async (): ReturnType<AttachmentUploader> => {
      // The slot is ours: from here each attempt is bounded by the time that is left.
      clearSlotTimer();
      const budgetEnd = startedAt + RCS_BUSY_RETRY_BUDGET_MS;
      for (let attempt = 0; ; attempt += 1) {
        if (stop.signal.aborted) throw cancelledError();
        const remaining = deadline === null ? undefined : deadline - deps.now();
        if (remaining !== undefined && remaining <= 0) throw timeoutError();
        try {
          return await upload(remaining === undefined ? args : { ...args, timeoutMs: remaining });
        } catch (error) {
          if (!isRcsDispatchBusy(error)) throw error;
          const base =
            RCS_BUSY_RETRY_DELAYS_MS[Math.min(attempt, RCS_BUSY_RETRY_DELAYS_MS.length - 1)]!;
          const delay = Math.round(base * (0.8 + 0.4 * deps.random()));
          const resumeAt = deps.now() + delay;
          if (resumeAt >= budgetEnd || (deadline !== null && resumeAt >= deadline)) throw error;
          await deps.sleep(delay, stop.signal);
        }
      }
    };

    try {
      return await deps.gate.run(uploadWithBusyRetry, stop.signal);
    } catch (error) {
      if (error instanceof UploadGateCancelledError) {
        throw timedOut ? timeoutError() : cancelledError();
      }
      throw error;
    } finally {
      clearSlotTimer();
      args.signal?.removeEventListener('abort', onCallerAbort);
      release();
      markSettled();
    }
  };
}
