/**
 * findmyStore: the dev-fixture short-circuit vs. the prod fetch/normalize path, and the
 * loading/refreshing/error state transitions. The endpoint module (`findMyApi`) and the
 * dev/prod switch (`isDevServer`) are mocked in-file; the REAL `@core/findmy` normalizers
 * run so the wire→view mapping is exercised end to end.
 */
import { useFindMyStore } from '@state/findmyStore';

const mockIsDevServer = jest.fn();
jest.mock('@utils/isDev', () => ({ isDevServer: () => mockIsDevServer() }));

// The store passes the shared `http` instance straight through to the (mocked) endpoint fns,
// so a bare object is enough — findMyApi never really touches it here.
jest.mock('@/services', () => ({ http: {} }));

jest.mock('@core/api', () => ({
  findMyApi: {
    getDevices: jest.fn(),
    getFriends: jest.fn(),
    getItems: jest.fn(),
    refreshDevices: jest.fn(),
    refreshFriends: jest.fn(),
    refreshItems: jest.fn(),
  },
}));

import { findMyApi } from '@core/api';
const api = findMyApi as unknown as {
  getDevices: jest.Mock;
  getFriends: jest.Mock;
  getItems: jest.Mock;
  refreshDevices: jest.Mock;
  refreshFriends: jest.Mock;
  refreshItems: jest.Mock;
};

function resetStore() {
  useFindMyStore.setState({
    devices: [],
    friends: [],
    items: [],
    loading: false,
    refreshing: false,
    error: null,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsDevServer.mockReturnValue(false);
  resetStore();
});

describe('dev-fixture short-circuit', () => {
  it('load() fills devices/friends/items from fixtures and never hits the network', async () => {
    mockIsDevServer.mockReturnValue(true);
    await useFindMyStore.getState().load();
    const s = useFindMyStore.getState();
    expect(s.devices.length).toBeGreaterThan(0);
    expect(s.friends.length).toBeGreaterThan(0);
    expect(s.items.length).toBeGreaterThan(0);
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
    expect(api.getDevices).not.toHaveBeenCalled();
  });

  it('refresh() fills fixtures with refreshing=false and no network call', async () => {
    mockIsDevServer.mockReturnValue(true);
    await useFindMyStore.getState().refresh();
    const s = useFindMyStore.getState();
    expect(s.devices.length).toBeGreaterThan(0);
    expect(s.refreshing).toBe(false);
    expect(s.error).toBeNull();
    expect(api.refreshDevices).not.toHaveBeenCalled();
  });
});

describe('prod load()', () => {
  it('sets loading=true synchronously before the fetch resolves', () => {
    api.getDevices.mockReturnValue(new Promise(() => {})); // never resolves
    api.getFriends.mockReturnValue(new Promise(() => {}));
    api.getItems.mockReturnValue(new Promise(() => {}));
    void useFindMyStore.getState().load();
    expect(useFindMyStore.getState().loading).toBe(true);
    expect(useFindMyStore.getState().error).toBeNull();
  });

  it('normalizes the wire payloads and clears loading', async () => {
    api.getDevices.mockResolvedValue([
      { name: 'iPhone 15', coordinates: [37.3, -122.0], batteryLevel: 0.8 },
    ]);
    api.getFriends.mockResolvedValue([
      { title: 'Mom', coordinates: [37.4, -122.1], long_address: 'Home', last_updated: 123 },
    ]);
    api.getItems.mockResolvedValue([{ name: 'Keys', coordinates: [1, 2] }]);

    await useFindMyStore.getState().load();
    const s = useFindMyStore.getState();

    expect(api.getDevices).toHaveBeenCalledWith({});
    expect(s.loading).toBe(false);
    expect(s.devices[0]).toMatchObject({
      name: 'iPhone 15',
      latitude: 37.3,
      longitude: -122.0,
      batteryLevel: 0.8,
    });
    expect(s.friends[0]).toMatchObject({ name: 'Mom', address: 'Home', lastUpdated: 123 });
    expect(s.items[0]).toMatchObject({ name: 'Keys', latitude: 1, longitude: 2 });
  });

  it('sets an error message and clears loading when a fetch rejects', async () => {
    api.getDevices.mockRejectedValue(new Error('offline'));
    api.getFriends.mockResolvedValue([]);
    api.getItems.mockResolvedValue([]);

    await useFindMyStore.getState().load();
    const s = useFindMyStore.getState();
    expect(s.loading).toBe(false);
    expect(s.error).toMatch(/load Find My/i);
  });
});

describe('prod refresh()', () => {
  it('sets refreshing=true synchronously before the refresh resolves', () => {
    api.refreshDevices.mockReturnValue(new Promise(() => {}));
    api.refreshFriends.mockReturnValue(new Promise(() => {}));
    api.refreshItems.mockReturnValue(new Promise(() => {}));
    void useFindMyStore.getState().refresh();
    expect(useFindMyStore.getState().refreshing).toBe(true);
  });

  it('normalizes the refreshed payloads and clears refreshing', async () => {
    api.refreshDevices.mockResolvedValue([{ name: 'Watch', coordinates: [10, 20] }]);
    api.refreshFriends.mockResolvedValue([{ title: 'Craig', coordinates: [30, 40] }]);
    api.refreshItems.mockResolvedValue([]);

    await useFindMyStore.getState().refresh();
    const s = useFindMyStore.getState();
    expect(s.refreshing).toBe(false);
    expect(s.devices[0]).toMatchObject({ name: 'Watch', latitude: 10, longitude: 20 });
    expect(s.friends[0]).toMatchObject({ name: 'Craig' });
    expect(s.items).toEqual([]);
  });

  it('sets an error and clears refreshing when a refresh rejects', async () => {
    api.refreshDevices.mockRejectedValue(new Error('boom'));
    api.refreshFriends.mockResolvedValue([]);
    api.refreshItems.mockResolvedValue([]);

    await useFindMyStore.getState().refresh();
    const s = useFindMyStore.getState();
    expect(s.refreshing).toBe(false);
    expect(s.error).toMatch(/refresh locations/i);
  });
});
