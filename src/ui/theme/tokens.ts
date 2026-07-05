/**
 * iOS design tokens (the only skin we keep). Mirrors the colors/spacing from the
 * Flutter Cupertino layouts (text_bubble.dart: sender #1982FC, gray gradient
 * received bubbles) and the built-in themes (OLED Dark, Bright White).
 *
 * Pure data so it is consumable by the ThemeProvider, tests, and any non-React
 * code (e.g. notification styling).
 */
export type ThemeMode = 'light' | 'dark';

export interface BubbleColors {
  senderBackground: string;
  senderText: string;
  receivedBackgroundTop: string;
  receivedBackgroundBottom: string;
  receivedText: string;
  smsBackground: string; // green SMS bubbles
  rcsBackground: string; // teal RCS bubbles (distinct from iMessage blue + SMS green)
}

export interface ThemeTokens {
  mode: ThemeMode;
  color: {
    background: string;
    secondaryBackground: string;
    groupedBackground: string;
    label: string;
    secondaryLabel: string;
    tertiaryLabel: string;
    separator: string;
    tint: string; // iOS system blue
    destructive: string;
    bubble: BubbleColors;
  };
  spacing: { xs: number; sm: number; md: number; lg: number; xl: number };
  radius: { bubble: number; tail: number; card: number; pill: number };
  font: {
    family: string; // SF Pro on iOS-styled Android falls back to system
    size: { caption: number; footnote: number; body: number; headline: number; title: number };
  };
}

const IMESSAGE_BLUE = '#1982FC';
const SMS_GREEN = '#43CC47';
// RCS gets its own teal so it reads as neither iMessage (blue) nor carrier SMS (green) — Google
// Messages itself surfaces RCS distinctly from SMS. Dark enough to carry white bubble text.
const RCS_TEAL = '#0A8F94';

const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
const radius = { bubble: 18, tail: 6, card: 12, pill: 999 } as const;
const font = {
  family: 'System',
  size: { caption: 11, footnote: 13, body: 17, headline: 17, title: 28 },
} as const;

export const lightTheme: ThemeTokens = {
  mode: 'light',
  color: {
    background: '#FFFFFF',
    secondaryBackground: '#F2F2F7',
    groupedBackground: '#EFEFF4',
    label: '#000000',
    secondaryLabel: '#3C3C43',
    tertiaryLabel: '#8E8E93',
    separator: '#C6C6C8',
    tint: IMESSAGE_BLUE,
    destructive: '#FF3B30',
    bubble: {
      senderBackground: IMESSAGE_BLUE,
      senderText: '#FFFFFF',
      receivedBackgroundTop: '#E9E9EB',
      receivedBackgroundBottom: '#E5E5EA',
      receivedText: '#000000',
      smsBackground: SMS_GREEN,
      rcsBackground: RCS_TEAL,
    },
  },
  spacing,
  radius,
  font,
};

export const darkTheme: ThemeTokens = {
  mode: 'dark',
  color: {
    background: '#000000',
    secondaryBackground: '#1C1C1E',
    groupedBackground: '#000000',
    label: '#FFFFFF',
    secondaryLabel: '#EBEBF5',
    tertiaryLabel: '#8E8E93',
    separator: '#38383A',
    tint: IMESSAGE_BLUE,
    destructive: '#FF453A',
    bubble: {
      senderBackground: IMESSAGE_BLUE,
      senderText: '#FFFFFF',
      receivedBackgroundTop: '#262629',
      receivedBackgroundBottom: '#1C1C1E',
      receivedText: '#FFFFFF',
      smsBackground: SMS_GREEN,
      rcsBackground: RCS_TEAL,
    },
  },
  spacing,
  radius,
  font,
};

export const themes: Record<ThemeMode, ThemeTokens> = { light: lightTheme, dark: darkTheme };

/**
 * A hex colour (`#RGB` / `#RRGGBB`) at a given alpha, as an `rgba()` string. Pure — used to make
 * the chat header/composer translucent over a wallpaper so it shows through instead of framing it
 * in solid bars. Returns the input unchanged for a non-hex value (defensive).
 */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return hex;
  let h = m[1]!;
  if (h.length === 3)
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// ---- Named presets (selectable in Settings) -------------------------------

export type PresetKey = 'ios-light' | 'bright-white' | 'oled-dark' | 'nord' | 'gator';

export interface ThemePreset {
  key: PresetKey;
  label: string;
  tokens: ThemeTokens;
}

/** iOS Light: grouped-gray system look, vs Bright-White's pure white. */
export const iosLightTheme: ThemeTokens = {
  mode: 'light',
  color: {
    background: '#FFFFFF',
    secondaryBackground: '#F2F2F7',
    groupedBackground: '#F2F2F7',
    label: '#000000',
    secondaryLabel: '#3C3C43',
    tertiaryLabel: '#8E8E93',
    separator: '#C6C6C8',
    tint: IMESSAGE_BLUE,
    destructive: '#FF3B30',
    bubble: {
      senderBackground: IMESSAGE_BLUE,
      senderText: '#FFFFFF',
      receivedBackgroundTop: '#E9E9EB',
      receivedBackgroundBottom: '#E5E5EA',
      receivedText: '#000000',
      smsBackground: SMS_GREEN,
      rcsBackground: RCS_TEAL,
    },
  },
  spacing,
  radius,
  font,
};

/** Nord (parity with the Flutter "Nord" built-in theme). */
export const nordTheme: ThemeTokens = {
  mode: 'dark',
  color: {
    background: '#2E3440',
    secondaryBackground: '#3B4252',
    groupedBackground: '#2E3440',
    label: '#ECEFF4',
    secondaryLabel: '#D8DEE9',
    tertiaryLabel: '#7B88A1',
    separator: '#434C5E',
    tint: '#88C0D0',
    destructive: '#BF616A',
    bubble: {
      senderBackground: '#5E81AC',
      senderText: '#ECEFF4',
      receivedBackgroundTop: '#434C5E',
      receivedBackgroundBottom: '#4C566A',
      receivedText: '#ECEFF4',
      smsBackground: '#A3BE8C',
      rcsBackground: '#4C7C8C', // muted frost teal, distinct from the green SMS + blue sender
    },
  },
  spacing,
  radius,
  font,
};

/**
 * Gator: the app-icon palette — a deep-navy "underwater" background with vivid gator-green
 * accents, and the icon's blue/green speech bubbles (blue sender, green SMS).
 */
export const gatorTheme: ThemeTokens = {
  mode: 'dark',
  color: {
    background: '#0B1A2B',
    secondaryBackground: '#16293E',
    groupedBackground: '#0B1A2B',
    label: '#F2F7FB',
    secondaryLabel: '#AFC4D6',
    tertiaryLabel: '#6E869B',
    separator: '#223850',
    tint: '#4FC865', // gator green
    destructive: '#FF5A52',
    bubble: {
      senderBackground: '#2E8FE0', // the icon's blue bubble
      senderText: '#FFFFFF',
      receivedBackgroundTop: '#1E3147',
      receivedBackgroundBottom: '#16293E',
      receivedText: '#EAF2F8',
      smsBackground: '#3FBF55', // gator green
      rcsBackground: '#17A2B8', // teal — distinct from the icon's blue sender + gator-green SMS
    },
  },
  spacing,
  radius,
  font,
};

/**
 * The CATALOG of all preset definitions. Keeping every definition here (even disabled ones)
 * means re-enabling a theme is a one-line change — just add its key to {@link PRESET_ORDER}.
 * To add a brand-new theme: define its `ThemeTokens` above, add the key to {@link PresetKey},
 * add an entry here, then list the key in PRESET_ORDER.
 */
export const PRESETS: Record<PresetKey, ThemePreset> = {
  'ios-light': { key: 'ios-light', label: 'iOS Light', tokens: iosLightTheme },
  'bright-white': { key: 'bright-white', label: 'Bright White', tokens: lightTheme },
  'oled-dark': { key: 'oled-dark', label: 'OLED Dark', tokens: darkTheme },
  nord: { key: 'nord', label: 'Nord', tokens: nordTheme },
  gator: { key: 'gator', label: 'Gator', tokens: gatorTheme },
};

/**
 * The presets ACTUALLY offered to the user (Settings reads this) and honored by
 * {@link resolvePreset}. Currently only OLED Dark is enabled; the other definitions stay in
 * {@link PRESETS} so you can re-enable any of them by adding its key back to this array, e.g.
 * `['oled-dark', 'nord']`.
 */
export const PRESET_ORDER: PresetKey[] = ['oled-dark', 'gator'];
export const DEFAULT_PRESET: PresetKey = 'oled-dark';

const ACTIVE_PRESETS = new Set<string>(PRESET_ORDER);

/**
 * Pure: preset key → tokens. Only keys in {@link PRESET_ORDER} are honored; any other (an
 * unknown key, or a now-disabled theme a user had previously selected) falls back to the
 * always-present {@link DEFAULT_PRESET}.
 */
export function resolvePreset(key: string | null | undefined): ThemeTokens {
  const usable = !!key && ACTIVE_PRESETS.has(key) && key in PRESETS;
  return (usable ? PRESETS[key as PresetKey] : PRESETS[DEFAULT_PRESET]).tokens;
}

/**
 * Safe parse of a stored tokens blob. Returns null for null/empty/corrupt input so
 * callers (the theme editor, the per-chat ChatThemeProvider) fall back to a known
 * theme rather than crash. Pure, so it's usable in non-React code + tests.
 */
export function safeParseTokens(json: string | null | undefined): ThemeTokens | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as ThemeTokens;
  } catch {
    return null;
  }
}
