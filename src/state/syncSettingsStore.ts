import { create } from 'zustand';
import { getDatabase } from '@db/database';
import { kvGet, kvSetWithinTransaction } from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import { canCommitHydration, reportHydrationError, type HydrationOptions } from '@state/hydration';

export const SYNC_MESSAGES_PER_CHAT_KEY = 'sync.messagesPerChat';

/** Initial per-chat sync caps in stepper order, smallest first; 0 = all history, so it is last. */
export const MESSAGES_PER_CHAT_OPTIONS = [25, 50, 100, 250, 500, 0] as const;

interface SyncSettingsState {
  /** Cap on messages fetched per chat during the INITIAL full sync (0 = all). Full history
   *  always backfills on demand when a chat is opened, so a cap just speeds first sync. */
  messagesPerChat: number;
  /**
   * True while `messagesPerChat` holds a choice that is not saved yet. Setup offers the choice
   * before the encrypted DB is open, so that save fails; connect then opens the DB and hydrates,
   * which must save this choice rather than replace it with the stored default.
   */
  unsaved: boolean;
  hydrated: boolean;
  hydrate: (options?: HydrationOptions) => Promise<void>;
  setMessagesPerChat: (value: number) => Promise<void>;
}

/**
 * Initial-sync tuning (parity with the old app's "Messages to Sync Per Chat"). Persisted in `kv`;
 * defaults to 0 (all) to preserve the app's prior behavior. Read by `runSync` via `getState()`.
 */
export const useSyncSettingsStore = create<SyncSettingsState>((set, get) => ({
  messagesPerChat: 0,
  unsaved: false,
  hydrated: false,
  hydrate: async (options) => {
    try {
      const db = getDatabase();
      if (get().unsaved) {
        // A choice made before the DB opened (setup) wins over the stored value: save it now.
        if (!canCommitHydration(options)) return;
        await get().setMessagesPerChat(get().messagesPerChat);
        if (canCommitHydration(options)) set({ hydrated: true });
        return;
      }
      const v = await kvGet(db, SYNC_MESSAGES_PER_CHAT_KEY);
      if (!canCommitHydration(options)) return;
      // A choice made while this read was in flight is newer than the stored value; keep it.
      if (get().unsaved) {
        set({ hydrated: true });
        return;
      }
      const n = v == null ? 0 : Number(v);
      set({ messagesPerChat: Number.isFinite(n) && n >= 0 ? n : 0, hydrated: true });
    } catch (error) {
      reportHydrationError(options, error);
      // DB not open yet at launch — re-hydrated at home mount. Leave `hydrated` false.
    }
  },
  setMessagesPerChat: async (value) => {
    set({ messagesPerChat: value, unsaved: true }); // optimistic
    try {
      const db = getDatabase();
      await withDbTransaction(db, (context) =>
        kvSetWithinTransaction(context, SYNC_MESSAGES_PER_CHAT_KEY, String(value)),
      );
      // Only this value is now saved; a newer choice made meanwhile stays unsaved until its own
      // save finishes.
      if (get().messagesPerChat === value) set({ unsaved: false });
    } catch {
      // Best-effort persist; the in-memory value still applies this session, and the next
      // hydrate (connect, or home mount) saves it once the DB is open.
    }
  },
}));
