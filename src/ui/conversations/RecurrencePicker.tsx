import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Recurrence } from '@core/schedule';
import { useTheme } from '../theme';

const OPTIONS: { label: string; value: Recurrence | null }[] = [
  { label: 'None', value: null },
  { label: 'Daily', value: 'daily' },
  { label: 'Weekly', value: 'weekly' },
  { label: 'Monthly', value: 'monthly' },
];

/**
 * Segmented recurrence chips (None / Daily / Weekly / Monthly) for a scheduled message.
 * Presentation-only: the parent owns the selection state.
 */
export function RecurrencePicker({
  value,
  onChange,
}: {
  value: Recurrence | null;
  onChange: (value: Recurrence | null) => void;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.row} accessibilityRole="radiogroup" accessibilityLabel="Repeat">
      {OPTIONS.map((opt) => {
        const selected = value === opt.value;
        return (
          <Pressable
            key={opt.label}
            onPress={() => onChange(opt.value)}
            accessibilityRole="button"
            accessibilityLabel={`Repeat ${opt.label.toLowerCase()}`}
            accessibilityState={{ selected }}
            style={[
              styles.chip,
              {
                backgroundColor: selected ? theme.color.tint : theme.color.secondaryBackground,
              },
            ]}
          >
            <Text
              style={[styles.chipText, { color: selected ? '#fff' : theme.color.label }]}
              numberOfLines={1}
            >
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 8 },
  chip: {
    flex: 1,
    borderRadius: 16,
    paddingVertical: 8,
    alignItems: 'center',
  },
  chipText: { fontSize: 14, fontWeight: '500' },
});
