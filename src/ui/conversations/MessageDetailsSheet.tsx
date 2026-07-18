import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRedactedModeStore } from '@state/redactedModeStore';
import { formatSeparatorDate, formatTime, redactTitle } from '@utils';
import { useTheme } from '../theme';
import type { SelectedMessage } from './MessageActionsOverlay';

interface MessageDetailsSheetProps {
  /** The long-pressed message; its presence is the OPEN signal (`null` = closed). */
  data: SelectedMessage | null;
  onClose: () => void;
  /** The chat's own service — used for the Service row when the message carries none (own messages
   *  have no joined handle, so their per-message `senderService` is null). */
  chatService?: 'iMessage' | 'SMS' | 'RCS' | null;
}

/**
 * "Details": a read-only bottom sheet showing a single message's Sent/Delivered/Read/Edited times,
 * who it's from, and the service it used. Same plain Modal + Pressable pattern as EditHistorySheet.
 * Rows with no value are dropped (a received message has no Delivered/Read); the sender name honors
 * redacted mode so the sheet can't leak identity a redacted bubble hides.
 */
export function MessageDetailsSheet({
  data,
  onClose,
  chatService,
}: MessageDetailsSheetProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const redacted = useRedactedModeStore((s) => s.enabled);

  const from = data
    ? data.isFromMe
      ? 'You'
      : redactTitle(data.senderName ?? 'Unknown', redacted)
    : '';
  const service = data ? (data.senderService ?? chatService ?? null) : null;
  // label/value pairs, dropping any with an empty value (formatTime/formatSeparatorDate return ''
  // for a null/0 date, so an undelivered/unread/unedited message simply omits those rows).
  const rows: [string, string][] = data
    ? ([
        ['Sent', formatSeparatorDate(data.dateCreated)],
        ['Delivered', formatTime(data.dateDelivered)],
        ['Read', formatTime(data.dateRead)],
        ['Edited', formatSeparatorDate(data.dateEdited)],
        ['From', from],
        ['Service', service ?? ''],
      ].filter(([, v]) => !!v) as [string, string][])
    : [];

  return (
    <Modal visible={!!data} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable
          style={[
            styles.sheet,
            { paddingBottom: insets.bottom + 12, backgroundColor: theme.color.background },
          ]}
          // Swallow taps inside the sheet so they don't dismiss through to the backdrop.
          onPress={() => undefined}
          accessibilityViewIsModal
        >
          <Text style={[styles.title, { color: theme.color.label }]}>Details</Text>
          {rows.map(([label, value]) => (
            <View key={label} style={[styles.row, { borderTopColor: theme.color.separator }]}>
              <Text style={[styles.label, { color: theme.color.secondaryLabel }]}>{label}</Text>
              <Text style={[styles.value, { color: theme.color.label }]}>{value}</Text>
            </View>
          ))}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingTop: 16,
    paddingHorizontal: 16,
  },
  title: { fontSize: 16, fontWeight: '600', textAlign: 'center', marginBottom: 8 },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 16,
  },
  label: { fontSize: 14, fontWeight: '600' },
  value: { fontSize: 15, flexShrink: 1, textAlign: 'right' },
});
