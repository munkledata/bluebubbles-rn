import {
  canonicalIMessageGroupMembers,
  createIMessageGroup as postIMessageGroupCreate,
} from '@core/api/endpoints/chats';
import { ApiError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';
import { DbCommitGuardRejectedError, type DbCommitGuard } from '@db/transaction';
import {
  resolveRcsAttemptOwnership,
  sendCapabilityCommitGuard,
  type RcsCapabilitySource,
} from './send/rcsAttemptCapability';
import { pinSendTransport } from './send/sendTransport';

/** Refusals that prove the server sent nothing (its reviewed pre-dispatch checks). */
const DEFINITE_GROUP_CREATE_FAILURES = new Set([
  'imessage_group_create_invalid_target',
  'imessage_group_create_unavailable',
  'imessage_group_create_rejected',
  'imessage_group_create_recipient_unavailable',
]);

export interface CreateAppleGroupArgs {
  addresses: readonly string[];
  message: string;
  /** One stable id per draft, so a retry after an unknown outcome replays instead of resending. */
  tempGuid: string;
}

export type CreateAppleGroupResult =
  | {
      readonly status: 'accepted';
      readonly guid: string;
      readonly messageGuid: string;
      readonly existing: boolean;
    }
  /** `notOnIMessage`: at least one member isn't on iMessage (the server names nobody). */
  | { readonly status: 'rejected'; readonly notOnIMessage?: true }
  | { readonly status: 'outcome-unknown' };

const NEW_GROUP_CAPABILITY_GUID = 'iMessage;+;new-group';

/** One creation at a time: a second tap never queues behind an in-flight request. */
let activeGroupCreate = false;

/**
 * FP-006: create one iMessage group with its first message through the server's
 * `supports_imessage_group_create` route, with one HTTP attempt. Nothing is written locally here:
 * the caller fetches the new chat through the ordinary single-chat sync afterwards.
 */
export async function createExactIMessageGroup(
  client: HttpClient,
  args: CreateAppleGroupArgs,
  accountGuard?: DbCommitGuard,
  capabilitySource?: RcsCapabilitySource,
): Promise<CreateAppleGroupResult> {
  const addresses = canonicalIMessageGroupMembers(args.addresses);
  if (!addresses || args.message.trim().length === 0 || !args.tempGuid.startsWith('temp-')) {
    return { status: 'rejected' };
  }
  if (activeGroupCreate) return { status: 'rejected' };
  activeGroupCreate = true;

  try {
    const transport = pinSendTransport(client, accountGuard);
    let capability: Awaited<ReturnType<typeof resolveRcsAttemptOwnership>>;
    try {
      // No chat exists yet. Any non-RCS guid reads the same account-pinned server info; this
      // placeholder is never sent and carries no member address.
      capability = await resolveRcsAttemptOwnership(
        transport.http,
        NEW_GROUP_CAPABILITY_GUID,
        transport.admissionGuard,
        capabilitySource,
        { requireServerInfo: true },
      );
    } catch (error) {
      if (error instanceof DbCommitGuardRejectedError) throw error;
      return { status: 'rejected' };
    }
    const capabilityGuard = sendCapabilityCommitGuard(transport.admissionGuard, capabilitySource);
    if (capability.serverInfo?.supports_imessage_group_create !== true) {
      return { status: 'rejected' };
    }
    try {
      transport.assertNetworkCurrent();
      if (!capabilityGuard()) throw new DbCommitGuardRejectedError();
    } catch (error) {
      if (error instanceof DbCommitGuardRejectedError) throw error;
      return { status: 'rejected' };
    }

    try {
      const ack = await postIMessageGroupCreate(transport.http, {
        addresses,
        message: args.message,
        tempGuid: args.tempGuid,
      });
      if (!capabilityGuard()) return { status: 'outcome-unknown' };
      return {
        status: 'accepted',
        guid: ack.guid,
        messageGuid: ack.messageGuid,
        existing: ack.existing,
      };
    } catch (error) {
      if (!capabilityGuard() || error instanceof DbCommitGuardRejectedError) {
        return { status: 'outcome-unknown' };
      }
      if (
        error instanceof ApiError &&
        error.serverErrorType != null &&
        DEFINITE_GROUP_CREATE_FAILURES.has(error.serverErrorType)
      ) {
        return error.serverErrorType === 'imessage_group_create_recipient_unavailable'
          ? { status: 'rejected', notOnIMessage: true }
          : { status: 'rejected' };
      }
      return { status: 'outcome-unknown' };
    }
  } finally {
    activeGroupCreate = false;
  }
}
