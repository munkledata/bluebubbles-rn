import {
  activeFcmPushKeyState,
  FCM_PUSH_ENCRYPTION_TYPE_V3,
  pendingFcmDeviceEncryptionState,
  pendingFcmPushKeyState,
  revokedFcmDeviceEncryptionState,
  serializeFcmDeviceEncryptionState,
} from '@core/realtime';
import type { SecureVault } from '@core/secure';
import {
  FCM_PUSH_ENCRYPTION_VAULT_KEY,
  moveFcmPushKeyStateToOrigin,
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

describe('moveFcmPushKeyStateToOrigin', () => {
  const MOVED_ORIGIN = 'https://moved.example';
  const BINDING = {
    serverInstallationId: '11111111-1111-4111-8111-111111111111',
    principalId: '22222222-2222-4222-8222-222222222222',
    deviceId: '33333333-3333-4333-8333-333333333333',
  } as const;

  it.each([
    ['an active V3 record', activeFcmPushKeyState(KEY, 2, BINDING, ORIGIN, 1_700_000_000_000)],
    ['a pending V3 record', pendingFcmPushKeyState(KEY, ORIGIN, 1_700_000_000_000)],
  ])('carries %s to the approved origin with its key and binding unchanged', async (_l, state) => {
    const { vault, values } = mockVault();
    values.set(FCM_PUSH_ENCRYPTION_VAULT_KEY, serializeFcmDeviceEncryptionState(state));

    await expect(moveFcmPushKeyStateToOrigin(vault, ORIGIN, MOVED_ORIGIN)).resolves.toBe(true);

    await expect(readFcmDeviceEncryptionState(vault)).resolves.toEqual({
      kind: 'valid',
      state: { ...state, origin: MOVED_ORIGIN },
    });
  });

  it.each([
    [
      'a V3 record for another origin',
      activeFcmPushKeyState(KEY, 2, BINDING, 'https://other.example', 1_700_000_000_000),
    ],
    ['a V2 record (it re-enrolls on its own)', pendingFcmDeviceEncryptionState(KEY, ORIGIN)],
    ['a revoked V3 tombstone', revokedFcmDeviceEncryptionState(FCM_PUSH_ENCRYPTION_TYPE_V3)],
  ])('leaves %s untouched', async (_label, state) => {
    const { vault, values, set } = mockVault();
    values.set(FCM_PUSH_ENCRYPTION_VAULT_KEY, serializeFcmDeviceEncryptionState(state));

    await expect(moveFcmPushKeyStateToOrigin(vault, ORIGIN, MOVED_ORIGIN)).resolves.toBe(false);

    expect(set).not.toHaveBeenCalled();
  });

  it('does nothing when no record exists', async () => {
    const { vault, set } = mockVault();

    await expect(moveFcmPushKeyStateToOrigin(vault, ORIGIN, MOVED_ORIGIN)).resolves.toBe(false);

    expect(set).not.toHaveBeenCalled();
  });
});
