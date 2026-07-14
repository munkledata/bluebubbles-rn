/**
 * The one import a component test needs. Wraps RNTL's `render()` in a `ThemeProvider` so
 * components that call `useTheme()` (which throws outside a provider) render correctly, and
 * re-exports every RNTL helper so tests import from HERE only.
 *
 * Why pre-seed the store: `ThemeProvider` reads `useThemeStore`, and until `hydrated` is true
 * it renders a blank placeholder `<View>` instead of `children` (real app: it awaits the
 * persisted theme to avoid a flash). It also calls `getDatabase()` during hydrate, which throws
 * in jest. So the harness sets `hydrated: true` (and the requested preset) directly — no DB
 * hydrate needed. setup.ts resets this store after each test.
 *
 * Async because RNTL 14 under React 19 returns a Promise from `render()` — always `await`.
 */
import React, { type ReactElement, type ReactNode } from 'react';
import { render, type RenderResult } from '@testing-library/react-native';
import { ThemeProvider } from '@ui/theme/ThemeProvider';
import { useThemeStore } from '@state/themeStore';
import { DEFAULT_PRESET, type PresetKey } from '@ui/theme/tokens';

// Re-export the full RNTL surface (screen, fireEvent, waitFor, act, cleanup, …) so a test
// only ever imports from this module.
export * from '@testing-library/react-native';

export interface RenderWithThemeOptions {
  /** Which built-in preset to resolve tokens from (default: the app default, OLED Dark). */
  preset?: PresetKey;
}

function ThemeWrapper({ children }: { children: ReactNode }): React.JSX.Element {
  return <ThemeProvider>{children}</ThemeProvider>;
}

/**
 * Render `ui` inside a hydrated `ThemeProvider`. Await it (RNTL 14 render is async).
 * The returned object is the standard RNTL query bag (getByText, unmount, rerender, …).
 */
export async function renderWithTheme(
  ui: ReactElement,
  options: RenderWithThemeOptions = {},
): Promise<RenderResult> {
  const { preset = DEFAULT_PRESET } = options;
  // Seed synchronously BEFORE render so ThemeProvider paints children (not the placeholder)
  // with the requested preset on the very first commit.
  useThemeStore.setState({
    preset,
    customThemeId: null,
    customTokens: null,
    hydrated: true,
  });
  return render(ui, { wrapper: ThemeWrapper });
}
