/**
 * hydrateAllStores() is the single registry behind the two launch-time hydration passes
 * (root layout pre-connect + home mount post-connect). Contract: it kicks EVERY registered
 * kv-backed store's hydrate exactly once, and it resolves without throwing even when the DB
 * isn't open yet — each store's own guarded try/catch (the documented launch-order crash
 * class) is what makes the registry safe to call blindly.
 */
import { getDatabase } from '@db/database';
import { HYDRATED_STORES, hydrateAllStores } from '@state/hydrateStores';
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
import { useRedactedModeStore } from '@state/redactedModeStore';
import { useSmartReplyStore } from '@state/smartReplyStore';
import { useSyncSettingsStore } from '@state/syncSettingsStore';
import { useThemeStore } from '@state/themeStore';

jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));
const mockGetDatabase = getDatabase as jest.Mock;

afterEach(() => {
  jest.restoreAllMocks();
});

describe('hydrateAllStores', () => {
  it('registers all five kv-backed stores', () => {
    expect(HYDRATED_STORES).toHaveLength(5);
    expect(HYDRATED_STORES).toEqual(
      expect.arrayContaining([
        useThemeStore,
        useSmartReplyStore,
        useFeatureSettingsStore,
        useSyncSettingsStore,
        useRedactedModeStore,
      ]),
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

  it('resolves without throwing when the DB is not open yet (launch before connect)', async () => {
    mockGetDatabase.mockImplementation(() => {
      throw new Error('Database not initialized');
    });
    useSmartReplyStore.setState({ enabled: true, hydrated: false });
    useRedactedModeStore.setState({ enabled: false, hydrated: false });
    useSyncSettingsStore.setState({ messagesPerChat: 0, hydrated: false });
    await expect(hydrateAllStores()).resolves.toBeUndefined();
    // The stores' own guards hold: hydrated stays false so the home-mount pass retries.
    expect(useSmartReplyStore.getState().hydrated).toBe(false);
    expect(useRedactedModeStore.getState().hydrated).toBe(false);
    expect(useSyncSettingsStore.getState().hydrated).toBe(false);
  });
});
