/**
 * hydrateAllStores() is the single registry behind the two launch-time hydration passes
 * (root layout pre-connect + home mount post-connect). Contract: it kicks EVERY registered
 * kv-backed store's hydrate exactly once, and it resolves without throwing even when the DB
 * isn't open yet — each store's own guarded try/catch (the documented launch-order crash
 * class) is what makes the registry safe to call blindly.
 */
import { getDatabase } from '@db/database';
import {
  HYDRATED_STORES,
  areCriticalSettingsHydrated,
  hydrateAllStores,
} from '@state/hydrateStores';
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
import { useSyncSettingsStore } from '@state/syncSettingsStore';
import { useThemeStore } from '@state/themeStore';
import { DEFAULT_PRESET } from '@ui/theme/tokens';

jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));
const mockGetDatabase = getDatabase as jest.Mock;

beforeEach(() => {
  useThemeStore.setState({
    preset: DEFAULT_PRESET,
    customThemeId: null,
    customTokens: null,
    hydrated: false,
  });
  useFeatureSettingsStore.setState({ hydrated: false });
  useSyncSettingsStore.setState({ hydrated: false });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('hydrateAllStores', () => {
  it('registers the three kv-backed stores', () => {
    expect(HYDRATED_STORES).toHaveLength(3);
    expect(HYDRATED_STORES).toEqual(
      expect.arrayContaining([useThemeStore, useFeatureSettingsStore, useSyncSettingsStore]),
    );
  });

  it('calls every registered store hydrate exactly once', async () => {
    const spies = HYDRATED_STORES.map((s) =>
      jest.spyOn(s.getState(), 'hydrate').mockResolvedValue(undefined),
    );
    await hydrateAllStores();
    for (const spy of spies) {
      expect(spy).toHaveBeenCalledTimes(1);
    }
  });

  it('forwards one shared ownership guard to every registered store', async () => {
    const options = { shouldCommit: jest.fn(() => true), onError: jest.fn() };
    const spies = HYDRATED_STORES.map((s) =>
      jest.spyOn(s.getState(), 'hydrate').mockResolvedValue(undefined),
    );

    await hydrateAllStores(options);

    for (const spy of spies) expect(spy).toHaveBeenCalledWith(options);
  });

  it('does not start any store read when ownership is already revoked', async () => {
    const options = { shouldCommit: jest.fn(() => false), onError: jest.fn() };
    const spies = HYDRATED_STORES.map((s) =>
      jest.spyOn(s.getState(), 'hydrate').mockResolvedValue(undefined),
    );

    await hydrateAllStores(options);

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(options.onError).not.toHaveBeenCalled();
  });

  it('propagates an unexpected registered-store rejection after starting every registration', async () => {
    const sentinel = new Error('UNEXPECTED_REGISTERED_HYDRATE_FAILURE');
    const options = { shouldCommit: jest.fn(() => true), onError: jest.fn() };
    const spies = HYDRATED_STORES.map((store) =>
      jest.spyOn(store.getState(), 'hydrate').mockResolvedValue(undefined),
    );
    spies[1]!.mockRejectedValueOnce(sentinel);

    await expect(hydrateAllStores(options)).rejects.toBe(sentinel);

    for (const spy of spies) {
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(options);
    }
  });

  it('requires Feature and Sync hydration but not Theme fallback hydration', () => {
    useThemeStore.setState({ hydrated: false });
    useFeatureSettingsStore.setState({ hydrated: true });
    useSyncSettingsStore.setState({ hydrated: true });
    expect(areCriticalSettingsHydrated()).toBe(true);

    useFeatureSettingsStore.setState({ hydrated: false });
    expect(areCriticalSettingsHydrated()).toBe(false);
    useFeatureSettingsStore.setState({ hydrated: true });

    useSyncSettingsStore.setState({ hydrated: false });
    expect(areCriticalSettingsHydrated()).toBe(false);
  });

  it('resolves without throwing when the DB is not open yet (launch before connect)', async () => {
    mockGetDatabase.mockImplementation(() => {
      throw new Error('Database not initialized');
    });
    useFeatureSettingsStore.setState({ hydrated: false });
    useSyncSettingsStore.setState({ messagesPerChat: 0, hydrated: false });
    await expect(hydrateAllStores()).resolves.toBeUndefined();
    // Theme opens the first-paint gate on its safe default; critical stores stay false so the
    // home-mount pass retries after the encrypted DB is available.
    expect(useThemeStore.getState()).toEqual(
      expect.objectContaining({ preset: DEFAULT_PRESET, hydrated: true }),
    );
    expect(useFeatureSettingsStore.getState().hydrated).toBe(false);
    expect(useSyncSettingsStore.getState().hydrated).toBe(false);
  });
});
