import {
  subscribeRealtimeGenerationInvalidation,
  type RealtimeDeliveryLease,
} from './deliveryCoordinator';

/**
 * One shared cancellation signal per account generation (review item 1073).
 *
 * Disconnect retires the generation synchronously, before it waits for admitted account work, and
 * that aborts this signal. Requests bound to it therefore stop at once instead of holding the
 * teardown drain until their own timeout. Only the current generation's entry is kept.
 */
let current: { readonly generation: number; readonly controller: AbortController } | null = null;

export function accountCancellationSignal(lease: RealtimeDeliveryLease): AbortSignal {
  // A retired lease, or one captured while Disconnect was running, never becomes current again.
  if (!lease.isCurrent()) return cancelledSignal();
  if (current?.generation !== lease.generation) {
    const entry = { generation: lease.generation, controller: new AbortController() };
    current = entry;
    subscribeRealtimeGenerationInvalidation(lease.generation, () => {
      if (current === entry) current = null;
      entry.controller.abort();
    });
  }
  return current.controller.signal;
}

function cancelledSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}
