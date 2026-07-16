import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme';

interface ActionListRowProps {
  title: string;
  subtitle: string;
  /** Subtitle tint; defaults to the secondary label color. */
  subtitleColor?: string;
  onPress: () => void;
  /** Disables the main press target only — the trailing action stays live. */
  disabled?: boolean;
  accessibilityLabel?: string;
  /** Trailing action button (Delete / Cancel / Clear …). */
  action: {
    label: string;
    color: string;
    onPress: () => void;
    accessibilityLabel?: string;
  };
}

/**
 * A hairline-separated list row: pressable "title + subtitle" body with a trailing
 * action button (the Reminders / Scheduled list scaffold).
 */
export function ActionListRow({
  title,
  subtitle,
  subtitleColor,
  onPress,
  disabled = false,
  accessibilityLabel,
  action,
}: ActionListRowProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={[styles.row, { borderBottomColor: theme.color.separator }]}>
      <Pressable
        style={styles.rowText}
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
      >
        <Text numberOfLines={2} style={[styles.title, { color: theme.color.label }]}>
          {title}
        </Text>
        <Text style={[styles.subtitle, { color: subtitleColor ?? theme.color.secondaryLabel }]}>
          {subtitle}
        </Text>
      </Pressable>
      <Pressable
        onPress={action.onPress}
        hitSlop={8}
        style={styles.action}
        accessibilityRole="button"
        accessibilityLabel={action.accessibilityLabel}
      >
        <Text style={[styles.actionText, { color: action.color }]}>{action.label}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowText: { flex: 1 },
  title: { fontSize: 16 },
  subtitle: { fontSize: 13, marginTop: 3 },
  action: { padding: 4 },
  actionText: { fontSize: 15, fontWeight: '500' },
});
