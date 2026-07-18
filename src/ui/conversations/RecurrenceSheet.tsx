import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Recurrence } from '@core/schedule';
import { useTheme } from '../theme';

interface RecurrenceSheetProps {
  visible: boolean;
  /** Dismiss WITHOUT scheduling (backdrop tap / Cancel / back button). */
  onClose: () => void;
  /** Schedule with the chosen cadence (null = send once). */
  onPick: (recurrence: Recurrence | null) => void;
}

const CHOICES: { label: string; value: Recurrence | null }[] = [
  { label: 'Send once', value: null },
  { label: 'Repeat daily', value: 'daily' },
  { label: 'Repeat weekly', value: 'weekly' },
  { label: 'Repeat monthly', value: 'monthly' },
];

/**
 * Third step of the schedule flow (after the native date + time pickers): choose whether
 * the message repeats. Same plain Modal + Pressable bottom sheet as {@link FailedMessageSheet}.
 */
export function RecurrenceSheet({
  visible,
  onClose,
  onPick,
}: RecurrenceSheetProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        {/* Card: swallow taps so pressing inside doesn't dismiss. */}
        <Pressable
          style={[
            styles.sheet,
            { paddingBottom: insets.bottom + 12, backgroundColor: theme.color.background },
          ]}
          onPress={() => {}}
        >
          <View style={styles.header}>
            <Text style={[styles.title, { color: theme.color.label }]}>Repeat</Text>
            <Text style={[styles.subtitle, { color: theme.color.secondaryLabel }]}>
              Send this message once, or on a schedule.
            </Text>
          </View>
          {CHOICES.map((choice) => (
            <Pressable
              key={choice.label}
              style={[styles.action, { borderTopColor: theme.color.separator }]}
              onPress={() => onPick(choice.value)}
              accessibilityRole="button"
            >
              <Text style={[styles.actionText, { color: theme.color.tint }]}>{choice.label}</Text>
            </Pressable>
          ))}
          <Pressable
            style={[
              styles.action,
              styles.cancel,
              { backgroundColor: theme.color.secondaryBackground },
            ]}
            onPress={onClose}
            accessibilityRole="button"
          >
            <Text style={[styles.actionText, { color: theme.color.tint, fontWeight: '600' }]}>
              Cancel
            </Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: { paddingHorizontal: 16, paddingTop: 4, gap: 0 },
  header: { paddingVertical: 16, alignItems: 'center', gap: 4 },
  title: { fontSize: 17, fontWeight: '700' },
  subtitle: { fontSize: 13, textAlign: 'center' },
  action: { paddingVertical: 14, alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth },
  actionText: { fontSize: 17, fontWeight: '500' },
  cancel: { marginTop: 8, borderTopWidth: 0, borderRadius: 12 },
});
