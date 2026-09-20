import { registerDevice } from '@core/api/endpoints/fcm';
import type { HttpClient } from '@core/api/http';
import { FCM_DEVICE_ENCRYPTION_TYPE, FCM_PUSH_ENCRYPTION_TYPE_V3 } from '@core/realtime';

const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

describe('fcmApi.registerDevice', () => {
  it('POSTs /devices with the Gator discriminated-union body (provider=fcm, token)', async () => {
    const post = jest.fn((..._a: unknown[]) => Promise.resolve({ id: 'dev-1' }));
    const http = { post } as unknown as HttpClient;
    const res = await registerDevice(http, 'My Phone', 'fcm-token-123');
    expect(post).toHaveBeenCalledWith('/devices', expect.anything(), {
      captureErrorDetail: true,
      json: { name: 'My Phone', provider: 'fcm', token: 'fcm-token-123' },
    });
    expect(res).toEqual({
      id: 'dev-1',
      pushEncryptionType: null,
      pushEncryptionIdentity: null,
    });
  });

  it('tolerates a server that omits the new device id', async () => {
    const post = jest.fn((..._a: unknown[]) => Promise.resolve({}));
    const http = { post } as unknown as HttpClient;
    expect(await registerDevice(http, 'My Phone', 'tok')).toEqual({
      id: null,
      pushEncryptionType: null,
      pushEncryptionIdentity: null,
    });
  });

  it('sends the exact V2 key extension and returns the server acknowledgement', async () => {
    const post = jest.fn((..._a: unknown[]) =>
      Promise.resolve({ id: 'dev-v2', pushEncryptionType: FCM_DEVICE_ENCRYPTION_TYPE }),
    );
    const http = { post } as unknown as HttpClient;

    await expect(
      registerDevice(http, 'My Phone', 'tok-v2', {
        type: FCM_DEVICE_ENCRYPTION_TYPE,
        key: KEY,
      }),
    ).resolves.toEqual({
      id: 'dev-v2',
      pushEncryptionType: FCM_DEVICE_ENCRYPTION_TYPE,
      pushEncryptionIdentity: null,
    });
    expect(post).toHaveBeenCalledWith('/devices', expect.anything(), {
      captureErrorDetail: true,
      json: {
        name: 'My Phone',
        provider: 'fcm',
        token: 'tok-v2',
        pushEncryption: { type: FCM_DEVICE_ENCRYPTION_TYPE, key: KEY },
      },
    });
  });

  it('sends and parses the exact identity-bound V3 registration extension', async () => {
    const identity = {
      serverInstallationId: '11111111-1111-4111-8111-111111111111',
      principalId: '22222222-2222-4222-8222-222222222222',
      deviceId: '33333333-3333-4333-8333-333333333333',
    } as const;
    const post = jest.fn((..._a: unknown[]) =>
      Promise.resolve({
        id: identity.deviceId,
        pushEncryptionType: FCM_PUSH_ENCRYPTION_TYPE_V3,
        pushEncryptionIdentity: identity,
      }),
    );
    const http = { post } as unknown as HttpClient;

    await expect(
      registerDevice(http, 'My Phone', 'tok-v3', {
        type: FCM_PUSH_ENCRYPTION_TYPE_V3,
        key: KEY,
      }),
    ).resolves.toEqual({
      id: identity.deviceId,
      pushEncryptionType: FCM_PUSH_ENCRYPTION_TYPE_V3,
      pushEncryptionIdentity: identity,
    });
    expect(post).toHaveBeenCalledWith('/devices', expect.anything(), {
      captureErrorDetail: true,
      json: {
        name: 'My Phone',
        provider: 'fcm',
        token: 'tok-v3',
        pushEncryption: { type: FCM_PUSH_ENCRYPTION_TYPE_V3, key: KEY },
      },
    });
  });

  it('sends version-bound V3 rotation metadata and returns the exact rotation acknowledgement', async () => {
    const identity = {
      serverInstallationId: '11111111-1111-4111-8111-111111111111',
      principalId: '22222222-2222-4222-8222-222222222222',
      deviceId: '33333333-3333-4333-8333-333333333333',
    } as const;
    const rotationId = '44444444-4444-4444-8444-444444444444';
    const previousKeyExpiresAt = 1_700_086_700_000;
    const post = jest.fn((..._a: unknown[]) =>
      Promise.resolve({
        id: identity.deviceId,
        pushEncryptionType: FCM_PUSH_ENCRYPTION_TYPE_V3,
        pushEncryptionIdentity: identity,
        pushEncryptionKeyVersion: 2,
        pushEncryptionRotationId: rotationId,
        pushEncryptionPreviousKeyExpiresAt: previousKeyExpiresAt,
      }),
    );
    const http = { post } as unknown as HttpClient;

    await expect(
      registerDevice(http, 'My Phone', 'tok-v3', {
        type: FCM_PUSH_ENCRYPTION_TYPE_V3,
        key: KEY,
        rotation: { id: rotationId, previousKeyVersion: 1 },
      }),
    ).resolves.toEqual({
      id: identity.deviceId,
      pushEncryptionType: FCM_PUSH_ENCRYPTION_TYPE_V3,
      pushEncryptionIdentity: identity,
      pushEncryptionKeyVersion: 2,
      pushEncryptionRotationId: rotationId,
      pushEncryptionPreviousKeyExpiresAt: previousKeyExpiresAt,
    });
    expect(post).toHaveBeenCalledWith('/devices', expect.anything(), {
      captureErrorDetail: true,
      json: {
        name: 'My Phone',
        provider: 'fcm',
        token: 'tok-v3',
        pushEncryption: {
          type: FCM_PUSH_ENCRYPTION_TYPE_V3,
          key: KEY,
          rotation: { id: rotationId, previousKeyVersion: 1 },
        },
      },
    });
  });

  it('rejects a malformed V2 key before issuing a request', async () => {
    const post = jest.fn();
    const http = { post } as unknown as HttpClient;

    await expect(
      registerDevice(http, 'My Phone', 'tok-v2', {
        type: FCM_DEVICE_ENCRYPTION_TYPE,
        key: 'not-a-32-byte-key',
      }),
    ).rejects.toThrow('invalid FCM device encryption key');
    expect(post).not.toHaveBeenCalled();
  });
});
