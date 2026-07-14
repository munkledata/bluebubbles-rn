import {
  getDevices,
  getFriends,
  getItems,
  refreshDevices,
  refreshFriends,
  refreshItems,
} from '@core/api/endpoints/findmy';
import type { HttpClient } from '@core/api/http';

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

  it('getItems degrades to [] when the server predates /findmy/items (404)', async () => {
    const get = jest.fn((..._a: unknown[]) => Promise.reject(new Error('404')));
    const http = { get } as unknown as HttpClient;
    expect(await getItems(http)).toEqual([]);
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
