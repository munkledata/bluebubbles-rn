import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import type { MessagePreview } from '@db/repositories';
import { useTheme } from '../theme';

interface ReplyQuoteProps {
  preview: MessagePreview;
  isFromMe: boolean;
  /** Tap to jump to the original message (set when the original is in the list). */
  onPress?: () => void;
}

/** A dimmed preview of the original message, shown above a reply bubble. Tappable. */
export function ReplyQuote({ preview, isFromMe, onPress }: ReplyQuoteProps): React.JSX.Element {
  const theme = useTheme();
  const who = preview.isFromMe === 1 ? 'You' : (preview.senderName ?? 'Unknown');
  const text = preview.text || (preview.hasAttachments === 1 ? '📎 Attachment' : '');

  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={[
        styles.wrap,
        { alignSelf: isFromMe ? 'flex-end' : 'flex-start', borderLeftColor: theme.color.tint },
      ]}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={onPress ? `Reply to ${who}. Tap to jump to the original.` : undefined}
    >
      <Text numberOfLines={1} style={[styles.who, { color: theme.color.secondaryLabel }]}>
        {who}
      </Text>
      <Text numberOfLines={2} style={[styles.text, { color: theme.color.tertiaryLabel }]}>
        {text}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    maxWidth: '70%',
    borderLeftWidth: 2,
    paddingLeft: 8,
    marginHorizontal: 14,
    marginBottom: 3,
    opacity: 0.95,
  },
  who: { fontSize: 11, fontWeight: '600' },
  text: { fontSize: 13, lineHeight: 17 },
});
