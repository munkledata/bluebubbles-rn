import React, { type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';

interface ScreenHeaderProps {
  title: string;
  /** Back handler; the ‹ Back button renders only when provided. */
  onBack?: () => void;
  /** Optional right-slot content (fills the fixed-width slot that mirrors the back button). */
  right?: ReactNode;
}

/**
 * iOS-style screen header: safe-area top inset, hairline bottom separator, and an
 * OPTICALLY centered title — the back button and right slot are fixed-width so the
 * flex title stays centered regardless of which side has content.
 */
export function ScreenHeader({ title, onBack, right }: ScreenHeaderProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        styles.header,
        { paddingTop: insets.top + 8, borderBottomColor: theme.color.separator },
      ]}
    >
      <View style={styles.side}>
        {onBack ? (
          <Pressable onPress={onBack} hitSlop={8} accessibilityRole="button">
            <Text style={[styles.back, { color: theme.color.tint }]}>‹ Back</Text>
          </Pressable>
        ) : null}
      </View>
      <Text numberOfLines={1} style={[styles.title, { color: theme.color.label }]}>
        {title}
      </Text>
      <View style={styles.side}>{right}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  side: { width: 70 },
  back: { fontSize: 17 },
  title: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '600' },
});
