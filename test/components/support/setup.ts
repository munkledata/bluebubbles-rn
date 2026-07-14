/**
 * Shared setup for the 'components' jest project (jest-expo world). Registered as
 * `setupFilesAfterEnv` in jest.config.js — runs after the test framework is installed,
 * once per test file.
 *
 * Two jobs:
 *   1. Mock `@db/database` so anything that hydrates from the DB (e.g. `themeStore`)
 *      doesn't call the real `getDatabase()`, which throws off-device (it opens
 *      op-sqlite/SQLCipher). Mirrors the pattern in test/state/themeStore.test.ts.
 *   2. Reset zustand store state between tests. Leaked store state is the #1 source of
 *      cross-test flakiness, so every store the harness pre-seeds is restored here.
 *
 * Keep this MINIMAL — later phases add their own mocks/resets as they need them.
 */
import { cleanup } from '@testing-library/react-native';
import { useThemeStore } from '@state/themeStore';
import { DEFAULT_PRESET } from '@ui/theme/tokens';

// getDatabase() throws when the DB isn't open (jest never opens it). Any store/component
// that reads the DB during a component test relies on this stub.
jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));

afterEach(async () => {
  // Unmount any tree the test rendered FIRST, so the store reset below has no live
  // ThemeProvider subscriber to re-render — otherwise the setState fires a React
  // "not wrapped in act(...)" warning. (RNTL 14 cleanup is async under React 19.)
  await cleanup();
  // renderWithTheme pre-seeds these; reset so the next test starts from a known state.
  useThemeStore.setState({
    preset: DEFAULT_PRESET,
    customThemeId: null,
    customTokens: null,
    hydrated: false,
  });
});
