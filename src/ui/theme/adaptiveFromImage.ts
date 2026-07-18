/**
 * Adaptive per-chat theming from a background image (ROADMAP Phase 3.3).
 *
 * Two layers:
 *  - PURE color math + a pure token generator (`generateAdaptiveTokens`). No React,
 *    no native, no deps — fully node-testable and the part we can guarantee.
 *  - An ASYNC native bridge (`adaptiveTokensFromImage`) that extracts a seed colour
 *    from an image via react-native-image-colors, then defers to the pure generator.
 *    The native module is lazily `import()`-ed so this file (and the chat screen that
 *    imports it) stays importable on a build that hasn't linked the native module yet;
 *    any failure degrades to `null` so callers fall back gracefully.
 *
 * We deliberately do NOT use Material Color Utilities — the generator is a small,
 * deterministic HSL pipeline tuned for iOS-style bubbles with WCAG-checked contrast.
 */
import { darkTheme, iosLightTheme, type ThemeMode, type ThemeTokens } from './tokens';

// ---- Pure colour helpers (node-testable) ----------------------------------

/** Clamp a number into [min, max]. */
function clamp(n: number, min: number, max: number): number {
  return n < min ? min : n > max ? max : n;
}

/** Parse `#RGB` / `#RRGGBB` into 0–255 channels. Throws on an unparseable string. */
function parseHex(hex: string): { r: number; g: number; b: number } {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) {
    h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
  }
  if (!/^[0-9a-fA-F]{6}$/.test(h)) {
    throw new Error(`invalid hex color: ${hex}`);
  }
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/** Two-digit uppercase hex for a 0–255 channel (rounded + clamped). */
function channelHex(n: number): string {
  return clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0').toUpperCase();
}

export interface Hsl {
  h: number; // 0–360
  s: number; // 0–1
  l: number; // 0–1
}

/** `#hex` → HSL. Hue in degrees, saturation/lightness in [0, 1]. */
export function hexToHsl(hex: string): Hsl {
  const { r, g, b } = parseHex(hex);
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn:
        h = (gn - bn) / d + (gn < bn ? 6 : 0);
        break;
      case gn:
        h = (bn - rn) / d + 2;
        break;
      default:
        h = (rn - gn) / d + 4;
        break;
    }
    h *= 60;
  }
  return { h, s, l };
}

/** HSL → `#RRGGBB`. Hue is taken mod 360; s/l are clamped into [0, 1]. */
export function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp(s, 0, 1);
  const lig = clamp(l, 0, 1);
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lig - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) {
    [r, g, b] = [c, x, 0];
  } else if (hue < 120) {
    [r, g, b] = [x, c, 0];
  } else if (hue < 180) {
    [r, g, b] = [0, c, x];
  } else if (hue < 240) {
    [r, g, b] = [0, x, c];
  } else if (hue < 300) {
    [r, g, b] = [x, 0, c];
  } else {
    [r, g, b] = [c, 0, x];
  }
  return `#${channelHex((r + m) * 255)}${channelHex((g + m) * 255)}${channelHex((b + m) * 255)}`;
}

/** Linearize one 0–255 sRGB channel for luminance (WCAG 2.x). */
function linearChannel(c255: number): number {
  const c = c255 / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance of a colour (0 = black, 1 = white). */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  return 0.2126 * linearChannel(r) + 0.7152 * linearChannel(g) + 0.0722 * linearChannel(b);
}

/** WCAG contrast ratio between two colours (1–21). Order-independent. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
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

// ---- Pure token generator (the heart, node-testable) ----------------------

/**
 * Normalize a raw seed into a usable tint: keep its hue, but pull near-grey or
 * extreme colours into a vivid-but-not-neon band (S ∈ [0.35, 0.85]) and a usable
 * lightness band (L ∈ [0.40, 0.62]) so the accent reads clearly on either mode.
 *
 * Crucially, the tint is reused verbatim as `bubble.senderBackground`, so it MUST be
 * able to carry AA (≥ 4.5) text. At high saturation the [0.40, 0.62] band has a
 * "dead zone" (roughly L ∈ [0.45, 0.60]) where neither near-white nor near-black
 * clears 4.5 on the tint. We close it by darkening: keep the hue + saturation, then
 * step L down (toward a darker, white-on-tint readable shade) until the more-readable
 * foreground clears AA. A floor of 0.15 keeps a vivid hue (no muddy near-black) and the
 * loop is bounded; darkening only ever raises white-on-tint contrast so it converges.
 */
function normalizeTint(seedHex: string): string {
  const { h, s, l } = hexToHsl(seedHex);
  const s2 = clamp(s, 0.35, 0.85);
  let l2 = clamp(l, 0.4, 0.62);
  let tint = hslToHex(h, s2, l2);
  // Darken in small steps until the tint can carry AA text (hue/saturation preserved).
  while (l2 > 0.15 && contrastRatio(readableTextOn(tint), tint) < 4.5) {
    l2 = Math.max(0.15, l2 - 0.02);
    tint = hslToHex(h, s2, l2);
  }
  return tint;
}

/** A pleasant SMS green that nods toward the seed hue but stays unmistakably green. */
const SMS_GREEN = '#43CC47';
/** RCS gator-green — kept fixed (like SMS green) so the service colour reads consistently over any wallpaper. */
const RCS_GREEN = '#1E7D46';

/**
 * Build a fully-populated, valid `ThemeTokens` from a single seed colour.
 *
 * Structural tokens (spacing/radius/font) are inherited from the mode's base preset
 * (darkTheme / iosLightTheme); only the colour tokens are derived from the seed. The
 * result is contrast-checked by construction:
 *   - sender text on the sender bubble (the tint),
 *   - the primary label on the background,
 *   - received text on the received bubble
 * all use `readableTextOn(...)`, which picks the higher-contrast of near-white /
 * near-black — guaranteeing AA (≥ 4.5) wherever the surface allows it.
 */
export function generateAdaptiveTokens(seedHex: string, mode: ThemeMode): ThemeTokens {
  const base = mode === 'dark' ? darkTheme : iosLightTheme;
  const tint = normalizeTint(seedHex);
  const { h } = hexToHsl(tint);

  let background: string;
  let secondaryBackground: string;
  let groupedBackground: string;
  let label: string;
  let secondaryLabel: string;
  let tertiaryLabel: string;
  let separator: string;
  let receivedTop: string;
  let receivedBottom: string;
  let receivedText: string;

  if (mode === 'dark') {
    background = hslToHex(h, 0.14, 0.08);
    secondaryBackground = hslToHex(h, 0.14, 0.15);
    groupedBackground = background;
    label = hslToHex(h, 0.06, 0.97); // near-white with a hue hint
    secondaryLabel = hslToHex(h, 0.08, 0.82);
    tertiaryLabel = hslToHex(h, 0.08, 0.6);
    separator = hslToHex(h, 0.12, 0.25);
    receivedTop = hslToHex(h, 0.12, 0.22);
    receivedBottom = hslToHex(h, 0.12, 0.18);
    receivedText = readableTextOn(receivedTop); // near-white on these dark bubbles
  } else {
    background = hslToHex(h, 0.1, 0.98);
    secondaryBackground = hslToHex(h, 0.12, 0.94);
    groupedBackground = background;
    label = readableTextOn(background); // near-black on the light background
    secondaryLabel = hslToHex(h, 0.1, 0.28);
    tertiaryLabel = hslToHex(h, 0.08, 0.5);
    separator = hslToHex(h, 0.1, 0.85);
    receivedTop = hslToHex(h, 0.1, 0.9);
    receivedBottom = hslToHex(h, 0.1, 0.86);
    receivedText = readableTextOn(receivedTop); // near-black on the light bubbles
  }

  return {
    mode,
    color: {
      background,
      secondaryBackground,
      groupedBackground,
      label,
      secondaryLabel,
      tertiaryLabel,
      separator,
      tint,
      destructive: mode === 'dark' ? '#FF453A' : '#FF3B30',
      bubble: {
        senderBackground: tint,
        senderText: readableTextOn(tint),
        receivedBackgroundTop: receivedTop,
        receivedBackgroundBottom: receivedBottom,
        receivedText,
        smsBackground: SMS_GREEN,
        rcsBackground: RCS_GREEN,
      },
    },
    spacing: base.spacing,
    radius: base.radius,
    font: base.font,
  };
}

// ---- Async native bridge (lazy import — keeps this module node-importable) -

const SEED_FALLBACK = '#1982FC';

/**
 * Extract an accent colour from an image and build adaptive theme tokens for it.
 *
 * The native colour extractor is imported lazily so this module (and the chat
 * settings screen) load fine on a build that hasn't linked react-native-image-colors.
 * Returns `null` on ANY failure (module not linked, fetch/decoding error) so the
 * caller can fall back to just setting the background image.
 */
export async function adaptiveTokensFromImage(
  uri: string,
  mode: ThemeMode,
): Promise<ThemeTokens | null> {
  try {
    const ImageColors = (await import('react-native-image-colors')).default;
    const result = await ImageColors.getColors(uri, {
      fallback: SEED_FALLBACK,
      cache: true,
      key: uri,
    });

    let seed: string;
    switch (result.platform) {
      case 'android':
        seed =
          mode === 'dark'
            ? result.darkVibrant || result.vibrant || result.dominant
            : result.vibrant || result.dominant;
        break;
      case 'ios':
        seed = result.primary || result.detail;
        break;
      default:
        seed = result.vibrant || result.dominant;
        break;
    }

    return generateAdaptiveTokens(seed || SEED_FALLBACK, mode);
  } catch {
    return null;
  }
}
