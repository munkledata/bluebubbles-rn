import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Reminder } from '@core/models';
import { getDatabase } from '@db/database';
import { listReminders } from '@db/repositories';
import { useReactiveQuery } from '@db/useReactiveQuery';
import { cancelReminder, rescheduleReminder } from '@/services/notifications/remindersService';
import { Screen, useTheme } from '@ui';
import { pickFutureDateTime } from '@ui/conversations/pickDateTime';
import { formatChatDate, formatTime } from '@utils';

/** Saved message reminders, reactive; tap to reschedule, Delete to cancel. */
export default function RemindersScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { data } = useReactiveQuery<Reminder[]>(
    () => listReminders(getDatabase()),
    ['reminders'],
    [],
  );
  const rows = data ?? [];

  const onReschedule = (r: Reminder): void => {
    void (async () => {
      const when = await pickFutureDateTime();
      if (when == null) return;
      try {
        await rescheduleReminder(getDatabase(), r, when);
      } catch {
        Alert.alert('Reminder', 'Couldn’t reschedule the reminder.');
      }
    })();
  };

  const onCancel = (r: Reminder): void => {
    void cancelReminder(getDatabase(), r).catch(() =>
      Alert.alert('Reminder', 'Couldn’t cancel the reminder.'),
    );
  };

  return (
    <Screen>
      <View
        style={[
          styles.header,
          { paddingTop: insets.top + 8, borderBottomColor: theme.color.separator },
        ]}
      >
        <Pressable onPress={() => router.back()} hitSlop={8}>
          <Text style={[styles.back, { color: theme.color.tint }]}>‹ Back</Text>
        </Pressable>
        <Text style={[styles.title, { color: theme.color.label }]}>Reminders</Text>
        <View style={styles.spacer} />
      </View>

      <FlashList
        data={rows}
        keyExtractor={(r: Reminder) => String(r.id)}
        renderItem={({ item }: { item: Reminder }) => (
          <View style={[styles.row, { borderBottomColor: theme.color.separator }]}>
            <Pressable style={styles.rowText} onPress={() => onReschedule(item)}>
              <Text numberOfLines={2} style={[styles.text, { color: theme.color.label }]}>
                {item.messagePreview || 'Message'}
              </Text>
              <Text style={[styles.when, { color: theme.color.secondaryLabel }]}>
                {formatChatDate(item.scheduledFor)} · {formatTime(item.scheduledFor)}
              </Text>
            </Pressable>
            <Pressable onPress={() => onCancel(item)} hitSlop={8} style={styles.cancel}>
              <Text style={[styles.cancelText, { color: theme.color.destructive }]}>Delete</Text>
            </Pressable>
          </View>
        )}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: theme.color.tertiaryLabel }]}>No reminders</Text>
        }
      />
    </Screen>
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
  back: { fontSize: 17, width: 70 },
  title: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '600' },
  spacer: { width: 70 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowText: { flex: 1 },
  text: { fontSize: 16 },
  when: { fontSize: 13, marginTop: 3 },
  cancel: { padding: 4 },
  cancelText: { fontSize: 15, fontWeight: '500' },
  empty: { textAlign: 'center', marginTop: 40, fontSize: 15 },
});
