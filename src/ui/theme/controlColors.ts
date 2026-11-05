import type { SwitchProps, TextInputProps } from 'react-native';
import { withAlpha, type ThemeTokens } from './tokens';

/**
 * Accent colors for a text field's cursor, selection highlight and selection handles. Without them
 * Android draws its own system accent (teal), not the theme's tint.
 */
export function textInputAccentProps(
  theme: ThemeTokens,
): Pick<TextInputProps, 'cursorColor' | 'selectionColor' | 'selectionHandleColor'> {
  return {
    cursorColor: theme.color.tint,
    // A see-through highlight keeps the selected text readable.
    selectionColor: withAlpha(theme.color.tint, 0.35),
    selectionHandleColor: theme.color.tint,
  };
}

/** Theme colors for a Switch: the tint when on, a neutral track when off, a white thumb. */
export function switchAccentProps(
  theme: ThemeTokens,
): Pick<SwitchProps, 'trackColor' | 'thumbColor' | 'ios_backgroundColor'> {
  return {
    trackColor: { false: theme.color.separator, true: theme.color.tint },
    thumbColor: '#FFFFFF',
    ios_backgroundColor: theme.color.separator,
  };
}
