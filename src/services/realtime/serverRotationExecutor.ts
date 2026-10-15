import { strictServerOrigin } from '@core/config';
import type { ServerInfo } from '@core/models';
import { isScopedDeviceCredential } from '@core/secure';
import { useSessionStore } from '@state/sessionStore';
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
  /**
   * After the durable commit: carry a live V3 push-key record from the old origin to the new one
   * as tracked account work. Never throws; a failure leaves push to report itself unavailable.
   */
  readonly moveFcmPushKeyState: (
    fromOrigin: string,
    toOrigin: string,
    lease: RealtimeDeliveryLease,
    isCurrent: () => boolean,
  ) => Promise<void>;
  /** Synchronous handoff after the complete durable tuple is active. */
  readonly publishCandidate: (origin: string, info: ServerInfo) => void;
  /** The current server's last-known info, for the identity check. Defaults to the live session. */
  readonly getCurrentServerInfo?: () => ServerInfo | null | undefined;
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
        | 'different-server'
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

const CURRENT_SERVER_UNREACHABLE_MESSAGE =
  'Gator couldn’t reach your current server to check the password. A paired device can change ' +
  'its server address only while the current server is reachable.';
const DIFFERENT_SERVER_MESSAGE =
  'That address answers as a different Messages server, so Gator won’t switch to it. To use a ' +
  'different server, disconnect and set it up again.';

const currentSessionServerInfo = (): ServerInfo | null | undefined =>
  useSessionStore.getState().serverInfo;

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
  const currentPassword = session.password;
  const scopedSession = isScopedDeviceCredential(currentPassword);
  if (
    !enteredPassword ||
    (scopedSession
      ? isScopedDeviceCredential(enteredPassword)
      : !passwordsMatch(enteredPassword, currentPassword))
  ) {
    return {
      ok: false,
      kind: 'password-mismatch',
      message: 'The password does not match your current server password.',
      terminal: false,
    };
  }

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

  if (scopedSession) {
    // Prove fresh knowledge of the shared password only to the already-trusted origin. The
    // proposed origin receives the narrower device credential below, never the shared password.
    const passwordProof = await deps.validateCandidate(
      request.currentOrigin,
      enteredPassword,
      beforeCommitCurrent,
    );
    if (!beforeCommitCurrent() || (!passwordProof.ok && passwordProof.kind === 'cancelled')) {
      deps.coordinator.cancel(requestId);
      return staleResult();
    }
    if (!passwordProof.ok) {
      return {
        ok: false,
        kind: passwordProof.kind === 'unauthorized' ? 'password-mismatch' : 'validation-failed',
        message:
          passwordProof.kind === 'unauthorized'
            ? 'The password does not match your current server password.'
            : passwordProof.kind === 'unreachable'
              ? CURRENT_SERVER_UNREACHABLE_MESSAGE
              : passwordProof.message,
        terminal: false,
      };
    }
  }

  const validation = await deps.validateCandidate(
    request.candidateOrigin,
    scopedSession ? currentPassword : enteredPassword,
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

  // The same server installation keeps its Messages-database identity at a new address. A different
  // Mac that happens to accept the same password must never inherit this phone's local data.
  const currentProviderEpoch =
    (deps.getCurrentServerInfo ?? currentSessionServerInfo)()?.imessage_provider_epoch ?? null;
  if (
    currentProviderEpoch !== null &&
    validation.serverInfo.imessage_provider_epoch !== currentProviderEpoch
  ) {
    deps.coordinator.cancel(requestId);
    return {
      ok: false,
      kind: 'different-server',
      message: DIFFERENT_SERVER_MESSAGE,
      terminal: true,
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
      currentPassword,
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

    // Same server installation and credential at a new URL: move the V3 push-key record before the
    // reconnect registers push again, or V3 push stays broken with no re-enrollment path.
    await deps.moveFcmPushKeyState(
      request.currentOrigin,
      request.candidateOrigin,
      lease,
      durableCommitCurrent,
    );
    if (!durableCommitCurrent()) return staleResult();

    try {
      deps.publishCandidate(request.candidateOrigin, persistence.serverInfo);
    } catch {
      // The new address is saved, so reopening Gator finishes the change cleanly.
      if (!lease.isCurrent()) return staleResult();
      return {
        ok: false,
        kind: 'reconnect-failed',
        message: 'The server changed, but live updates could not restart. Reopen Gator to retry.',
        terminal: true,
      };
    }
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
