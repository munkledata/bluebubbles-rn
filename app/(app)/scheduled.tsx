import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { showDialog } from '@ui/dialog/dialogStore';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getDatabase } from '@db/database';
import { listAllScheduled, type ScheduledRow } from '@db/repositories';
import { useReactiveQuery } from '@db/useReactiveQuery';
import { cancelScheduled, syncScheduledFromServer } from '@/services/send';
import { Screen, useTheme } from '@ui';
import { formatChatDate, formatTime } from '@utils';

/** Pending scheduled messages, reactive; each row can be cancelled. */
export default function ScheduledScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // Reconcile server-scheduled rows on open so the list reflects what the server is tracking.
  useEffect(() => {
    void syncScheduledFromServer();
  }, []);
  const { data } = useReactiveQuery<ScheduledRow[]>(
    () => listAllScheduled(getDatabase()),
    ['scheduled_messages'],
    [],
  );
  const rows = data ?? [];

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
        <Text style={[styles.title, { color: theme.color.label }]}>Scheduled</Text>
        <View style={styles.spacer} />
      </View>

      <FlashList
        data={rows}
        keyExtractor={(r: ScheduledRow) => String(r.id)}
        renderItem={({ item }: { item: ScheduledRow }) => (
          <View style={[styles.row, { borderBottomColor: theme.color.separator }]}>
            <Pressable
              style={styles.rowText}
              onPress={() => router.push(`/scheduled-edit/${item.id}`)}
              accessibilityRole="button"
              accessibilityLabel={`Edit scheduled message: ${item.text}`}
            >
              <Text numberOfLines={2} style={[styles.text, { color: theme.color.label }]}>
                {item.text}
              </Text>
              <Text style={[styles.when, { color: theme.color.secondaryLabel }]}>
                {formatChatDate(item.scheduledFor)} · {formatTime(item.scheduledFor)}
              </Text>
            </Pressable>
            <Pressable
              onPress={() =>
                void cancelScheduled(item).catch(() =>
                  showDialog('Scheduled', 'Couldn’t cancel that message.'),
                )
              }
              hitSlop={8}
              style={styles.cancel}
            >
              <Text style={[styles.cancelText, { color: theme.color.destructive }]}>Cancel</Text>
            </Pressable>
          </View>
        )}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: theme.color.tertiaryLabel }]}>
            No scheduled messages
          </Text>
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
