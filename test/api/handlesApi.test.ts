import { checkIMessageAvailability } from '@core/api/endpoints/handles';
import type { HttpClient } from '@core/api/http';

describe('handlesApi', () => {
  it('GETs the availability route with the address URL-ENCODED (+ must not become a space)', async () => {
    const get = jest.fn(() => Promise.resolve({ available: true }));
    const http = { get } as unknown as HttpClient;
    await expect(checkIMessageAvailability(http, '+15551234567')).resolves.toBe(true);
    expect(get).toHaveBeenCalledWith(
      '/handle/availability/imessage?address=%2B15551234567',
      expect.anything(),
    );
  });

  it('returns false verbatim (an SMS-only address)', async () => {
    const get = jest.fn(() => Promise.resolve({ available: false }));
    const http = { get } as unknown as HttpClient;
    await expect(checkIMessageAvailability(http, 'a@b.com')).resolves.toBe(false);
  });

  it('propagates errors for the caller to swallow (advisory probe)', async () => {
    const get = jest.fn(() => Promise.reject(new Error('helper not connected')));
    const http = { get } as unknown as HttpClient;
    await expect(checkIMessageAvailability(http, 'a@b.com')).rejects.toThrow('helper');
  });
});
