import { useFeatureSettingsStore } from '@state/featureSettingsStore';
import { canCommitHydration, type HydrationOptions } from '@state/hydration';
import { useSyncSettingsStore } from '@state/syncSettingsStore';
import { useThemeStore } from '@state/themeStore';

/**
 * The kv-backed zustand stores hydrated at app launch. Each store's own `hydrate()` guards
 * `getDatabase()` in a try/catch (the DB isn't open yet on the root layout's pre-connect pass —
 * see AGENTS.md), so calling the whole registry is always safe; the home-mount re-run picks up
 * whatever the first pass skipped. Add new kv-hydrated stores HERE, not to the call sites.
 */
export const HYDRATED_STORES = [
  useThemeStore,
  useFeatureSettingsStore,
  useSyncSettingsStore,
] as const;

/**
 * Did every setting that controls data/realtime behavior load successfully?
 *
 * Theme is intentionally excluded: its hydrate catches an unavailable pre-DB read and opens the
 * first-paint gate with the safe dark default so setup can never become a blank screen.
 */
export function areCriticalSettingsHydrated(): boolean {
  return useFeatureSettingsStore.getState().hydrated && useSyncSettingsStore.getState().hydrated;
}

/** Kick every registered store's guarded hydrate; resolves once all have finished. */
export async function hydrateAllStores(options?: HydrationOptions): Promise<void> {
  if (!canCommitHydration(options)) return;
  await Promise.all(HYDRATED_STORES.map((store) => store.getState().hydrate(options)));
}
