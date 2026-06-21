import React, { createContext, useContext, useMemo, type ReactNode } from 'react';
import { View } from 'react-native';
import { useThemeStore } from '@state/themeStore';
import { lightTheme, resolvePreset, type ThemeMode, type ThemeTokens } from './tokens';

export type ThemePreference = ThemeMode | 'system';

interface ThemeContextValue {
  theme: ThemeTokens;
}

const ThemeContext = createContext<ThemeContextValue>({ theme: lightTheme });

interface ThemeProviderProps {
  children: ReactNode;
}

/**
 * Provides iOS design tokens to the tree, resolved from the persisted theme
 * preset (themeStore). Changing the preset recolors every `useTheme()` consumer.
 */
export function ThemeProvider({ children }: ThemeProviderProps): React.JSX.Element {
  const preset = useThemeStore((s) => s.preset);
  const customTokens = useThemeStore((s) => s.customTokens);
  const hydrated = useThemeStore((s) => s.hydrated);
  // A custom theme (if active) overrides the built-in preset.
  const value = useMemo<ThemeContextValue>(
    () => ({ theme: customTokens ?? resolvePreset(preset) }),
    [preset, customTokens],
  );
  // Hold the first paint until the persisted theme has loaded, so a custom-theme user
  // doesn't see a flash of the default preset before hydration recolors the tree.
  return (
    <ThemeContext.Provider value={value}>
      {hydrated ? (
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
