import { registerDevice } from '@core/api/endpoints/fcm';
import type { HttpClient } from '@core/api/http';

describe('fcmApi.registerDevice', () => {
  it('POSTs /fcm/device with the device name + FCM token', async () => {
    const post = jest.fn((..._a: unknown[]) => Promise.resolve({}));
    const http = { post } as unknown as HttpClient;
    await registerDevice(http, 'My Phone', 'fcm-token-123');
    expect(post).toHaveBeenCalledWith('/fcm/device', expect.anything(), {
      json: { name: 'My Phone', identifier: 'fcm-token-123' },
    });
  });
});
