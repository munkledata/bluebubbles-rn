import { darkTheme, lightTheme, safeParseTokens, type ThemeTokens } from '@ui/theme/tokens';

/**
 * ChatThemeProvider decides the active theme as `safeParseTokens(themeTokens) ?? globalTheme`.
 * These assert that exact fallback contract without rendering the RN component (the jest
 * project is React-free / Node): a valid blob wins, null/corrupt falls back to the global.
 */
describe('per-chat theme fallback (ChatThemeProvider logic)', () => {
  const global = lightTheme;
  const resolve = (stored: string | null | undefined): ThemeTokens =>
    safeParseTokens(stored) ?? global;

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
});
