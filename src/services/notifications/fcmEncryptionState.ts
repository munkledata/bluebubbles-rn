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
