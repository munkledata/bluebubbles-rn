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
    },
  },
  spacing,
  radius,
  font,
};

export const themes: Record<ThemeMode, ThemeTokens> = { light: lightTheme, dark: darkTheme };

// ---- Named presets (selectable in Settings) -------------------------------

export type PresetKey = 'ios-light' | 'bright-white' | 'oled-dark' | 'nord';

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
    },
  },
  spacing,
  radius,
  font,
};

export const PRESETS: Record<PresetKey, ThemePreset> = {
  'ios-light': { key: 'ios-light', label: 'iOS Light', tokens: iosLightTheme },
  'bright-white': { key: 'bright-white', label: 'Bright White', tokens: lightTheme },
  'oled-dark': { key: 'oled-dark', label: 'OLED Dark', tokens: darkTheme },
  nord: { key: 'nord', label: 'Nord', tokens: nordTheme },
};

export const PRESET_ORDER: PresetKey[] = ['ios-light', 'bright-white', 'oled-dark', 'nord'];
export const DEFAULT_PRESET: PresetKey = 'oled-dark';

/** Pure: preset key → tokens, falling back to the default for unknown keys. */
export function resolvePreset(key: string | null | undefined): ThemeTokens {
  return (key && key in PRESETS ? PRESETS[key as PresetKey] : PRESETS[DEFAULT_PRESET]).tokens;
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
