import { darkTheme } from '@ui/theme/tokens';

/**
 * A complete, restorable theme-token blob for backup fixtures. Restore drops token sets that cannot
 * render, so fixtures wrap their distinguishing marker in the dark preset; extra keys survive the
 * round trip, which keeps each fixture's tokens unique.
 */
export function themeTokens(marker: Record<string, unknown>): string {
  return JSON.stringify({ ...darkTheme, ...marker });
}
