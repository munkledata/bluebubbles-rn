import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import { useTheme } from '../theme';

/** Valid Ionicons name (we use the outline variants for the iOS-styled look). */
export type IconName = ComponentProps<typeof Ionicons>['name'];

interface IconProps {
  name: IconName;
  /** Glyph size in px (default 22 — a comfortable touch-target glyph). */
  size?: number;
  /** Defaults to the theme's primary label color. */
  color?: string;
  style?: StyleProp<TextStyle>;
}

/**
 * The app's single icon primitive — Ionicons (outline set), theme-colored by default.
 * Replaces the ad-hoc emoji/unicode glyphs so icons are crisp, consistent, and don't depend
 * on the platform emoji font. Decorative by default: wrap it in a Pressable that carries the
 * accessibilityLabel (the icon itself announces nothing).
 */
export function Icon({ name, size = 22, color, style }: IconProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <Ionicons
      name={name}
      size={size}
      color={color ?? theme.color.label}
      style={style}
      accessible={false}
    />
  );
}
