import { getDatabase } from '@db/database';
import { DbCommitGuardRejectedError } from '@db/transaction';
import { accountHttp } from './clients';
import {
  addExactIMessageGroupParticipant,
  leaveExactIMessageGroup,
  removeExactIMessageGroupParticipant,
  type AddAppleGroupParticipantArgs,
  type AddAppleGroupParticipantResult,
  type LeaveAppleGroupArgs,
  type LeaveAppleGroupResult,
  type RemoveAppleGroupParticipantArgs,
  type RemoveAppleGroupParticipantResult,
} from './groupParticipantService';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
  type RealtimeDeliveryLease,
} from './realtime/deliveryCoordinator';
import { captureSessionRcsCapabilityLease } from './send/rcsAttemptCapability';

/** Account-scoped UI entry point; a retired account/capability owns and suppresses its late result. */
export async function addAppleGroupParticipant(
  args: AddAppleGroupParticipantArgs,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<AddAppleGroupParticipantResult | null> {
  const snapshot = { ...args };
  let completed = false;
  let result: AddAppleGroupParticipantResult | null = null;
  try {
    const status = await runTrackedRealtimeWork(accountLease, async (lease) => {
      if (!lease.isCurrent()) return;
      const capability = captureSessionRcsCapabilityLease();
      if (
        !capability ||
        capability.serverInfo?.supports_imessage_group_participant_add !== true ||
        !capability.isCurrent()
      ) {
        completed = true;
        return;
      }
      result = await addExactIMessageGroupParticipant(
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

/** Account-scoped UI entry point for one destructive participant removal. */
export async function removeAppleGroupParticipant(
  args: RemoveAppleGroupParticipantArgs,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<RemoveAppleGroupParticipantResult | null> {
  const snapshot = { ...args };
  let completed = false;
  let result: RemoveAppleGroupParticipantResult | null = null;
  try {
    const status = await runTrackedRealtimeWork(accountLease, async (lease) => {
      if (!lease.isCurrent()) return;
      const capability = captureSessionRcsCapabilityLease();
      if (
        !capability ||
        capability.serverInfo?.supports_imessage_group_participant_remove !== true ||
        !capability.isCurrent()
      ) {
        completed = true;
        return;
      }
      result = await removeExactIMessageGroupParticipant(
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

/** Account-scoped UI entry point for one destructive group leave attempt. */
export async function leaveAppleGroup(
  args: LeaveAppleGroupArgs,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<LeaveAppleGroupResult | null> {
  const snapshot = { ...args };
  let completed = false;
  let result: LeaveAppleGroupResult | null = null;
  try {
    const status = await runTrackedRealtimeWork(accountLease, async (lease) => {
      if (!lease.isCurrent()) return;
      const capability = captureSessionRcsCapabilityLease();
      if (
        !capability ||
        capability.serverInfo?.supports_imessage_group_leave !== true ||
        !capability.isCurrent()
      ) {
        completed = true;
        return;
      }
      result = await leaveExactIMessageGroup(
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
