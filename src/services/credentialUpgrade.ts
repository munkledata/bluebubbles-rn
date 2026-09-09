import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';
import { deviceCredentialsApi, fcmApi, serverApi } from '@core/api';
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
  beginCredentialUpgradeRuntime,
  discardCredentialUpgradeCandidateRuntime,
  resumeCredentialUpgradeRuntime,
  type CredentialUpgradeRuntimeDependencies,
  type CredentialUpgradeRuntimeOutcome,
} from './credentialUpgradeRuntime';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
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
const CANDIDATE_REVOCATION_DEADLINE_MS = 5_000;

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
  return (
    registration.provider === 'fcm' &&
    registration.pushEncryption.type === FCM_PUSH_ENCRYPTION_TYPE_V3 &&
    registration.name === DEVICE_NAME &&
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
    prepareV3Registration: async (origin) => {
      const [{ getMessaging, getToken }, stored] = await Promise.all([
        import('@react-native-firebase/messaging'),
        readFcmDeviceEncryptionState(vault),
      ]);
      if (!isCurrent()) throw new Error('credential upgrade was cancelled');
      if (
        stored.kind === 'invalid' ||
        (stored.kind === 'valid' && stored.state.status === 'revoked')
      ) {
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
      if (
        stored.kind === 'invalid' ||
        (stored.kind === 'valid' && stored.state.status === 'revoked')
      ) {
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
    revokeCandidate: async (origin, candidateCredential) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), CANDIDATE_REVOCATION_DEADLINE_MS);
      try {
        await deviceCredentialsApi.revokeSelf(
          fixedCredentialClient(origin, candidateCredential, isCurrent),
          controller.signal,
        );
      } finally {
        clearTimeout(timeout);
      }
    },
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

function runCredentialUpgrade(
  mode: 'begin' | 'resume' | 'discard',
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
              : mode === 'resume'
                ? await resumeCredentialUpgradeRuntime(deps)
                : await discardCredentialUpgradeCandidateRuntime(deps);
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
  return operation;
}

/** Consume one bearer issued/displayed by the Mac's local owner-confirmed dashboard. */
export function beginScopedCredentialUpgrade(
  candidateCredential: string,
): Promise<CredentialUpgradeRuntimeOutcome> {
  return runCredentialUpgrade('begin', candidateCredential, { restartRealtime: true });
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
