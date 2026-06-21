import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { ThemeTokens } from './tokens';

interface ThemePreviewCardProps {
  /** The (draft) tokens to preview — re-renders live as edits change them. */
  tokens: ThemeTokens;
}

/**
 * A small live preview of a conversation under the given tokens: a received bubble,
 * a sent bubble, and a tint chip on the theme background. Self-contained mock (does
 * NOT import the heavy MessageBubble) so it stays cheap to re-render on every edit.
 */
export function ThemePreviewCard({ tokens }: ThemePreviewCardProps): React.JSX.Element {
  const c = tokens.color;
  const b = c.bubble;
  return (
    <View
      style={[styles.card, { backgroundColor: c.background, borderColor: c.separator }]}
      accessibilityLabel="Theme preview"
    >
      <View style={styles.row}>
        <View
          style={[styles.bubble, styles.received, { backgroundColor: b.receivedBackgroundTop }]}
        >
          <Text style={[styles.bubbleText, { color: b.receivedText }]}>Like the new theme?</Text>
        </View>
      </View>
      <View style={[styles.row, styles.rowEnd]}>
        <View style={[styles.bubble, styles.sent, { backgroundColor: b.senderBackground }]}>
          <Text style={[styles.bubbleText, { color: b.senderText }]}>Looks great 🎨</Text>
        </View>
      </View>
      <View style={styles.tintRow}>
        <View style={[styles.tintChip, { backgroundColor: c.tint }]} />
        <Text style={[styles.tintLabel, { color: c.secondaryLabel }]}>Tint</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    gap: 8,
    overflow: 'hidden',
  },
  row: { flexDirection: 'row' },
  rowEnd: { justifyContent: 'flex-end' },
  bubble: { maxWidth: '78%', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 18 },
  received: { borderBottomLeftRadius: 6 },
  sent: { borderBottomRightRadius: 6 },
  bubbleText: { fontSize: 15 },
  tintRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  tintChip: { width: 18, height: 18, borderRadius: 9 },
  tintLabel: { fontSize: 13 },
});
