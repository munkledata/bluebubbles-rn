import { withAlpha } from '../theme/tokens';

export interface OverlayTextStyle {
  color: string;
  fontWeight?: '600';
}

export interface OverlayPillStyle {
  backgroundColor: string;
  borderRadius: number;
  paddingHorizontal: number;
  paddingVertical: number;
  overflow: 'hidden';
}

/**
 * Text style for the non-bubble overlay labels (date separator, sender header, status /
 * "Edited") . Pure (no React Native) so it's unit-testable.
 * - no background → the muted theme colour (unchanged behaviour).
 * - background → the theme's PRIMARY label colour, semibold. Over a wallpaper each label sits in
 *   a frosted pill (`overlayPillStyle`) tinted with the theme background, so the label colour —
 *   designed to contrast the theme background — is the guaranteed-legible choice. A text halo
 *   alone was tried first and does NOT survive busy photos; the pill does.
 */
export function overlayTextStyle(
  hasBackground: boolean | undefined,
  fallbackColor: string,
  labelColor: string,
): OverlayTextStyle {
  if (!hasBackground) return { color: fallbackColor };
  return { color: labelColor, fontWeight: '600' };
}

/**
 * Frosted pill behind an overlay label — the same chip language as the header/composer controls
 * floating over a wallpaper (theme background at 62%). Null when no wallpaper (labels stay
 * unbacked). Callers add their own `alignSelf` so the pill hugs the text instead of stretching.
 */
export function overlayPillStyle(
  hasBackground: boolean | undefined,
  themeBackground: string,
): OverlayPillStyle | null {
  if (!hasBackground) return null;
  return {
    backgroundColor: withAlpha(themeBackground, 0.62),
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
    overflow: 'hidden',
  };
}
