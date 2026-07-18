import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, Text } from 'react-native';
import { asRecurrence, recurrenceLabel } from '@core/schedule';
import { showDialog } from '@ui/dialog/dialogStore';
import { getDatabase } from '@db/database';
import {
  deleteScheduledHistory,
  listAllScheduled,
  listScheduledHistory,
  type ScheduledRow,
} from '@db/repositories';
import { useReactiveQuery } from '@db/useReactiveQuery';
import { cancelScheduled, syncScheduledFromServer } from '@/services/send';
import { ActionListRow, Screen, ScreenHeader, useTheme } from '@ui';
import { formatChatDate, formatTime } from '@utils';

/** One flat-list item: a scheduled row or the COMPLETED section header. */
type ListItem = { kind: 'header'; key: string; label: string } | { kind: 'row'; row: ScheduledRow };

/**
 * Scheduled messages: PENDING rows (tap to edit, Cancel to drop) plus a COMPLETED history of
 * sent/errored one-time sends — previously a failed scheduled send silently vanished from the UI.
 */
export default function ScheduledScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  // Reconcile server-scheduled rows on open so the list reflects what the server is tracking.
  useEffect(() => {
    void syncScheduledFromServer();
  }, []);
  const { data } = useReactiveQuery<{ pending: ScheduledRow[]; history: ScheduledRow[] }>(
    async () => ({
      pending: await listAllScheduled(getDatabase()),
      history: await listScheduledHistory(getDatabase()),
    }),
    ['scheduled_messages'],
    [],
  );
  const pending = data?.pending ?? [];
  const history = data?.history ?? [];
  const items: ListItem[] = [
    ...pending.map((row): ListItem => ({ kind: 'row', row })),
    ...(history.length > 0
      ? [{ kind: 'header', key: 'completed', label: 'COMPLETED' } as ListItem]
      : []),
    ...history.map((row): ListItem => ({ kind: 'row', row })),
  ];

  const statusLine = (row: ScheduledRow): { label: string; color: string } => {
    if (row.status === 'sent') return { label: '✓ Sent', color: theme.color.tint };
    if (row.status === 'error')
      return { label: '✕ Failed to send', color: theme.color.destructive };
    return {
      label: `${formatChatDate(row.scheduledFor)} · ${formatTime(row.scheduledFor)}`,
      color: theme.color.secondaryLabel,
    };
  };

  const isPendingRow = (row: ScheduledRow): boolean =>
    row.status === 'pending' || row.status === 'sending';

  return (
    <Screen>
      <ScreenHeader title="Scheduled" onBack={() => router.back()} />

      <FlashList
        data={items}
        keyExtractor={(it: ListItem) => (it.kind === 'header' ? it.key : `r-${it.row.id}`)}
        renderItem={({ item }: { item: ListItem }) => {
          if (item.kind === 'header') {
            return (
              <Text style={[styles.sectionLabel, { color: theme.color.secondaryLabel }]}>
                {item.label}
              </Text>
            );
          }
          const row = item.row;
          const status = statusLine(row);
          const pendingRow = isPendingRow(row);
          // Compact recurrence tag, e.g. "· Repeats daily" (null for one-shot rows).
          const rec = asRecurrence(row.recurrence);
          return (
            <ActionListRow
              title={row.text}
              subtitle={`${status.label}${!pendingRow ? ` · ${formatChatDate(row.scheduledFor)}` : ''}${rec ? ` · ${recurrenceLabel(rec)}` : ''}`}
              subtitleColor={status.color}
              disabled={!pendingRow}
              onPress={() => router.push(`/scheduled-edit/${row.id}`)}
              accessibilityLabel={
                pendingRow
                  ? `Edit scheduled message: ${row.text}`
                  : `Scheduled message ${status.label}: ${row.text}`
              }
              action={
                pendingRow
                  ? {
                      label: 'Cancel',
                      color: theme.color.destructive,
                      onPress: () =>
                        void cancelScheduled(row).catch(() =>
                          showDialog('Scheduled', 'Couldn’t cancel that message.'),
                        ),
                    }
                  : {
                      label: 'Clear',
                      color: theme.color.tertiaryLabel,
                      onPress: () => void deleteScheduledHistory(getDatabase(), row.id),
                      accessibilityLabel: 'Remove from history',
                    }
              }
            />
          );
        }}
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
  sectionLabel: { fontSize: 13, marginTop: 24, marginBottom: 4, marginLeft: 16 },
  empty: { textAlign: 'center', marginTop: 40, fontSize: 15 },
});
