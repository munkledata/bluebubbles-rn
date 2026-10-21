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
 * `rcs_dispatch_busy`. Gator sent a multi-file share in parallel, so all but one file showed
 * "Code 503" until the retry queue picked them up minutes later.
 *
 * For RCS-bridge uploads (every upload without `service: 'iMessage'`):
 * - A busy refusal is retried after 2, 4, 8 and 15 seconds (±20% jitter) instead of being reported
 *   as a failure. The server reads the whole file before it says busy, so each retry re-sends it:
 *   a file is not retried in place once the re-sent data would pass
 *   {@link RCS_BUSY_MAX_RESENT_BYTES}. After that, after the fourth retry, or at the caller's
 *   `timeoutMs`, the busy error is reported exactly as before and the ordinary retry path takes
 *   over. The server drops a refused upload's idempotency entry, so re-sending under the same temp
 *   guid cannot duplicate the message.
 * - The files of one multi-file share ({@link createRcsShareUploader}) take turns, normally in the
 *   order they reach it, so they are not uploaded at once. The next file usually still meets one busy
 *   refusal while the server relays the previous one to Google, which the retry absorbs; files over
 *   about 7 MB get too few retries to cover a long relay and may still fall back to the ordinary
 *   retry. Separate sends do not wait for each other at this layer (the app-wide upload gate and the
 *   logical send queue may still order them), so a slow upload in one chat cannot hold another.
 * - The temp guid stays registered in the upload registry from the start of any wait until the
 *   last attempt settles, like the uploader's own handle: the retry drain skips a registered temp
 *   guid, so it cannot start a second attempt of a file that is only waiting here, and
 *   "Cancel Sending" or an account teardown stops a waiting file without opening another socket.
 *
 * iMessage uploads pass straight through. Every limit handed to the uploader is a whole number of
 * milliseconds, which the uploader requires. A server-side queue (planned) removes the need for
 * all of this.
 */

/** Waits before each busy retry; their count is the retry limit. */
export const RCS_BUSY_RETRY_DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000, 15_000];
/** Most data one file may re-send because of busy refusals. */
export const RCS_BUSY_MAX_RESENT_BYTES = 20 * 1024 * 1024;

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
  /** Optional turn-taking slot; {@link createRcsShareUploader} gives each share its own. */
  readonly gate?: ConcurrencyGate;
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

/** Wrap `upload` so RCS uploads ride out the server's busy refusals (and take turns on a gate). */
export function createRcsPacedUploader(
  upload: AttachmentUploader,
  overrides: Partial<RcsUploadPacingDeps> = {},
): AttachmentUploader {
  const deps: RcsUploadPacingDeps = {
    gate: overrides.gate,
    registry: overrides.registry ?? uploadRegistry,
    sleep: overrides.sleep ?? sleepFor,
    now: overrides.now ?? Date.now,
    random: overrides.random ?? Math.random,
  };

  return async (args) => {
    if (args.service === 'iMessage') return upload(args);

    const deadline = args.timeoutMs === undefined ? null : deps.now() + args.timeoutMs;
    // One stop signal for this file: the caller's lifetime, "Cancel Sending" and account teardown
    // (through the registry), or the caller's time limit while the file waits for its turn.
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
    let turnTimer =
      args.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            stop.abort();
          }, args.timeoutMs);
    const clearTurnTimer = (): void => {
      if (turnTimer !== undefined) clearTimeout(turnTimer);
      turnTimer = undefined;
    };

    const uploadWithBusyRetry = async (): ReturnType<AttachmentUploader> => {
      // The file's turn: from here each attempt is bounded by the time that is left.
      clearTurnTimer();
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
      if (!deps.gate) return await uploadWithBusyRetry();
      try {
        return await deps.gate.run(uploadWithBusyRetry, stop.signal);
      } catch (error) {
        if (error instanceof UploadGateCancelledError) {
          throw timedOut ? timeoutError() : cancelledError();
        }
        throw error;
      }
    } finally {
      clearTurnTimer();
      args.signal?.removeEventListener('abort', onCallerAbort);
      release();
      markSettled();
    }
  };
}

/**
 * A paced uploader for ONE multi-file share: its RCS files take turns, normally in share order,
 * so they are not uploaded at once. Create one per share; never share it.
 */
export function createRcsShareUploader(
  upload: AttachmentUploader,
  overrides: Partial<Omit<RcsUploadPacingDeps, 'gate'>> = {},
): AttachmentUploader {
  return createRcsPacedUploader(upload, { ...overrides, gate: createConcurrencyGate(1) });
}
