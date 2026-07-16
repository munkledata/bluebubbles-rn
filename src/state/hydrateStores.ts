import { useFeatureSettingsStore } from '@state/featureSettingsStore';
import { useRedactedModeStore } from '@state/redactedModeStore';
import { useSmartReplyStore } from '@state/smartReplyStore';
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
  useSmartReplyStore,
  useFeatureSettingsStore,
  useSyncSettingsStore,
  useRedactedModeStore,
] as const;

/** Kick every registered store's guarded hydrate; resolves once all have finished. */
export async function hydrateAllStores(): Promise<void> {
  await Promise.all(HYDRATED_STORES.map((store) => store.getState().hydrate()));
}
