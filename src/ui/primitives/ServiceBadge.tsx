import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme';

interface ServiceBadgeProps {
  /** Badge label, e.g. "RCS". */
  label: string;
  /** Fill color; defaults to the theme's RCS green. */
  color?: string;
  /** Label color; defaults to white (RCS passes a pale gator-green for its deep-green pill). */
  textColor?: string;
}

/**
 * A small pill that surfaces a non-iMessage service (currently RCS) on a conversation header/tile.
 * Kept subtle + iOS-styled: uppercase caption on a tinted rounded chip. Non-focusable — the
 * adjacent title already announces the chat, so the badge is decorative-by-default under TalkBack.
 */
export function ServiceBadge({ label, color, textColor }: ServiceBadgeProps): React.JSX.Element {
  const theme = useTheme();
  const bg = color ?? theme.color.bubble.rcsBackground ?? theme.color.bubble.smsBackground;
  return (
    <View
      style={[styles.badge, { backgroundColor: bg }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Text style={[styles.text, textColor ? { color: textColor } : null]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    alignSelf: 'center',
  },
  text: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
});
