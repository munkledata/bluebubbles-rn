import { MAX_SERVER_ORIGIN_INPUT_LENGTH, strictServerOrigin } from '../config';
import {
  activeFcmDeviceEncryptionV3State,
  decodeFcmDeviceEncryptionKey,
  FCM_DEVICE_ENCRYPTION_TYPE,
} from '../realtime/fcmEncryption';
import { FCM_PUSH_ENCRYPTION_TYPE_V3 } from '../realtime/fcmPushEnvelopeIdentity';
import { isScopedDeviceCredential } from './deviceCredential';
import { utf8Encode } from '@utils/bytes';

/**
 * Durable handoff from a legacy shared password to one scoped device credential.
 *
 * Version 1 was frozen before any runtime writer existed and records the exact deployed V2/V3
 * registration contracts. Any future wire shape must use a new journal version; silently widening
 * a live record would make an interrupted old write ambiguous.
 */
const CREDENTIAL_UPGRADE_JOURNAL_VERSION = 1 as const;

/** Bound the complete SecureStore value before parsing or retaining any attacker-controlled text. */
export const MAX_CREDENTIAL_UPGRADE_JOURNAL_UTF8_BYTES = 32 * 1024;

const MAX_PREVIOUS_CREDENTIAL_UTF8_BYTES = 16 * 1024;
const MAX_FCM_DEVICE_NAME_CHARACTERS = 256;
const MAX_FCM_TOKEN_CHARACTERS = 4_096;
const MAX_FCM_DEVICE_ID_CHARACTERS = 256;

export interface CredentialUpgradeFcmRegistration {
  readonly name: string;
  readonly provider: 'fcm';
  readonly token: string;
  readonly pushEncryption: {
    readonly type: typeof FCM_DEVICE_ENCRYPTION_TYPE | typeof FCM_PUSH_ENCRYPTION_TYPE_V3;
    readonly key: string;
  };
}

export interface CredentialUpgradeFcmV2AdoptionAck {
  readonly id: string;
  readonly pushEncryptionType: typeof FCM_DEVICE_ENCRYPTION_TYPE;
}

export interface CredentialUpgradeFcmV3AdoptionAck {
  readonly id: string;
  readonly pushEncryptionType: typeof FCM_PUSH_ENCRYPTION_TYPE_V3;
  readonly pushEncryptionIdentity: {
    readonly serverInstallationId: string;
    readonly principalId: string;
    readonly deviceId: string;
  };
}

export type CredentialUpgradeFcmAdoptionAck =
  CredentialUpgradeFcmV2AdoptionAck | CredentialUpgradeFcmV3AdoptionAck;

interface CredentialUpgradeJournalBase {
  readonly version: typeof CREDENTIAL_UPGRADE_JOURNAL_VERSION;
  /** Exact canonical origin whose active session owns both credentials. */
  readonly origin: string;
  /** Retained only until promotion so a stale/interleaved journal cannot replace another session. */
  readonly previousCredential: string;
  /** One-time bearer which must survive process death after the dashboard stops displaying it. */
  readonly candidateCredential: string;
}

export interface CredentialUpgradeCandidateJournal extends CredentialUpgradeJournalBase {
  readonly phase: 'candidate';
}

export interface CredentialUpgradeAdoptingJournal extends CredentialUpgradeJournalBase {
  readonly phase: 'adopting';
  /**
   * Exact body persisted before the first mutating request. Recovery must replay this body even if
   * Firebase has since rotated its installation token, or the old unmanaged row could survive.
   */
  readonly registration: CredentialUpgradeFcmRegistration;
}

export interface CredentialUpgradeAdoptedJournal extends CredentialUpgradeJournalBase {
  readonly phase: 'adopted';
  readonly registration: CredentialUpgradeFcmRegistration;
  /** Exact server acknowledgement already paired with the matching active local encryption state. */
  readonly ack: CredentialUpgradeFcmAdoptionAck;
}

export interface RevokedCredentialUpgradeJournal {
  readonly version: typeof CREDENTIAL_UPGRADE_JOURNAL_VERSION;
  /** Keyless terminal marker retained by Disconnect until a fresh explicit session commits. */
  readonly phase: 'revoked';
}

export type CredentialUpgradeJournal =
  | CredentialUpgradeCandidateJournal
  | CredentialUpgradeAdoptingJournal
  | CredentialUpgradeAdoptedJournal
  | RevokedCredentialUpgradeJournal;

export type CredentialUpgradeJournalInspection =
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'valid'; readonly journal: CredentialUpgradeJournal };

export interface StoredServerCredential {
  readonly origin: string;
  readonly credential: string;
}

export type CredentialUpgradeQuarantineReason =
  | 'invalid-journal'
  | 'session-missing'
  | 'origin-mismatch'
  | 'credential-mismatch'
  | 'promotion-before-adoption';

/**
 * Pure recovery decision. It performs no vault, network, session-store, or realtime mutation.
 * Callers can therefore apply the same rule during foreground boot and a killed-app wake.
 */
export type CredentialUpgradeResolution =
  | {
      readonly kind: 'none';
      readonly session: StoredServerCredential | null;
    }
  | {
      readonly kind: 'resume-candidate';
      readonly session: StoredServerCredential;
      readonly journal: CredentialUpgradeCandidateJournal;
    }
  | {
      readonly kind: 'retry-adoption';
      readonly session: StoredServerCredential;
      readonly journal: CredentialUpgradeAdoptingJournal;
    }
  | {
      readonly kind: 'finish-promotion';
      /** Candidate is authoritative once encrypted push adoption has an exact acknowledgement. */
      readonly session: StoredServerCredential;
      readonly journal: CredentialUpgradeAdoptedJournal;
      /** False means the main credential was promoted and only journal cleanup remains. */
      readonly writeMainCredential: boolean;
    }
  | { readonly kind: 'revoked' }
  | {
      readonly kind: 'quarantined';
      readonly reason: CredentialUpgradeQuarantineReason;
    };

const INVALID_JOURNAL_MESSAGE = 'invalid credential-upgrade journal';

function invalidJournal(): Error {
  return new Error(INVALID_JOURNAL_MESSAGE);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function hasBoundedUtf8(value: string, maximumBytes: number): boolean {
  return (
    value.length > 0 && value.length <= maximumBytes && utf8Encode(value).length <= maximumBytes
  );
}

function requireCanonicalOrigin(origin: unknown): asserts origin is string {
  if (
    typeof origin !== 'string' ||
    origin.length > MAX_SERVER_ORIGIN_INPUT_LENGTH ||
    strictServerOrigin(origin) !== origin
  ) {
    throw invalidJournal();
  }
}

function requirePreviousCredential(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !hasBoundedUtf8(value, MAX_PREVIOUS_CREDENTIAL_UTF8_BYTES)) {
    throw invalidJournal();
  }
}

function requireCandidateCredential(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !isScopedDeviceCredential(value)) throw invalidJournal();
}

function requireDeviceId(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_FCM_DEVICE_ID_CHARACTERS
  ) {
    throw invalidJournal();
  }
}

function normalizeRegistration(value: unknown): CredentialUpgradeFcmRegistration {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['name', 'provider', 'token', 'pushEncryption']) ||
    typeof value.name !== 'string' ||
    value.name.length === 0 ||
    value.name.length > MAX_FCM_DEVICE_NAME_CHARACTERS ||
    value.provider !== 'fcm' ||
    typeof value.token !== 'string' ||
    value.token.length === 0 ||
    value.token.length > MAX_FCM_TOKEN_CHARACTERS ||
    !isPlainRecord(value.pushEncryption) ||
    !hasExactKeys(value.pushEncryption, ['type', 'key']) ||
    (value.pushEncryption.type !== FCM_DEVICE_ENCRYPTION_TYPE &&
      value.pushEncryption.type !== FCM_PUSH_ENCRYPTION_TYPE_V3) ||
    typeof value.pushEncryption.key !== 'string'
  ) {
    throw invalidJournal();
  }
  try {
    decodeFcmDeviceEncryptionKey(value.pushEncryption.key);
  } catch {
    throw invalidJournal();
  }

  return Object.freeze({
    name: value.name,
    provider: 'fcm' as const,
    token: value.token,
    pushEncryption: Object.freeze({
      type: value.pushEncryption.type,
      key: value.pushEncryption.key,
    }),
  });
}

function normalizeAdoptionAck(
  value: unknown,
  registration: CredentialUpgradeFcmRegistration,
  origin: string,
): CredentialUpgradeFcmAdoptionAck {
  if (
    !isPlainRecord(value) ||
    typeof value.id !== 'string' ||
    value.pushEncryptionType !== registration.pushEncryption.type
  ) {
    throw invalidJournal();
  }

  if (value.pushEncryptionType === FCM_DEVICE_ENCRYPTION_TYPE) {
    if (!hasExactKeys(value, ['id', 'pushEncryptionType'])) throw invalidJournal();
    requireDeviceId(value.id);
    return Object.freeze({
      id: value.id,
      pushEncryptionType: FCM_DEVICE_ENCRYPTION_TYPE,
    });
  }

  if (
    value.pushEncryptionType !== FCM_PUSH_ENCRYPTION_TYPE_V3 ||
    !hasExactKeys(value, ['id', 'pushEncryptionType', 'pushEncryptionIdentity']) ||
    !isPlainRecord(value.pushEncryptionIdentity) ||
    !hasExactKeys(value.pushEncryptionIdentity, [
      'serverInstallationId',
      'principalId',
      'deviceId',
    ]) ||
    typeof value.pushEncryptionIdentity.serverInstallationId !== 'string' ||
    typeof value.pushEncryptionIdentity.principalId !== 'string' ||
    typeof value.pushEncryptionIdentity.deviceId !== 'string' ||
    value.id !== value.pushEncryptionIdentity.deviceId
  ) {
    throw invalidJournal();
  }

  const identity = Object.freeze({
    serverInstallationId: value.pushEncryptionIdentity.serverInstallationId,
    principalId: value.pushEncryptionIdentity.principalId,
    deviceId: value.pushEncryptionIdentity.deviceId,
  });
  try {
    // Reuse the active-state validator so the journal and receive path accept the same canonical
    // UUID/key/origin contract. Its return value is deliberately not retained here.
    activeFcmDeviceEncryptionV3State(registration.pushEncryption.key, identity, origin);
  } catch {
    throw invalidJournal();
  }
  return Object.freeze({
    id: value.id,
    pushEncryptionType: FCM_PUSH_ENCRYPTION_TYPE_V3,
    pushEncryptionIdentity: identity,
  });
}

function normalizeJournal(value: unknown): CredentialUpgradeJournal {
  if (
    !isPlainRecord(value) ||
    value.version !== CREDENTIAL_UPGRADE_JOURNAL_VERSION ||
    typeof value.phase !== 'string'
  ) {
    throw invalidJournal();
  }

  if (value.phase === 'revoked') {
    if (!hasExactKeys(value, ['version', 'phase'])) throw invalidJournal();
    return Object.freeze({ version: CREDENTIAL_UPGRADE_JOURNAL_VERSION, phase: 'revoked' });
  }

  requireCanonicalOrigin(value.origin);
  requirePreviousCredential(value.previousCredential);
  requireCandidateCredential(value.candidateCredential);
  if (value.previousCredential === value.candidateCredential) throw invalidJournal();

  const base = {
    version: CREDENTIAL_UPGRADE_JOURNAL_VERSION,
    origin: value.origin,
    previousCredential: value.previousCredential,
    candidateCredential: value.candidateCredential,
  } as const;

  if (value.phase === 'candidate') {
    if (
      !hasExactKeys(value, [
        'version',
        'phase',
        'origin',
        'previousCredential',
        'candidateCredential',
      ])
    ) {
      throw invalidJournal();
    }
    return Object.freeze({ ...base, phase: 'candidate' });
  }

  if (value.phase !== 'adopting' && value.phase !== 'adopted') throw invalidJournal();
  const registration = normalizeRegistration(value.registration);
  if (value.phase === 'adopting') {
    if (
      !hasExactKeys(value, [
        'version',
        'phase',
        'origin',
        'previousCredential',
        'candidateCredential',
        'registration',
      ])
    ) {
      throw invalidJournal();
    }
    return Object.freeze({ ...base, phase: 'adopting', registration });
  }

  if (
    !hasExactKeys(value, [
      'version',
      'phase',
      'origin',
      'previousCredential',
      'candidateCredential',
      'registration',
      'ack',
    ])
  ) {
    throw invalidJournal();
  }
  const ack = normalizeAdoptionAck(value.ack, registration, value.origin);
  return Object.freeze({ ...base, phase: 'adopted', registration, ack });
}

function requirePhase<P extends CredentialUpgradeJournal['phase']>(
  journal: CredentialUpgradeJournal,
  phase: P,
): Extract<CredentialUpgradeJournal, { phase: P }> {
  const normalized = normalizeJournal(journal);
  if (normalized.phase !== phase) throw invalidJournal();
  return normalized as Extract<CredentialUpgradeJournal, { phase: P }>;
}

/** Take durable custody of the one-time bearer without performing a server mutation. */
export function createCredentialUpgradeCandidate(
  origin: string,
  previousCredential: string,
  candidateCredential: string,
): CredentialUpgradeCandidateJournal {
  return requirePhase(
    {
      version: CREDENTIAL_UPGRADE_JOURNAL_VERSION,
      phase: 'candidate',
      origin,
      previousCredential,
      candidateCredential,
    },
    'candidate',
  );
}

/** Persist this transition before the first POST so every later retry owns one exact target. */
export function beginCredentialUpgradePushAdoption(
  candidate: CredentialUpgradeCandidateJournal,
  registration: CredentialUpgradeFcmRegistration,
): CredentialUpgradeAdoptingJournal {
  const current = requirePhase(candidate, 'candidate');
  return requirePhase({ ...current, phase: 'adopting', registration }, 'adopting');
}

/** Record an exact acknowledgement only after the matching local encryption state is active. */
export function acknowledgeCredentialUpgradePushAdoption(
  adopting: CredentialUpgradeAdoptingJournal,
  ack: CredentialUpgradeFcmAdoptionAck,
): CredentialUpgradeAdoptedJournal {
  const current = requirePhase(adopting, 'adopting');
  return requirePhase({ ...current, phase: 'adopted', ack }, 'adopted');
}

export function revokedCredentialUpgradeJournal(): RevokedCredentialUpgradeJournal {
  return Object.freeze({ version: CREDENTIAL_UPGRADE_JOURNAL_VERSION, phase: 'revoked' });
}

/** Serialize only the canonical key order and exact phase shape. */
export function serializeCredentialUpgradeJournal(journal: CredentialUpgradeJournal): string {
  const serialized = JSON.stringify(normalizeJournal(journal));
  if (utf8Encode(serialized).length > MAX_CREDENTIAL_UPGRADE_JOURNAL_UTF8_BYTES) {
    throw invalidJournal();
  }
  return serialized;
}

/**
 * Inspect one SecureStore value. Present malformed/noncanonical data is distinct from absence and
 * must be quarantined rather than interpreted as permission to fall back to the shared password.
 */
export function inspectCredentialUpgradeJournal(
  stored: string | null,
): CredentialUpgradeJournalInspection {
  if (stored === null) return { kind: 'absent' };
  if (
    stored.length === 0 ||
    stored.length > MAX_CREDENTIAL_UPGRADE_JOURNAL_UTF8_BYTES ||
    utf8Encode(stored).length > MAX_CREDENTIAL_UPGRADE_JOURNAL_UTF8_BYTES
  ) {
    return { kind: 'invalid' };
  }

  try {
    const journal = normalizeJournal(JSON.parse(stored));
    // The app is the sole writer. Exact canonical bytes reject duplicate keys, alternate escapes,
    // whitespace, and field-order variants instead of assigning several encodings one meaning.
    if (JSON.stringify(journal) !== stored) return { kind: 'invalid' };
    return { kind: 'valid', journal };
  } catch {
    return { kind: 'invalid' };
  }
}

/** Resolve every durable crash boundary without changing either stored value. */
export function resolveCredentialUpgrade(
  storedJournal: string | null,
  storedSession: StoredServerCredential | null,
): CredentialUpgradeResolution {
  const inspected = inspectCredentialUpgradeJournal(storedJournal);
  const sessionSnapshot = storedSession
    ? Object.freeze({ origin: storedSession.origin, credential: storedSession.credential })
    : null;
  if (inspected.kind === 'absent') return { kind: 'none', session: sessionSnapshot };
  if (inspected.kind === 'invalid') {
    return { kind: 'quarantined', reason: 'invalid-journal' };
  }

  const { journal } = inspected;
  if (journal.phase === 'revoked') return { kind: 'revoked' };
  if (!sessionSnapshot) return { kind: 'quarantined', reason: 'session-missing' };
  if (sessionSnapshot.origin !== journal.origin) {
    return { kind: 'quarantined', reason: 'origin-mismatch' };
  }

  if (journal.phase === 'adopted') {
    if (
      sessionSnapshot.credential !== journal.previousCredential &&
      sessionSnapshot.credential !== journal.candidateCredential
    ) {
      return { kind: 'quarantined', reason: 'credential-mismatch' };
    }
    return {
      kind: 'finish-promotion',
      session: Object.freeze({
        origin: journal.origin,
        credential: journal.candidateCredential,
      }),
      journal,
      writeMainCredential: sessionSnapshot.credential === journal.previousCredential,
    };
  }

  if (sessionSnapshot.credential === journal.candidateCredential) {
    return { kind: 'quarantined', reason: 'promotion-before-adoption' };
  }
  if (sessionSnapshot.credential !== journal.previousCredential) {
    return { kind: 'quarantined', reason: 'credential-mismatch' };
  }
  if (journal.phase === 'candidate') {
    return { kind: 'resume-candidate', session: sessionSnapshot, journal };
  }
  return { kind: 'retry-adoption', session: sessionSnapshot, journal };
}
