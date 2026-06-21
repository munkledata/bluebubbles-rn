import { create } from 'zustand';
import { findMyApi } from '@core/api';
import {
  normalizeDevice,
  normalizeFriend,
  type FindMyDevice,
  type FindMyFriend,
} from '@core/findmy';
import { http } from '@/services';
import { isDevServer } from '@utils/isDev';

// DEV fixtures so the screen renders without a real iCloud-connected server.
const FIXTURE_DEVICES: FindMyDevice[] = [
  {
    id: 'd1',
    name: 'iPhone 15 Pro',
    batteryLevel: 0.82,
    latitude: 37.3349,
    longitude: -122.009,
    address: 'Apple Park, Cupertino',
  },
  {
    id: 'd2',
    name: 'MacBook Pro',
    batteryLevel: 0.41,
    latitude: 37.7749,
    longitude: -122.4194,
    address: 'San Francisco, CA',
  },
  {
    id: 'd3',
    name: 'AirPods Pro',
    batteryLevel: 0.6,
    latitude: 37.3349,
    longitude: -122.009,
    address: 'Apple Park, Cupertino',
  },
  {
    id: 'd4',
    name: 'Apple Watch',
    batteryLevel: null,
    latitude: null,
    longitude: null,
    address: null,
  },
];
const FIXTURE_FRIENDS: FindMyFriend[] = [
  {
    id: 'f1',
    name: 'Mom',
    address: 'Home — Palo Alto, CA',
    latitude: 37.4419,
    longitude: -122.143,
    lastUpdated: 1718900000000,
  },
  {
    id: 'f2',
    name: 'Craig',
    address: 'Infinite Loop, Cupertino',
    latitude: 37.3318,
    longitude: -122.0312,
    lastUpdated: 1718899000000,
  },
  {
    id: 'f3',
    name: 'Tim',
    address: 'Locating…',
    latitude: null,
    longitude: null,
    lastUpdated: null,
  },
];

interface FindMyState {
  devices: FindMyDevice[];
  friends: FindMyFriend[];
  loading: boolean;
  /** A server-side location refresh (the POST /refresh endpoints) is in flight. */
  refreshing: boolean;
  error: string | null;
  /** Initial load — GETs the last-known devices/friends. */
  load: () => Promise<void>;
  /** Force the server to re-poll iCloud for fresh locations, then merge the result. */
  refresh: () => Promise<void>;
}

const isDev = isDevServer;

/** Find My devices + friends. Dev session uses fixtures; prod fetches the server. */
export const useFindMyStore = create<FindMyState>((set) => ({
  devices: [],
  friends: [],
  loading: false,
  refreshing: false,
  error: null,
  load: async () => {
    if (isDev()) {
      set({ devices: FIXTURE_DEVICES, friends: FIXTURE_FRIENDS, loading: false, error: null });
      return;
    }
    set({ loading: true, error: null });
    try {
      const [devRaw, friRaw] = await Promise.all([
        findMyApi.getDevices(http),
        findMyApi.getFriends(http),
      ]);
      set({
        devices: devRaw.map(normalizeDevice),
        friends: friRaw.map(normalizeFriend),
        loading: false,
      });
    } catch {
      set({ loading: false, error: 'Couldn’t load Find My. Check your server connection.' });
    }
  },
  refresh: async () => {
    if (isDev()) {
      set({ devices: FIXTURE_DEVICES, friends: FIXTURE_FRIENDS, refreshing: false, error: null });
      return;
    }
    set({ refreshing: true, error: null });
    try {
      // POST /refresh asks the server to re-poll iCloud (falls back to a GET if the
      // server returns nothing); this is what actually updates stale locations.
      const [devRaw, friRaw] = await Promise.all([
        findMyApi.refreshDevices(http),
        findMyApi.refreshFriends(http),
      ]);
      set({
        devices: devRaw.map(normalizeDevice),
        friends: friRaw.map(normalizeFriend),
        refreshing: false,
      });
    } catch {
      set({
        refreshing: false,
        error: 'Couldn’t refresh locations. Check your server connection.',
      });
    }
  },
}));
