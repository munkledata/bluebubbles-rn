import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { MessageSummaryInfo } from '@core/models';
import { useRedactedModeStore } from '@state/redactedModeStore';
import { formatSeparatorDate, redactMessageText } from '@utils';
import { useTheme } from '../theme';

interface EditHistorySheetProps {
  /**
   * The selected message's parsed edit history, wrapped so the wrapper's presence is the OPEN
   * signal (`null` = closed) independent of whether there's any `info` to show — an optimistic
   * local edit sets dateEdited but has no synced summary info yet, and that must still open (to an
   * empty state) rather than being indistinguishable from "closed".
   */
  data: { info: MessageSummaryInfo | null } | null;
  onClose: () => void;
}

/** Sort part-index keys (JSON object keys are strings) numerically ascending. */
function sortedPartEntries(
  editedParts: MessageSummaryInfo['editedParts'],
): [string, NonNullable<MessageSummaryInfo['editedParts']>[string]][] {
  if (!editedParts) return [];
  return Object.entries(editedParts).sort(([a], [b]) => Number(a) - Number(b));
}

/**
 * "View Edit History": the per-part revision timeline for an edited message (Apple
 * `message_summary_info`), plus a "part removed" row for each unsent part. The bubble only ever
 * shows the CURRENT text with an "Edited" label — this is where the full timeline is readable.
 * Same plain Modal + Pressable bottom-sheet pattern as ThreadSheet; revision bodies honor redacted
 * mode exactly like the message bubble (content → "Message") so the sheet can't leak text a
 * redacted bubble hides.
 */
export function EditHistorySheet({ data, onClose }: EditHistorySheetProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const redacted = useRedactedModeStore((s) => s.enabled);

  const parts = sortedPartEntries(data?.info?.editedParts);
  const retracted = data?.info?.retractedParts ?? [];
  const multiPart = parts.length > 1;
  const isEmpty = parts.length === 0 && retracted.length === 0;

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
          <Text style={[styles.title, { color: theme.color.label }]}>Edit History</Text>
          <ScrollView style={styles.list}>
            {parts.map(([partKey, revisions]) => (
              <View key={`part-${partKey}`} style={styles.part}>
                {multiPart ? (
                  <Text style={[styles.partHeader, { color: theme.color.secondaryLabel }]}>
                    Part {Number(partKey) + 1}
                  </Text>
                ) : null}
                {revisions.map((rev, i) => {
                  // Original → current: index 0 is the original text, later entries are edits.
                  const label = i === 0 ? 'Original' : 'Edited';
                  const when = rev.date != null ? formatSeparatorDate(rev.date) : '';
                  return (
                    <View
                      key={`rev-${partKey}-${i}`}
                      style={[
                        styles.row,
                        i > 0 && {
                          borderTopColor: theme.color.separator,
                          borderTopWidth: StyleSheet.hairlineWidth,
                        },
                      ]}
                    >
                      <View style={styles.rowHead}>
                        <Text style={[styles.who, { color: theme.color.secondaryLabel }]}>
                          {label}
                        </Text>
                        {when ? (
                          <Text style={[styles.when, { color: theme.color.tertiaryLabel }]}>
                            {when}
                          </Text>
                        ) : null}
                      </View>
                      <Text style={[styles.body, { color: theme.color.label }]}>
                        {redactMessageText(rev.text, redacted)}
                      </Text>
                    </View>
                  );
                })}
              </View>
            ))}
            {retracted.map((idx) => (
              <View key={`removed-${idx}`} style={styles.removedRow}>
                <Text style={[styles.removed, { color: theme.color.secondaryLabel }]}>
                  Part {idx + 1} removed
                </Text>
              </View>
            ))}
            {isEmpty ? (
              <Text style={[styles.empty, { color: theme.color.secondaryLabel }]}>
                No edit history.
              </Text>
            ) : null}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: {
    maxHeight: '70%',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingTop: 16,
    paddingHorizontal: 16,
  },
  title: { fontSize: 16, fontWeight: '600', textAlign: 'center', marginBottom: 8 },
  list: { flexGrow: 0 },
  part: { marginBottom: 4 },
  partHeader: { fontSize: 12, fontWeight: '700', marginTop: 8, marginBottom: 2 },
  row: { paddingVertical: 10 },
  rowHead: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 },
  who: { fontSize: 12, fontWeight: '600' },
  when: { fontSize: 12 },
  body: { fontSize: 15, lineHeight: 20 },
  removedRow: { paddingVertical: 10, borderTopColor: 'transparent' },
  removed: { fontSize: 14, fontStyle: 'italic' },
  empty: { fontSize: 15, textAlign: 'center', paddingVertical: 24 },
});
