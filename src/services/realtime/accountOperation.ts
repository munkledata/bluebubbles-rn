import { runTrackedRealtimeWork, type RealtimeDeliveryLease } from './deliveryCoordinator';

/**
 * The one value-returning wrapper for account-owned work.
 *
 * Account isolation requires late work from a disconnected account to never land in the next one.
 * `runTrackedRealtimeWork` makes Disconnect's drain wait for the work but returns only
 * 'delivered' | 'paused', so callers used to hand-build the same scaffolding (a completion flag, an
 * outer result, lease checks around the await, a catch that hides a stale account's errors). This
 * helper is that scaffolding, written once.
 */

/** `{ ok: false }` means the account changed before, during or after the work: drop the result. */
export type AccountOperationResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false };

const STALE_ACCOUNT_OPERATION = new Error('Account operation lease is no longer current.');

/** Stop the current account operation (reported as `{ ok: false }`) if its account changed. */
export function assertAccountOperationCurrent(lease: RealtimeDeliveryLease): void {
  if (!lease.isCurrent()) throw STALE_ACCOUNT_OPERATION;
}

/**
 * Run `task` under the Disconnect drain and return its value, or `{ ok: false }` when the account
 * changed. Registration happens before the task's first await; the lease is re-checked after the
 * task; an error thrown once the account is stale is hidden, because it belongs to the old account.
 */
export async function runAccountOperation<T>(
  lease: RealtimeDeliveryLease,
  task: (activeLease: RealtimeDeliveryLease) => Promise<T>,
): Promise<AccountOperationResult<T>> {
  let value: T | undefined;
  let completed = false;
  try {
    const status = await runTrackedRealtimeWork(lease, async (activeLease) => {
      assertAccountOperationCurrent(activeLease);
      value = await task(activeLease);
      assertAccountOperationCurrent(activeLease);
      completed = true;
    });
    if (status === 'paused' || !completed || !lease.isCurrent()) return { ok: false };
    return { ok: true, value: value as T };
  } catch (error) {
    if (error === STALE_ACCOUNT_OPERATION || !lease.isCurrent()) return { ok: false };
    throw error;
  }
}
