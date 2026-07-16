import React, { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getDatabase } from '@db/database';
import { listThreadMessages, type MessageRow } from '@db/repositories';
import { useRedactedModeStore } from '@state/redactedModeStore';
import { formatTime, redactMessageText, redactTitle } from '@utils';
import { useTheme } from '../theme';

interface ThreadSheetProps {
  /** The thread originator's guid (null → hidden). */
  originatorGuid: string | null;
  onClose: () => void;
  /** Tap a row → jump the chat to that message. */
  onJump: (msg: { guid: string; dateCreated: number }) => void;
}

/**
 * "View Thread": the reply chain (originator + every reply) as a bottom sheet — the in-bubble
 * reply quote only shows the immediate parent, so this is where a whole thread is readable.
 * Same plain Modal + Pressable pattern as MessageActionsOverlay.
 */
export function ThreadSheet({
  originatorGuid,
  onClose,
  onJump,
}: ThreadSheetProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const redacted = useRedactedModeStore((s) => s.enabled);
  const [rows, setRows] = useState<MessageRow[]>([]);

  useEffect(() => {
    let alive = true;
    if (!originatorGuid) {
      setRows([]);
      return;
    }
    void listThreadMessages(getDatabase(), originatorGuid).then((r) => {
      if (alive) setRows(r);
    });
    return () => {
      alive = false;
    };
  }, [originatorGuid]);

  return (
    <Modal visible={!!originatorGuid} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable
          style={[
            styles.sheet,
            { paddingBottom: insets.bottom + 12, backgroundColor: theme.color.background },
          ]}
          // Swallow taps inside the sheet so they don't dismiss through to the backdrop.
          onPress={() => undefined}
        >
          <Text style={[styles.title, { color: theme.color.label }]}>
            Thread · {Math.max(rows.length - 1, 0)} {rows.length - 1 === 1 ? 'reply' : 'replies'}
          </Text>
          <ScrollView style={styles.list}>
            {rows.map((m, i) => {
              const who =
                m.isFromMe === 1 ? 'You' : redactTitle(m.senderName ?? 'Unknown', redacted);
              return (
                <Pressable
                  key={m.guid}
                  onPress={() => {
                    onClose();
                    if (m.dateCreated != null) onJump({ guid: m.guid, dateCreated: m.dateCreated });
                  }}
                  style={[
                    styles.row,
                    i > 0 && {
                      borderTopColor: theme.color.separator,
                      borderTopWidth: StyleSheet.hairlineWidth,
                    },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={`Jump to ${who}'s message`}
                >
                  <View style={styles.rowHead}>
                    <Text style={[styles.who, { color: theme.color.secondaryLabel }]}>
                      {who}
                      {i === 0 ? ' · original' : ''}
                    </Text>
                    <Text style={[styles.when, { color: theme.color.tertiaryLabel }]}>
                      {formatTime(m.dateCreated ?? 0)}
                    </Text>
                  </View>
                  <Text numberOfLines={3} style={[styles.body, { color: theme.color.label }]}>
                    {redacted ? redactMessageText(m.text, true) : (m.text ?? '📎 Attachment')}
                  </Text>
                </Pressable>
              );
            })}
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
  row: { paddingVertical: 10 },
  rowHead: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 },
  who: { fontSize: 12, fontWeight: '600' },
  when: { fontSize: 12 },
  body: { fontSize: 15, lineHeight: 20 },
});
