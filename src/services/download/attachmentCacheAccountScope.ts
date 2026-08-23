import {
  runTrackedRealtimeWork,
  type RealtimeDeliveryLease,
} from '../realtime/deliveryCoordinator';
import type { AttachmentCacheReservationScope } from './attachmentCacheCoordinator';

/**
 * Bind attachment-cache work to one account-generation lease.
 *
 * Tracking keeps native cleanup visible to Disconnect. Callers that write to the database own
 * their short transaction and use this scope's current-generation check as the commit guard.
 */
export function createAttachmentCacheAccountScope(
  lease: RealtimeDeliveryLease,
): AttachmentCacheReservationScope {
  const runTracked = async <T>(task: () => Promise<T>): Promise<T | null> => {
    let result: { readonly value: T } | undefined;
    const status = await runTrackedRealtimeWork(lease, async () => {
      result = { value: await task() };
    });
    return status === 'delivered' && result !== undefined ? result.value : null;
  };

  return {
    generation: lease.generation,
    isCurrent: () => lease.isCurrent(),
    runTracked,
  };
}
