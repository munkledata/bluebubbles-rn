import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme';

interface BubbleProps {
  text: string;
  isFromMe: boolean;
  /** SMS messages render green; iMessage renders blue (sender) / gray (received). */
  service?: 'iMessage' | 'SMS';
}

/**
 * iOS message bubble. Mirrors text_bubble.dart: blue (#1982FC) sender bubbles,
 * gray received bubbles, green for SMS. Tail clipping, reactions, replies, and
 * effects are layered on in the conversation-view feature (Phase 4+).
 */
export function Bubble({ text, isFromMe, service = 'iMessage' }: BubbleProps): React.JSX.Element {
  const theme = useTheme();
  const b = theme.color.bubble;

  const backgroundColor = isFromMe
    ? service === 'SMS'
      ? b.smsBackground
      : b.senderBackground
    : b.receivedBackgroundBottom;
  const color = isFromMe ? b.senderText : b.receivedText;

  return (
    <View
      style={[
        styles.bubble,
        {
          backgroundColor,
          borderRadius: theme.radius.bubble,
          alignSelf: isFromMe ? 'flex-end' : 'flex-start',
        },
      ]}
    >
      <Text style={[styles.text, { color, fontSize: theme.font.size.body }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bubble: {
    maxWidth: '78%',
    paddingVertical: 8,
    paddingHorizontal: 14,
    marginVertical: 2,
    marginHorizontal: 10,
  },
  text: { lineHeight: 22 },
});
