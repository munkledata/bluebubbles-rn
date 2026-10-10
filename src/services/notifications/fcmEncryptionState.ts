import {
  FCM_PUSH_ENCRYPTION_TYPE_V3,
  inspectFcmDeviceEncryptionState,
  revokedFcmDeviceEncryptionState,
  serializeFcmDeviceEncryptionState,
  type FcmDeviceEncryptionState,
  type FcmDeviceEncryptionStateInspection,
} from '@core/realtime';
import type { SecureVault } from '@core/secure';

export const FCM_PUSH_ENCRYPTION_VAULT_KEY = 'fcmPushEncryptionV2' as const;

export async function readFcmDeviceEncryptionState(
  secureVault: SecureVault,
): Promise<FcmDeviceEncryptionStateInspection> {
  return inspectFcmDeviceEncryptionState(await secureVault.get(FCM_PUSH_ENCRYPTION_VAULT_KEY));
}

export async function writeFcmDeviceEncryptionState(
  secureVault: SecureVault,
  state: FcmDeviceEncryptionState,
): Promise<void> {
  await secureVault.set(FCM_PUSH_ENCRYPTION_VAULT_KEY, serializeFcmDeviceEncryptionState(state));
}

/**
 * Carry a live V3 push-key record across an approved server-address change. The record's identity
 * is the server installation (serverInstallationId), not the URL, and the rotation keeps the same
 * credential, so only `origin` changes; key, version and binding are kept. Without this the V3
 * branch has no re-enrollment path: registration throws "belongs to another server" and every push
 * fails the origin check until the user disconnects. Records for any other origin, revoked
 * tombstones and V2 records (which re-enroll on their own) are left alone. Returns whether it moved.
 */
export async function moveFcmPushKeyStateToOrigin(
  secureVault: SecureVault,
  fromOrigin: string,
  toOrigin: string,
): Promise<boolean> {
  const current = await readFcmDeviceEncryptionState(secureVault);
  if (
    current.kind !== 'valid' ||
    current.state.encryptionType !== FCM_PUSH_ENCRYPTION_TYPE_V3 ||
    current.state.status === 'revoked' ||
    current.state.origin !== fromOrigin
  ) {
    return false;
  }
  await writeFcmDeviceEncryptionState(secureVault, { ...current.state, origin: toOrigin });
  return true;
}

/**
 * Replace an old account's key with a keyless tombstone. Retaining the tombstone records that this
 * installation entered random-key push encryption, so a later reconnect cannot silently fall back
 * to an absent, unauthenticated receive state.
 * The caller must run this only after account-scoped registration/delivery work has drained;
 * otherwise a late pending/active write could resurrect the old key after this overwrite.
 */
export async function retireFcmDeviceEncryptionState(secureVault: SecureVault): Promise<void> {
  const current = await readFcmDeviceEncryptionState(secureVault);
  if (current.kind === 'absent') return;
  const encryptionType =
    current.kind === 'valid' && current.state.encryptionType === FCM_PUSH_ENCRYPTION_TYPE_V3
      ? FCM_PUSH_ENCRYPTION_TYPE_V3
      : undefined;
  await writeFcmDeviceEncryptionState(secureVault, revokedFcmDeviceEncryptionState(encryptionType));
}
