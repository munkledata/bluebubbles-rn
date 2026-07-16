import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { StyleSheet, Text } from 'react-native';
import { showDialog } from '@ui/dialog/dialogStore';
import type { Reminder } from '@core/models';
import { getDatabase } from '@db/database';
import { listReminders } from '@db/repositories';
import { useReactiveQuery } from '@db/useReactiveQuery';
import { cancelReminder, rescheduleReminder } from '@/services/notifications/remindersService';
import { ActionListRow, Screen, ScreenHeader, useTheme } from '@ui';
import { pickReminderTime } from '@ui/conversations/pickReminderTime';
import { formatChatDate, formatTime } from '@utils';

/** Saved message reminders, reactive; tap to reschedule, Delete to cancel. */
export default function RemindersScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const { data } = useReactiveQuery<Reminder[]>(
    () => listReminders(getDatabase()),
    ['reminders'],
    [],
  );
  const rows = data ?? [];

  const onReschedule = (r: Reminder): void => {
    void (async () => {
      const when = await pickReminderTime();
      if (when == null) return;
      try {
        await rescheduleReminder(getDatabase(), r, when);
      } catch {
        showDialog('Reminder', 'Couldn’t reschedule the reminder.');
      }
    })();
  };

  const onCancel = (r: Reminder): void => {
    void cancelReminder(getDatabase(), r).catch(() =>
      showDialog('Reminder', 'Couldn’t cancel the reminder.'),
    );
  };

  return (
    <Screen>
      <ScreenHeader title="Reminders" onBack={() => router.back()} />

      <FlashList
        data={rows}
        keyExtractor={(r: Reminder) => String(r.id)}
        renderItem={({ item }: { item: Reminder }) => (
          <ActionListRow
            title={item.messagePreview || 'Message'}
            subtitle={`${formatChatDate(item.scheduledFor)} · ${formatTime(item.scheduledFor)}`}
            onPress={() => onReschedule(item)}
            action={{
              label: 'Delete',
              color: theme.color.destructive,
              onPress: () => onCancel(item),
            }}
          />
        )}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: theme.color.tertiaryLabel }]}>No reminders</Text>
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  empty: { textAlign: 'center', marginTop: 40, fontSize: 15 },
});
