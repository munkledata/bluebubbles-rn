export type RealtimeDeliveryResult = 'delivered' | 'paused';

/** Account generation captured by work admitted before a Disconnect. */
export interface RealtimeDeliveryLease {
  readonly generation: number;
  isCurrent(): boolean;
}

let acceptingDeliveries = true;
let accountGeneration = 0;
const admittedDeliveries = new Set<Promise<void>>();
const generationInvalidationListeners = new Map<number, Set<() => void>>();

/**
 * Subscribe short-lived, dormant work (for example a backoff timer) to one account generation.
 * The listener runs synchronously when that generation is retired, before teardown waits for
 * already-admitted work. Call the returned function as soon as the dormant work settles or is
 * superseded so the coordinator does not retain its closure.
 */
export function subscribeRealtimeGenerationInvalidation(
  generation: number,
  listener: () => void,
): () => void {
  if (!acceptingDeliveries || generation !== accountGeneration) {
    listener();
    return () => undefined;
  }

  const listeners = generationInvalidationListeners.get(generation) ?? new Set<() => void>();
  generationInvalidationListeners.set(generation, listeners);
  listeners.add(listener);
  let subscribed = true;

  return () => {
    if (!subscribed) return;
    subscribed = false;
    listeners.delete(listener);
    if (listeners.size === 0) generationInvalidationListeners.delete(generation);
  };
}

/** Capture the generation for account-scoped work that may finish after a network/native await. */
export function captureRealtimeDeliveryLease(): RealtimeDeliveryLease {
  const generation = accountGeneration;
  // A component can briefly mount while teardown has already closed admission. Remember that
  // state: resume opens the NEXT account, and must not make a lease captured in the gap valid.
  const acceptedAtCapture = acceptingDeliveries;
  return {
    generation,
    isCurrent: () => acceptedAtCapture && acceptingDeliveries && generation === accountGeneration,
  };
}

/**
 * Run one socket or FCM delivery only while the current account accepts realtime work.
 *
 * The non-rejecting drain slot is registered before `task` is invoked. That ordering is
 * load-bearing: account teardown can call {@link pauseRealtimeDeliveries} immediately after a
 * native callback returns and must still see every task admitted before the pause.
 */
export function runTrackedRealtimeDelivery(
  task: (lease: RealtimeDeliveryLease) => Promise<unknown>,
): Promise<RealtimeDeliveryResult> {
  if (!acceptingDeliveries) return Promise.resolve('paused');

  const lease = captureRealtimeDeliveryLease();
  return runTrackedRealtimeWork(lease, task);
}

/**
 * Atomically admit a short account-scoped commit for a previously captured generation.
 *
 * Long network/file transfers should run outside this boundary, then use this function for their
 * final DB/native commit. If Disconnect invalidated the lease while the transfer was running, the
 * commit is rejected as `paused`; if the commit won the race, teardown sees and drains it.
 */
export function runTrackedRealtimeWork(
  lease: RealtimeDeliveryLease,
  task: (lease: RealtimeDeliveryLease) => Promise<unknown>,
): Promise<RealtimeDeliveryResult> {
  if (!lease.isCurrent()) return Promise.resolve('paused');

  let settleDrainSlot!: () => void;
  const drainSlot = new Promise<void>((resolve) => {
    settleDrainSlot = resolve;
  });
  admittedDeliveries.add(drainSlot);

  let taskPromise: Promise<unknown>;
  try {
    taskPromise = Promise.resolve(task(lease));
  } catch (error) {
    taskPromise = Promise.reject(error);
  }

  const result = taskPromise.then(() => 'delivered' as const);
  const finishTracking = (): void => {
    admittedDeliveries.delete(drainSlot);
    settleDrainSlot();
  };

  // Handle both outcomes here so the drain can never reject. The original `result` is returned,
  // unchanged, so a failed delivery still rejects the transport callback that owns it.
  void result.then(finishTracking, finishTracking);
  return result;
}

/**
 * Run one local account mutation under the realtime teardown barrier.
 *
 * UI callbacks can outlive the screen/account that created them (swipe animations and global
 * confirmation dialogs are the common cases). Callers pass the lease captured by that screen
 * instance. A stale callback is a quiet no-op; an admitted DB write is drained before Disconnect
 * wipes the account. If that write fails after its account was retired, its now-irrelevant error is
 * suppressed instead of surfacing in the next account.
 */
export async function runAccountScopedLocalMutation(
  lease: RealtimeDeliveryLease,
  mutation: () => Promise<unknown>,
): Promise<void> {
  try {
    await runTrackedRealtimeWork(lease, async (activeLease) => {
      if (!activeLease.isCurrent()) return;
      await mutation();
      // There is deliberately no work after the mutation. This re-check documents the handoff:
      // when it became stale mid-write, teardown owns the result and wipes it before reconnect.
      if (!activeLease.isCurrent()) return;
    });
  } catch (error) {
    if (!lease.isCurrent()) return;
    throw error;
  }
}

/**
 * Close admission synchronously, then resolve once every socket/FCM delivery admitted before the
 * close has settled. A failed delivery is still drained because the tracked slots never reject.
 */
export async function pauseRealtimeDeliveries(): Promise<void> {
  if (acceptingDeliveries) {
    // Invalidate every lease synchronously. Long-running transfers can now abandon their eventual
    // DB/native commit even while this function is waiting for already-admitted short work.
    const retiredGeneration = accountGeneration;
    acceptingDeliveries = false;
    accountGeneration += 1;
    const listeners = generationInvalidationListeners.get(retiredGeneration);
    generationInvalidationListeners.delete(retiredGeneration);
    for (const listener of listeners ?? []) {
      try {
        listener();
      } catch {
        // A best-effort cleanup listener must never prevent account teardown.
      }
    }
  }
  await Promise.all([...admittedDeliveries]);
}

/** Re-open admission after the caller has finished the protected account transition. */
export function resumeRealtimeDeliveries(): void {
  acceptingDeliveries = true;
}
