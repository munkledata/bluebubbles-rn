import { create } from 'zustand';
import { getDatabase } from '@db/database';
import { kvGet, kvSet } from '@db/repositories';

export const SYNC_MESSAGES_PER_CHAT_KEY = 'sync.messagesPerChat';

/** The selectable caps for the initial per-chat history sync (0 = all history). */
export const MESSAGES_PER_CHAT_OPTIONS = [0, 25, 50, 100, 250, 500] as const;

interface SyncSettingsState {
  /** Cap on messages fetched per chat during the INITIAL full sync (0 = all). Full history
   *  always backfills on demand when a chat is opened, so a cap just speeds first sync. */
  messagesPerChat: number;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setMessagesPerChat: (value: number) => Promise<void>;
}

/**
 * Initial-sync tuning (parity with the old app's "Messages to Sync Per Chat"). Persisted in `kv`;
 * defaults to 0 (all) to preserve the app's prior behavior. Read by `runSync` via `getState()`.
 */
export const useSyncSettingsStore = create<SyncSettingsState>((set) => ({
  messagesPerChat: 0,
  hydrated: false,
  hydrate: async () => {
    try {
      const v = await kvGet(getDatabase(), SYNC_MESSAGES_PER_CHAT_KEY);
      const n = v == null ? 0 : Number(v);
      set({ messagesPerChat: Number.isFinite(n) && n >= 0 ? n : 0, hydrated: true });
    } catch {
      // DB not open yet at launch — re-hydrated at home mount. Leave `hydrated` false.
    }
  },
  setMessagesPerChat: async (value) => {
    set({ messagesPerChat: value }); // optimistic
    try {
      await kvSet(getDatabase(), SYNC_MESSAGES_PER_CHAT_KEY, String(value));
    } catch {
      // best-effort persist; the in-memory value still applies this session
    }
  },
}));
