import {
  answerFaceTimeCall as postFaceTimeCallAnswer,
  isCanonicalFaceTimeCallAddress,
  isCanonicalFaceTimeCallUuid,
  leaveFaceTimeCall as postFaceTimeCallLeave,
  startFaceTimeCall as postFaceTimeCallStart,
} from '@core/api/endpoints/facetime';
import { ApiError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';
import { DbCommitGuardRejectedError, type DbCommitGuard } from '@db/transaction';
import { claimFaceTimeMutationLane } from './facetimeMutationLane';
import { sendCapabilityCommitGuard, type RcsCapabilitySource } from './send/rcsAttemptCapability';
import { generateTempGuid } from './send/sendService';
import { pinSendTransport } from './send/sendTransport';

const DEFINITE_FACETIME_CALL_START_FAILURES = new Map<string, number>([
  ['facetime_call_start_invalid', 400],
  ['facetime_call_start_unavailable', 503],
  ['facetime_call_start_rejected', 409],
  ['idempotency_key_invalid', 400],
  ['idempotency_capacity_exhausted', 503],
  ['idempotency_persistence_unavailable', 503],
]);

const DEFINITE_FACETIME_CALL_CONTROL_FAILURES = {
  answer: new Map<string, number>([
    ['facetime_call_answer_invalid', 400],
    ['facetime_call_answer_unavailable', 503],
    ['facetime_call_answer_rejected', 409],
    ['idempotency_key_invalid', 400],
    ['idempotency_capacity_exhausted', 503],
    ['idempotency_persistence_unavailable', 503],
  ]),
  leave: new Map<string, number>([
    ['facetime_call_leave_invalid', 400],
    ['facetime_call_leave_unavailable', 503],
    ['facetime_call_leave_rejected', 409],
    ['idempotency_key_invalid', 400],
    ['idempotency_capacity_exhausted', 503],
    ['idempotency_persistence_unavailable', 503],
  ]),
} as const;

type FaceTimeCallControlAction = keyof typeof DEFINITE_FACETIME_CALL_CONTROL_FAILURES;

export interface StartAppleFaceTimeCallArgs {
  readonly address: string;
  readonly video: boolean;
}

export type FaceTimeCallStartResult =
  | { readonly status: 'accepted' }
  | { readonly status: 'rejected' }
  | { readonly status: 'outcome-unknown' };

export interface ControlAppleFaceTimeCallArgs {
  readonly callUuid: string;
}

export type FaceTimeCallControlResult =
  | { readonly status: 'accepted' }
  | { readonly status: 'rejected' }
  | { readonly status: 'outcome-unknown' };

function isDefiniteFaceTimeCallStartFailure(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.serverErrorType == null) return false;
  const expectedStatus = DEFINITE_FACETIME_CALL_START_FAILURES.get(error.serverErrorType);
  return expectedStatus !== undefined && error.status === expectedStatus;
}

function isDefiniteFaceTimeCallControlFailure(
  action: FaceTimeCallControlAction,
  error: unknown,
): boolean {
  if (!(error instanceof ApiError) || error.serverErrorType == null) return false;
  const expectedStatus = DEFINITE_FACETIME_CALL_CONTROL_FAILURES[action].get(error.serverErrorType);
  return expectedStatus !== undefined && error.status === expectedStatus;
}

function capabilityMatchesPinnedTransport(
  http: HttpClient,
  source: RcsCapabilitySource | undefined,
): boolean {
  if (!source || source.serverInfo?.supports_facetime_call_start !== true) return false;
  if (source.kind === 'fixed') return true;
  const transport = http.snapshotTransport();
  return (
    source.isCurrent() &&
    source.origin === transport.origin &&
    source.revision === transport.transportRevision
  );
}

function controlCapabilityMatchesPinnedTransport(
  action: FaceTimeCallControlAction,
  http: HttpClient,
  source: RcsCapabilitySource | undefined,
): boolean {
  const supported =
    action === 'answer'
      ? source?.serverInfo?.supports_facetime_call_answer === true
      : source?.serverInfo?.supports_facetime_call_leave === true;
  if (!source || !supported) return false;
  if (source.kind === 'fixed') return true;
  const transport = http.snapshotTransport();
  return (
    source.isCurrent() &&
    source.origin === transport.origin &&
    source.revision === transport.transportRevision
  );
}

/**
 * Start one FaceTime call under one exact account/origin/auth/capability owner.
 *
 * The address and temporary GUID are held only for this invocation. Nothing is persisted or
 * replayed, and any unrecognized result after HTTP dispatch is terminally outcome-unknown.
 */
export async function startExactFaceTimeCall(
  client: HttpClient,
  args: StartAppleFaceTimeCallArgs,
  accountGuard?: DbCommitGuard,
  capabilitySource?: RcsCapabilitySource,
): Promise<FaceTimeCallStartResult> {
  if (!isCanonicalFaceTimeCallAddress(args.address) || typeof args.video !== 'boolean') {
    return { status: 'rejected' };
  }

  const releaseLane = claimFaceTimeMutationLane();
  if (!releaseLane) return { status: 'rejected' };

  try {
    // Capture account, origin, credentials, capability owner, and attempt id before the first await.
    const transport = pinSendTransport(client, accountGuard);
    const capabilityGuard = sendCapabilityCommitGuard(transport.admissionGuard, capabilitySource);
    const tempGuid = generateTempGuid();

    if (!capabilityGuard() || !capabilityMatchesPinnedTransport(transport.http, capabilitySource)) {
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
      // This is the dispatch boundary. No error below it may cause an automatic replay.
      await postFaceTimeCallStart(transport.http, {
        address: args.address,
        video: args.video,
        tempGuid,
      });
      if (!capabilityGuard()) return { status: 'outcome-unknown' };
      return { status: 'accepted' };
    } catch (error) {
      if (!capabilityGuard() || error instanceof DbCommitGuardRejectedError) {
        return { status: 'outcome-unknown' };
      }
      if (isDefiniteFaceTimeCallStartFailure(error)) return { status: 'rejected' };
      return { status: 'outcome-unknown' };
    }
  } finally {
    releaseLane();
  }
}

async function controlExactFaceTimeCall(
  action: FaceTimeCallControlAction,
  client: HttpClient,
  args: ControlAppleFaceTimeCallArgs,
  accountGuard?: DbCommitGuard,
  capabilitySource?: RcsCapabilitySource,
): Promise<FaceTimeCallControlResult> {
  if (!isCanonicalFaceTimeCallUuid(args.callUuid)) return { status: 'rejected' };

  const releaseLane = claimFaceTimeMutationLane();
  if (!releaseLane) return { status: 'rejected' };

  try {
    // Capture account, origin, credentials, capability owner, and attempt id before the first await.
    const transport = pinSendTransport(client, accountGuard);
    const capabilityGuard = sendCapabilityCommitGuard(transport.admissionGuard, capabilitySource);
    const tempGuid = generateTempGuid();

    if (
      !capabilityGuard() ||
      !controlCapabilityMatchesPinnedTransport(action, transport.http, capabilitySource)
    ) {
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
      // This is the one-shot dispatch boundary. The UUID and temporary GUID are never retained.
      if (action === 'answer') {
        await postFaceTimeCallAnswer(transport.http, { callUuid: args.callUuid, tempGuid });
      } else {
        await postFaceTimeCallLeave(transport.http, { callUuid: args.callUuid, tempGuid });
      }
      if (!capabilityGuard()) return { status: 'outcome-unknown' };
      // The accepted branch is deliberately representable, although helper 693647 cannot yet
      // return a trustworthy post-dispatch success acknowledgement for either private action.
      return { status: 'accepted' };
    } catch (error) {
      if (!capabilityGuard() || error instanceof DbCommitGuardRejectedError) {
        return { status: 'outcome-unknown' };
      }
      if (isDefiniteFaceTimeCallControlFailure(action, error)) return { status: 'rejected' };
      return { status: 'outcome-unknown' };
    }
  } finally {
    releaseLane();
  }
}

/** Answer one exact call without retaining its UUID or replaying an ambiguous attempt. */
export function answerExactFaceTimeCall(
  client: HttpClient,
  args: ControlAppleFaceTimeCallArgs,
  accountGuard?: DbCommitGuard,
  capabilitySource?: RcsCapabilitySource,
): Promise<FaceTimeCallControlResult> {
  return controlExactFaceTimeCall('answer', client, args, accountGuard, capabilitySource);
}

/** Leave one exact call without retaining its UUID or replaying an ambiguous attempt. */
export function leaveExactFaceTimeCall(
  client: HttpClient,
  args: ControlAppleFaceTimeCallArgs,
  accountGuard?: DbCommitGuard,
  capabilitySource?: RcsCapabilitySource,
): Promise<FaceTimeCallControlResult> {
  return controlExactFaceTimeCall('leave', client, args, accountGuard, capabilitySource);
}
