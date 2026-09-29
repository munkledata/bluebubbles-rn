import { createFaceTimeLink as postFaceTimeLink } from '@core/api/endpoints/facetime';
import { ApiError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';
import { DbCommitGuardRejectedError, type DbCommitGuard } from '@db/transaction';
import { claimFaceTimeMutationLane } from './facetimeMutationLane';
import { generateTempGuid } from './send/sendService';
import { sendCapabilityCommitGuard, type RcsCapabilitySource } from './send/rcsAttemptCapability';
import { pinSendTransport } from './send/sendTransport';

const DEFINITE_FACETIME_LINK_FAILURES = new Map<string, number>([
  ['facetime_link_invalid', 400],
  ['facetime_link_unavailable', 503],
  ['facetime_link_rejected', 409],
  ['idempotency_key_invalid', 400],
  ['idempotency_capacity_exhausted', 503],
  ['idempotency_persistence_unavailable', 503],
]);

export type FaceTimeLinkCreationResult =
  | { readonly status: 'accepted'; readonly link: string }
  | { readonly status: 'rejected' }
  | { readonly status: 'outcome-unknown' };

function isDefiniteFaceTimeLinkFailure(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.serverErrorType == null) return false;
  const expectedStatus = DEFINITE_FACETIME_LINK_FAILURES.get(error.serverErrorType);
  return expectedStatus !== undefined && error.status === expectedStatus;
}

function capabilityMatchesPinnedTransport(
  http: HttpClient,
  source: RcsCapabilitySource | undefined,
): boolean {
  if (!source || source.serverInfo?.supports_facetime_link_creation !== true) return false;
  if (source.kind === 'fixed') return true;
  const transport = http.snapshotTransport();
  return (
    source.isCurrent() &&
    source.origin === transport.origin &&
    source.revision === transport.transportRevision
  );
}

/**
 * Create one FaceTime link under one exact account/origin/auth/capability owner.
 *
 * This operation is deliberately not durable: an ambiguous request is never replayed, and its
 * temporary GUID is not returned or retained. The bearer URL exists only in the accepted result.
 */
export async function createExactFaceTimeLink(
  client: HttpClient,
  accountGuard?: DbCommitGuard,
  capabilitySource?: RcsCapabilitySource,
): Promise<FaceTimeLinkCreationResult> {
  const releaseLane = claimFaceTimeMutationLane();
  if (!releaseLane) return { status: 'rejected' };

  try {
    // All authority is captured synchronously, before the first await and before HTTP dispatch.
    const transport = pinSendTransport(client, accountGuard);
    const capabilityGuard = sendCapabilityCommitGuard(transport.admissionGuard, capabilitySource);
    const tempGuid = generateTempGuid();
    let dispatched = false;

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
      // From this boundary onward, any missing/malformed response may still have created a link.
      dispatched = true;
      const ack = await postFaceTimeLink(transport.http, { tempGuid });
      if (!capabilityGuard()) return { status: 'outcome-unknown' };
      return { status: 'accepted', link: ack.link };
    } catch (error) {
      if (!dispatched) return { status: 'rejected' };
      if (!capabilityGuard() || error instanceof DbCommitGuardRejectedError) {
        return { status: 'outcome-unknown' };
      }
      if (isDefiniteFaceTimeLinkFailure(error)) return { status: 'rejected' };
      return { status: 'outcome-unknown' };
    }
  } finally {
    releaseLane();
  }
}
