import { DbCommitGuardRejectedError } from '@db/transaction';
import { accountHttp } from './clients';
import {
  startExactFaceTimeCall,
  type FaceTimeCallStartResult,
  type StartAppleFaceTimeCallArgs,
} from './facetimeCallService';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
  type RealtimeDeliveryLease,
} from './realtime/deliveryCoordinator';
import { captureSessionRcsCapabilityLease } from './send/rcsAttemptCapability';

/** Account-scoped UI entry; the one submitted address and attempt id are never persisted. */
export async function startAppleFaceTimeCall(
  args: StartAppleFaceTimeCallArgs,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<FaceTimeCallStartResult | null> {
  const snapshot = { address: args.address, video: args.video } as const;
  let completed = false;
  let result: FaceTimeCallStartResult | null = null;
  try {
    const status = await runTrackedRealtimeWork(accountLease, async (lease) => {
      if (!lease.isCurrent()) return;
      const capability = captureSessionRcsCapabilityLease();
      if (
        !capability ||
        capability.serverInfo?.supports_facetime_call_start !== true ||
        !capability.isCurrent()
      ) {
        completed = true;
        return;
      }
      result = await startExactFaceTimeCall(
        accountHttp(lease),
        snapshot,
        () => lease.isCurrent(),
        capability,
      );
      if (lease.isCurrent()) completed = true;
    });
    return status === 'delivered' && completed && accountLease.isCurrent() ? result : null;
  } catch (error) {
    if (!accountLease.isCurrent() || error instanceof DbCommitGuardRejectedError) return null;
    throw error;
  }
}
