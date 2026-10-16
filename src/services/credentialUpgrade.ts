import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';
import { deviceCredentialsApi, fcmApi, serverApi } from '@core/api';
import { ApiError } from '@core/api/errors';
import {
  activeFcmDeviceEncryptionV3State,
  encodeFcmDeviceEncryptionKey,
  FCM_DEVICE_ENCRYPTION_KEY_BYTES,
  FCM_PUSH_ENCRYPTION_TYPE_V3,
  pendingFcmDeviceEncryptionV3State,
} from '@core/realtime';
import {
  hasActiveServerSession,
  logger,
  resolveCredentialUpgrade,
  type CredentialUpgradeFcmRegistration,
  type StoredServerCredential,
} from '@core/secure';
import { useSessionStore } from '@state/sessionStore';
import { fixedCredentialClient, vault } from './clients';
import {
  beginCredentialReplacementRuntime,
  beginCredentialUpgradeRuntime,
  discardCredentialUpgradeCandidateRuntime,
  resumeCredentialUpgradeRuntime,
  revokeReplacedCredentialRuntime,
  type CredentialUpgradeRuntimeDependencies,
  type CredentialUpgradeRuntimeOutcome,
} from './credentialUpgradeRuntime';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
  type RealtimeDeliveryLease,
} from './realtime/deliveryCoordinator';
import {
  pauseRealtimeForCredentialUpgrade,
  resumeRealtimeAfterCredentialUpgrade,
} from './realtimeControl';
import { serverRotationCoordinator } from './realtime/serverRotationCoordinator';
import {
  readFcmDeviceEncryptionState,
  writeFcmDeviceEncryptionState,
} from './notifications/fcmEncryptionState';
import { runSerializedFcmRegistration } from './notifications/fcmRegistrationCoordinator';

const DEVICE_NAME = `Gator (Android ${Platform.Version})`;
/** Each request made with a bearer that is not the live session's gives up after this long. */
const SCOPED_BEARER_REQUEST_DEADLINE_MS = 5_000;

interface LiveUpgradeSession {
  readonly epoch: number;
  readonly transportRevision: number;
  readonly origin: string;
  readonly credential: string;
}

export interface ResumeScopedCredentialUpgradeOptions {
  /** The caller will restart realtime itself (used by `startRealtime`). */
  readonly restartRealtime?: boolean;
}

export type ScopedCredentialUpgradeStatus =
  | { readonly kind: 'none' }
  | { readonly kind: 'candidate' }
  | { readonly kind: 'in-progress' }
  | { readonly kind: 'revoked' }
  | { readonly kind: 'quarantined' }
  | { readonly kind: 'unavailable' };

let credentialUpgradeInFlight: Promise<CredentialUpgradeRuntimeOutcome> | null = null;

/** Read only the durable phase needed by UI; never return either stored credential. */
export async function inspectScopedCredentialUpgradeStatus(): Promise<ScopedCredentialUpgradeStatus> {
  try {
    const [sessionState, origin, credential, storedJournal] = await Promise.all([
      vault.get('serverSessionState'),
      vault.get('serverAddress'),
      vault.get('serverPassword'),
      vault.get('serverCredentialUpgrade'),
    ]);
    const session: StoredServerCredential | null = hasActiveServerSession(
      sessionState,
      origin,
      credential,
    )
      ? { origin: origin!, credential: credential! }
      : null;
    const resolution = resolveCredentialUpgrade(storedJournal, session);
    if (resolution.kind === 'none') return { kind: 'none' };
    if (resolution.kind === 'resume-candidate') return { kind: 'candidate' };
    if (resolution.kind === 'retry-adoption' || resolution.kind === 'finish-promotion') {
      return { kind: 'in-progress' };
    }
    if (resolution.kind === 'revoked') return { kind: 'revoked' };
    return { kind: 'quarantined' };
  } catch {
    return { kind: 'unavailable' };
  }
}

function captureLiveUpgradeSession(): LiveUpgradeSession | null {
  const state = useSessionStore.getState();
  if (state.status !== 'connected' || !state.origin || !state.password) return null;
  return Object.freeze({
    epoch: state.epoch,
    transportRevision: state.transportRevision,
    origin: state.origin,
    credential: state.password,
  });
}

function sameLiveUpgradeSession(session: LiveUpgradeSession): boolean {
  const current = useSessionStore.getState();
  return (
    current.status === 'connected' &&
    current.epoch === session.epoch &&
    current.transportRevision === session.transportRevision &&
    current.origin === session.origin &&
    current.password === session.credential
  );
}

function registrationHasExactV3(
  registration: CredentialUpgradeFcmRegistration,
  origin: string,
): boolean {
  // The name is a display label. A saved adoption replays the exact name it was saved with, which
  // embeds the Android version of that time, so it must not be compared with today's (review M128).
  return (
    registration.provider === 'fcm' &&
    registration.pushEncryption.type === FCM_PUSH_ENCRYPTION_TYPE_V3 &&
    registration.name.length > 0 &&
    registration.token.length > 0 &&
    origin.length > 0
  );
}

function createRuntimeDependencies(
  session: LiveUpgradeSession,
  isCurrent: () => boolean,
  markTransportPaused: () => void,
): CredentialUpgradeRuntimeDependencies {
  return {
    vault,
    isCurrent,
    beginExclusiveTransition: () => {
      pauseRealtimeForCredentialUpgrade();
      markTransportPaused();
      return !serverRotationCoordinator.hasInProgressTransition() && isCurrent();
    },
    fetchCandidateServerInfo: (origin, credential) =>
      serverApi.serverInfo(fixedCredentialClient(origin, credential, isCurrent)),
    checkBearerAccepted: async (origin, credential) => {
      await withBearerDeadline((signal) =>
        serverApi.serverInfo(fixedCredentialClient(origin, credential, isCurrent), signal),
      );
    },
    prepareV3Registration: async (origin) => {
      const [{ getMessaging, getToken }, stored] = await Promise.all([
        import('@react-native-firebase/messaging'),
        readFcmDeviceEncryptionState(vault),
      ]);
      if (!isCurrent()) throw new Error('credential upgrade was cancelled');
      // Disconnect leaves a revoked, keyless marker: it is no active key, so adoption mints a fresh
      // V3 key exactly as a scoped login does. Only an unreadable record stays ineligible.
      if (stored.kind === 'invalid') {
        throw new Error('FCM encryption state is not eligible for credential adoption');
      }
      if (
        stored.kind === 'valid' &&
        stored.state.status !== 'revoked' &&
        stored.state.origin !== origin
      ) {
        throw new Error('FCM encryption state belongs to another server origin');
      }

      const token = await getToken(getMessaging());
      if (!token || !isCurrent()) throw new Error('FCM token is unavailable');
      let key: string;
      if (
        stored.kind === 'valid' &&
        stored.state.encryptionType === FCM_PUSH_ENCRYPTION_TYPE_V3 &&
        stored.state.status !== 'revoked'
      ) {
        key = stored.state.key;
      } else {
        key = encodeFcmDeviceEncryptionKey(
          await Crypto.getRandomBytesAsync(FCM_DEVICE_ENCRYPTION_KEY_BYTES),
        );
      }
      if (!isCurrent()) throw new Error('credential upgrade was cancelled');
      return {
        name: DEVICE_NAME,
        provider: 'fcm',
        token,
        pushEncryption: { type: FCM_PUSH_ENCRYPTION_TYPE_V3, key },
      };
    },
    persistPendingV3: async (origin, registration) => {
      if (!registrationHasExactV3(registration, origin)) {
        throw new Error('credential adoption requires an exact V3 registration');
      }
      const stored = await readFcmDeviceEncryptionState(vault);
      if (!isCurrent()) throw new Error('credential upgrade was cancelled');
      // A revoked marker is replaced by the pending fresh key (see prepareV3Registration).
      if (stored.kind === 'invalid') {
        throw new Error('FCM encryption state is not eligible for credential adoption');
      }
      if (stored.kind === 'valid' && stored.state.status !== 'revoked') {
        if (stored.state.origin !== origin) {
          throw new Error('FCM encryption state belongs to another server origin');
        }
        if (
          stored.state.encryptionType === FCM_PUSH_ENCRYPTION_TYPE_V3 &&
          stored.state.key !== registration.pushEncryption.key
        ) {
          throw new Error('FCM V3 encryption key changed during credential adoption');
        }
        // Preserve an already-active exact V3 binding until the server acknowledges the candidate.
        if (
          stored.state.encryptionType === FCM_PUSH_ENCRYPTION_TYPE_V3 &&
          stored.state.status === 'active'
        ) {
          return;
        }
      }
      await writeFcmDeviceEncryptionState(
        vault,
        pendingFcmDeviceEncryptionV3State(registration.pushEncryption.key, origin),
      );
    },
    registerV3: async (origin, credential, registration) => {
      if (!registrationHasExactV3(registration, origin)) {
        throw new Error('credential adoption requires an exact V3 registration');
      }
      const ack = await fcmApi.registerDevice(
        fixedCredentialClient(origin, credential, isCurrent),
        registration.name,
        registration.token,
        registration.pushEncryption,
      );
      if (
        ack.pushEncryptionType !== FCM_PUSH_ENCRYPTION_TYPE_V3 ||
        !ack.id ||
        !ack.pushEncryptionIdentity ||
        ack.id !== ack.pushEncryptionIdentity.deviceId ||
        ack.pushEncryptionKeyVersion !== 1 ||
        ack.pushEncryptionRotationId !== undefined ||
        ack.pushEncryptionPreviousKeyExpiresAt !== undefined
      ) {
        throw new Error('server did not acknowledge identity-bound FCM adoption');
      }
      return {
        id: ack.id,
        pushEncryptionType: FCM_PUSH_ENCRYPTION_TYPE_V3,
        pushEncryptionIdentity: ack.pushEncryptionIdentity,
      };
    },
    persistActiveV3: async (origin, registration, ack) => {
      await writeFcmDeviceEncryptionState(
        vault,
        activeFcmDeviceEncryptionV3State(
          registration.pushEncryption.key,
          ack.pushEncryptionIdentity,
          origin,
        ),
      );
    },
    activeV3Matches: async (origin, registration, ack) => {
      const stored = await readFcmDeviceEncryptionState(vault);
      return (
        stored.kind === 'valid' &&
        stored.state.encryptionType === FCM_PUSH_ENCRYPTION_TYPE_V3 &&
        stored.state.status === 'active' &&
        stored.state.origin === origin &&
        stored.state.key === registration.pushEncryption.key &&
        stored.state.deviceId === ack.id &&
        stored.state.serverInstallationId === ack.pushEncryptionIdentity.serverInstallationId &&
        stored.state.principalId === ack.pushEncryptionIdentity.principalId
      );
    },
    revokeCandidate: (origin, candidateCredential) =>
      withBearerDeadline((signal) =>
        deviceCredentialsApi.revokeSelf(
          fixedCredentialClient(origin, candidateCredential, isCurrent),
          signal,
        ),
      ).then(() => undefined),
    releasePreviousPushTarget: async (origin, previousCredential) => {
      const stored = await readFcmDeviceEncryptionState(vault);
      if (!isCurrent()) throw new Error('credential upgrade was cancelled');
      // The replaced bearer's own push row is the active V3 binding it registered. The server lets
      // it remove only that row; anything else needs the owner (review M130).
      const state = stored.kind === 'valid' ? stored.state : null;
      if (
        !state ||
        state.encryptionType !== FCM_PUSH_ENCRYPTION_TYPE_V3 ||
        !('deviceId' in state) ||
        state.origin !== origin
      ) {
        return 'refused';
      }
      try {
        await withBearerDeadline((signal) =>
          fcmApi.removeDevice(
            fixedCredentialClient(origin, previousCredential, isCurrent),
            state.deviceId,
            signal,
          ),
        );
        return 'released';
      } catch (error) {
        // Already gone counts as freed: the next registration attempt decides the rest.
        if (error instanceof ApiError && error.status === 404) return 'released';
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          return 'refused';
        }
        throw error;
      }
    },
    revokePreviousCredential: (origin, previousCredential) =>
      withBearerDeadline((signal) =>
        deviceCredentialsApi.revokeSelf(
          fixedCredentialClient(origin, previousCredential, isCurrent),
          signal,
        ),
      ).then(() => undefined),
    publishCredential: (previousCredential, candidateCredential) => {
      const current = useSessionStore.getState();
      if (
        current.status === 'connected' &&
        current.epoch === session.epoch &&
        current.transportRevision === session.transportRevision &&
        current.origin === session.origin &&
        current.password === candidateCredential
      ) {
        return true;
      }
      return current.replaceCredentialForTransport(
        session.origin,
        previousCredential,
        session.transportRevision,
        candidateCredential,
      );
    },
  };
}

async function withBearerDeadline<T>(request: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SCOPED_BEARER_REQUEST_DEADLINE_MS);
  try {
    return await request(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Once a replacement's new credential is live, revoke the one it replaced (review M130). This runs
 * against the new live session, so an interruption leaves the revocation pending, never the live
 * session on a revoked bearer. A legacy upgrade records nothing, so it passes straight through.
 */
async function revokeReplacedAfterPromotion(
  outcome: CredentialUpgradeRuntimeOutcome,
  lease: RealtimeDeliveryLease,
): Promise<CredentialUpgradeRuntimeOutcome> {
  const promoted = captureLiveUpgradeSession();
  if (!promoted) {
    // No live session to act for right now: a recorded old bearer is retried on the next reconnect.
    const recorded = await vault.get('replacedServerCredential').then(
      (value) => value !== null,
      () => true,
    );
    return recorded ? { kind: 'adopted-revocation-pending' } : outcome;
  }
  const isCurrent = (): boolean => lease.isCurrent() && sameLiveUpgradeSession(promoted);
  const revocation = await revokeReplacedCredentialRuntime(
    createRuntimeDependencies(promoted, isCurrent, () => undefined),
  );
  return revocation === 'pending' || revocation === 'cancelled'
    ? { kind: 'adopted-revocation-pending' }
    : outcome;
}

/**
 * Before an approved server-address change saves the new address, revoke a replaced credential at
 * the current address, where it was issued (review M130). Both address-change paths require this
 * server to be reachable, so this normally completes at once; 'pending' makes the change wait.
 */
export async function settleReplacedCredentialBeforeAddressChange(
  isCurrent: () => boolean,
): Promise<'settled' | 'pending' | 'cancelled'> {
  const session = captureLiveUpgradeSession();
  if (!session || !isCurrent()) return 'cancelled';
  const current = (): boolean => isCurrent() && sameLiveUpgradeSession(session);
  const revocation = await revokeReplacedCredentialRuntime(
    createRuntimeDependencies(session, current, () => undefined),
  );
  if (revocation === 'cancelled') return 'cancelled';
  return revocation === 'pending' ? 'pending' : 'settled';
}

let replacedRevocationInFlight: Promise<void> | null = null;

/**
 * Retry revoking a replaced bearer after an ordinary reconnect, without holding up realtime
 * startup (review M130). Tracked like other account work, so Disconnect waits for it.
 */
function revokeReplacedCredentialInBackground(): void {
  if (replacedRevocationInFlight) return;
  const session = captureLiveUpgradeSession();
  if (!session) return;
  const lease = captureRealtimeDeliveryLease();
  if (!lease.isCurrent()) return;
  const isCurrent = (): boolean => lease.isCurrent() && sameLiveUpgradeSession(session);
  const deps = createRuntimeDependencies(session, isCurrent, () => undefined);
  const attempt = (async (): Promise<void> => {
    try {
      await runTrackedRealtimeWork(lease, async () => {
        await revokeReplacedCredentialRuntime(deps);
      });
    } catch (error) {
      logger.warn('[credential-upgrade] replaced credential revocation attempt failed', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  })();
  replacedRevocationInFlight = attempt;
  const clear = (): void => {
    if (replacedRevocationInFlight === attempt) replacedRevocationInFlight = null;
  };
  void attempt.then(clear, clear);
}

function runCredentialUpgrade(
  mode: 'begin' | 'replace' | 'resume' | 'discard',
  candidateCredential: string | undefined,
  options: ResumeScopedCredentialUpgradeOptions,
): Promise<CredentialUpgradeRuntimeOutcome> {
  if (credentialUpgradeInFlight) {
    // Realtime startup/resume must wait for the exact credential mutation already in progress.
    // User begin/discard requests remain non-coalescing and report busy below.
    return mode === 'resume'
      ? credentialUpgradeInFlight
      : Promise.resolve({ kind: 'busy' as const });
  }
  const session = captureLiveUpgradeSession();
  if (!session) return Promise.resolve({ kind: 'cancelled' });
  const lease = captureRealtimeDeliveryLease();
  if (!lease.isCurrent()) return Promise.resolve({ kind: 'cancelled' });

  let transportPaused = false;
  let outcome: CredentialUpgradeRuntimeOutcome = { kind: 'cancelled' };
  const isCurrent = (): boolean => lease.isCurrent() && sameLiveUpgradeSession(session);
  const deps = createRuntimeDependencies(session, isCurrent, () => {
    transportPaused = true;
  });

  const operation = (async (): Promise<CredentialUpgradeRuntimeOutcome> => {
    try {
      const tracked = await runTrackedRealtimeWork(lease, () =>
        runSerializedFcmRegistration(async () => {
          outcome =
            mode === 'begin'
              ? await beginCredentialUpgradeRuntime(candidateCredential ?? '', deps)
              : mode === 'replace'
                ? await beginCredentialReplacementRuntime(candidateCredential ?? '', deps)
                : mode === 'resume'
                  ? await resumeCredentialUpgradeRuntime(deps)
                  : await discardCredentialUpgradeCandidateRuntime(deps);
          if (outcome.kind === 'adopted' || outcome.kind === 'adopted-cleanup-pending') {
            outcome = await revokeReplacedAfterPromotion(outcome, lease);
          }
        }),
      );
      if (tracked === 'paused') outcome = { kind: 'cancelled' };
    } catch (error) {
      if (isCurrent()) {
        logger.warn('[credential-upgrade] recovery attempt failed', {
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
        outcome = { kind: 'retry', stage: 'storage' };
      } else {
        outcome = { kind: 'cancelled' };
      }
    } finally {
      if (transportPaused && options.restartRealtime !== false && lease.isCurrent()) {
        await resumeRealtimeAfterCredentialUpgrade().catch((error) => {
          logger.warn('[credential-upgrade] realtime restart failed', {
            errorName: error instanceof Error ? error.name : 'UnknownError',
          });
        });
      }
    }
    return outcome;
  })();

  credentialUpgradeInFlight = operation;
  const clear = (): void => {
    if (credentialUpgradeInFlight === operation) credentialUpgradeInFlight = null;
  };
  void operation.then(clear, clear);
  if (mode === 'resume') {
    // Only after an idle resume: a resumed promotion has just tried the revocation itself.
    void operation.then((outcome) => {
      if (outcome.kind === 'idle') revokeReplacedCredentialInBackground();
    });
  }
  return operation;
}

/** Consume one bearer issued/displayed by the Mac's local owner-confirmed dashboard. */
export function beginScopedCredentialUpgrade(
  candidateCredential: string,
): Promise<CredentialUpgradeRuntimeOutcome> {
  return runCredentialUpgrade('begin', candidateCredential, { restartRealtime: true });
}

/** Replace this app's scoped bearer without clearing local data or revoking the previous bearer. */
export function beginScopedCredentialReplacement(
  candidateCredential: string,
): Promise<CredentialUpgradeRuntimeOutcome> {
  return runCredentialUpgrade('replace', candidateCredential, { restartRealtime: true });
}

/** Resume candidate/adoption/promotion state left by a retry, reconnect, or process death. */
export function resumeScopedCredentialUpgrade(
  options: ResumeScopedCredentialUpgradeOptions = {},
): Promise<CredentialUpgradeRuntimeOutcome> {
  return runCredentialUpgrade('resume', undefined, options);
}

/** Cancel only a candidate which has not crossed the durable adoption-intent boundary. */
export function discardScopedCredentialUpgradeCandidate(): Promise<CredentialUpgradeRuntimeOutcome> {
  return runCredentialUpgrade('discard', undefined, { restartRealtime: true });
}
