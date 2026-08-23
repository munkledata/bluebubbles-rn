import { create } from 'zustand';
import { getDatabase } from '@db/database';
import {
  getCustomThemeById,
  kvGet,
  kvSet,
  kvSetWithinTransaction,
  THEME_CUSTOM_KEY,
  THEME_PREF_KEY,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import {
  DEFAULT_PRESET,
  isDarkThemeTokens,
  resolvePresetKey,
  type PresetKey,
  type ThemeTokens,
} from '@ui/theme/tokens';
import { canCommitHydration, reportHydrationError, type HydrationOptions } from '@state/hydration';

interface ThemeState {
  preset: PresetKey;
  /** Active custom-theme id, or null when a built-in preset is in use. */
  customThemeId: number | null;
  /** Parsed tokens of the active custom theme (overrides the preset when set). */
  customTokens: ThemeTokens | null;
  hydrated: boolean;
  hydrate: (options?: HydrationOptions) => Promise<void>;
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
  hydrate: async (options) => {
    try {
      const db = getDatabase();
      const presetVal = await kvGet(db, THEME_PREF_KEY);
      if (!canCommitHydration(options)) return;
      const preset = resolvePresetKey(presetVal);
      const customRaw = await kvGet(db, THEME_CUSTOM_KEY);
      if (!canCommitHydration(options)) return;
      const customId = customRaw ? Number(customRaw) : NaN;
      if (Number.isFinite(customId)) {
        const row = await getCustomThemeById(db, customId);
        if (!canCommitHydration(options)) return;
        const tokens = row ? parseTokens(row.tokens) : null;
        if (isDarkThemeTokens(tokens)) {
          set({ preset, customThemeId: customId, customTokens: tokens, hydrated: true });
          return;
        }
      }
      set({ preset, customThemeId: null, customTokens: null, hydrated: true });
    } catch (error) {
      reportHydrationError(options, error);
      // An unguarded pre-DB launch still opens ThemeProvider with the safe dark default. A retired
      // guarded run, however, must not repaint a newer boot or release its first-paint gate.
      if (canCommitHydration(options)) set({ hydrated: true });
    }
  },
  setPreset: async (key) => {
    const preset = resolvePresetKey(key);
    set({ preset, customThemeId: null, customTokens: null }); // optimistic → instant recolor
    try {
      const db = getDatabase();
      await withDbTransaction(db, async (context) => {
        await kvSetWithinTransaction(context, THEME_PREF_KEY, preset);
        await kvSetWithinTransaction(context, THEME_CUSTOM_KEY, '');
      });
    } catch {
      // best-effort persist; the in-memory selection still applies this session
    }
  },
  setCustomTheme: async (id, tokens) => {
    if (!isDarkThemeTokens(tokens)) {
      throw new Error('Light themes are unavailable while Gator is dark-only.');
    }
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
      if (isDarkThemeTokens(tokens)) set({ customTokens: tokens });
      else set({ customThemeId: null, customTokens: null }); // missing, corrupt, or unavailable light
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
