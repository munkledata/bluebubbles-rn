import { withAlpha } from '../theme/tokens';

export interface EdgeFadeStop {
  color: string;
  positions: [string];
}

/**
 * Colour stops for a transcript edge veil: a theme-background scrim that is strongest at the
 * screen edge, holds near-opaque through the (transparent) bar zone, then dissolves to nothing
 * across the fade band — so messages scrolling under the header/composer fade out instead of
 * hard-clipping at the list edge. Pure (no React Native) so it's unit-testable.
 *
 * `holdFraction` = bar-zone height / total veil height (clamped to 0..1).
 * The final stop is the SAME colour at alpha 0 — not `transparent` (= black at alpha 0), which
 * would interpolate through darkened mid-stops and leave a smoky fringe over light themes.
 */
export function edgeFadeStops(themeBackground: string, holdFraction: number): EdgeFadeStop[] {
  const hold = Math.max(0, Math.min(1, holdFraction));
  return [
    { color: withAlpha(themeBackground, 0.88), positions: ['0%'] },
    { color: withAlpha(themeBackground, 0.8), positions: [`${Math.round(hold * 100)}%`] },
    { color: withAlpha(themeBackground, 0), positions: ['100%'] },
  ];
}
