import { fromBase64, toBase64 } from '@utils/bytes';
import { MAX_SERVER_ORIGIN_INPUT_LENGTH, strictServerOrigin } from '../config';

/** Exact current-server algorithm marker used in registration and FCM envelopes. */
export const FCM_DEVICE_ENCRYPTION_TYPE = 'AEAD_GCM_V2_DEVICE' as const;

export const FCM_DEVICE_ENCRYPTION_KEY_BYTES = 32;
export const FCM_DEVICE_ENCRYPTION_KEY_ENCODED_LENGTH = 43;

const STATE_VERSION = 1;
// Device ids are server-controlled and may need JSON escaping; keep parsing bounded while allowing
// every valid 2,048-character canonical origin plus the finite key/id/status fields.
const MAX_STATE_CHARACTERS = MAX_SERVER_ORIGIN_INPUT_LENGTH + 2_048;

interface FcmDeviceEncryptionKeyState {
  readonly version: typeof STATE_VERSION;
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
  readonly version: typeof STATE_VERSION;
  readonly encryptionType: typeof FCM_DEVICE_ENCRYPTION_TYPE;
  readonly status: 'revoked';
}

export type FcmDeviceEncryptionState =
  | PendingFcmDeviceEncryptionState
  | ActiveFcmDeviceEncryptionState
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
    version: STATE_VERSION,
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
    version: STATE_VERSION,
    encryptionType: FCM_DEVICE_ENCRYPTION_TYPE,
    status: 'active',
    origin,
    key,
    deviceId,
  };
}

export function revokedFcmDeviceEncryptionState(): RevokedFcmDeviceEncryptionState {
  return {
    version: STATE_VERSION,
    encryptionType: FCM_DEVICE_ENCRYPTION_TYPE,
    status: 'revoked',
  };
}

/** Serialize a state only after validating every security-relevant field. */
export function serializeFcmDeviceEncryptionState(state: FcmDeviceEncryptionState): string {
  if (state.status === 'pending') {
    return JSON.stringify(pendingFcmDeviceEncryptionState(state.key, state.origin));
  }
  if (state.status === 'active') {
    return JSON.stringify(activeFcmDeviceEncryptionState(state.key, state.deviceId, state.origin));
  }
  return JSON.stringify(revokedFcmDeviceEncryptionState());
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
  if (
    !isPlainRecord(value) ||
    value.version !== STATE_VERSION ||
    value.encryptionType !== FCM_DEVICE_ENCRYPTION_TYPE
  ) {
    return { kind: 'invalid' };
  }

  if (value.status === 'revoked') {
    if (Object.keys(value).length !== 3) return { kind: 'invalid' };
    return { kind: 'valid', state: revokedFcmDeviceEncryptionState() };
  }
  if (value.status !== 'pending' && value.status !== 'active') return { kind: 'invalid' };
  if (typeof value.key !== 'string' || typeof value.origin !== 'string') {
    return { kind: 'invalid' };
  }
  try {
    if (value.status === 'pending') {
      if (Object.keys(value).length !== 5) return { kind: 'invalid' };
      return {
        kind: 'valid',
        state: pendingFcmDeviceEncryptionState(value.key, value.origin),
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
