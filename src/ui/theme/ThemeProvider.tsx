import React, { createContext, useContext, useMemo, type ReactNode } from 'react';
import { View } from 'react-native';
import { useThemeStore } from '@state/themeStore';
import { darkTheme, darkThemeOrFallback, resolvePreset, type ThemeTokens } from './tokens';

export interface ThemeContextValue {
  theme: ThemeTokens;
}

/**
 * Exported so a nested provider (e.g. ChatThemeProvider) can override the active
 * theme for a subtree. Consumers should keep using `useTheme()` rather than this
 * directly.
 */
export const ThemeContext = createContext<ThemeContextValue>({ theme: darkTheme });

interface ThemeProviderProps {
  children: ReactNode;
  /** Root boot/lock shells may render with the safe dark fallback before DB hydration. */
  renderWithFallbackTheme?: boolean;
}

/**
 * Provides iOS design tokens to the tree, resolved from the persisted theme
 * preset (themeStore). Changing the preset recolors every `useTheme()` consumer.
 */
export function ThemeProvider({
  children,
  renderWithFallbackTheme = false,
}: ThemeProviderProps): React.JSX.Element {
  const preset = useThemeStore((s) => s.preset);
  const customTokens = useThemeStore((s) => s.customTokens);
  const hydrated = useThemeStore((s) => s.hydrated);
  // A dark custom theme (if active) overrides the built-in preset. Legacy light custom
  // tokens stay stored for THEME-01B but cannot make this dark-only tree render light.
  const value = useMemo<ThemeContextValue>(
    () => ({ theme: darkThemeOrFallback(customTokens, resolvePreset(preset)) }),
    [preset, customTokens],
  );
  // Without renderWithFallbackTheme this holds the first paint until the persisted theme loads.
  // The app root opts out so a stalled hydration can never leave a blank screen; every preset is
  // dark, so the brief default-preset paint before a custom theme applies is cosmetic.
  return (
    <ThemeContext.Provider value={value}>
      {hydrated || renderWithFallbackTheme ? (
        children
      ) : (
        <View style={{ flex: 1, backgroundColor: value.theme.color.background }} />
      )}
    </ThemeContext.Provider>
  );
}

/** Access the active iOS theme tokens. */
export function useTheme(): ThemeTokens {
  return useContext(ThemeContext).theme;
}
