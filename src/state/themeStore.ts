import { create } from 'zustand';
import { getDatabase } from '@db/database';
import {
  getCustomThemeById,
  kvGet,
  kvSet,
  THEME_CUSTOM_KEY,
  THEME_PREF_KEY,
} from '@db/repositories';
import { DEFAULT_PRESET, type PresetKey, type ThemeTokens } from '@ui/theme/tokens';

interface ThemeState {
  preset: PresetKey;
  /** Active custom-theme id, or null when a built-in preset is in use. */
  customThemeId: number | null;
  /** Parsed tokens of the active custom theme (overrides the preset when set). */
  customTokens: ThemeTokens | null;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  /** Select a built-in preset (also clears any active custom theme). */
  setPreset: (key: PresetKey) => Promise<void>;
  /** Make a custom theme active (overrides the preset). */
  setCustomTheme: (id: number, tokens: ThemeTokens) => Promise<void>;
  /** Re-load the active custom theme's tokens from the DB (live recolor after an edit). */
  reloadCustomTokens: () => Promise<void>;
  /** Revert to the selected preset. */
  clearCustomTheme: () => Promise<void>;
}

function parseTokens(json: string): ThemeTokens | null {
  try {
    return JSON.parse(json) as ThemeTokens;
  } catch {
    return null;
  }
}

/**
 * App-wide theme selection. The Settings/theme screens and ThemeProvider share this
 * store, so a change recolors the whole tree. A built-in preset key is persisted in
 * `kv` (theme.preset); when a user picks a custom theme its id is persisted (theme.custom)
 * and its parsed tokens override the preset.
 */
export const useThemeStore = create<ThemeState>((set, get) => ({
  preset: DEFAULT_PRESET,
  customThemeId: null,
  customTokens: null,
  hydrated: false,
  hydrate: async () => {
    try {
      const db = getDatabase();
      const presetVal = await kvGet(db, THEME_PREF_KEY);
      const preset = (presetVal as PresetKey) ?? DEFAULT_PRESET;
      const customRaw = await kvGet(db, THEME_CUSTOM_KEY);
      const customId = customRaw ? Number(customRaw) : NaN;
      if (Number.isFinite(customId)) {
        const row = await getCustomThemeById(db, customId);
        const tokens = row ? parseTokens(row.tokens) : null;
        if (tokens) {
          set({ preset, customThemeId: customId, customTokens: tokens, hydrated: true });
          return;
        }
      }
      set({ preset, customThemeId: null, customTokens: null, hydrated: true });
    } catch {
      set({ hydrated: true });
    }
  },
  setPreset: async (key) => {
    set({ preset: key, customThemeId: null, customTokens: null }); // optimistic → instant recolor
    try {
      const db = getDatabase();
      await kvSet(db, THEME_PREF_KEY, key);
      await kvSet(db, THEME_CUSTOM_KEY, '');
    } catch {
      // best-effort persist; the in-memory selection still applies this session
    }
  },
  setCustomTheme: async (id, tokens) => {
    set({ customThemeId: id, customTokens: tokens }); // optimistic
    try {
      await kvSet(getDatabase(), THEME_CUSTOM_KEY, String(id));
    } catch {
      // best-effort persist
    }
  },
  reloadCustomTokens: async () => {
    const id = get().customThemeId;
    if (id == null) return;
    try {
      const row = await getCustomThemeById(getDatabase(), id);
      const tokens = row ? parseTokens(row.tokens) : null;
      if (tokens) set({ customTokens: tokens });
      else set({ customThemeId: null, customTokens: null }); // theme was deleted
    } catch {
      // keep the current tokens on a transient read error
    }
  },
  clearCustomTheme: async () => {
    set({ customThemeId: null, customTokens: null });
    try {
      await kvSet(getDatabase(), THEME_CUSTOM_KEY, '');
    } catch {
      // best-effort persist
    }
  },
}));
