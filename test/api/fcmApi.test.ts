import { registerDevice } from '@core/api/endpoints/fcm';
import type { HttpClient } from '@core/api/http';

describe('fcmApi.registerDevice', () => {
  it('POSTs /devices with the Gator discriminated-union body (provider=fcm, token)', async () => {
    const post = jest.fn((..._a: unknown[]) => Promise.resolve({ id: 'dev-1' }));
    const http = { post } as unknown as HttpClient;
    const res = await registerDevice(http, 'My Phone', 'fcm-token-123');
    expect(post).toHaveBeenCalledWith('/devices', expect.anything(), {
      json: { name: 'My Phone', provider: 'fcm', token: 'fcm-token-123' },
    });
    expect(res).toEqual({ id: 'dev-1' });
  });

  it('tolerates a server that omits the new device id', async () => {
    const post = jest.fn((..._a: unknown[]) => Promise.resolve({}));
    const http = { post } as unknown as HttpClient;
    expect(await registerDevice(http, 'My Phone', 'tok')).toEqual({ id: null });
  });
});
