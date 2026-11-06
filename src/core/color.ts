/** RGB channels parsed from a three- or six-digit hex colour. */
export interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** Exactly `#RGB` / `#RRGGBB`: the forms the theme editor accepts and every Gator theme stores. */
export const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Parse `#RGB` / `#RRGGBB` into 0–255 channels. */
export function parseHexColor(hex: string): RgbColor {
  let value = hex.trim().replace(/^#/, '');
  if (value.length === 3) {
    value = value[0]! + value[0]! + value[1]! + value[1]! + value[2]! + value[2]!;
  }
  if (!/^[0-9a-fA-F]{6}$/.test(value)) {
    throw new Error(`invalid hex color: ${hex}`);
  }
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

/** Linearize one 0–255 sRGB channel for luminance (WCAG 2.x). */
function linearChannel(channel: number): number {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of a colour (0 = black, 1 = white). */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHexColor(hex);
  return 0.2126 * linearChannel(r) + 0.7152 * linearChannel(g) + 0.0722 * linearChannel(b);
}

/**
 * WCAG contrast ratio between two colours (1–21). Order-independent. Runs at render time on theme
 * colours, so an unparseable colour scores 1 (no contrast) instead of throwing: callers then pick
 * their readable fallback, and readableTextOn returns near-white.
 */
export function contrastRatio(a: string, b: string): number {
  let la: number;
  let lb: number;
  try {
    la = relativeLuminance(a);
    lb = relativeLuminance(b);
  } catch {
    return 1;
  }
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

const NEAR_WHITE = '#FFFFFF';
const NEAR_BLACK = '#111111';

/**
 * The more-readable foreground for `bg`: near-white or near-black, whichever has the
 * higher contrast ratio. With a pure-grey background the two are within a hair, so we
 * tie-break toward the choice that clears WCAG AA (4.5) where one of them can.
 */
export function readableTextOn(bg: string): string {
  const whiteContrast = contrastRatio(NEAR_WHITE, bg);
  const blackContrast = contrastRatio(NEAR_BLACK, bg);
  return whiteContrast >= blackContrast ? NEAR_WHITE : NEAR_BLACK;
}
