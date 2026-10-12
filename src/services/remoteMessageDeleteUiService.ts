import { getDatabase } from '@db/database';
import { DbCommitGuardRejectedError } from '@db/transaction';
import { accountHttp } from './clients';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
  type RealtimeDeliveryLease,
} from './realtime/deliveryCoordinator';
import {
  remoteDeleteExactIMessage,
  type RemoteDeleteMessageArgs,
  type RemoteDeleteMessageResult,
} from './remoteMessageDeleteService';
import { captureSessionRcsCapabilityLease } from './send/rcsAttemptCapability';

/** Account-scoped UI entry point for the dedicated whole-message remote-delete command. */
export async function deleteMessageFromMac(
  args: RemoteDeleteMessageArgs,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<RemoteDeleteMessageResult | null> {
  const snapshot = { ...args };
  let completed = false;
  let result: RemoteDeleteMessageResult | null = null;
  try {
    const status = await runTrackedRealtimeWork(accountLease, async (lease) => {
      if (!lease.isCurrent()) return;
      const capability = captureSessionRcsCapabilityLease();
      if (
        !capability ||
        capability.serverInfo?.supports_imessage_remote_delete !== true ||
        !capability.isCurrent()
      ) {
        completed = true;
        return;
      }
      result = await remoteDeleteExactIMessage(
        getDatabase(),
        accountHttp(lease),
        snapshot,
        Date.now(),
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
