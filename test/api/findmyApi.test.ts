import { ApiError } from '@core/api/errors';
import { logger } from '@core/secure';
import {
  getDevices,
  getFriends,
  getItems,
  refreshDevices,
  refreshFriends,
  refreshItems,
} from '@core/api/endpoints/findmy';
import type { HttpClient } from '@core/api/http';

/** The exact ApiError HttpClient.parseResponse would raise for a given HTTP status. */
const httpFailure = (status: number): ApiError =>
  ApiError.fromStatus(status, `GET /findmy/items failed`);

describe('findmyApi list endpoints', () => {
  it('getDevices GETs /findmy/devices and unwraps the named-key object', async () => {
    const get = jest.fn((..._a: unknown[]) => Promise.resolve({ devices: [{ id: 'd1' }] }));
    const http = { get } as unknown as HttpClient;
    expect(await getDevices(http)).toEqual([{ id: 'd1' }]);
    expect(get).toHaveBeenCalledWith('/findmy/devices', expect.anything());
  });

  it('getFriends tolerates a missing friends key', async () => {
    const get = jest.fn((..._a: unknown[]) => Promise.resolve({ friends: null }));
    const http = { get } as unknown as HttpClient;
    expect(await getFriends(http)).toEqual([]);
  });

  /**
   * `getItems` degrades to [] on ANY failure — deliberately, because findmyStore awaits
   * devices+friends+items in one Promise.all and a throw here would blank the WHOLE Find My
   * screen. The price is that "this server predates /findmy/items" and "your password is wrong"
   * look identical to the caller, so the ONLY thing separating them is the `status !== 404` warn
   * log. These tests pin BOTH halves of that discrimination: the expected 404 must stay quiet,
   * and anything else must be diagnosable.
   *
   * Pinned residual gap (see the returned findings): even with the log, a 401/500 still shows the
   * user an empty Items tab with no error state.
   */
  describe('getItems failure discrimination', () => {
    let warn: jest.SpyInstance;
    beforeEach(() => {
      warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    });

    it('degrades to [] SILENTLY on a real 404 — the expected "server predates /findmy/items"', async () => {
      // A genuine route-absent 404, exactly as HttpClient.parseResponse raises it — NOT a generic
      // Error('404') whose message nothing inspects.
      const get = jest.fn((..._a: unknown[]) => Promise.reject(httpFailure(404)));
      const http = { get } as unknown as HttpClient;
      expect(await getItems(http)).toEqual([]);
      expect(get).toHaveBeenCalledWith('/findmy/items', expect.anything());
      // An old server is normal operation: it must not spam the log on every Find My refresh.
      expect(warn).not.toHaveBeenCalled();
    });

    it.each([
      ['401 unauthorized (wrong password)', 401],
      ['500 server error (helper crashed)', 500],
    ])(
      'still returns [] for a %s but LOGS it — an old server and a real failure are not the same thing',
      async (_label, status) => {
        const get = jest.fn((..._a: unknown[]) => Promise.reject(httpFailure(status)));
        const http = { get } as unknown as HttpClient;
        expect(await getItems(http)).toEqual([]);
        expect(warn).toHaveBeenCalledTimes(1);
        const line = String(warn.mock.calls[0]?.[0] ?? '');
        expect(line).toContain('/findmy/items');
        // The status must be IN the line, else the log can't tell 401 from 500 either.
        expect(line).toContain(String(status));
      },
    );

    it('logs a schema/parse failure too (a malformed payload is not an old server)', async () => {
      const get = jest.fn((..._a: unknown[]) =>
        Promise.reject(new ApiError('parse_error', 'Response did not match schema', 200)),
      );
      const http = { get } as unknown as HttpClient;
      expect(await getItems(http)).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('logs a non-ApiError throw (no status at all) rather than treating it as an old server', async () => {
      const get = jest.fn((..._a: unknown[]) => Promise.reject(new Error('boom')));
      const http = { get } as unknown as HttpClient;
      expect(await getItems(http)).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0] ?? '')).toContain('boom');
    });
  });

  it('by contrast getDevices does NOT swallow — a 401 propagates so the UI can show an error', async () => {
    // The sibling endpoint has no try/catch at all; this proves the getItems swallow is a property
    // of getItems, not an artifact of the fake HttpClient used here.
    const get = jest.fn((..._a: unknown[]) => Promise.reject(httpFailure(401)));
    const http = { get } as unknown as HttpClient;
    await expect(getDevices(http)).rejects.toMatchObject({ kind: 'unauthorized', status: 401 });
  });
});

describe('findmyApi refresh endpoints', () => {
  it('refreshDevices only GETs (no /findmy/devices/refresh route exists — POSTing would 404)', async () => {
    const get = jest.fn((..._a: unknown[]) => Promise.resolve({ devices: [{ id: 'd1' }] }));
    const post = jest.fn();
    const http = { get, post } as unknown as HttpClient;
    expect(await refreshDevices(http)).toEqual([{ id: 'd1' }]);
    expect(post).not.toHaveBeenCalled();
  });

  it('refreshItems likewise only GETs', async () => {
    const get = jest.fn((..._a: unknown[]) => Promise.resolve({ items: [{ id: 'i1' }] }));
    const post = jest.fn();
    const http = { get, post } as unknown as HttpClient;
    expect(await refreshItems(http)).toEqual([{ id: 'i1' }]);
    expect(post).not.toHaveBeenCalled();
  });

  it('refreshFriends returns the refresh result when it has friends', async () => {
    const post = jest.fn((..._a: unknown[]) => Promise.resolve({ friends: [{ id: 'f1' }] }));
    const get = jest.fn();
    const http = { get, post } as unknown as HttpClient;
    expect(await refreshFriends(http)).toEqual([{ id: 'f1' }]);
    expect(post).toHaveBeenCalledWith('/findmy/friends/refresh', expect.anything(), { json: {} });
    expect(get).not.toHaveBeenCalled();
  });

  it('refreshFriends falls back to a plain GET when the refresh comes back empty', async () => {
    const post = jest.fn((..._a: unknown[]) => Promise.resolve({ friends: [] }));
    const get = jest.fn((..._a: unknown[]) => Promise.resolve({ friends: [{ id: 'f2' }] }));
    const http = { get, post } as unknown as HttpClient;
    expect(await refreshFriends(http)).toEqual([{ id: 'f2' }]);
    expect(get).toHaveBeenCalledWith('/findmy/friends', expect.anything());
  });
});
