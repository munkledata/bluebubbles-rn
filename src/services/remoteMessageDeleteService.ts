import { remoteDeleteMessage as postRemoteDeleteMessage } from '@core/api/endpoints/messages';
import { ApiError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';
import { looksLikeRcsMessageGuid } from '@core/rcs/providerIdentity';
import { logger } from '@core/secure';
import {
  deleteMessageLocalWithinTransaction,
  getChatHeader,
  getMessagePreviewByGuid,
} from '@db/repositories';
import { DbCommitGuardRejectedError, withDbTransaction, type DbCommitGuard } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { isProvenIMessageGroupChat, isProvenOneToOneIMessageChat } from '@utils';
import { utf8Decode, utf8Encode } from '@utils/bytes';
import {
  resolveRcsAttemptOwnership,
  sendCapabilityCommitGuard,
  type RcsCapabilitySource,
} from './send/rcsAttemptCapability';
import { pinSendTransport } from './send/sendTransport';

const ID_MAX_BYTES = 1_024;
const REMOTE_DELETE_CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const DEFINITE_REMOTE_DELETE_FAILURES = new Map<string, number>([
  ['imessage_remote_delete_invalid_target', 400],
  ['imessage_remote_delete_unavailable', 503],
  ['imessage_remote_delete_rejected', 409],
]);

export interface RemoteDeleteMessageArgs {
  readonly chatGuid: string;
  readonly messageGuid: string;
}

export type RemoteDeleteMessageResult =
  | { readonly status: 'accepted' }
  | { readonly status: 'rejected' }
  | { readonly status: 'outcome-unknown' };

/** A destructive remote delete has one active lane per exact stored message. */
const activeRemoteDeletes = new WeakMap<AppDatabase, Set<string>>();

function claimRemoteDelete(db: AppDatabase, key: string): boolean {
  let active = activeRemoteDeletes.get(db);
  if (!active) {
    active = new Set();
    activeRemoteDeletes.set(db, active);
  }
  if (active.has(key)) return false;
  active.add(key);
  return true;
}

function releaseRemoteDelete(db: AppDatabase, key: string): void {
  const active = activeRemoteDeletes.get(db);
  active?.delete(key);
  if (active?.size === 0) activeRemoteDeletes.delete(db);
}

function isBoundedIdentifier(value: string): boolean {
  const bytes = utf8Encode(value);
  if (
    value.length === 0 ||
    value.trim() !== value ||
    REMOTE_DELETE_CONTROL_CHARACTER.test(value) ||
    bytes.byteLength > ID_MAX_BYTES
  ) {
    return false;
  }
  return utf8Decode(bytes) === value;
}

function hasExactRemoteDeleteShape(args: RemoteDeleteMessageArgs): boolean {
  return (
    /^(?:(?:iMessage|any);-;.+|iMessage;\+;.+)$/u.test(args.chatGuid) &&
    isBoundedIdentifier(args.chatGuid) &&
    !args.messageGuid.startsWith('temp-') &&
    !looksLikeRcsMessageGuid(args.messageGuid as unknown) &&
    isBoundedIdentifier(args.messageGuid)
  );
}

function isDefiniteRemoteDeleteFailure(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.serverErrorType == null) return false;
  return DEFINITE_REMOTE_DELETE_FAILURES.get(error.serverErrorType) === error.status;
}

function isEligibleIMessageChat(
  header: Awaited<ReturnType<typeof getChatHeader>>,
  chatGuid: string,
): boolean {
  return (
    header?.guid === chatGuid &&
    (isProvenOneToOneIMessageChat(header) || isProvenIMessageGroupChat(header))
  );
}

/**
 * Delete one whole stored message from Messages on the Mac with one non-retrying HTTP attempt.
 * The phone tombstone is written only after the exact server acknowledgement; failure and ambiguity
 * deliberately leave the local row visible so the user can inspect Messages before acting again.
 */
export async function remoteDeleteExactIMessage(
  db: AppDatabase,
  client: HttpClient,
  args: RemoteDeleteMessageArgs,
  now: number = Date.now(),
  accountGuard?: DbCommitGuard,
  capabilitySource?: RcsCapabilitySource,
): Promise<RemoteDeleteMessageResult> {
  if (!hasExactRemoteDeleteShape(args)) return { status: 'rejected' };
  const laneKey = `${args.chatGuid}\u0000${args.messageGuid}`;
  if (!claimRemoteDelete(db, laneKey)) return { status: 'rejected' };

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
    if (capability.serverInfo?.supports_imessage_remote_delete !== true) {
      return { status: 'rejected' };
    }

    try {
      const header = await getChatHeader(db, args.chatGuid);
      if (!capabilityGuard()) throw new DbCommitGuardRejectedError();
      if (!isEligibleIMessageChat(header, args.chatGuid)) return { status: 'rejected' };

      const target = await getMessagePreviewByGuid(db, args.chatGuid, args.messageGuid);
      if (!capabilityGuard()) throw new DbCommitGuardRejectedError();
      if (!target || target.guid !== args.messageGuid || target.isRetracted === true) {
        return { status: 'rejected' };
      }
      transport.assertNetworkCurrent();
      if (!capabilityGuard()) throw new DbCommitGuardRejectedError();
    } catch (error) {
      if (error instanceof DbCommitGuardRejectedError) throw error;
      return { status: 'rejected' };
    }

    let acknowledged = false;
    try {
      const ack = await postRemoteDeleteMessage(transport.http, args);
      if (!transport.admissionGuard()) throw new DbCommitGuardRejectedError();
      if (ack.guid !== args.messageGuid) return { status: 'outcome-unknown' };
      acknowledged = true;
    } catch (error) {
      if (error instanceof DbCommitGuardRejectedError) throw error;
      if (!transport.admissionGuard()) return { status: 'outcome-unknown' };
      return isDefiniteRemoteDeleteFailure(error)
        ? { status: 'rejected' }
        : { status: 'outcome-unknown' };
    }

    if (!acknowledged) return { status: 'outcome-unknown' };
    try {
      await withDbTransaction(
        db,
        (context) => deleteMessageLocalWithinTransaction(context, args.messageGuid, now),
        transport.admissionGuard,
      );
    } catch (error) {
      if (error instanceof DbCommitGuardRejectedError) throw error;
      // The strict acknowledgement already proves the Mac-side outcome. A later sync/deletion event
      // can repair the phone mirror, so do not misreport that confirmed deletion as ambiguous.
      logger.warn('[remote-delete] local mirror tombstone failed after confirmed remote deletion', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    }
    return { status: 'accepted' };
  } finally {
    releaseRemoteDelete(db, laneKey);
  }
}
