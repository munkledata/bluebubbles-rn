import {
  addIMessageGroupParticipant as postIMessageGroupParticipantAdd,
  isCanonicalIMessageParticipantAddress,
  isValidIMessageGroupGuid,
  leaveIMessageGroup as postIMessageGroupLeave,
  removeIMessageGroupParticipant as postIMessageGroupParticipantRemove,
} from '@core/api/endpoints/chats';
import { ApiError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';
import { getChatHeader, type ChatHeaderRow } from '@db/repositories';
import { DbCommitGuardRejectedError, type DbCommitGuard } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { isProvenIMessageGroupChat } from '@utils';
import {
  resolveRcsAttemptOwnership,
  sendCapabilityCommitGuard,
  type RcsCapabilitySource,
} from './send/rcsAttemptCapability';
import { generateTempGuid } from './send/sendService';
import { pinSendTransport } from './send/sendTransport';

const MAX_IMESSAGE_GROUP_PARTICIPANTS = 64;
const DEFINITE_GROUP_PARTICIPANT_ADD_FAILURES = new Set([
  'imessage_group_participant_add_invalid_target',
  'imessage_group_participant_add_unavailable',
  'imessage_group_participant_add_rejected',
  'idempotency_key_invalid',
  'idempotency_capacity_exhausted',
  'idempotency_persistence_unavailable',
]);
const DEFINITE_GROUP_PARTICIPANT_REMOVE_FAILURES = new Set([
  'imessage_group_participant_remove_invalid_target',
  'imessage_group_participant_remove_unavailable',
  'imessage_group_participant_remove_rejected',
  'idempotency_key_invalid',
  'idempotency_capacity_exhausted',
  'idempotency_persistence_unavailable',
]);
const DEFINITE_GROUP_LEAVE_FAILURES = new Set([
  'imessage_group_leave_invalid_target',
  'imessage_group_leave_unavailable',
  'imessage_group_leave_rejected',
  'idempotency_key_invalid',
  'idempotency_capacity_exhausted',
  'idempotency_persistence_unavailable',
]);

export interface AddAppleGroupParticipantArgs {
  readonly chatGuid: string;
  readonly address: string;
}

export type AddAppleGroupParticipantResult =
  | {
      readonly status: 'accepted';
      readonly tempGuid: string;
      readonly guid: string;
      readonly address: string;
    }
  | { readonly status: 'rejected'; readonly tempGuid?: string }
  | { readonly status: 'outcome-unknown'; readonly tempGuid: string };

export interface RemoveAppleGroupParticipantArgs {
  readonly chatGuid: string;
  readonly address: string;
}

export type RemoveAppleGroupParticipantResult =
  | {
      readonly status: 'accepted';
      readonly tempGuid: string;
      readonly guid: string;
      readonly address: string;
    }
  | { readonly status: 'rejected'; readonly tempGuid?: string }
  | { readonly status: 'outcome-unknown'; readonly tempGuid: string };

export interface LeaveAppleGroupArgs {
  readonly chatGuid: string;
}

export type LeaveAppleGroupResult =
  | {
      readonly status: 'accepted';
      readonly tempGuid: string;
      readonly guid: string;
    }
  | { readonly status: 'rejected'; readonly tempGuid?: string }
  | { readonly status: 'outcome-unknown'; readonly tempGuid: string };

/** Add, remove, and leave share one one-shot lane; none may queue behind another for one group. */
const activeGroupMembershipOperations = new WeakMap<AppDatabase, Set<string>>();

function claimGroupMembershipOperation(db: AppDatabase, chatGuid: string): boolean {
  let active = activeGroupMembershipOperations.get(db);
  if (!active) {
    active = new Set();
    activeGroupMembershipOperations.set(db, active);
  }
  if (active.has(chatGuid)) return false;
  active.add(chatGuid);
  return true;
}

function releaseGroupMembershipOperation(db: AppDatabase, chatGuid: string): void {
  const active = activeGroupMembershipOperations.get(db);
  active?.delete(chatGuid);
  if (active?.size === 0) activeGroupMembershipOperations.delete(db);
}

function participantIdentity(address: string): string {
  return address.includes('@') ? address.toLowerCase() : address;
}

function literalAddressCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Prove that the one header statement returned every canonical member of the exact Apple group,
 * then create the deterministic unique roster representation expected by the narrow write path.
 */
export function exactSortedIMessageGroupRoster(
  header: ChatHeaderRow | null,
  chatGuid: string,
): readonly string[] | null {
  if (
    header?.guid !== chatGuid ||
    !isProvenIMessageGroupChat(header) ||
    header.participantCount > MAX_IMESSAGE_GROUP_PARTICIPANTS ||
    !header.participantAddresses
  ) {
    return null;
  }

  const addresses = header.participantAddresses.split('|||');
  if (
    addresses.length !== header.participantCount ||
    addresses.some((address) => !isCanonicalIMessageParticipantAddress(address))
  ) {
    return null;
  }
  const identities = new Set(addresses.map(participantIdentity));
  if (identities.size !== addresses.length) return null;
  return Object.freeze([...addresses].sort(literalAddressCompare));
}

function isDefiniteGroupParticipantAddFailure(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.serverErrorType != null &&
    DEFINITE_GROUP_PARTICIPANT_ADD_FAILURES.has(error.serverErrorType)
  );
}

function isDefiniteGroupParticipantRemoveFailure(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.serverErrorType != null &&
    DEFINITE_GROUP_PARTICIPANT_REMOVE_FAILURES.has(error.serverErrorType)
  );
}

function isDefiniteGroupLeaveFailure(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.serverErrorType != null &&
    DEFINITE_GROUP_LEAVE_FAILURES.has(error.serverErrorType)
  );
}

/**
 * Add one canonical address to one proven existing iMessage group with one HTTP attempt. Local
 * membership is never edited here: the server sync/event path remains the only roster authority.
 */
export async function addExactIMessageGroupParticipant(
  db: AppDatabase,
  client: HttpClient,
  args: AddAppleGroupParticipantArgs,
  accountGuard?: DbCommitGuard,
  capabilitySource?: RcsCapabilitySource,
): Promise<AddAppleGroupParticipantResult> {
  if (
    !isValidIMessageGroupGuid(args.chatGuid) ||
    !isCanonicalIMessageParticipantAddress(args.address)
  ) {
    return { status: 'rejected' };
  }
  if (!claimGroupMembershipOperation(db, args.chatGuid)) return { status: 'rejected' };

  try {
    // Pin origin, credentials, and account before capability/DB discovery can yield.
    const transport = pinSendTransport(client, accountGuard);
    let capability: Awaited<ReturnType<typeof resolveRcsAttemptOwnership>>;
    try {
      capability = await resolveRcsAttemptOwnership(
        transport.http,
        args.chatGuid,
        transport.admissionGuard,
        capabilitySource,
        { requireServerInfo: true },
      );
    } catch (error) {
      if (error instanceof DbCommitGuardRejectedError) throw error;
      return { status: 'rejected' };
    }

    const capabilityGuard = sendCapabilityCommitGuard(transport.admissionGuard, capabilitySource);
    if (capability.serverInfo?.supports_imessage_group_participant_add !== true) {
      return { status: 'rejected' };
    }

    let header: Awaited<ReturnType<typeof getChatHeader>>;
    try {
      header = await getChatHeader(db, args.chatGuid);
    } catch {
      if (!capabilityGuard()) throw new DbCommitGuardRejectedError();
      return { status: 'rejected' };
    }
    if (!capabilityGuard()) throw new DbCommitGuardRejectedError();
    const roster = exactSortedIMessageGroupRoster(header, args.chatGuid);
    if (
      !roster ||
      roster.some((address) => participantIdentity(address) === participantIdentity(args.address))
    ) {
      return { status: 'rejected' };
    }

    const tempGuid = generateTempGuid();
    try {
      transport.assertNetworkCurrent();
      if (!capabilityGuard()) throw new DbCommitGuardRejectedError();
    } catch (error) {
      if (error instanceof DbCommitGuardRejectedError) throw error;
      return { status: 'rejected', tempGuid };
    }

    try {
      // From this call onward a missing/malformed response may still mean Messages added the
      // participant. The same idempotency key is never replayed automatically.
      const ack = await postIMessageGroupParticipantAdd(transport.http, {
        chatGuid: args.chatGuid,
        address: args.address,
        tempGuid,
      });
      if (!capabilityGuard()) return { status: 'outcome-unknown', tempGuid };
      return {
        status: 'accepted',
        tempGuid,
        guid: ack.guid,
        address: ack.address,
      };
    } catch (error) {
      if (!capabilityGuard() || error instanceof DbCommitGuardRejectedError) {
        return { status: 'outcome-unknown', tempGuid };
      }
      if (isDefiniteGroupParticipantAddFailure(error)) {
        return { status: 'rejected', tempGuid };
      }
      return { status: 'outcome-unknown', tempGuid };
    }
  } finally {
    releaseGroupMembershipOperation(db, args.chatGuid);
  }
}

/**
 * Remove one present canonical member from a proven group of at least three with one HTTP attempt.
 * Local membership is never edited here; an authoritative sync/event owns the visible roster.
 */
export async function removeExactIMessageGroupParticipant(
  db: AppDatabase,
  client: HttpClient,
  args: RemoveAppleGroupParticipantArgs,
  accountGuard?: DbCommitGuard,
  capabilitySource?: RcsCapabilitySource,
): Promise<RemoveAppleGroupParticipantResult> {
  if (
    !isValidIMessageGroupGuid(args.chatGuid) ||
    !isCanonicalIMessageParticipantAddress(args.address)
  ) {
    return { status: 'rejected' };
  }
  if (!claimGroupMembershipOperation(db, args.chatGuid)) return { status: 'rejected' };

  try {
    // Pin origin, credentials, and account before capability/DB discovery can yield.
    const transport = pinSendTransport(client, accountGuard);
    let capability: Awaited<ReturnType<typeof resolveRcsAttemptOwnership>>;
    try {
      capability = await resolveRcsAttemptOwnership(
        transport.http,
        args.chatGuid,
        transport.admissionGuard,
        capabilitySource,
        { requireServerInfo: true },
      );
    } catch (error) {
      if (error instanceof DbCommitGuardRejectedError) throw error;
      return { status: 'rejected' };
    }

    const capabilityGuard = sendCapabilityCommitGuard(transport.admissionGuard, capabilitySource);
    if (capability.serverInfo?.supports_imessage_group_participant_remove !== true) {
      return { status: 'rejected' };
    }

    let header: Awaited<ReturnType<typeof getChatHeader>>;
    try {
      header = await getChatHeader(db, args.chatGuid);
    } catch {
      if (!capabilityGuard()) throw new DbCommitGuardRejectedError();
      return { status: 'rejected' };
    }
    if (!capabilityGuard()) throw new DbCommitGuardRejectedError();
    const roster = exactSortedIMessageGroupRoster(header, args.chatGuid);
    if (
      !roster ||
      roster.length < 3 ||
      !roster.some((address) => participantIdentity(address) === participantIdentity(args.address))
    ) {
      return { status: 'rejected' };
    }

    const tempGuid = generateTempGuid();
    try {
      transport.assertNetworkCurrent();
      if (!capabilityGuard()) throw new DbCommitGuardRejectedError();
    } catch (error) {
      if (error instanceof DbCommitGuardRejectedError) throw error;
      return { status: 'rejected', tempGuid };
    }

    try {
      const ack = await postIMessageGroupParticipantRemove(transport.http, {
        chatGuid: args.chatGuid,
        address: args.address,
        tempGuid,
      });
      if (!capabilityGuard()) return { status: 'outcome-unknown', tempGuid };
      return {
        status: 'accepted',
        tempGuid,
        guid: ack.guid,
        address: ack.address,
      };
    } catch (error) {
      if (!capabilityGuard() || error instanceof DbCommitGuardRejectedError) {
        return { status: 'outcome-unknown', tempGuid };
      }
      if (isDefiniteGroupParticipantRemoveFailure(error)) {
        return { status: 'rejected', tempGuid };
      }
      return { status: 'outcome-unknown', tempGuid };
    }
  } finally {
    releaseGroupMembershipOperation(db, args.chatGuid);
  }
}

/**
 * Leave one proven iMessage group with one HTTP attempt. Even an exact accepted response does not
 * delete the local chat or roster; sync remains authoritative. Current helpers may only be able to
 * report post-dispatch uncertainty, which stays terminal and is never promoted to success here.
 */
export async function leaveExactIMessageGroup(
  db: AppDatabase,
  client: HttpClient,
  args: LeaveAppleGroupArgs,
  accountGuard?: DbCommitGuard,
  capabilitySource?: RcsCapabilitySource,
): Promise<LeaveAppleGroupResult> {
  if (!isValidIMessageGroupGuid(args.chatGuid)) return { status: 'rejected' };
  if (!claimGroupMembershipOperation(db, args.chatGuid)) return { status: 'rejected' };

  try {
    const transport = pinSendTransport(client, accountGuard);
    let capability: Awaited<ReturnType<typeof resolveRcsAttemptOwnership>>;
    try {
      capability = await resolveRcsAttemptOwnership(
        transport.http,
        args.chatGuid,
        transport.admissionGuard,
        capabilitySource,
        { requireServerInfo: true },
      );
    } catch (error) {
      if (error instanceof DbCommitGuardRejectedError) throw error;
      return { status: 'rejected' };
    }

    const capabilityGuard = sendCapabilityCommitGuard(transport.admissionGuard, capabilitySource);
    if (capability.serverInfo?.supports_imessage_group_leave !== true) {
      return { status: 'rejected' };
    }

    let header: Awaited<ReturnType<typeof getChatHeader>>;
    try {
      header = await getChatHeader(db, args.chatGuid);
    } catch {
      if (!capabilityGuard()) throw new DbCommitGuardRejectedError();
      return { status: 'rejected' };
    }
    if (!capabilityGuard()) throw new DbCommitGuardRejectedError();
    const roster = exactSortedIMessageGroupRoster(header, args.chatGuid);
    if (!roster || roster.length < 2 || roster.length > MAX_IMESSAGE_GROUP_PARTICIPANTS) {
      return { status: 'rejected' };
    }

    const tempGuid = generateTempGuid();
    try {
      transport.assertNetworkCurrent();
      if (!capabilityGuard()) throw new DbCommitGuardRejectedError();
    } catch (error) {
      if (error instanceof DbCommitGuardRejectedError) throw error;
      return { status: 'rejected', tempGuid };
    }

    try {
      const ack = await postIMessageGroupLeave(transport.http, {
        chatGuid: args.chatGuid,
        tempGuid,
      });
      if (!capabilityGuard()) return { status: 'outcome-unknown', tempGuid };
      return { status: 'accepted', tempGuid, guid: ack.guid };
    } catch (error) {
      if (!capabilityGuard() || error instanceof DbCommitGuardRejectedError) {
        return { status: 'outcome-unknown', tempGuid };
      }
      if (isDefiniteGroupLeaveFailure(error)) return { status: 'rejected', tempGuid };
      return { status: 'outcome-unknown', tempGuid };
    }
  } finally {
    releaseGroupMembershipOperation(db, args.chatGuid);
  }
}
