import { registerDevice } from '@core/api/endpoints/fcm';
import type { HttpClient } from '@core/api/http';
import { FCM_DEVICE_ENCRYPTION_TYPE } from '@core/realtime';

const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

describe('fcmApi.registerDevice', () => {
  it('POSTs /devices with the Gator discriminated-union body (provider=fcm, token)', async () => {
    const post = jest.fn((..._a: unknown[]) => Promise.resolve({ id: 'dev-1' }));
    const http = { post } as unknown as HttpClient;
    const res = await registerDevice(http, 'My Phone', 'fcm-token-123');
    expect(post).toHaveBeenCalledWith('/devices', expect.anything(), {
      json: { name: 'My Phone', provider: 'fcm', token: 'fcm-token-123' },
    });
    expect(res).toEqual({ id: 'dev-1', pushEncryptionType: null });
  });

  it('tolerates a server that omits the new device id', async () => {
    const post = jest.fn((..._a: unknown[]) => Promise.resolve({}));
    const http = { post } as unknown as HttpClient;
    expect(await registerDevice(http, 'My Phone', 'tok')).toEqual({
      id: null,
      pushEncryptionType: null,
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
    });
    expect(post).toHaveBeenCalledWith('/devices', expect.anything(), {
      json: {
        name: 'My Phone',
        provider: 'fcm',
        token: 'tok-v2',
        pushEncryption: { type: FCM_DEVICE_ENCRYPTION_TYPE, key: KEY },
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
