import { create } from 'zustand';
import { getDatabase } from '@db/database';
import { kvGet, kvSet } from '@db/repositories';

export const REDACTED_MODE_KEY = 'privacy.redactedMode';

interface RedactedModeState {
  enabled: boolean;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setEnabled: (value: boolean) => Promise<void>;
}

/**
 * Redacted (privacy) mode: when on, message content + contact names are masked in
 * the inbox, the chat, and notification bodies — for shoulder-surfing / screenshots.
 * Persisted in `kv`; defaults OFF. Hydrate at app launch alongside the other stores
 * (the notification `hidePreview` flag is pushed from this in the root layout).
 */
export const useRedactedModeStore = create<RedactedModeState>((set) => ({
  enabled: false,
  hydrated: false,
  hydrate: async () => {
    try {
      const v = await kvGet(getDatabase(), REDACTED_MODE_KEY);
      set({ enabled: v === '1', hydrated: true });
    } catch {
      // DB not open yet at launch — re-hydrated at home mount. Leave hydrated false.
    }
  },
  setEnabled: async (value) => {
    set({ enabled: value }); // optimistic
    try {
      await kvSet(getDatabase(), REDACTED_MODE_KEY, value ? '1' : '0');
    } catch {
      // best-effort persist; the in-memory toggle still applies this session
    }
  },
}));
