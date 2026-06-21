import { create } from 'zustand';
import { getDatabase } from '@db/database';
import { kvGet, kvSet } from '@db/repositories';

export const SMART_REPLY_KEY = 'smartReply.enabled';

interface SmartReplyState {
  enabled: boolean;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setEnabled: (value: boolean) => Promise<void>;
}

/**
 * Whether suggested-reply chips are shown above the composer. Persisted in `kv`.
 * Defaults ON (the rule engine is lightweight — no model download). Hydrate at
 * app launch alongside the theme store.
 */
export const useSmartReplyStore = create<SmartReplyState>((set) => ({
  enabled: true,
  hydrated: false,
  hydrate: async () => {
    try {
      const v = await kvGet(getDatabase(), SMART_REPLY_KEY);
      set({ enabled: v == null ? true : v === '1', hydrated: true });
    } catch {
      // DB not initialized yet (called at app launch before connect) — a later
      // call once the DB is open (home mount) retries. Leave `hydrated` false.
    }
  },
  setEnabled: async (value) => {
    set({ enabled: value }); // optimistic
    try {
      await kvSet(getDatabase(), SMART_REPLY_KEY, value ? '1' : '0');
    } catch {
      // best-effort persist; the in-memory toggle still applies this session
    }
  },
}));
