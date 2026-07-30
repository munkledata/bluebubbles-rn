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
  /** Run `fn` once a slot is free, always releasing the slot afterwards. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Slots currently in use — for tests and diagnostics. */
  readonly active: number;
  /** Callers parked waiting for a slot — for tests and diagnostics. */
  readonly waiting: number;
}

export function createConcurrencyGate(max: number): ConcurrencyGate {
  const limit = Math.max(1, Math.floor(max));
  let active = 0;
  const waiters: Array<() => void> = [];

  const acquire = (): Promise<void> => {
    if (active < limit) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waiters.push(() => {
        active += 1;
        resolve();
      });
    });
  };

  const release = (): void => {
    active -= 1;
    waiters.shift()?.();
  };

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire();
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
}

export interface UploadRegistry {
  /**
   * Track a live upload under `key` (the message's TEMP GUID — what "Cancel Sending" knows).
   * Returns a release function to call when the attempt ends.
   */
  add(key: string, handle: CancellableUpload): () => void;
  /** Stop the upload registered under `key`. Returns false when there is nothing in flight. */
  cancel(key: string): boolean;
  /** In-flight count — for tests and diagnostics. */
  readonly size: number;
}

export function createUploadRegistry(): UploadRegistry {
  const byKey = new Map<string, CancellableUpload>();
  return {
    add(key, handle) {
      byKey.set(key, handle);
      return () => {
        // Identity-checked: a retry re-registers the SAME temp guid with a NEW handle, and a
        // late release from the previous attempt must not unregister the live one — that would
        // silently make the running upload uncancellable.
        if (byKey.get(key) === handle) byKey.delete(key);
      };
    },
    cancel(key) {
      const handle = byKey.get(key);
      if (!handle) return false;
      byKey.delete(key);
      try {
        handle.cancel();
      } catch {
        // Racing its own completion — the upload is finishing anyway.
      }
      return true;
    },
    get size() {
      return byKey.size;
    },
  };
}

/** Process-wide gate + registry the production uploader uses. */
export const uploadGate: ConcurrencyGate = createConcurrencyGate(DEFAULT_MAX_CONCURRENT_UPLOADS);
export const uploadRegistry: UploadRegistry = createUploadRegistry();
