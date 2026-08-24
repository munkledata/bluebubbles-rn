import { strictServerOrigin } from '@core/config';
import type { ServerInfo } from '@core/models';
import { timingSafeEqual, utf8Encode } from '@utils/bytes';
import type { ConnectResult } from '../connection';
import type { RealtimeDeliveryLease } from './deliveryCoordinator';
import type { ServerRotationCoordinator, ServerRotationRequest } from './serverRotationCoordinator';

interface RotationSessionSnapshot {
  readonly origin: string | null;
  readonly password: string | null;
  readonly epoch: number;
}

export interface ServerRotationExecutorDeps {
  readonly coordinator: ServerRotationCoordinator;
  readonly getSession: () => RotationSessionSnapshot;
  readonly captureLease: () => RealtimeDeliveryLease;
  readonly validateCandidate: (
    origin: string,
    password: string,
    isCurrent: () => boolean,
  ) => Promise<ConnectResult>;
  readonly persistCandidate: (
    origin: string,
    password: string,
    info: ServerInfo,
    lease: RealtimeDeliveryLease,
    isCurrent: () => boolean,
  ) => Promise<ConnectResult>;
  /** Synchronous handoff after the complete durable tuple is active. */
  readonly publishCandidate: (origin: string, info: ServerInfo) => void;
  readonly reconnect: (lease: RealtimeDeliveryLease, isCurrent: () => boolean) => Promise<void>;
}

export type ServerRotationApprovalResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly kind:
        | 'stale'
        | 'password-mismatch'
        | 'cleartext-consent-required'
        | 'validation-failed'
        | 'persistence-failed'
        | 'reconnect-failed';
      readonly message: string;
      /** False means the still-visible prompt can safely show the error and accept another try. */
      readonly terminal: boolean;
    };

function passwordsMatch(left: string, right: string): boolean {
  return timingSafeEqual(utf8Encode(left), utf8Encode(right));
}

function currentSessionMatches(
  request: ServerRotationRequest,
  expectedPassword: string,
  session: RotationSessionSnapshot,
): boolean {
  return (
    session.epoch === request.sessionEpoch &&
    strictServerOrigin(session.origin) === request.currentOrigin &&
    session.password !== null &&
    passwordsMatch(session.password, expectedPassword)
  );
}

function rotatedSessionMatches(
  request: ServerRotationRequest,
  expectedPassword: string,
  session: RotationSessionSnapshot,
): boolean {
  return (
    session.epoch === request.sessionEpoch &&
    strictServerOrigin(session.origin) === request.candidateOrigin &&
    session.password !== null &&
    passwordsMatch(session.password, expectedPassword)
  );
}

const staleResult = (): ServerRotationApprovalResult => ({
  ok: false,
  kind: 'stale',
  message: 'This server-change request is no longer active.',
  terminal: true,
});

/**
 * Execute a user-approved rotation without retaining the entered password.
 *
 * Local password and cleartext checks happen before the first candidate-client call. Candidate
 * validation remains cancellable and non-durable. Only after it succeeds do we claim the prompt
 * and enter the caller's short account-tracked correlated-vault commit.
 */
export async function approveServerRotation(
  requestId: number,
  enteredPassword: string,
  cleartextApproved: boolean,
  deps: ServerRotationExecutorDeps,
): Promise<ServerRotationApprovalResult> {
  const request = deps.coordinator.current(requestId);
  if (!request) return staleResult();
  if (request.requiresCleartextApproval && !cleartextApproved) {
    return {
      ok: false,
      kind: 'cleartext-consent-required',
      message: 'Confirm that you want to send credentials over this insecure connection.',
      terminal: false,
    };
  }

  const session = deps.getSession();
  if (!session.password || !currentSessionMatches(request, session.password, session)) {
    deps.coordinator.cancel(requestId);
    return staleResult();
  }
  if (!enteredPassword || !passwordsMatch(enteredPassword, session.password)) {
    return {
      ok: false,
      kind: 'password-mismatch',
      message: 'The password does not match your current server password.',
      terminal: false,
    };
  }
  const currentPassword = session.password;

  const lease = deps.captureLease();
  if (lease.generation !== request.deliveryGeneration || !lease.isCurrent()) {
    deps.coordinator.cancel(requestId);
    return staleResult();
  }
  const beforeCommitCurrent = (): boolean => {
    const liveRequest = deps.coordinator.current(requestId);
    return (
      liveRequest === request &&
      lease.isCurrent() &&
      currentSessionMatches(request, currentPassword, deps.getSession())
    );
  };
  if (!beforeCommitCurrent()) return staleResult();

  const validation = await deps.validateCandidate(
    request.candidateOrigin,
    enteredPassword,
    beforeCommitCurrent,
  );
  if (!beforeCommitCurrent() || (!validation.ok && validation.kind === 'cancelled')) {
    deps.coordinator.cancel(requestId);
    return staleResult();
  }
  if (!validation.ok) {
    return {
      ok: false,
      kind: 'validation-failed',
      message: validation.message,
      terminal: false,
    };
  }

  // From here the already-approved durable commit may finish if the app backgrounds, but account
  // replacement still revokes the lease and the tracked persistence owner drains before teardown.
  if (deps.coordinator.claim(requestId) !== request) return staleResult();
  try {
    const durableCommitCurrent = (): boolean =>
      lease.isCurrent() && currentSessionMatches(request, currentPassword, deps.getSession());
    if (!durableCommitCurrent()) return staleResult();

    const persistence = await deps.persistCandidate(
      request.candidateOrigin,
      enteredPassword,
      validation.serverInfo,
      lease,
      durableCommitCurrent,
    );
    if (!persistence.ok) {
      if (persistence.kind === 'cancelled' || !lease.isCurrent()) return staleResult();
      return {
        ok: false,
        kind: 'persistence-failed',
        message: persistence.message,
        terminal: true,
      };
    }
    if (!durableCommitCurrent()) return staleResult();

    deps.publishCandidate(request.candidateOrigin, persistence.serverInfo);
    const rotatedCurrent = (): boolean =>
      lease.isCurrent() && rotatedSessionMatches(request, currentPassword, deps.getSession());
    if (!rotatedCurrent()) return staleResult();

    try {
      await deps.reconnect(lease, rotatedCurrent);
    } catch {
      if (!rotatedCurrent()) return staleResult();
      return {
        ok: false,
        kind: 'reconnect-failed',
        message: 'The server changed, but live updates could not restart. Reopen Gator to retry.',
        terminal: true,
      };
    }
    return rotatedCurrent() ? { ok: true } : staleResult();
  } finally {
    deps.coordinator.finish(requestId);
  }
}
