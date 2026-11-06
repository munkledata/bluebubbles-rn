import { getDatabase } from '@db/database';
import { runCapabilityGatedAccountAction } from './capabilityGatedAction';
import { accountHttp } from './clients';
import {
  clearExactIMessageGroupName,
  renameExactIMessageGroup,
  type ClearAppleGroupNameArgs,
  type ClearAppleGroupNameResult,
  type RenameAppleGroupArgs,
  type RenameAppleGroupResult,
} from './groupRenameService';
import {
  captureRealtimeDeliveryLease,
  type RealtimeDeliveryLease,
} from './realtime/deliveryCoordinator';

/** Account-scoped UI entry point; a retired account/capability quietly owns its late result. */
export async function renameAppleGroup(
  args: RenameAppleGroupArgs,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<RenameAppleGroupResult | null> {
  const snapshot = { ...args };
  return runCapabilityGatedAccountAction(
    accountLease,
    'supports_imessage_group_rename',
    (lease, capability) =>
      renameExactIMessageGroup(
        getDatabase(),
        accountHttp(lease),
        snapshot,
        () => lease.isCurrent(),
        capability,
      ),
  );
}

/** Account-scoped UI entry point for "Remove Name"; a retired account quietly owns its result. */
export async function clearAppleGroupName(
  args: ClearAppleGroupNameArgs,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<ClearAppleGroupNameResult | null> {
  const snapshot = { ...args };
  return runCapabilityGatedAccountAction(
    accountLease,
    'supports_imessage_group_name_clear',
    (lease, capability) =>
      clearExactIMessageGroupName(
        getDatabase(),
        accountHttp(lease),
        snapshot,
        () => lease.isCurrent(),
        capability,
      ),
  );
}
