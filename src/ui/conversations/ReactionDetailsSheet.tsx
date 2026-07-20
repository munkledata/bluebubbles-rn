import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { reactionMeta } from '@core/reactions/reactionType';
import type { ReactionRow } from '@db/repositories';
import { useRedactedModeStore } from '@state/redactedModeStore';
import { redactTitle } from '@utils';
import { useTheme } from '../theme';

interface ReactionDetailsSheetProps {
  /**
   * The reacted message's reactions, wrapped so the wrapper's presence is the OPEN signal
   * (`null` = closed). Same pattern as EditHistorySheet.
   */
  data: { reactions: ReactionRow[] } | null;
  onClose: () => void;
}

/** The glyph for a reaction row: the classic tapback emoji, or the arbitrary-emoji glyph itself. */
function glyphOf(r: ReactionRow): string {
  return r.baseType === 'emoji' ? (r.emoji ?? '') : reactionMeta(r.baseType).emoji;
}

/**
 * "Who reacted": a tap on a message's reaction badges opens this sheet listing each reactor and the
 * reaction they gave. The badge cluster on the bubble only shows one badge per distinct type (and
 * whether it's yours) — in a group that hides WHO reacted, which this surfaces. Reactor names honor
 * redacted mode (masked like the sender header) so the sheet can't leak identity a redacted thread
 * hides. Same plain Modal + Pressable bottom-sheet pattern as EditHistorySheet.
 */
export function ReactionDetailsSheet({
  data,
  onClose,
}: ReactionDetailsSheetProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const redacted = useRedactedModeStore((s) => s.enabled);
  const reactions = data?.reactions ?? [];

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
          <Text style={[styles.title, { color: theme.color.label }]}>Reactions</Text>
          <ScrollView style={styles.list}>
            {reactions.map((r, i) => {
              const name = r.isFromMe
                ? 'You'
                : redacted
                  ? redactTitle(r.senderName ?? '', true)
                  : (r.senderName ?? 'Unknown');
              return (
                <View
                  key={`${r.isFromMe ? 'me' : (r.senderName ?? '?')}-${r.baseType}-${r.emoji ?? ''}-${i}`}
                  style={[
                    styles.row,
                    i > 0 && {
                      borderTopColor: theme.color.separator,
                      borderTopWidth: StyleSheet.hairlineWidth,
                    },
                  ]}
                >
                  <Text style={styles.glyph}>{glyphOf(r)}</Text>
                  <Text style={[styles.name, { color: theme.color.label }]} numberOfLines={1}>
                    {name}
                  </Text>
                </View>
              );
            })}
            {reactions.length === 0 ? (
              <Text style={[styles.empty, { color: theme.color.secondaryLabel }]}>
                No reactions.
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
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, gap: 12 },
  glyph: { fontSize: 22 },
  name: { fontSize: 16, flexShrink: 1 },
  empty: { fontSize: 15, textAlign: 'center', paddingVertical: 24 },
});
