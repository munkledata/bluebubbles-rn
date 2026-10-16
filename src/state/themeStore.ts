import { create } from 'zustand';
import { getDatabase } from '@db/database';
import {
  getCustomThemeById,
  kvGet,
  kvSetWithinTransaction,
  THEME_CUSTOM_KEY,
  THEME_PREF_KEY,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import {
  DEFAULT_PRESET,
  isDarkThemeTokens,
  resolvePresetKey,
  safeParseTokens,
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
}

/** A stored custom theme that is corrupt or incomplete falls back to the preset (never crashes). */
function parseTokens(json: string): ThemeTokens | null {
  return safeParseTokens(json);
}

/**
 * App-wide theme selection. The Settings/theme screens and ThemeProvider share this
 * store, so a change recolors the whole tree. A built-in preset key is persisted in
 * `kv` (theme.preset); when a user picks a custom theme its id is persisted (theme.custom)
 * and its parsed tokens override the preset. The theme screens write custom-theme choices
 * through themeCommands and then update this store (review M251).
 */
export const useThemeStore = create<ThemeState>((set) => ({
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
}));
