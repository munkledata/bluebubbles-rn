import {
  isValidIMessageGroupGuid,
  isValidIMessageGroupName,
  renameIMessageGroup as postIMessageGroupRename,
} from '@core/api/endpoints/chats';
import { ApiError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';
import { getChatHeader } from '@db/repositories';
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

const DEFINITE_GROUP_RENAME_FAILURES = new Set([
  'imessage_group_rename_invalid_target',
  'imessage_group_rename_unavailable',
  'imessage_group_rename_rejected',
]);

export interface RenameAppleGroupArgs {
  chatGuid: string;
  displayName: string;
}

export type RenameAppleGroupResult =
  | {
      readonly status: 'accepted';
      readonly tempGuid: string;
      readonly guid: string;
      readonly displayName: string;
    }
  | { readonly status: 'rejected'; readonly tempGuid?: string }
  | { readonly status: 'outcome-unknown'; readonly tempGuid: string };

/** Group renames are one-shot mutations; a second tap cannot queue behind an active request. */
const activeGroupRenames = new WeakMap<AppDatabase, Set<string>>();

function claimGroupRename(db: AppDatabase, chatGuid: string): boolean {
  let active = activeGroupRenames.get(db);
  if (!active) {
    active = new Set();
    activeGroupRenames.set(db, active);
  }
  if (active.has(chatGuid)) return false;
  active.add(chatGuid);
  return true;
}

function releaseGroupRename(db: AppDatabase, chatGuid: string): void {
  const active = activeGroupRenames.get(db);
  active?.delete(chatGuid);
  if (active?.size === 0) activeGroupRenames.delete(db);
}

function isExactEligibleGroup(
  header: Awaited<ReturnType<typeof getChatHeader>>,
  chatGuid: string,
): boolean {
  return header?.guid === chatGuid && isProvenIMessageGroupChat(header);
}

function isDefiniteGroupRenameFailure(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.serverErrorType != null &&
    DEFINITE_GROUP_RENAME_FAILURES.has(error.serverErrorType)
  );
}

/**
 * Rename one proven existing iMessage group with one stable idempotency key and one HTTP attempt.
 * No local chat title is changed: sync remains the authority for Apple Messages' group name.
 */
export async function renameExactIMessageGroup(
  db: AppDatabase,
  client: HttpClient,
  args: RenameAppleGroupArgs,
  accountGuard?: DbCommitGuard,
  capabilitySource?: RcsCapabilitySource,
): Promise<RenameAppleGroupResult> {
  if (!isValidIMessageGroupGuid(args.chatGuid) || !isValidIMessageGroupName(args.displayName)) {
    return { status: 'rejected' };
  }
  if (!claimGroupRename(db, args.chatGuid)) return { status: 'rejected' };

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
    if (capability.serverInfo?.supports_imessage_group_rename !== true) {
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
    if (!isExactEligibleGroup(header, args.chatGuid)) return { status: 'rejected' };

    const tempGuid = generateTempGuid();
    try {
      transport.assertNetworkCurrent();
      if (!capabilityGuard()) throw new DbCommitGuardRejectedError();
    } catch (error) {
      if (error instanceof DbCommitGuardRejectedError) throw error;
      return { status: 'rejected', tempGuid };
    }

    try {
      const ack = await postIMessageGroupRename(transport.http, {
        chatGuid: args.chatGuid,
        displayName: args.displayName,
        tempGuid,
      });
      // The request has crossed its one-shot dispatch boundary. A same-account transport or
      // capability refresh can retire the admission proof while the pinned request is in flight;
      // that must not turn a possibly-applied rename into a retryable/silent rejection.
      if (!capabilityGuard()) return { status: 'outcome-unknown', tempGuid };
      return {
        status: 'accepted',
        tempGuid,
        guid: ack.guid,
        displayName: ack.displayName,
      };
    } catch (error) {
      if (!capabilityGuard() || error instanceof DbCommitGuardRejectedError) {
        return { status: 'outcome-unknown', tempGuid };
      }
      if (isDefiniteGroupRenameFailure(error)) return { status: 'rejected', tempGuid };
      // Includes both explicit outcome-unknown types and transport/parse ambiguity after POST.
      return { status: 'outcome-unknown', tempGuid };
    }
  } finally {
    releaseGroupRename(db, args.chatGuid);
  }
}
