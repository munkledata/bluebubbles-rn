import { create } from 'zustand';
import { getDatabase } from '@db/database';
import { kvGet, kvSet } from '@db/repositories';
import {
  DEFAULT_MAX_CONCURRENT_DOWNLOADS,
  MAX_CONCURRENT_DOWNLOADS_LIMIT,
  setMaxConcurrentDownloads,
} from '@/services/download/downloadService';

export const MAX_CONCURRENT_DOWNLOADS_KEY = 'downloads.maxConcurrent';
export { MAX_CONCURRENT_DOWNLOADS_LIMIT };

interface DownloadSettingsState {
  maxConcurrent: number;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setMaxConcurrent: (n: number) => Promise<void>;
}

function clamp(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_MAX_CONCURRENT_DOWNLOADS;
  return Math.max(1, Math.min(MAX_CONCURRENT_DOWNLOADS_LIMIT, Math.floor(n)));
}

/**
 * User-configurable parallel-download cap (Settings → Downloads). Persisted in `kv` and pushed
 * into the download semaphore via {@link setMaxConcurrentDownloads} on hydrate/change. Hydrate at
 * app launch alongside the other kv-backed stores (guard `getDatabase()` — it throws pre-connect).
 */
export const useDownloadSettingsStore = create<DownloadSettingsState>((set) => ({
  maxConcurrent: DEFAULT_MAX_CONCURRENT_DOWNLOADS,
  hydrated: false,
  hydrate: async () => {
    try {
      const v = await kvGet(getDatabase(), MAX_CONCURRENT_DOWNLOADS_KEY);
      const n = v == null ? DEFAULT_MAX_CONCURRENT_DOWNLOADS : clamp(Number(v));
      setMaxConcurrentDownloads(n);
      set({ maxConcurrent: n, hydrated: true });
    } catch {
      // DB not open yet (app launch before connect) — a later hydrate retries.
    }
  },
  setMaxConcurrent: async (n) => {
    const val = clamp(n);
    setMaxConcurrentDownloads(val); // apply immediately, before the persist
    set({ maxConcurrent: val });
    try {
      await kvSet(getDatabase(), MAX_CONCURRENT_DOWNLOADS_KEY, String(val));
    } catch {
      // best-effort persist; the in-memory cap still applies this session
    }
  },
}));
