import { runCapabilityGatedAccountAction } from './capabilityGatedAction';
import { accountHttp } from './clients';
import { createExactFaceTimeLink, type FaceTimeLinkCreationResult } from './facetimeLinkService';
import {
  captureRealtimeDeliveryLease,
  type RealtimeDeliveryLease,
} from './realtime/deliveryCoordinator';

/** Account-scoped UI entry; no URL or idempotency key is persisted by this boundary. */
export async function createAppleFaceTimeLink(
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<FaceTimeLinkCreationResult | null> {
  return runCapabilityGatedAccountAction(
    accountLease,
    'supports_facetime_link_creation',
    (lease, capability) =>
      createExactFaceTimeLink(accountHttp(lease), () => lease.isCurrent(), capability),
  );
}
