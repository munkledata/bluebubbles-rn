import type { ServerInfo } from '@core/models';
import { FCM_PUSH_ENCRYPTION_TYPE_V3 } from '@core/realtime';
import {
  acknowledgeCredentialUpgradePushAdoption,
  beginCredentialUpgradePushAdoption,
  createCredentialUpgradeCandidate,
  isScopedDeviceCredential,
  resolveCredentialUpgrade,
  serializeCredentialUpgradeJournal,
  SERVER_SESSION_STATE,
  type CredentialUpgradeFcmRegistration,
  type CredentialUpgradeFcmV3AdoptionAck,
  type CredentialUpgradeJournal,
  type CredentialUpgradeQuarantineReason,
  type CredentialUpgradeResolution,
  type SecureVault,
} from '@core/secure';

interface RuntimeSessionSnapshot {
  readonly origin: string;
  readonly credential: string;
}

interface RuntimeJournalSnapshot {
  readonly resolution: CredentialUpgradeResolution;
  readonly storedSession: RuntimeSessionSnapshot | null;
}

export interface CredentialUpgradeRuntimeDependencies {
  readonly vault: Pick<SecureVault, 'get' | 'set' | 'delete'>;
  /** Revoked as soon as Disconnect or another account/transport transition wins. */
  isCurrent(): boolean;
  /** Pauses socket/rotation work before this journal performs or resumes any mutation. */
  beginExclusiveTransition(): boolean;
  fetchCandidateServerInfo(origin: string, credential: string): Promise<ServerInfo>;
  prepareV3Registration(origin: string): Promise<CredentialUpgradeFcmRegistration>;
  persistPendingV3(origin: string, registration: CredentialUpgradeFcmRegistration): Promise<void>;
  registerV3(
    origin: string,
    credential: string,
    registration: CredentialUpgradeFcmRegistration,
  ): Promise<CredentialUpgradeFcmV3AdoptionAck>;
  persistActiveV3(
    origin: string,
    registration: CredentialUpgradeFcmRegistration,
    ack: CredentialUpgradeFcmV3AdoptionAck,
  ): Promise<void>;
  activeV3Matches(
    origin: string,
    registration: CredentialUpgradeFcmRegistration,
    ack: CredentialUpgradeFcmV3AdoptionAck,
  ): Promise<boolean>;
  /** Revoke the exact pre-adoption bearer before its only local custody is removed. */
  revokeCandidate(origin: string, candidateCredential: string): Promise<void>;
  /** Synchronous live handoff after the durable main credential has committed. */
  publishCredential(previousCredential: string, candidateCredential: string): boolean;
}

export type CredentialUpgradeRuntimeOutcome =
  | { readonly kind: 'adopted' }
  | { readonly kind: 'adopted-cleanup-pending' }
  | { readonly kind: 'idle' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'revoked' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'discarded' }
  | { readonly kind: 'conflict' }
  | {
      readonly kind: 'retry';
      readonly stage: 'candidate-validation' | 'candidate-revocation' | 'adoption' | 'storage';
    }
  | {
      readonly kind: 'unsupported';
      readonly reason: 'scoped-credentials' | 'fcm-v3';
    }
  | {
      readonly kind: 'quarantined';
      readonly reason:
        | CredentialUpgradeQuarantineReason
        | 'invalid-candidate'
        | 'legacy-session-required'
        | 'v3-registration-required'
        | 'invalid-v3-ack'
        | 'active-v3-mismatch';
    };

function activeStoredSession(
  sessionState: string | null,
  origin: string | null,
  credential: string | null,
): RuntimeSessionSnapshot | null {
  if (
    (sessionState === null || sessionState === SERVER_SESSION_STATE.active) &&
    origin &&
    credential
  ) {
    return Object.freeze({ origin, credential });
  }
  return null;
}

async function readJournalSnapshot(
  deps: CredentialUpgradeRuntimeDependencies,
): Promise<RuntimeJournalSnapshot | null> {
  let sessionState: string | null;
  let origin: string | null;
  let credential: string | null;
  let storedJournal: string | null;
  try {
    [sessionState, origin, credential, storedJournal] = await Promise.all([
      deps.vault.get('serverSessionState'),
      deps.vault.get('serverAddress'),
      deps.vault.get('serverPassword'),
      deps.vault.get('serverCredentialUpgrade'),
    ]);
  } catch {
    return null;
  }
  if (!deps.isCurrent()) return null;
  const storedSession = activeStoredSession(sessionState, origin, credential);
  return {
    storedSession,
    resolution: resolveCredentialUpgrade(storedJournal, storedSession),
  };
}

function terminalResolutionOutcome(
  resolution: CredentialUpgradeResolution,
): CredentialUpgradeRuntimeOutcome | null {
  if (resolution.kind === 'none') return { kind: 'idle' };
  if (resolution.kind === 'revoked') return { kind: 'revoked' };
  if (resolution.kind === 'quarantined') {
    return { kind: 'quarantined', reason: resolution.reason };
  }
  return null;
}

function isExactJournal(
  resolution: CredentialUpgradeResolution,
  expected: CredentialUpgradeJournal,
): boolean {
  if (
    resolution.kind !== 'resume-candidate' &&
    resolution.kind !== 'retry-adoption' &&
    resolution.kind !== 'finish-promotion'
  ) {
    return false;
  }
  return (
    serializeCredentialUpgradeJournal(resolution.journal) ===
    serializeCredentialUpgradeJournal(expected)
  );
}

async function rereadExactJournal(
  deps: CredentialUpgradeRuntimeDependencies,
  expected: CredentialUpgradeJournal,
): Promise<CredentialUpgradeResolution | null> {
  const snapshot = await readJournalSnapshot(deps);
  if (!snapshot || !isExactJournal(snapshot.resolution, expected)) return null;
  return snapshot.resolution;
}

function exactV3AdoptedJournal(
  resolution: Extract<CredentialUpgradeResolution, { kind: 'finish-promotion' }>,
): boolean {
  return (
    resolution.journal.registration.pushEncryption.type === FCM_PUSH_ENCRYPTION_TYPE_V3 &&
    resolution.journal.ack.pushEncryptionType === FCM_PUSH_ENCRYPTION_TYPE_V3
  );
}

async function finishPromotion(
  deps: CredentialUpgradeRuntimeDependencies,
  resolution: Extract<CredentialUpgradeResolution, { kind: 'finish-promotion' }>,
): Promise<CredentialUpgradeRuntimeOutcome> {
  if (!exactV3AdoptedJournal(resolution)) {
    return { kind: 'quarantined', reason: 'v3-registration-required' };
  }
  const { journal } = resolution;
  const ack = journal.ack as CredentialUpgradeFcmV3AdoptionAck;
  let activeMatches = false;
  try {
    activeMatches = await deps.activeV3Matches(journal.origin, journal.registration, ack);
  } catch {
    return { kind: 'retry', stage: 'storage' };
  }
  if (!deps.isCurrent()) return { kind: 'cancelled' };
  if (!activeMatches) return { kind: 'quarantined', reason: 'active-v3-mismatch' };

  if (resolution.writeMainCredential) {
    try {
      await deps.vault.set('serverPassword', journal.candidateCredential);
    } catch {
      return { kind: 'retry', stage: 'storage' };
    }
    if (!deps.isCurrent()) return { kind: 'cancelled' };
  }

  const promoted = await readJournalSnapshot(deps);
  if (
    !promoted ||
    promoted.resolution.kind !== 'finish-promotion' ||
    !isExactJournal(promoted.resolution, journal) ||
    promoted.resolution.writeMainCredential
  ) {
    return deps.isCurrent()
      ? { kind: 'quarantined', reason: 'credential-mismatch' }
      : { kind: 'cancelled' };
  }

  let cleanupPending = false;
  try {
    await deps.vault.delete('serverCredentialUpgrade');
    cleanupPending = (await deps.vault.get('serverCredentialUpgrade')) !== null;
  } catch {
    cleanupPending = true;
  }
  if (!deps.isCurrent()) return { kind: 'cancelled' };
  if (!deps.publishCredential(journal.previousCredential, journal.candidateCredential)) {
    return { kind: 'cancelled' };
  }
  return cleanupPending ? { kind: 'adopted-cleanup-pending' } : { kind: 'adopted' };
}

async function advanceCredentialUpgrade(
  deps: CredentialUpgradeRuntimeDependencies,
  initial: CredentialUpgradeResolution,
): Promise<CredentialUpgradeRuntimeOutcome> {
  let resolution = initial;

  if (resolution.kind === 'resume-candidate') {
    const { journal } = resolution;
    if (isScopedDeviceCredential(journal.previousCredential)) {
      return { kind: 'quarantined', reason: 'legacy-session-required' };
    }

    let serverInfo: ServerInfo;
    try {
      serverInfo = await deps.fetchCandidateServerInfo(journal.origin, journal.candidateCredential);
    } catch {
      return deps.isCurrent()
        ? { kind: 'retry', stage: 'candidate-validation' }
        : { kind: 'cancelled' };
    }
    if (!deps.isCurrent()) return { kind: 'cancelled' };
    if (serverInfo.supports_scoped_device_credentials !== true) {
      return { kind: 'unsupported', reason: 'scoped-credentials' };
    }
    if (serverInfo.supports_fcm_push_encryption_v3 !== true) {
      return { kind: 'unsupported', reason: 'fcm-v3' };
    }

    let registration: CredentialUpgradeFcmRegistration;
    try {
      registration = await deps.prepareV3Registration(journal.origin);
    } catch {
      return deps.isCurrent() ? { kind: 'retry', stage: 'storage' } : { kind: 'cancelled' };
    }
    if (!deps.isCurrent()) return { kind: 'cancelled' };
    if (registration.pushEncryption.type !== FCM_PUSH_ENCRYPTION_TYPE_V3) {
      return { kind: 'quarantined', reason: 'v3-registration-required' };
    }

    if (!(await rereadExactJournal(deps, journal))) return { kind: 'cancelled' };

    let adopting;
    try {
      adopting = beginCredentialUpgradePushAdoption(journal, registration);
      await deps.vault.set('serverCredentialUpgrade', serializeCredentialUpgradeJournal(adopting));
    } catch {
      return { kind: 'retry', stage: 'storage' };
    }
    if (!deps.isCurrent()) return { kind: 'cancelled' };
    resolution = {
      kind: 'retry-adoption',
      session: resolution.session,
      journal: adopting,
    };
  }

  if (resolution.kind === 'retry-adoption') {
    const { journal } = resolution;
    if (journal.registration.pushEncryption.type !== FCM_PUSH_ENCRYPTION_TYPE_V3) {
      return { kind: 'quarantined', reason: 'v3-registration-required' };
    }

    // The exact request intent is already durable. Reassert its matching local pending state on
    // every retry before POST; this covers a crash immediately after the journal phase changed.
    try {
      await deps.persistPendingV3(journal.origin, journal.registration);
    } catch {
      return deps.isCurrent() ? { kind: 'retry', stage: 'storage' } : { kind: 'cancelled' };
    }
    if (!deps.isCurrent()) return { kind: 'cancelled' };

    let ack: CredentialUpgradeFcmV3AdoptionAck;
    try {
      ack = await deps.registerV3(
        journal.origin,
        journal.candidateCredential,
        journal.registration,
      );
    } catch {
      return deps.isCurrent() ? { kind: 'retry', stage: 'adoption' } : { kind: 'cancelled' };
    }
    if (!deps.isCurrent()) return { kind: 'cancelled' };

    let adopted;
    try {
      adopted = acknowledgeCredentialUpgradePushAdoption(journal, ack);
    } catch {
      return { kind: 'quarantined', reason: 'invalid-v3-ack' };
    }
    try {
      await deps.persistActiveV3(journal.origin, journal.registration, ack);
    } catch {
      return { kind: 'retry', stage: 'storage' };
    }
    if (!deps.isCurrent()) return { kind: 'cancelled' };
    if (!(await rereadExactJournal(deps, journal))) return { kind: 'cancelled' };

    try {
      await deps.vault.set('serverCredentialUpgrade', serializeCredentialUpgradeJournal(adopted));
    } catch {
      return { kind: 'retry', stage: 'storage' };
    }
    if (!deps.isCurrent()) return { kind: 'cancelled' };
    resolution = {
      kind: 'finish-promotion',
      session: Object.freeze({
        origin: adopted.origin,
        credential: adopted.candidateCredential,
      }),
      journal: adopted,
      writeMainCredential: true,
    };
  }

  if (resolution.kind === 'finish-promotion') return finishPromotion(deps, resolution);
  return terminalResolutionOutcome(resolution) ?? { kind: 'cancelled' };
}

/** Persist one user-supplied scoped bearer, then advance it through exact V3 push adoption. */
export async function beginCredentialUpgradeRuntime(
  candidateCredential: string,
  deps: CredentialUpgradeRuntimeDependencies,
): Promise<CredentialUpgradeRuntimeOutcome> {
  if (!isScopedDeviceCredential(candidateCredential)) {
    return { kind: 'quarantined', reason: 'invalid-candidate' };
  }
  const snapshot = await readJournalSnapshot(deps);
  if (!snapshot) return { kind: 'cancelled' };
  const terminal = terminalResolutionOutcome(snapshot.resolution);
  if (terminal?.kind !== 'idle') return terminal ?? { kind: 'conflict' };
  if (!snapshot.storedSession || isScopedDeviceCredential(snapshot.storedSession.credential)) {
    return { kind: 'quarantined', reason: 'legacy-session-required' };
  }
  if (!deps.beginExclusiveTransition()) return { kind: 'busy' };
  if (!deps.isCurrent()) return { kind: 'cancelled' };

  let candidate;
  try {
    candidate = createCredentialUpgradeCandidate(
      snapshot.storedSession.origin,
      snapshot.storedSession.credential,
      candidateCredential,
    );
    await deps.vault.set('serverCredentialUpgrade', serializeCredentialUpgradeJournal(candidate));
  } catch {
    return { kind: 'retry', stage: 'storage' };
  }
  if (!deps.isCurrent()) return { kind: 'cancelled' };
  return advanceCredentialUpgrade(deps, {
    kind: 'resume-candidate',
    session: snapshot.storedSession,
    journal: candidate,
  });
}

/** Resume every durable crash boundary without accepting or inventing another bearer. */
export async function resumeCredentialUpgradeRuntime(
  deps: CredentialUpgradeRuntimeDependencies,
): Promise<CredentialUpgradeRuntimeOutcome> {
  const snapshot = await readJournalSnapshot(deps);
  if (!snapshot) return { kind: 'cancelled' };
  const terminal = terminalResolutionOutcome(snapshot.resolution);
  if (terminal) return terminal;
  if (!deps.beginExclusiveTransition()) return { kind: 'busy' };
  if (!deps.isCurrent()) return { kind: 'cancelled' };
  return advanceCredentialUpgrade(deps, snapshot.resolution);
}

/** Discard only a pre-mutation candidate; adopting/adopted journals are never cancellable. */
export async function discardCredentialUpgradeCandidateRuntime(
  deps: CredentialUpgradeRuntimeDependencies,
): Promise<CredentialUpgradeRuntimeOutcome> {
  const snapshot = await readJournalSnapshot(deps);
  if (!snapshot) return { kind: 'cancelled' };
  const terminal = terminalResolutionOutcome(snapshot.resolution);
  if (terminal) return terminal;
  if (snapshot.resolution.kind !== 'resume-candidate') return { kind: 'conflict' };
  if (!deps.beginExclusiveTransition()) return { kind: 'busy' };
  if (!deps.isCurrent()) return { kind: 'cancelled' };
  if (!(await rereadExactJournal(deps, snapshot.resolution.journal))) {
    return { kind: 'cancelled' };
  }
  try {
    await deps.revokeCandidate(
      snapshot.resolution.journal.origin,
      snapshot.resolution.journal.candidateCredential,
    );
  } catch {
    return deps.isCurrent()
      ? { kind: 'retry', stage: 'candidate-revocation' }
      : { kind: 'cancelled' };
  }
  if (!deps.isCurrent()) return { kind: 'cancelled' };
  if (!(await rereadExactJournal(deps, snapshot.resolution.journal))) {
    return { kind: 'cancelled' };
  }
  try {
    await deps.vault.delete('serverCredentialUpgrade');
    if ((await deps.vault.get('serverCredentialUpgrade')) !== null) {
      return { kind: 'retry', stage: 'storage' };
    }
  } catch {
    return { kind: 'retry', stage: 'storage' };
  }
  return deps.isCurrent() ? { kind: 'discarded' } : { kind: 'cancelled' };
}
