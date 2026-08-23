import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { showDialog } from '@ui/dialog/dialogStore';
import type { Reminder } from '@core/models';
import { getDatabase } from '@db/database';
import { listReminders } from '@db/repositories';
import { useReactiveQuery } from '@db/useReactiveQuery';
import { cancelReminder, rescheduleReminder } from '@/services/notifications/remindersService';
import { captureRealtimeDeliveryLease } from '@/services/realtime/deliveryCoordinator';
import { ActionListRow, Screen, ScreenHeader, useTheme } from '@ui';
import { pickReminderTime } from '@ui/conversations/pickReminderTime';
import { reminderSubtitle } from '@utils';

/** Saved message reminders, reactive; tap to reschedule, Delete to cancel. */
export default function RemindersScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const [accountLease] = useState(() => captureRealtimeDeliveryLease());
  const { data } = useReactiveQuery<Reminder[]>(
    () => listReminders(getDatabase()),
    ['reminders'],
    [],
  );
  const rows = data ?? [];

  const onReschedule = (r: Reminder): void => {
    if (!accountLease.isCurrent()) return;
    void (async () => {
      try {
        const when = await pickReminderTime();
        if (when == null || !accountLease.isCurrent()) return;
        await rescheduleReminder(getDatabase(), r, when, undefined, accountLease);
      } catch {
        if (accountLease.isCurrent()) {
          showDialog('Reminder', 'Couldn’t reschedule the reminder.');
        }
      }
    })();
  };

  const onCancel = (r: Reminder): void => {
    void (async () => {
      if (!accountLease.isCurrent()) return;
      try {
        await cancelReminder(getDatabase(), r, undefined, accountLease);
      } catch {
        if (accountLease.isCurrent()) showDialog('Reminder', 'Couldn’t cancel the reminder.');
      }
    })();
  };

  return (
    <Screen>
      <ScreenHeader title="Reminders" onBack={() => router.back()} />

      <FlashList
        data={rows}
        keyExtractor={(r: Reminder) => String(r.id)}
        renderItem={({ item }: { item: Reminder }) => {
          const subtitle = reminderSubtitle(item.scheduledFor);
          return (
            <ActionListRow
              title={item.messagePreview || 'Message'}
              subtitle={subtitle}
              onPress={() => onReschedule(item)}
              action={{
                label: 'Delete',
                color: theme.color.destructive,
                onPress: () => onCancel(item),
              }}
            />
          );
        }}
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
