import { getDatabase } from '@db/database';
import { DbCommitGuardRejectedError } from '@db/transaction';
import { accountHttp } from './clients';
import {
  renameExactIMessageGroup,
  type RenameAppleGroupArgs,
  type RenameAppleGroupResult,
} from './groupRenameService';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
  type RealtimeDeliveryLease,
} from './realtime/deliveryCoordinator';
import { captureSessionRcsCapabilityLease } from './send/rcsAttemptCapability';

/** Account-scoped UI entry point; a retired account/capability quietly owns its late result. */
export async function renameAppleGroup(
  args: RenameAppleGroupArgs,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<RenameAppleGroupResult | null> {
  const snapshot = { ...args };
  let completed = false;
  let result: RenameAppleGroupResult | null = null;
  try {
    const status = await runTrackedRealtimeWork(accountLease, async (lease) => {
      if (!lease.isCurrent()) return;
      const capability = captureSessionRcsCapabilityLease();
      if (
        !capability ||
        capability.serverInfo?.supports_imessage_group_rename !== true ||
        !capability.isCurrent()
      ) {
        completed = true;
        return;
      }
      result = await renameExactIMessageGroup(
        getDatabase(),
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
