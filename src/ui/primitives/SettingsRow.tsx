import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { useTheme } from '../theme';

/**
 * The iOS grouped-settings row family. Every row reads its own theme colors and shares
 * the standard 16/14 row padding; place rows inside a `SettingsSection`, which draws the
 * hairline dividers between them.
 */

interface InfoRowProps {
  label: string;
  value: string;
}

/** Static label + right-aligned value (label = theme label, value = secondaryLabel). */
export function InfoRow({ label, value }: InfoRowProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.row}>
      <Text style={[styles.label, { color: theme.color.label }]}>{label}</Text>
      <Text numberOfLines={1} style={[styles.value, { color: theme.color.secondaryLabel }]}>
        {value}
      </Text>
    </View>
  );
}

interface SwitchRowProps {
  label: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  /** Disables the switch and dims the label (for rows gated on another setting). */
  disabled?: boolean;
  accessibilityLabel: string;
}

/** Label + toggle. */
export function SwitchRow({
  label,
  value,
  onValueChange,
  disabled = false,
  accessibilityLabel,
}: SwitchRowProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.row}>
      <Text
        style={[styles.label, { color: disabled ? theme.color.tertiaryLabel : theme.color.label }]}
      >
        {label}
      </Text>
      <Switch
        value={value}
        disabled={disabled}
        onValueChange={onValueChange}
        accessibilityLabel={accessibilityLabel}
      />
    </View>
  );
}

interface NavRowProps {
  label: string;
  onPress: () => void;
  /** Label color: navigation/action rows are tinted by default. */
  color?: 'label' | 'tint' | 'destructive';
  /** Show the trailing › disclosure chevron (default true). */
  chevron?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
}

/** Pressable navigation/action row: colored label + optional disclosure chevron. */
export function NavRow({
  label,
  onPress,
  color = 'tint',
  chevron = true,
  disabled = false,
  accessibilityLabel,
}: NavRowProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={styles.row}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      <Text style={[styles.label, { color: theme.color[color] }]}>{label}</Text>
      {chevron ? (
        <Text style={[styles.trailing, { color: theme.color.tertiaryLabel }]}>›</Text>
      ) : null}
    </Pressable>
  );
}

interface CheckRowProps {
  label: string;
  checked: boolean;
  onPress: () => void;
  disabled?: boolean;
  /** Dim the label (e.g. an option that can't currently be selected). */
  dimmed?: boolean;
  /** Show a spinner in place of the checkmark while the selection saves. */
  loading?: boolean;
}

/** Single-select row: label + trailing checkmark when selected (or spinner while saving). */
export function CheckRow({
  label,
  checked,
  onPress,
  disabled = false,
  dimmed = false,
  loading = false,
}: CheckRowProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={styles.row}
      accessibilityRole="button"
      accessibilityState={{ selected: checked }}
    >
      <Text
        style={[
          styles.label,
          styles.grow,
          { color: dimmed ? theme.color.tertiaryLabel : theme.color.label },
        ]}
      >
        {label}
      </Text>
      {loading ? (
        <ActivityIndicator color={theme.color.tint} />
      ) : checked ? (
        <Text style={[styles.trailing, { color: theme.color.tint }]}>✓</Text>
      ) : null}
    </Pressable>
  );
}

interface StepperRowProps {
  label: string;
  /** Shown between the − / + buttons, already formatted (e.g. 'All'). */
  value: string | number;
  onDecrement: () => void;
  onIncrement: () => void;
  canDecrement: boolean;
  canIncrement: boolean;
  /** Accessibility labels for the − / + buttons. */
  decrementLabel: string;
  incrementLabel: string;
}

/** Label + a − / value / + stepper. */
export function StepperRow({
  label,
  value,
  onDecrement,
  onIncrement,
  canDecrement,
  canIncrement,
  decrementLabel,
  incrementLabel,
}: StepperRowProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.row}>
      <Text style={[styles.label, { color: theme.color.label }]}>{label}</Text>
      <View style={styles.stepper}>
        <Pressable
          onPress={onDecrement}
          disabled={!canDecrement}
          hitSlop={8}
          accessibilityLabel={decrementLabel}
        >
          <Text
            style={[
              styles.stepBtn,
              { color: canDecrement ? theme.color.tint : theme.color.tertiaryLabel },
            ]}
          >
            −
          </Text>
        </Pressable>
        <Text style={[styles.stepValue, { color: theme.color.label }]}>{value}</Text>
        <Pressable
          onPress={onIncrement}
          disabled={!canIncrement}
          hitSlop={8}
          accessibilityLabel={incrementLabel}
        >
          <Text
            style={[
              styles.stepBtn,
              { color: canIncrement ? theme.color.tint : theme.color.tertiaryLabel },
            ]}
          >
            +
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

/** Full-width caption row (an explanatory footnote inside a group). */
export function NoteRow({ text }: { text: string }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.row}>
      <Text style={[styles.note, { color: theme.color.tertiaryLabel }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  label: { fontSize: 16 },
  grow: { flex: 1 },
  value: { fontSize: 15, flexShrink: 1, marginLeft: 16, textAlign: 'right' },
  trailing: { fontSize: 16, fontWeight: '700' },
  note: { fontSize: 13, flex: 1 },
  stepper: { flexDirection: 'row', alignItems: 'center' },
  stepBtn: { fontSize: 24, fontWeight: '500', width: 32, textAlign: 'center' },
  stepValue: { fontSize: 16, fontWeight: '600', minWidth: 24, textAlign: 'center' },
});
