/** RGB channels parsed from a three- or six-digit hex colour. */
export interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

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
