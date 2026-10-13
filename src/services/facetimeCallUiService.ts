import { runCapabilityGatedAccountAction } from './capabilityGatedAction';
import { accountHttp } from './clients';
import {
  startExactFaceTimeCall,
  type FaceTimeCallStartResult,
  type StartAppleFaceTimeCallArgs,
} from './facetimeCallService';
import {
  captureRealtimeDeliveryLease,
  type RealtimeDeliveryLease,
} from './realtime/deliveryCoordinator';

/** Account-scoped UI entry; the one submitted address and attempt id are never persisted. */
export async function startAppleFaceTimeCall(
  args: StartAppleFaceTimeCallArgs,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<FaceTimeCallStartResult | null> {
  const snapshot = { address: args.address, video: args.video } as const;
  return runCapabilityGatedAccountAction(
    accountLease,
    'supports_facetime_call_start',
    (lease, capability) =>
      startExactFaceTimeCall(accountHttp(lease), snapshot, () => lease.isCurrent(), capability),
  );
}
