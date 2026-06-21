import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import type { EnrichedMessage } from '@features/conversations/useMessages';
import { useSmartReplies } from '@features/conversations/useSmartReplies';
import { useTheme } from '../theme';

interface SmartReplyChipsProps {
  /** Newest-first messages (from the chat screen's single subscription). */
  messages: EnrichedMessage[];
  /** Tapping a chip sends that text immediately. */
  onPick: (text: string) => void;
}

/** A row of tappable suggested-reply chips shown above the composer. */
export function SmartReplyChips({
  messages,
  onPick,
}: SmartReplyChipsProps): React.JSX.Element | null {
  const theme = useTheme();
  const suggestions = useSmartReplies(messages);
  if (suggestions.length === 0) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.scroll}
      contentContainerStyle={styles.row}
      keyboardShouldPersistTaps="handled"
    >
      {suggestions.map((s) => (
        <Pressable
          key={s}
          onPress={() => onPick(s)}
          style={[
            styles.chip,
            { borderColor: theme.color.tint, backgroundColor: theme.color.secondaryBackground },
          ]}
        >
          <Text style={[styles.chipText, { color: theme.color.tint }]}>{s}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  // flexGrow:0 keeps the horizontal scroller at content height (the message list
  // takes the remaining space); align-items:center stops chips stretching tall.
  scroll: { flexGrow: 0 },
  row: {
    paddingHorizontal: 10,
    paddingBottom: 8,
    gap: 8,
    flexDirection: 'row',
    alignItems: 'center',
  },
  chip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  chipText: { fontSize: 15, fontWeight: '500' },
});
