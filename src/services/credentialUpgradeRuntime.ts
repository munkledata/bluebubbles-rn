import type { ServerInfo } from '@core/models';
import { ApiError } from '@core/api/errors';
import { strictServerOrigin } from '@core/config';
import { FCM_PUSH_ENCRYPTION_TYPE_V3 } from '@core/realtime';
import {
  acknowledgeCredentialUpgradePushAdoption,
  beginCredentialUpgradePushAdoption,
  createCredentialUpgradeCandidate,
  createCredentialReplacementCandidate,
  createReplacedCredentialRecord,
  inspectReplacedCredentialRecord,
  isScopedDeviceCredential,
  resolveCredentialUpgrade,
  serializeCredentialUpgradeJournal,
  serializeReplacedCredentialRecord,
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
  /**
   * A short, time-limited server-info request made with exactly this bearer. Rejects with a 401
   * ApiError when the server no longer accepts it.
   */
  checkBearerAccepted(origin: string, credential: string): Promise<void>;
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
  /**
   * With the replaced bearer, remove only its own push row so the new bearer can claim this
   * phone's push target. 'refused' means the server definitely will not; a transient failure throws.
   */
  releasePreviousPushTarget(
    origin: string,
    previousCredential: string,
  ): Promise<'released' | 'refused'>;
  /** Revoke the replaced bearer itself, once the new one holds the push target and the session. */
  revokePreviousCredential(origin: string, previousCredential: string): Promise<void>;
  /** Synchronous live handoff after the durable main credential has committed. */
  publishCredential(previousCredential: string, candidateCredential: string): boolean;
}

export type CredentialUpgradeRuntimeOutcome =
  | { readonly kind: 'adopted' }
  | { readonly kind: 'adopted-cleanup-pending' }
  /** The replacement is live; revoking the old bearer is retried when the app next resumes. */
  | { readonly kind: 'adopted-revocation-pending' }
  | { readonly kind: 'idle' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'revoked' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'discarded' }
  | {
      readonly kind: 'conflict';
      /** A begin only: whether the saved attempt that blocked it holds this exact credential. */
      readonly sameCandidate?: boolean;
    }
  | {
      readonly kind: 'blocked';
      readonly reason: 'push-target-owned';
      /** The replaced bearer's own push row is already gone, so no notifications arrive (M130). */
      readonly notificationsPaused?: true;
    }
  | {
      readonly kind: 'retry';
      readonly stage:
        | 'candidate-validation'
        | 'candidate-revocation'
        | 'previous-revocation'
        | 'adoption'
        | 'storage';
      /** As on 'blocked': set only once the old push row was freed and no new one exists yet. */
      readonly notificationsPaused?: true;
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
        | 'scoped-session-required'
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

function savedAttemptHoldsCandidate(
  resolution: CredentialUpgradeResolution,
  candidateCredential: string,
): boolean {
  return (
    (resolution.kind === 'resume-candidate' ||
      resolution.kind === 'retry-adoption' ||
      resolution.kind === 'finish-promotion') &&
    resolution.journal.candidateCredential === candidateCredential
  );
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

const REPLACED_CREDENTIAL_KEY = 'replacedServerCredential';

/**
 * Revoke one exact scoped bearer. A revoked, never-issued or mistyped bearer cannot call
 * revoke-self, and one without the push:self scope is refused it, so a 401 or 403 counts as
 * "already gone" only when the info endpoint, asked with the same bearer, independently answers
 * 401. Any other answer keeps custody for another attempt.
 */
async function revokeExactBearer(
  deps: CredentialUpgradeRuntimeDependencies,
  revoke: () => Promise<void>,
  origin: string,
  credential: string,
): Promise<'revoked' | 'retry'> {
  try {
    await revoke();
    return 'revoked';
  } catch (error) {
    if (!(error instanceof ApiError && (error.status === 401 || error.status === 403))) {
      return 'retry';
    }
    try {
      await deps.checkBearerAccepted(origin, credential);
      return 'retry';
    } catch (validationError) {
      return validationError instanceof ApiError && validationError.status === 401
        ? 'revoked'
        : 'retry';
    }
  }
}

/**
 * One replaced-credential record operation at a time (review M130 follow-up). A revocation reads
 * the record, revokes its bearer over the network and then forgets it; a replacement writes a newer
 * record. Interleaved, the slower revocation could delete a record whose bearer it never revoked.
 * A task must never start another record operation, or it would wait for itself.
 *
 * Safe outside the lock: Disconnect reads and deletes the record only after tracked account work
 * has drained, the new-account commit clears it only behind Disconnect's tombstone, and the
 * post-promotion check for a missing live session only reads it.
 */
let replacedCredentialRecordTail: Promise<unknown> = Promise.resolve();

function withReplacedCredentialRecord<T>(task: () => Promise<T>): Promise<T> {
  const run = replacedCredentialRecordTail.then(task, task);
  replacedCredentialRecordTail = run.catch(() => undefined);
  return run;
}

/** Move custody of a replaced bearer to its own record; true once the write is confirmed. */
async function recordReplacedCredential(
  deps: CredentialUpgradeRuntimeDependencies,
  origin: string,
  credential: string,
): Promise<boolean> {
  try {
    const serialized = serializeReplacedCredentialRecord(
      createReplacedCredentialRecord(origin, credential),
    );
    await deps.vault.set(REPLACED_CREDENTIAL_KEY, serialized);
    return (await deps.vault.get(REPLACED_CREDENTIAL_KEY)) === serialized;
  } catch {
    return false;
  }
}

/** Forget the record only while it still holds exactly `expected`; true once it is gone. */
async function forgetReplacedCredential(
  deps: CredentialUpgradeRuntimeDependencies,
  expected: string | null,
): Promise<boolean> {
  try {
    const stored = await deps.vault.get(REPLACED_CREDENTIAL_KEY);
    if (stored === null) return true;
    // A newer record belongs to a later replacement; it is not ours to forget.
    if (stored !== expected) return true;
    await deps.vault.delete(REPLACED_CREDENTIAL_KEY);
    return (await deps.vault.get(REPLACED_CREDENTIAL_KEY)) === null;
  } catch {
    return false;
  }
}

/**
 * Revoke the bearer a scoped replacement left behind (review M130), and forget it only once the
 * server confirms. Never touches the live credential: a record naming it, or one that cannot be
 * read, is dropped without any server call.
 */
export function revokeReplacedCredentialRuntime(
  deps: CredentialUpgradeRuntimeDependencies,
): Promise<'none' | 'revoked' | 'pending' | 'cancelled'> {
  return withReplacedCredentialRecord(() => revokeReplacedCredentialRecord(deps));
}

async function revokeReplacedCredentialRecord(
  deps: CredentialUpgradeRuntimeDependencies,
): Promise<'none' | 'revoked' | 'pending' | 'cancelled'> {
  let stored: string | null;
  let mainCredential: string | null;
  let mainAddress: string | null;
  try {
    [stored, mainCredential, mainAddress] = await Promise.all([
      deps.vault.get(REPLACED_CREDENTIAL_KEY),
      deps.vault.get('serverPassword'),
      deps.vault.get('serverAddress'),
    ]);
  } catch {
    return deps.isCurrent() ? 'pending' : 'cancelled';
  }
  if (!deps.isCurrent()) return 'cancelled';
  const inspected = inspectReplacedCredentialRecord(stored);
  if (inspected.kind === 'absent') return 'none';
  if (inspected.kind === 'invalid' || inspected.record.credential === mainCredential) {
    // Nothing here may be revoked: an unreadable record names no bearer, and the live credential
    // never is. Remove it when the keystore allows; either way it must not block anything.
    await forgetReplacedCredential(deps, stored);
    return 'none';
  }
  const { origin, credential } = inspected.record;
  // Address changes wait for this record, so it can only name the current server. Any other origin
  // is stale, and the bearer is never sent to a host that may no longer be this server.
  if (origin !== strictServerOrigin(mainAddress)) return 'pending';
  const revoked = await revokeExactBearer(
    deps,
    () => deps.revokePreviousCredential(origin, credential),
    origin,
    credential,
  );
  if (!deps.isCurrent()) return 'cancelled';
  if (revoked !== 'revoked') return 'pending';
  return (await forgetReplacedCredential(deps, stored)) ? 'revoked' : 'pending';
}

function isPushTargetOwned(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    error.serverErrorType === 'device_target_owned'
  );
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

  // A scoped replacement keeps custody of the old bearer in its own record before the journal
  // goes away, so it can be revoked now or on a later resume (review M130). Until that record
  // is confirmed, the journal keeps custody instead and a later resume moves it.
  const replacement = journal.version === 2;
  const custodyMoved =
    !replacement ||
    (await withReplacedCredentialRecord(() =>
      recordReplacedCredential(deps, journal.origin, journal.previousCredential),
    ));
  let cleanupPending = !custodyMoved;
  if (custodyMoved) {
    try {
      await deps.vault.delete('serverCredentialUpgrade');
      cleanupPending = (await deps.vault.get('serverCredentialUpgrade')) !== null;
    } catch {
      cleanupPending = true;
    }
  }
  if (!deps.isCurrent()) return { kind: 'cancelled' };
  if (!deps.publishCredential(journal.previousCredential, journal.candidateCredential)) {
    return { kind: 'cancelled' };
  }
  // The caller revokes the recorded old bearer next, with the new live session's currency.
  return cleanupPending ? { kind: 'adopted-cleanup-pending' } : { kind: 'adopted' };
}

async function advanceCredentialUpgrade(
  deps: CredentialUpgradeRuntimeDependencies,
  initial: CredentialUpgradeResolution,
): Promise<CredentialUpgradeRuntimeOutcome> {
  let resolution = initial;

  if (resolution.kind === 'resume-candidate') {
    const { journal } = resolution;
    if (journal.version === 1 && isScopedDeviceCredential(journal.previousCredential)) {
      return { kind: 'quarantined', reason: 'legacy-session-required' };
    }
    if (journal.version === 2 && !isScopedDeviceCredential(journal.previousCredential)) {
      return { kind: 'quarantined', reason: 'scoped-session-required' };
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
    } catch (error) {
      if (!deps.isCurrent()) return { kind: 'cancelled' };
      if (journal.version !== 2 || !isPushTargetOwned(error)) {
        return { kind: 'retry', stage: 'adoption' };
      }
      // The replaced bearer's own push row still holds this phone's push target. Free only that
      // row with the old bearer, which keeps working, then register once more (review M130). The
      // exact V2 intent stays durable either way, and no other candidate is ever accepted.
      let released: 'released' | 'refused' | 'unavailable';
      try {
        released = await deps.releasePreviousPushTarget(journal.origin, journal.previousCredential);
      } catch {
        released = 'unavailable';
      }
      if (!deps.isCurrent()) return { kind: 'cancelled' };
      if (released === 'refused') return { kind: 'blocked', reason: 'push-target-owned' };
      if (released === 'unavailable') return { kind: 'retry', stage: 'adoption' };
      try {
        ack = await deps.registerV3(
          journal.origin,
          journal.candidateCredential,
          journal.registration,
        );
      } catch (retryError) {
        if (!deps.isCurrent()) return { kind: 'cancelled' };
        // The old row is gone and the new one is not in place, so this phone gets no notifications
        // until the adoption finishes; the caller must say so (review M130). Still owned after the
        // old row was freed means another registration holds it: an owner must look at the Mac.
        return isPushTargetOwned(retryError)
          ? { kind: 'blocked', reason: 'push-target-owned', notificationsPaused: true }
          : { kind: 'retry', stage: 'adoption', notificationsPaused: true };
      }
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

async function beginCredentialTransitionRuntime(
  candidateCredential: string,
  deps: CredentialUpgradeRuntimeDependencies,
  mode: 'legacy-upgrade' | 'scoped-replacement',
): Promise<CredentialUpgradeRuntimeOutcome> {
  if (!isScopedDeviceCredential(candidateCredential)) {
    return { kind: 'quarantined', reason: 'invalid-candidate' };
  }
  const snapshot = await readJournalSnapshot(deps);
  if (!snapshot) return { kind: 'cancelled' };
  const terminal = terminalResolutionOutcome(snapshot.resolution);
  if (terminal?.kind !== 'idle') {
    if (terminal) return terminal;
    // An earlier attempt is still saved. Its credential may be this very entry (stored by a try
    // whose confirmation was lost); say so without letting the saved secret leave this module.
    return {
      kind: 'conflict',
      sameCandidate: savedAttemptHoldsCandidate(snapshot.resolution, candidateCredential),
    };
  }
  if (!snapshot.storedSession) {
    return {
      kind: 'quarantined',
      reason: mode === 'legacy-upgrade' ? 'legacy-session-required' : 'scoped-session-required',
    };
  }
  const previousIsScoped = isScopedDeviceCredential(snapshot.storedSession.credential);
  if (mode === 'legacy-upgrade' ? previousIsScoped : !previousIsScoped) {
    return {
      kind: 'quarantined',
      reason: mode === 'legacy-upgrade' ? 'legacy-session-required' : 'scoped-session-required',
    };
  }
  if (snapshot.storedSession.credential === candidateCredential) {
    return { kind: 'quarantined', reason: 'invalid-candidate' };
  }
  if (mode === 'scoped-replacement') {
    // One replaced bearer is kept at a time: finish revoking the previous one first. Reaching the
    // server is needed for the new replacement anyway, so this rarely waits (review M130).
    const earlier = await revokeReplacedCredentialRuntime(deps);
    if (earlier === 'cancelled') return { kind: 'cancelled' };
    if (earlier === 'pending') return { kind: 'retry', stage: 'previous-revocation' };
  }
  if (!deps.beginExclusiveTransition()) return { kind: 'busy' };
  if (!deps.isCurrent()) return { kind: 'cancelled' };

  let candidate;
  try {
    candidate =
      mode === 'legacy-upgrade'
        ? createCredentialUpgradeCandidate(
            snapshot.storedSession.origin,
            snapshot.storedSession.credential,
            candidateCredential,
          )
        : createCredentialReplacementCandidate(
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

/** Upgrade a legacy shared-password session without changing its account or local data. */
export function beginCredentialUpgradeRuntime(
  candidateCredential: string,
  deps: CredentialUpgradeRuntimeDependencies,
): Promise<CredentialUpgradeRuntimeOutcome> {
  return beginCredentialTransitionRuntime(candidateCredential, deps, 'legacy-upgrade');
}

/** Replace only this phone's scoped bearer; the old bearer is never revoked here. */
export function beginCredentialReplacementRuntime(
  candidateCredential: string,
  deps: CredentialUpgradeRuntimeDependencies,
): Promise<CredentialUpgradeRuntimeOutcome> {
  return beginCredentialTransitionRuntime(candidateCredential, deps, 'scoped-replacement');
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
  const { origin, candidateCredential } = snapshot.resolution.journal;
  const revoked = await revokeExactBearer(
    deps,
    () => deps.revokeCandidate(origin, candidateCredential),
    origin,
    candidateCredential,
  );
  if (revoked !== 'revoked') {
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
