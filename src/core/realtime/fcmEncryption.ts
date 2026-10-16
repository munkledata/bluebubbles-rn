import { fromBase64, toBase64 } from '@utils/bytes';
import { MAX_SERVER_ORIGIN_INPUT_LENGTH, strictServerOrigin } from '../config';
import { FCM_PUSH_ENCRYPTION_TYPE_V3 } from './fcmPushEnvelopeIdentity';

/** Exact current-server algorithm marker used in registration and FCM envelopes. */
export const FCM_DEVICE_ENCRYPTION_TYPE = 'AEAD_GCM_V2_DEVICE' as const;

export const FCM_DEVICE_ENCRYPTION_KEY_BYTES = 32;
export const FCM_DEVICE_ENCRYPTION_KEY_ENCODED_LENGTH = 43;

const V2_STATE_VERSION = 1 as const;
const V3_STATE_VERSION = 2 as const;
const ROTATABLE_V3_STATE_VERSION = 3 as const;
export const FCM_PUSH_KEY_ROTATION_INTERVAL_MS = 30 * 24 * 60 * 60 * 1_000;
/** Local hard cap includes the server's 24h05 overlap plus five minutes of request/clock slack. */
export const FCM_PUSH_KEY_ROTATION_LOCAL_MAX_MS = 24 * 60 * 60 * 1_000 + 10 * 60 * 1_000;
const FCM_PUSH_KEY_TIMESTAMP_MAX_OFFSET_MS = Math.max(
  FCM_PUSH_KEY_ROTATION_INTERVAL_MS,
  FCM_PUSH_KEY_ROTATION_LOCAL_MAX_MS,
);
// Device ids are server-controlled and may need JSON escaping; keep parsing bounded while allowing
// every valid 2,048-character canonical origin plus the finite key/id/status fields.
const MAX_STATE_CHARACTERS = MAX_SERVER_ORIGIN_INPUT_LENGTH + 2_048;

interface FcmDeviceEncryptionKeyState {
  readonly version: typeof V2_STATE_VERSION;
  readonly encryptionType: typeof FCM_DEVICE_ENCRYPTION_TYPE;
  /** Canonical connected server origin this key was enrolled with. */
  readonly origin: string;
  readonly key: string;
}

export interface PendingFcmDeviceEncryptionState extends FcmDeviceEncryptionKeyState {
  readonly status: 'pending';
}

export interface ActiveFcmDeviceEncryptionState extends FcmDeviceEncryptionKeyState {
  readonly status: 'active';
  readonly deviceId: string;
}

export interface RevokedFcmDeviceEncryptionState {
  readonly version: typeof V2_STATE_VERSION | typeof V3_STATE_VERSION;
  readonly encryptionType: typeof FCM_DEVICE_ENCRYPTION_TYPE | typeof FCM_PUSH_ENCRYPTION_TYPE_V3;
  readonly status: 'revoked';
}

interface FcmDeviceEncryptionV3KeyState {
  readonly version: typeof V3_STATE_VERSION;
  readonly encryptionType: typeof FCM_PUSH_ENCRYPTION_TYPE_V3;
  /** Canonical connected server origin this key was enrolled with. */
  readonly origin: string;
  readonly key: string;
}

export interface PendingFcmDeviceEncryptionV3State extends FcmDeviceEncryptionV3KeyState {
  readonly status: 'pending';
}

export interface ActiveFcmDeviceEncryptionV3State extends FcmDeviceEncryptionV3KeyState {
  readonly status: 'active';
  readonly serverInstallationId: string;
  readonly principalId: string;
  readonly deviceId: string;
}

interface FcmPushKeyStateBase {
  readonly version: typeof ROTATABLE_V3_STATE_VERSION;
  readonly encryptionType: typeof FCM_PUSH_ENCRYPTION_TYPE_V3;
  readonly origin: string;
  /** Candidate/current key; during rotation this is always tried before `previousKey`. */
  readonly key: string;
}

interface FcmPushKeyBinding {
  readonly serverInstallationId: string;
  readonly principalId: string;
  readonly deviceId: string;
}

export interface PendingFcmPushKeyState extends FcmPushKeyStateBase {
  readonly status: 'pending';
  /** Persisted before POST and reused as the activation-age anchor after a lost response. */
  readonly requestedAt: number;
}

export interface RotatingFcmPushKeyState extends FcmPushKeyStateBase, FcmPushKeyBinding {
  readonly status: 'rotating';
  readonly previousKey: string;
  readonly previousKeyVersion: number;
  readonly rotationId: string;
  /** Original replacement start, retained when a bounded retry refreshes `requestedAt`. */
  readonly rotationStartedAt: number;
  /** Most recent attempt anchor; persisted before POST to bound any newly-created overlap. */
  readonly requestedAt: number;
}

export interface FcmPushPreviousKey {
  readonly key: string;
  readonly keyVersion: number;
  /** Exclusive client-side Unix-millisecond acceptance deadline. */
  readonly expiresAt: number;
}

export interface ActiveFcmPushKeyState extends FcmPushKeyStateBase, FcmPushKeyBinding {
  readonly status: 'active';
  readonly keyVersion: number;
  /** Request time for the acknowledged current key; bounds its next rotation even after a crash. */
  readonly activatedAt: number;
  readonly previous?: FcmPushPreviousKey;
}

export type FcmPushUsableKeyState =
  | PendingFcmDeviceEncryptionV3State
  | ActiveFcmDeviceEncryptionV3State
  | PendingFcmPushKeyState
  | RotatingFcmPushKeyState
  | ActiveFcmPushKeyState;

export type FcmDeviceEncryptionState =
  | PendingFcmDeviceEncryptionState
  | ActiveFcmDeviceEncryptionState
  | PendingFcmDeviceEncryptionV3State
  | ActiveFcmDeviceEncryptionV3State
  | PendingFcmPushKeyState
  | RotatingFcmPushKeyState
  | ActiveFcmPushKeyState
  | RevokedFcmDeviceEncryptionState;

export type FcmDeviceEncryptionStateInspection =
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'valid'; readonly state: FcmDeviceEncryptionState };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireOrigin(origin: string): void {
  if (strictServerOrigin(origin) !== origin) {
    throw new Error('invalid FCM device encryption origin');
  }
}

const CANONICAL_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function requireCanonicalUuid(value: string, label: string): void {
  if (!CANONICAL_UUID_V4.test(value)) throw new Error(`invalid ${label}`);
}

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid ${label}`);
}

function requireRotationTimestamp(value: number, label: string): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER - FCM_PUSH_KEY_TIMESTAMP_MAX_OFFSET_MS
  ) {
    throw new Error(`invalid ${label}`);
  }
}

function requireBinding(binding: FcmPushKeyBinding): void {
  requireCanonicalUuid(binding.serverInstallationId, 'FCM server installation id');
  requireCanonicalUuid(binding.principalId, 'FCM principal id');
  requireCanonicalUuid(binding.deviceId, 'FCM device id');
}

/** Canonical unpadded base64url encoding used by the server registration contract. */
export function encodeFcmDeviceEncryptionKey(bytes: Uint8Array): string {
  if (bytes.length !== FCM_DEVICE_ENCRYPTION_KEY_BYTES) {
    throw new Error('invalid FCM device encryption key length');
  }
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

/** Decode only the exact canonical 32-byte registration-key representation. */
export function decodeFcmDeviceEncryptionKey(encoded: string): Uint8Array {
  if (
    encoded.length !== FCM_DEVICE_ENCRYPTION_KEY_ENCODED_LENGTH ||
    !/^[A-Za-z0-9_-]{43}$/u.test(encoded)
  ) {
    throw new Error('invalid FCM device encryption key');
  }
  const decoded = fromBase64(`${encoded.replace(/-/g, '+').replace(/_/g, '/')}=`);
  if (
    decoded.length !== FCM_DEVICE_ENCRYPTION_KEY_BYTES ||
    encodeFcmDeviceEncryptionKey(decoded) !== encoded
  ) {
    throw new Error('invalid FCM device encryption key');
  }
  return decoded;
}

export function pendingFcmDeviceEncryptionState(
  key: string,
  origin: string,
): PendingFcmDeviceEncryptionState {
  decodeFcmDeviceEncryptionKey(key);
  requireOrigin(origin);
  return {
    version: V2_STATE_VERSION,
    encryptionType: FCM_DEVICE_ENCRYPTION_TYPE,
    status: 'pending',
    origin,
    key,
  };
}

export function activeFcmDeviceEncryptionState(
  key: string,
  deviceId: string,
  origin: string,
): ActiveFcmDeviceEncryptionState {
  decodeFcmDeviceEncryptionKey(key);
  requireOrigin(origin);
  if (deviceId.length === 0 || deviceId.length > 256) {
    throw new Error('invalid FCM device id');
  }
  return {
    version: V2_STATE_VERSION,
    encryptionType: FCM_DEVICE_ENCRYPTION_TYPE,
    status: 'active',
    origin,
    key,
    deviceId,
  };
}

export function pendingFcmDeviceEncryptionV3State(
  key: string,
  origin: string,
): PendingFcmDeviceEncryptionV3State {
  decodeFcmDeviceEncryptionKey(key);
  requireOrigin(origin);
  return {
    version: V3_STATE_VERSION,
    encryptionType: FCM_PUSH_ENCRYPTION_TYPE_V3,
    status: 'pending',
    origin,
    key,
  };
}

export function activeFcmDeviceEncryptionV3State(
  key: string,
  binding: {
    readonly serverInstallationId: string;
    readonly principalId: string;
    readonly deviceId: string;
  },
  origin: string,
): ActiveFcmDeviceEncryptionV3State {
  decodeFcmDeviceEncryptionKey(key);
  requireOrigin(origin);
  requireBinding(binding);
  return {
    version: V3_STATE_VERSION,
    encryptionType: FCM_PUSH_ENCRYPTION_TYPE_V3,
    status: 'active',
    origin,
    key,
    serverInstallationId: binding.serverInstallationId,
    principalId: binding.principalId,
    deviceId: binding.deviceId,
  };
}

export function pendingFcmPushKeyState(
  key: string,
  origin: string,
  requestedAt: number,
): PendingFcmPushKeyState {
  decodeFcmDeviceEncryptionKey(key);
  requireOrigin(origin);
  requireRotationTimestamp(requestedAt, 'FCM key request time');
  return {
    version: ROTATABLE_V3_STATE_VERSION,
    encryptionType: FCM_PUSH_ENCRYPTION_TYPE_V3,
    status: 'pending',
    origin,
    key,
    requestedAt,
  };
}

export function rotatingFcmPushKeyState(
  key: string,
  previousKey: string,
  previousKeyVersion: number,
  binding: FcmPushKeyBinding,
  origin: string,
  rotationId: string,
  requestedAt: number,
  rotationStartedAt = requestedAt,
): RotatingFcmPushKeyState {
  decodeFcmDeviceEncryptionKey(key);
  decodeFcmDeviceEncryptionKey(previousKey);
  if (key === previousKey) throw new Error('FCM rotation candidate must replace the previous key');
  requirePositiveInteger(previousKeyVersion, 'FCM previous key version');
  requireBinding(binding);
  requireOrigin(origin);
  requireCanonicalUuid(rotationId, 'FCM rotation id');
  requireRotationTimestamp(requestedAt, 'FCM key rotation request time');
  requireRotationTimestamp(rotationStartedAt, 'FCM key rotation start time');
  if (rotationStartedAt > requestedAt) throw new Error('invalid FCM key rotation start time');
  return {
    version: ROTATABLE_V3_STATE_VERSION,
    encryptionType: FCM_PUSH_ENCRYPTION_TYPE_V3,
    status: 'rotating',
    origin,
    key,
    serverInstallationId: binding.serverInstallationId,
    principalId: binding.principalId,
    deviceId: binding.deviceId,
    previousKey,
    previousKeyVersion,
    rotationId,
    rotationStartedAt,
    requestedAt,
  };
}

export function activeFcmPushKeyState(
  key: string,
  keyVersion: number,
  binding: FcmPushKeyBinding,
  origin: string,
  activatedAt: number,
  previous?: FcmPushPreviousKey,
): ActiveFcmPushKeyState {
  decodeFcmDeviceEncryptionKey(key);
  requirePositiveInteger(keyVersion, 'FCM key version');
  requireBinding(binding);
  requireOrigin(origin);
  requireRotationTimestamp(activatedAt, 'FCM key activation time');
  let normalizedPrevious: FcmPushPreviousKey | undefined;
  if (previous) {
    decodeFcmDeviceEncryptionKey(previous.key);
    if (previous.key === key) throw new Error('FCM previous key must differ from current key');
    requirePositiveInteger(previous.keyVersion, 'FCM previous key version');
    if (previous.keyVersion + 1 !== keyVersion) {
      throw new Error('FCM previous key version is not adjacent');
    }
    requireRotationTimestamp(previous.expiresAt, 'FCM previous key expiry');
    if (
      previous.expiresAt <= activatedAt ||
      previous.expiresAt > activatedAt + FCM_PUSH_KEY_ROTATION_LOCAL_MAX_MS
    ) {
      throw new Error('invalid FCM previous key expiry');
    }
    normalizedPrevious = Object.freeze({ ...previous });
  }
  return {
    version: ROTATABLE_V3_STATE_VERSION,
    encryptionType: FCM_PUSH_ENCRYPTION_TYPE_V3,
    status: 'active',
    origin,
    key,
    serverInstallationId: binding.serverInstallationId,
    principalId: binding.principalId,
    deviceId: binding.deviceId,
    keyVersion,
    activatedAt,
    ...(normalizedPrevious ? { previous: normalizedPrevious } : {}),
  };
}

export interface FcmPushDecryptionKeyCandidate {
  readonly key: string;
  readonly role: 'current' | 'previous';
}

/** Ordered keys for one V3 delivery; the previous key disappears at its exclusive deadline. */
export function fcmPushDecryptionKeyCandidates(
  state: FcmPushUsableKeyState,
  now: number,
): readonly FcmPushDecryptionKeyCandidate[] {
  const current = Object.freeze({ key: state.key, role: 'current' as const });
  if (state.version !== ROTATABLE_V3_STATE_VERSION || state.status === 'pending') return [current];
  if (state.status === 'rotating') {
    // Until the server acknowledges, it may never have received the new key and still encrypts
    // with the previous one, so keep accepting it, for at most one rotation interval (review M097).
    // A retry refreshes only requestedAt, so it can never move this deadline past the first
    // attempt's. Each payload also carries its own signed expiry, so old captures stay rejected.
    return now < state.rotationStartedAt + FCM_PUSH_KEY_ROTATION_INTERVAL_MS
      ? [current, Object.freeze({ key: state.previousKey, role: 'previous' as const })]
      : [current];
  }
  return state.previous && now < state.previous.expiresAt
    ? [current, Object.freeze({ key: state.previous.key, role: 'previous' as const })]
    : [current];
}

/** Legacy active V3 rotates immediately; versioned active V3 rotates no later than 30 days. */
export function fcmPushKeyRotationDue(
  state: ActiveFcmDeviceEncryptionV3State | ActiveFcmPushKeyState,
  now: number,
): boolean {
  return (
    state.version === V3_STATE_VERSION ||
    now >= state.activatedAt + FCM_PUSH_KEY_ROTATION_INTERVAL_MS
  );
}

export function revokedFcmDeviceEncryptionState(
  encryptionType:
    | typeof FCM_DEVICE_ENCRYPTION_TYPE
    | typeof FCM_PUSH_ENCRYPTION_TYPE_V3 = FCM_DEVICE_ENCRYPTION_TYPE,
): RevokedFcmDeviceEncryptionState {
  return {
    version: encryptionType === FCM_PUSH_ENCRYPTION_TYPE_V3 ? V3_STATE_VERSION : V2_STATE_VERSION,
    encryptionType,
    status: 'revoked',
  };
}

/** Serialize a state only after validating every security-relevant field. */
export function serializeFcmDeviceEncryptionState(state: FcmDeviceEncryptionState): string {
  if (state.version === ROTATABLE_V3_STATE_VERSION) {
    if (state.status === 'pending') {
      return JSON.stringify(pendingFcmPushKeyState(state.key, state.origin, state.requestedAt));
    }
    if (state.status === 'rotating') {
      return JSON.stringify(
        rotatingFcmPushKeyState(
          state.key,
          state.previousKey,
          state.previousKeyVersion,
          state,
          state.origin,
          state.rotationId,
          state.requestedAt,
          state.rotationStartedAt,
        ),
      );
    }
    return JSON.stringify(
      activeFcmPushKeyState(
        state.key,
        state.keyVersion,
        state,
        state.origin,
        state.activatedAt,
        state.previous,
      ),
    );
  }
  if (state.encryptionType === FCM_PUSH_ENCRYPTION_TYPE_V3) {
    if (state.status === 'pending') {
      return JSON.stringify(pendingFcmDeviceEncryptionV3State(state.key, state.origin));
    }
    if (state.status === 'active') {
      return JSON.stringify(
        activeFcmDeviceEncryptionV3State(
          state.key,
          {
            serverInstallationId: state.serverInstallationId,
            principalId: state.principalId,
            deviceId: state.deviceId,
          },
          state.origin,
        ),
      );
    }
    return JSON.stringify(revokedFcmDeviceEncryptionState(FCM_PUSH_ENCRYPTION_TYPE_V3));
  }
  if (state.status === 'pending') {
    return JSON.stringify(pendingFcmDeviceEncryptionState(state.key, state.origin));
  }
  if (state.status === 'active') {
    return JSON.stringify(activeFcmDeviceEncryptionState(state.key, state.deviceId, state.origin));
  }
  return JSON.stringify(revokedFcmDeviceEncryptionState(FCM_DEVICE_ENCRYPTION_TYPE));
}

/**
 * Inspect the one crash-safe SecureStore value. Any present but malformed value is distinct from
 * absence so callers reject a legacy downgrade instead of treating corruption as pre-migration.
 */
export function inspectFcmDeviceEncryptionState(
  stored: string | null,
): FcmDeviceEncryptionStateInspection {
  if (stored === null) return { kind: 'absent' };
  if (stored.length === 0 || stored.length > MAX_STATE_CHARACTERS) return { kind: 'invalid' };

  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    return { kind: 'invalid' };
  }
  if (!isPlainRecord(value)) {
    return { kind: 'invalid' };
  }

  const isV2 =
    value.version === V2_STATE_VERSION && value.encryptionType === FCM_DEVICE_ENCRYPTION_TYPE;
  const isV3 =
    value.version === V3_STATE_VERSION && value.encryptionType === FCM_PUSH_ENCRYPTION_TYPE_V3;
  const isRotatableV3 =
    value.version === ROTATABLE_V3_STATE_VERSION &&
    value.encryptionType === FCM_PUSH_ENCRYPTION_TYPE_V3;
  if (!isV2 && !isV3 && !isRotatableV3) return { kind: 'invalid' };

  if (value.status === 'revoked') {
    if (isRotatableV3 || Object.keys(value).length !== 3) return { kind: 'invalid' };
    return {
      kind: 'valid',
      state: revokedFcmDeviceEncryptionState(
        isV3 ? FCM_PUSH_ENCRYPTION_TYPE_V3 : FCM_DEVICE_ENCRYPTION_TYPE,
      ),
    };
  }
  if (
    value.status !== 'pending' &&
    value.status !== 'active' &&
    !(isRotatableV3 && value.status === 'rotating')
  ) {
    return { kind: 'invalid' };
  }
  if (typeof value.key !== 'string' || typeof value.origin !== 'string') {
    return { kind: 'invalid' };
  }
  try {
    if (isRotatableV3) {
      if (value.status === 'pending') {
        if (Object.keys(value).length !== 6 || typeof value.requestedAt !== 'number') {
          return { kind: 'invalid' };
        }
        return {
          kind: 'valid',
          state: pendingFcmPushKeyState(value.key, value.origin, value.requestedAt),
        };
      }
      if (
        typeof value.serverInstallationId !== 'string' ||
        typeof value.principalId !== 'string' ||
        typeof value.deviceId !== 'string'
      ) {
        return { kind: 'invalid' };
      }
      const binding = {
        serverInstallationId: value.serverInstallationId,
        principalId: value.principalId,
        deviceId: value.deviceId,
      };
      if (value.status === 'rotating') {
        if (
          Object.keys(value).length !== 13 ||
          typeof value.previousKey !== 'string' ||
          typeof value.previousKeyVersion !== 'number' ||
          typeof value.rotationId !== 'string' ||
          typeof value.rotationStartedAt !== 'number' ||
          typeof value.requestedAt !== 'number'
        ) {
          return { kind: 'invalid' };
        }
        return {
          kind: 'valid',
          state: rotatingFcmPushKeyState(
            value.key,
            value.previousKey,
            value.previousKeyVersion,
            binding,
            value.origin,
            value.rotationId,
            value.requestedAt,
            value.rotationStartedAt,
          ),
        };
      }
      if (
        value.status !== 'active' ||
        (Object.keys(value).length !== 10 && Object.keys(value).length !== 11) ||
        typeof value.keyVersion !== 'number' ||
        typeof value.activatedAt !== 'number'
      ) {
        return { kind: 'invalid' };
      }
      let previous: FcmPushPreviousKey | undefined;
      if ('previous' in value) {
        if (
          !isPlainRecord(value.previous) ||
          Object.keys(value.previous).length !== 3 ||
          typeof value.previous.key !== 'string' ||
          typeof value.previous.keyVersion !== 'number' ||
          typeof value.previous.expiresAt !== 'number'
        ) {
          return { kind: 'invalid' };
        }
        previous = {
          key: value.previous.key,
          keyVersion: value.previous.keyVersion,
          expiresAt: value.previous.expiresAt,
        };
      }
      return {
        kind: 'valid',
        state: activeFcmPushKeyState(
          value.key,
          value.keyVersion,
          binding,
          value.origin,
          value.activatedAt,
          previous,
        ),
      };
    }
    if (value.status === 'pending') {
      if (Object.keys(value).length !== 5) return { kind: 'invalid' };
      return {
        kind: 'valid',
        state: isV3
          ? pendingFcmDeviceEncryptionV3State(value.key, value.origin)
          : pendingFcmDeviceEncryptionState(value.key, value.origin),
      };
    }
    if (isV3) {
      if (
        Object.keys(value).length !== 8 ||
        typeof value.serverInstallationId !== 'string' ||
        typeof value.principalId !== 'string' ||
        typeof value.deviceId !== 'string'
      ) {
        return { kind: 'invalid' };
      }
      return {
        kind: 'valid',
        state: activeFcmDeviceEncryptionV3State(
          value.key,
          {
            serverInstallationId: value.serverInstallationId,
            principalId: value.principalId,
            deviceId: value.deviceId,
          },
          value.origin,
        ),
      };
    }
    if (Object.keys(value).length !== 6 || typeof value.deviceId !== 'string') {
      return { kind: 'invalid' };
    }
    return {
      kind: 'valid',
      state: activeFcmDeviceEncryptionState(value.key, value.deviceId, value.origin),
    };
  } catch {
    return { kind: 'invalid' };
  }
}
