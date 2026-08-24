/**
 * In-flight upload control: how many attachment uploads may transfer at once, and the handles that
 * let the user stop one.
 *
 * PURE (no expo imports) for the same reason as `uploadErrors.ts` and `trackedUpload.ts` —
 * `attachmentUpload.ts` imports expo-file-system and cannot be loaded in the node jest project at
 * all, so anything worth testing has to live outside it.
 *
 * The gate deliberately mirrors the one `downloadService` already runs for the download side: same
 * acquire/release shape, same FIFO wake order, same default of 2. Two is the compromise that side
 * settled on — one at a time makes a multi-file send feel dead before the first byte moves, while
 * unbounded saturates a phone's (much narrower) uplink so every file's percentage crawls at once
 * and the readout stops meaning anything.
 *
 * KNOWN INTERACTION, pre-existing and unchanged by the gate: `listRetryableOutgoing` treats a queue
 * row older than `OUTGOING_GRACE_MS` (60 s) as no longer owned by its live UI send, so a very large
 * batch can have its tail claimed by the retry drain while the first send is still running. The
 * gate does not create that — uploads are bandwidth-bound, so the same 20 files run past 60 s
 * unbounded too (all 20 sharing the link) — it only changes which ones finish first. The re-send
 * reuses the original temp guid, so the server's idempotency cache absorbs it.
 */

export const DEFAULT_MAX_CONCURRENT_UPLOADS = 2;

export interface ConcurrencyGate {
  /**
   * Run `fn` once a slot is free, always releasing the slot afterwards. Aborting while queued
   * removes that waiter; once active, `fn` still owns cancellation and keeps its slot until it
   * settles so the concurrency cap can never be exceeded.
   */
  run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** Slots currently in use — for tests and diagnostics. */
  readonly active: number;
  /** Callers parked waiting for a slot — for tests and diagnostics. */
  readonly waiting: number;
}

export class UploadGateCancelledError extends Error {
  constructor() {
    super('upload gate wait was cancelled');
    this.name = 'UploadGateCancelledError';
  }
}

export function createConcurrencyGate(max: number): ConcurrencyGate {
  const limit = Math.max(1, Math.floor(max));
  let active = 0;
  const waiters: Array<{ start(): void }> = [];

  const acquire = (signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) return Promise.reject(new UploadGateCancelledError());
    if (active < limit) {
      active += 1;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const waiter = {
        start: () => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          active += 1;
          resolve();
        },
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        signal?.removeEventListener('abort', onAbort);
        reject(new UploadGateCancelledError());
      };

      waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
      // Close the tiny check→listener race for non-standard/injected AbortSignal implementations.
      if (signal?.aborted) onAbort();
    });
  };

  const release = (): void => {
    active -= 1;
    const waiter = waiters.shift();
    if (waiter) {
      waiter.start();
    }
  };

  return {
    async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      await acquire(signal);
      try {
        return await fn();
      } finally {
        // In a `finally` so a throwing upload can never strand a slot — a leaked slot would
        // permanently shrink the gate, and leaking `limit` of them wedges every later upload.
        release();
      }
    },
    get active() {
      return active;
    },
    get waiting() {
      return waiters.length;
    },
  };
}

/** A live upload that can be stopped. Kept minimal so the registry needs no expo types. */
export interface CancellableUpload {
  cancel(): void;
  /** Exact terminal boundary for work that can outlive the public uploader promise after cancel. */
  readonly settled: Promise<void>;
}

export interface UploadRegistry {
  /**
   * Track a live upload under `key` (the message's TEMP GUID — what "Cancel Sending" knows).
   * Returns a release function to call when the attempt ends.
   */
  add(key: string, handle: CancellableUpload): () => void;
  /** Stop the upload registered under `key`. Returns false when there is nothing in flight. */
  cancel(key: string): boolean;
  /**
   * Stop every registered upload during an account transition.
   *
   * The live key registry is cleared before invoking user/native handles so one throwing
   * cancellation cannot leave the remaining uploads reachable, and a stale release cannot remove
   * a later account's handle under the same temp guid. Cancelled-but-unsettled handles remain
   * separately reachable so a later cleanup sweep can retry native cancellation.
   */
  cancelAll(): number;
  /** Wait for every cancelled handle's exact terminal boundary. */
  awaitIdle(): Promise<void>;
  /** Cancelled native tails still settling — for tests and diagnostics. */
  readonly pending: number;
  /** In-flight count — for tests and diagnostics. */
  readonly size: number;
}

export function createUploadRegistry(): UploadRegistry {
  // More than one attempt can briefly share a temp guid (the live UI send can run past the retry
  // grace window while the retry drain starts another attempt). Keep EVERY handle: replacing by key
  // made both per-message cancel and account-wide teardown miss the older native upload.
  const byKey = new Map<string, Set<CancellableUpload>>();
  const pendingSettlements = new Map<CancellableUpload, Promise<void>>();

  const trackSettlement = (handle: CancellableUpload): void => {
    if (pendingSettlements.has(handle)) return;
    let tracked!: Promise<void>;
    tracked = handle.settled
      .catch(() => undefined)
      .finally(() => pendingSettlements.delete(handle));
    pendingSettlements.set(handle, tracked);
  };

  const cancelHandle = (handle: CancellableUpload): void => {
    // Register the exact tail before invoking native/user code. A synchronous cancellation throw
    // must not make teardown lose the still-settling operation it was trying to stop.
    trackSettlement(handle);
    try {
      handle.cancel();
    } catch {
      // Racing its own completion. The terminal promise above remains authoritative when present.
    }
  };

  return {
    add(key, handle) {
      const handles = byKey.get(key) ?? new Set<CancellableUpload>();
      handles.add(handle);
      byKey.set(key, handles);
      return () => {
        // Identity-checked within the key's set: a retry can register the SAME temp guid with a NEW
        // handle, and a late release from the previous attempt must not unregister the live one.
        const current = byKey.get(key);
        current?.delete(handle);
        if (current?.size === 0) byKey.delete(key);
      };
    },
    cancel(key) {
      const handles = byKey.get(key);
      if (!handles) return false;
      byKey.delete(key);
      for (const handle of handles) cancelHandle(handle);
      return true;
    },
    cancelAll() {
      const handles = new Set([
        ...pendingSettlements.keys(),
        ...[...byKey.values()].flatMap((set) => [...set]),
      ]);
      // Clear first. Besides making teardown synchronous from the caller's perspective, this keeps
      // a cancellation callback/release racing below from observing half-retired account state.
      byKey.clear();
      for (const handle of handles) cancelHandle(handle);
      return handles.size;
    },
    async awaitIdle() {
      // Loop because a second account sweep can add another cancelled tail while an earlier one is
      // settling. `runForget` closes account admission and re-cancels immediately before joining.
      while (pendingSettlements.size > 0) {
        await Promise.all([...pendingSettlements.values()]);
      }
    },
    get pending() {
      return pendingSettlements.size;
    },
    get size() {
      let count = 0;
      for (const handles of byKey.values()) count += handles.size;
      return count;
    },
  };
}

/** Process-wide gate + registry the production uploader uses. */
export const uploadGate: ConcurrencyGate = createConcurrencyGate(DEFAULT_MAX_CONCURRENT_UPLOADS);
export const uploadRegistry: UploadRegistry = createUploadRegistry();
