import { getDatabase } from '@db/database';
import { runCapabilityGatedAccountAction } from './capabilityGatedAction';
import { accountHttp } from './clients';
import {
  captureRealtimeDeliveryLease,
  type RealtimeDeliveryLease,
} from './realtime/deliveryCoordinator';
import {
  remoteDeleteExactIMessage,
  type RemoteDeleteMessageArgs,
  type RemoteDeleteMessageResult,
} from './remoteMessageDeleteService';

/** Account-scoped UI entry point for the dedicated whole-message remote-delete command. */
export async function deleteMessageFromMac(
  args: RemoteDeleteMessageArgs,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<RemoteDeleteMessageResult | null> {
  const snapshot = { ...args };
  return runCapabilityGatedAccountAction(
    accountLease,
    'supports_imessage_remote_delete',
    (lease, capability) =>
      remoteDeleteExactIMessage(
        getDatabase(),
        accountHttp(lease),
        snapshot,
        Date.now(),
        () => lease.isCurrent(),
        capability,
      ),
  );
}
