import {
  darkTheme,
  darkThemeOrFallback,
  gatorTheme,
  lightTheme,
  safeParseTokens,
  type ThemeTokens,
} from '@ui/theme/tokens';

/**
 * ChatThemeProvider accepts a stored dark token set and otherwise retains the global dark theme.
 * These assert that fallback contract without rendering the RN component (the jest project is
 * React-free / Node): a dark blob wins; null, corrupt, or legacy light blobs fall back.
 */
describe('per-chat theme fallback (ChatThemeProvider logic)', () => {
  const global = gatorTheme;
  const resolve = (stored: string | null | undefined): ThemeTokens =>
    darkThemeOrFallback(safeParseTokens(stored), global);

  it('uses the parsed chat tokens when present and valid', () => {
    const stored = JSON.stringify(darkTheme);
    expect(resolve(stored)).toEqual(darkTheme);
    expect(resolve(stored)).not.toBe(global);
  });

  it('falls back to the global theme when no per-chat tokens are set', () => {
    expect(resolve(null)).toBe(global);
    expect(resolve(undefined)).toBe(global);
    expect(resolve('')).toBe(global);
  });

  it('falls back to the global theme on corrupt JSON (never throws)', () => {
    expect(() => resolve('{ not valid json')).not.toThrow();
    expect(resolve('{ not valid json')).toBe(global);
  });

  it('falls back to the global theme for a stored legacy light theme', () => {
    expect(resolve(JSON.stringify(lightTheme))).toBe(global);
  });
});
