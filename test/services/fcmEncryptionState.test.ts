import { pendingFcmDeviceEncryptionState, serializeFcmDeviceEncryptionState } from '@core/realtime';
import type { SecureVault } from '@core/secure';
import {
  FCM_PUSH_ENCRYPTION_VAULT_KEY,
  readFcmDeviceEncryptionState,
  retireFcmDeviceEncryptionState,
  writeFcmDeviceEncryptionState,
} from '@/services/notifications/fcmEncryptionState';

const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const ORIGIN = 'https://gator.example';

function mockVault(): {
  readonly vault: SecureVault;
  readonly values: Map<string, string>;
  readonly get: jest.Mock;
  readonly set: jest.Mock;
  readonly remove: jest.Mock;
} {
  const values = new Map<string, string>();
  const get = jest.fn(async (key: string) => values.get(key) ?? null);
  const set = jest.fn(async (key: string, value: string) => {
    values.set(key, value);
  });
  const remove = jest.fn(async (key: string) => {
    values.delete(key);
  });
  return {
    vault: { get, set, delete: remove } as SecureVault,
    values,
    get,
    set,
    remove,
  };
}

describe('FCM device-encryption SecureStore state', () => {
  it('writes and reads the single validated crash-safe record', async () => {
    const { vault, values } = mockVault();
    const state = pendingFcmDeviceEncryptionState(KEY, ORIGIN);

    await writeFcmDeviceEncryptionState(vault, state);

    expect(values.get(FCM_PUSH_ENCRYPTION_VAULT_KEY)).toBe(
      serializeFcmDeviceEncryptionState(state),
    );
    await expect(readFcmDeviceEncryptionState(vault)).resolves.toEqual({
      kind: 'valid',
      state,
    });
  });

  it('overwrites the key with a retained keyless revoked tombstone', async () => {
    const { vault, values, set, remove } = mockVault();
    values.set(
      FCM_PUSH_ENCRYPTION_VAULT_KEY,
      serializeFcmDeviceEncryptionState(pendingFcmDeviceEncryptionState(KEY, ORIGIN)),
    );
    set.mockImplementation(async (key: string, value: string) => {
      expect(value).not.toContain(KEY);
      values.set(key, value);
    });

    await retireFcmDeviceEncryptionState(vault);

    await expect(readFcmDeviceEncryptionState(vault)).resolves.toEqual({
      kind: 'valid',
      state: {
        version: 1,
        encryptionType: 'AEAD_GCM_V2_DEVICE',
        status: 'revoked',
      },
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it('does not mark a never-migrated installation as V2 during retirement', async () => {
    const { vault, set, remove } = mockVault();

    await expect(retireFcmDeviceEncryptionState(vault)).resolves.toBeUndefined();

    expect(set).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('rejects retirement when the revoked tombstone cannot be persisted', async () => {
    const { vault, values, set, remove } = mockVault();
    values.set(
      FCM_PUSH_ENCRYPTION_VAULT_KEY,
      serializeFcmDeviceEncryptionState(pendingFcmDeviceEncryptionState(KEY, ORIGIN)),
    );
    set.mockRejectedValueOnce(new Error('SecureStore write unavailable'));

    await expect(retireFcmDeviceEncryptionState(vault)).rejects.toThrow(
      'SecureStore write unavailable',
    );
    expect(remove).not.toHaveBeenCalled();
  });
});
