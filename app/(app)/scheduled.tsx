import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { asRecurrence, recurrenceLabel } from '@core/schedule';
import { showDialog } from '@ui/dialog/dialogStore';
import { getDatabase } from '@db/database';
import { listAllScheduled, listScheduledHistory, type ScheduledRow } from '@db/repositories';
import { useReactiveQuery } from '@db/useReactiveQuery';
import {
  cancelScheduled,
  clearScheduledHistoryItem,
  syncScheduledFromServer,
} from '@/services/send';
import { captureRealtimeDeliveryLease } from '@/services/realtime/deliveryCoordinator';
import { ActionListRow, Screen, ScreenHeader, useTheme } from '@ui';
import { SCHEDULE_DELIVERY_TIMING_NOTE } from '@ui/conversations/RecurrenceSheet';
import { formatChatDate, formatTime } from '@utils';

/** One flat-list item: a scheduled row or the COMPLETED section header. */
type ListItem = { kind: 'header'; key: string; label: string } | { kind: 'row'; row: ScheduledRow };

/**
 * Scheduled messages: PENDING rows (tap to edit, Cancel to drop) plus a COMPLETED history of
 * sent, errored, and one-time legacy-uncertain sends. Previously a failed scheduled send silently
 * vanished from the UI.
 */
export default function ScheduledScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const [accountLease] = useState(() => captureRealtimeDeliveryLease());
  // Reconcile server-scheduled rows on open so the list reflects what the server is tracking.
  useEffect(() => {
    void syncScheduledFromServer(accountLease);
  }, [accountLease]);
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
    if (row.status === 'uncertain')
      return {
        label: 'Delivery uncertain — check conversation',
        color: theme.color.secondaryLabel,
      };
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
      <Text style={[styles.timingNote, { color: theme.color.secondaryLabel }]}>
        {SCHEDULE_DELIVERY_TIMING_NOTE}
      </Text>

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
          const subtitle = `${status.label}${!pendingRow ? ` · ${formatChatDate(row.scheduledFor)}` : ''}${rec && pendingRow ? ` · ${recurrenceLabel(rec)}` : ''}`;
          return (
            <ActionListRow
              title={row.text}
              subtitle={subtitle}
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
                        void cancelScheduled(row, accountLease).catch(() => {
                          if (accountLease.isCurrent()) {
                            showDialog('Scheduled', 'Couldn’t cancel that message.');
                          }
                        }),
                    }
                  : {
                      label: 'Clear',
                      color: theme.color.tertiaryLabel,
                      onPress: () => {
                        void clearScheduledHistoryItem(row.id, accountLease).catch(() => {
                          if (accountLease.isCurrent()) {
                            showDialog('Scheduled', 'Couldn’t clear that history item.');
                          }
                        });
                      },
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
  timingNote: { fontSize: 13, lineHeight: 18, paddingHorizontal: 16, paddingVertical: 12 },
  sectionLabel: { fontSize: 13, marginTop: 24, marginBottom: 4, marginLeft: 16 },
  empty: { textAlign: 'center', marginTop: 40, fontSize: 15 },
});
