import { DarkTheme as NavigationDarkTheme } from 'expo-router';

/** Light status-bar glyphs are the readable choice on every enabled dark theme. */
export const DARK_STATUS_BAR_STYLE = 'light' as const;

/**
 * Expo Router's always-dark navigation theme, recolored to the active dark preset.
 * Keeping this independent of the OS color scheme prevents a light transition surface
 * (and white push/pop flash) when the phone itself uses light appearance.
 */
export function buildDarkNavigationTheme(background: string): typeof NavigationDarkTheme {
  return {
    ...NavigationDarkTheme,
    colors: {
      ...NavigationDarkTheme.colors,
      background,
      card: background,
    },
  };
}
