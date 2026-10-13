import { getDatabase } from '@db/database';
import { runCapabilityGatedAccountAction } from './capabilityGatedAction';
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
  type RealtimeDeliveryLease,
} from './realtime/deliveryCoordinator';

/** Account-scoped UI entry point; a retired account/capability owns and suppresses its late result. */
export async function addAppleGroupParticipant(
  args: AddAppleGroupParticipantArgs,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<AddAppleGroupParticipantResult | null> {
  const snapshot = { ...args };
  return runCapabilityGatedAccountAction(
    accountLease,
    'supports_imessage_group_participant_add',
    (lease, capability) =>
      addExactIMessageGroupParticipant(
        getDatabase(),
        accountHttp(lease),
        snapshot,
        () => lease.isCurrent(),
        capability,
      ),
  );
}

/** Account-scoped UI entry point for one destructive participant removal. */
export async function removeAppleGroupParticipant(
  args: RemoveAppleGroupParticipantArgs,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<RemoveAppleGroupParticipantResult | null> {
  const snapshot = { ...args };
  return runCapabilityGatedAccountAction(
    accountLease,
    'supports_imessage_group_participant_remove',
    (lease, capability) =>
      removeExactIMessageGroupParticipant(
        getDatabase(),
        accountHttp(lease),
        snapshot,
        () => lease.isCurrent(),
        capability,
      ),
  );
}

/** Account-scoped UI entry point for one destructive group leave attempt. */
export async function leaveAppleGroup(
  args: LeaveAppleGroupArgs,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<LeaveAppleGroupResult | null> {
  const snapshot = { ...args };
  return runCapabilityGatedAccountAction(
    accountLease,
    'supports_imessage_group_leave',
    (lease, capability) =>
      leaveExactIMessageGroup(
        getDatabase(),
        accountHttp(lease),
        snapshot,
        () => lease.isCurrent(),
        capability,
      ),
  );
}
