import {
  isValidIMessageGroupGuid,
  removeIMessageGroupPhoto as deleteIMessageGroupPhoto,
  type IMessageGroupPhotoSetAck,
} from '@core/api/endpoints/chats';
import { ApiError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';
import {
  MAX_IMESSAGE_GROUP_PHOTO_BYTES,
  isSupportedImessageGroupPhotoType,
} from '@core/models/serverInfo';
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
import { uploadRegistry } from './send/uploadControl';

const DEFINITE_GROUP_PHOTO_FAILURES = new Set([
  'imessage_group_photo_invalid_target',
  'imessage_group_photo_unavailable',
  'imessage_group_photo_rejected',
  'idempotency_key_invalid',
  'idempotency_capacity_exhausted',
  'idempotency_persistence_unavailable',
]);

export interface PickedGroupPhoto {
  readonly uri: string;
  readonly name: string;
  readonly mimeType: string;
  /** Picker metadata is optional; the native uploader always re-checks the file itself. */
  readonly size?: number;
}

export interface SetAppleGroupPhotoArgs {
  readonly chatGuid: string;
  readonly image: PickedGroupPhoto;
}

export interface RemoveAppleGroupPhotoArgs {
  readonly chatGuid: string;
}

export type AppleGroupPhotoResult =
  | {
      readonly status: 'accepted';
      readonly operation: 'set' | 'remove';
      readonly tempGuid: string;
      readonly guid: string;
    }
  | {
      readonly status: 'rejected';
      readonly operation: 'set' | 'remove';
      readonly tempGuid?: string;
    }
  | {
      readonly status: 'outcome-unknown';
      readonly operation: 'set' | 'remove';
      readonly tempGuid: string;
    };

export type GroupPhotoUploader = (input: {
  readonly http: HttpClient;
  readonly chatGuid: string;
  readonly tempGuid: string;
  readonly image: PickedGroupPhoto;
  readonly signal: AbortSignal;
  /** Await-free final origin/account/capability fence before native dispatch. */
  readonly assertNetworkStart: () => void;
  /** Marks the point after which a missing response can no longer prove non-delivery. */
  readonly onDispatch: () => void;
}) => Promise<IMessageGroupPhotoSetAck>;

/** Set and remove share one lane: neither may queue behind another mutation for the same group. */
const activeGroupPhotoOperations = new WeakMap<AppDatabase, Set<string>>();

function claimGroupPhotoOperation(db: AppDatabase, chatGuid: string): boolean {
  let active = activeGroupPhotoOperations.get(db);
  if (!active) {
    active = new Set();
    activeGroupPhotoOperations.set(db, active);
  }
  if (active.has(chatGuid)) return false;
  active.add(chatGuid);
  return true;
}

function releaseGroupPhotoOperation(db: AppDatabase, chatGuid: string): void {
  const active = activeGroupPhotoOperations.get(db);
  active?.delete(chatGuid);
  if (active?.size === 0) activeGroupPhotoOperations.delete(db);
}

function isExactEligibleGroup(
  header: Awaited<ReturnType<typeof getChatHeader>>,
  chatGuid: string,
): boolean {
  return header?.guid === chatGuid && isProvenIMessageGroupChat(header);
}

function isDefiniteGroupPhotoFailure(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.serverErrorType != null &&
    DEFINITE_GROUP_PHOTO_FAILURES.has(error.serverErrorType)
  );
}

function isValidPickedGroupPhoto(image: PickedGroupPhoto): boolean {
  if (
    !/^(?:content|file):\/\//u.test(image.uri) ||
    !isSupportedImessageGroupPhotoType(image.mimeType, image.name)
  ) {
    return false;
  }
  return (
    image.size === undefined ||
    (Number.isSafeInteger(image.size) &&
      image.size > 0 &&
      image.size <= MAX_IMESSAGE_GROUP_PHOTO_BYTES)
  );
}

interface GroupPhotoAttempt {
  readonly tempGuid: string;
  readonly signal: AbortSignal;
  cancel(): void;
  onCancel(callback: () => void): void;
  finish(): void;
}

/** Register account cancellation synchronously, before capability discovery or any other await. */
function beginGroupPhotoAttempt(): GroupPhotoAttempt {
  const tempGuid = generateTempGuid();
  const controller = new AbortController();
  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  let cancelOwner = (): void => undefined;
  const cancel = (): void => {
    controller.abort();
    cancelOwner();
  };
  const release = uploadRegistry.add(tempGuid, {
    cancel,
    settled,
  });
  let finished = false;
  return {
    tempGuid,
    signal: controller.signal,
    cancel,
    onCancel: (callback) => {
      cancelOwner = callback;
      if (controller.signal.aborted) callback();
    },
    finish: () => {
      if (finished) return;
      finished = true;
      release();
      resolveSettled();
    },
  };
}

function assertPreDispatchCurrent(
  signal: AbortSignal,
  accountGuard: DbCommitGuard | undefined,
  capabilityGuard: DbCommitGuard,
): void {
  if (!(accountGuard?.() ?? true) || !capabilityGuard()) {
    throw new DbCommitGuardRejectedError();
  }
  if (signal.aborted) throw new ApiError('cancelled', 'Group photo operation was cancelled');
}

async function proveGroupPhotoTarget(
  db: AppDatabase,
  http: HttpClient,
  chatGuid: string,
  accountGuard: DbCommitGuard | undefined,
  capabilitySource: RcsCapabilitySource | undefined,
  signal: AbortSignal,
): Promise<{
  readonly transport: ReturnType<typeof pinSendTransport>;
  readonly capabilityGuard: DbCommitGuard;
}> {
  const transport = pinSendTransport(http, accountGuard);
  const capability = await resolveRcsAttemptOwnership(
    transport.http,
    chatGuid,
    transport.admissionGuard,
    capabilitySource,
    { requireServerInfo: true },
  );
  const capabilityGuard = sendCapabilityCommitGuard(transport.admissionGuard, capabilitySource);
  assertPreDispatchCurrent(signal, accountGuard, capabilityGuard);
  if (capability.serverInfo?.supports_imessage_group_photo !== true) {
    throw new ApiError('bad_request', 'This server cannot change Apple group photos.');
  }

  const header = await getChatHeader(db, chatGuid);
  assertPreDispatchCurrent(signal, accountGuard, capabilityGuard);
  if (!isExactEligibleGroup(header, chatGuid)) {
    throw new ApiError('bad_request', 'A proven existing Apple group is required.');
  }
  return { transport, capabilityGuard };
}

export interface PreparedIMessageGroupPhotoSet {
  readonly tempGuid: string;
  /** Consume this grant once with the image selected under its already-pinned authority. */
  submit(image: PickedGroupPhoto): Promise<AppleGroupPhotoResult>;
  /** Release the claim/idempotency key without dispatch, for a denied or cancelled picker. */
  cancel(): void;
}

/**
 * Pin account, origin/auth, capability, and exact local group proof before opening native picker
 * UI. The returned opaque owner is single-use and holds the one active mutation lane.
 */
export async function prepareExactIMessageGroupPhotoSet(
  db: AppDatabase,
  http: HttpClient,
  chatGuid: string,
  upload: GroupPhotoUploader,
  accountGuard?: DbCommitGuard,
  capabilitySource?: RcsCapabilitySource,
): Promise<PreparedIMessageGroupPhotoSet | null> {
  const operation = 'set' as const;
  if (!isValidIMessageGroupGuid(chatGuid)) return null;
  if (!claimGroupPhotoOperation(db, chatGuid)) return null;

  // Everything below belongs to one attempt identity. This registration intentionally precedes
  // the first await so Disconnect cannot miss a capability/DB preflight that later reaches native.
  const attempt = beginGroupPhotoAttempt();
  let proof: Awaited<ReturnType<typeof proveGroupPhotoTarget>>;
  try {
    proof = await proveGroupPhotoTarget(
      db,
      http,
      chatGuid,
      accountGuard,
      capabilitySource,
      attempt.signal,
    );
  } catch (error) {
    attempt.finish();
    releaseGroupPhotoOperation(db, chatGuid);
    if (error instanceof DbCommitGuardRejectedError) throw error;
    if (!(accountGuard?.() ?? true)) throw new DbCommitGuardRejectedError();
    return null;
  }

  let state: 'open' | 'submitting' | 'finished' = 'open';
  const finish = (): void => {
    if (state === 'finished') return;
    state = 'finished';
    attempt.finish();
    releaseGroupPhotoOperation(db, chatGuid);
  };
  attempt.onCancel(() => {
    // A grant waiting on native picker UI owns no socket/native transfer. Account teardown can
    // therefore retire it immediately instead of waiting for the user to dismiss that picker.
    if (state === 'open') finish();
  });

  return Object.freeze({
    tempGuid: attempt.tempGuid,
    cancel: () => {
      if (state === 'finished') return;
      attempt.cancel();
      if (state === 'open') finish();
    },
    submit: async (image: PickedGroupPhoto): Promise<AppleGroupPhotoResult> => {
      if (state !== 'open') {
        return { status: 'rejected', operation, tempGuid: attempt.tempGuid };
      }
      state = 'submitting';
      let dispatched = false;
      if (!isValidPickedGroupPhoto(image)) {
        finish();
        return { status: 'rejected', operation, tempGuid: attempt.tempGuid };
      }

      try {
        // The picker can remain open while sync updates this chat. Re-prove the exact local group
        // under the same pinned owner immediately before any native/network effect starts.
        const currentHeader = await getChatHeader(db, chatGuid);
        assertPreDispatchCurrent(attempt.signal, accountGuard, proof.capabilityGuard);
        if (!isExactEligibleGroup(currentHeader, chatGuid)) {
          return { status: 'rejected', operation, tempGuid: attempt.tempGuid };
        }
        proof.transport.assertNetworkCurrent();
        assertPreDispatchCurrent(attempt.signal, accountGuard, proof.capabilityGuard);
        const ack = await upload({
          http: proof.transport.http,
          chatGuid,
          tempGuid: attempt.tempGuid,
          image,
          signal: attempt.signal,
          assertNetworkStart: () => {
            proof.transport.assertNetworkCurrent();
            assertPreDispatchCurrent(attempt.signal, accountGuard, proof.capabilityGuard);
          },
          onDispatch: () => {
            dispatched = true;
          },
        });
        if (ack.updated !== true || ack.operation !== 'set' || ack.guid !== chatGuid) {
          return { status: 'outcome-unknown', operation, tempGuid: attempt.tempGuid };
        }
        if (!proof.capabilityGuard()) {
          return { status: 'outcome-unknown', operation, tempGuid: attempt.tempGuid };
        }
        return {
          status: 'accepted',
          operation,
          tempGuid: attempt.tempGuid,
          guid: ack.guid,
        };
      } catch (error) {
        if (dispatched) {
          if (isDefiniteGroupPhotoFailure(error)) {
            return { status: 'rejected', operation, tempGuid: attempt.tempGuid };
          }
          return { status: 'outcome-unknown', operation, tempGuid: attempt.tempGuid };
        }
        if (!(accountGuard?.() ?? true) || error instanceof DbCommitGuardRejectedError) throw error;
        return { status: 'rejected', operation, tempGuid: attempt.tempGuid };
      } finally {
        finish();
      }
    },
  });
}

/**
 * Non-picker convenience for already-owned image sources. Picker UI must call the prepare method
 * above first so its native wait cannot cross an origin/account/capability boundary.
 */
export async function setExactIMessageGroupPhoto(
  db: AppDatabase,
  http: HttpClient,
  args: SetAppleGroupPhotoArgs,
  upload: GroupPhotoUploader,
  accountGuard?: DbCommitGuard,
  capabilitySource?: RcsCapabilitySource,
): Promise<AppleGroupPhotoResult> {
  const prepared = await prepareExactIMessageGroupPhotoSet(
    db,
    http,
    args.chatGuid,
    upload,
    accountGuard,
    capabilitySource,
  );
  if (!prepared) return { status: 'rejected', operation: 'set' };
  return prepared.submit(args.image);
}

/** Remove one proven Apple-group photo. No automatic retry and no optimistic local mutation. */
export async function removeExactIMessageGroupPhoto(
  db: AppDatabase,
  http: HttpClient,
  args: RemoveAppleGroupPhotoArgs,
  accountGuard?: DbCommitGuard,
  capabilitySource?: RcsCapabilitySource,
): Promise<AppleGroupPhotoResult> {
  const operation = 'remove' as const;
  if (!isValidIMessageGroupGuid(args.chatGuid)) return { status: 'rejected', operation };
  if (!claimGroupPhotoOperation(db, args.chatGuid)) return { status: 'rejected', operation };

  const attempt = beginGroupPhotoAttempt();
  let dispatched = false;
  try {
    let proof: Awaited<ReturnType<typeof proveGroupPhotoTarget>>;
    try {
      proof = await proveGroupPhotoTarget(
        db,
        http,
        args.chatGuid,
        accountGuard,
        capabilitySource,
        attempt.signal,
      );
    } catch (error) {
      if (error instanceof DbCommitGuardRejectedError) throw error;
      if (!(accountGuard?.() ?? true)) throw new DbCommitGuardRejectedError();
      return { status: 'rejected', operation, tempGuid: attempt.tempGuid };
    }

    try {
      proof.transport.assertNetworkCurrent();
      assertPreDispatchCurrent(attempt.signal, accountGuard, proof.capabilityGuard);
      dispatched = true;
      const ack = await deleteIMessageGroupPhoto(
        proof.transport.http,
        { chatGuid: args.chatGuid, tempGuid: attempt.tempGuid },
        attempt.signal,
      );
      if (!proof.capabilityGuard()) {
        return { status: 'outcome-unknown', operation, tempGuid: attempt.tempGuid };
      }
      return {
        status: 'accepted',
        operation,
        tempGuid: attempt.tempGuid,
        guid: ack.guid,
      };
    } catch (error) {
      if (dispatched && isDefiniteGroupPhotoFailure(error)) {
        return { status: 'rejected', operation, tempGuid: attempt.tempGuid };
      }
      if (dispatched) return { status: 'outcome-unknown', operation, tempGuid: attempt.tempGuid };
      if (!(accountGuard?.() ?? true) || error instanceof DbCommitGuardRejectedError) throw error;
      return { status: 'rejected', operation, tempGuid: attempt.tempGuid };
    }
  } finally {
    attempt.finish();
    releaseGroupPhotoOperation(db, args.chatGuid);
  }
}
