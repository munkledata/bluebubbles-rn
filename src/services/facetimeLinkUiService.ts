import { DbCommitGuardRejectedError } from '@db/transaction';
import { http } from './clients';
import { createExactFaceTimeLink, type FaceTimeLinkCreationResult } from './facetimeLinkService';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
  type RealtimeDeliveryLease,
} from './realtime/deliveryCoordinator';
import { captureSessionRcsCapabilityLease } from './send/rcsAttemptCapability';

/** Account-scoped UI entry; no URL or idempotency key is persisted by this boundary. */
export async function createAppleFaceTimeLink(
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<FaceTimeLinkCreationResult | null> {
  let completed = false;
  let result: FaceTimeLinkCreationResult | null = null;
  try {
    const status = await runTrackedRealtimeWork(accountLease, async (lease) => {
      if (!lease.isCurrent()) return;
      const capability = captureSessionRcsCapabilityLease();
      if (
        !capability ||
        capability.serverInfo?.supports_facetime_link_creation !== true ||
        !capability.isCurrent()
      ) {
        completed = true;
        return;
      }
      result = await createExactFaceTimeLink(http, () => lease.isCurrent(), capability);
      if (lease.isCurrent()) completed = true;
    });
    return status === 'delivered' && completed && accountLease.isCurrent() ? result : null;
  } catch (error) {
    if (!accountLease.isCurrent() || error instanceof DbCommitGuardRejectedError) return null;
    throw error;
  }
}
