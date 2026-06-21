import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { EnrichedMessage } from '@features/conversations/useMessages';
import {
  formatSeparatorDate,
  sameSender,
  showDateSeparator,
  showSenderHeader,
  showTail,
  statusFor,
} from '@utils';
import { useTheme } from '../theme';
import { MessageBubble } from './MessageBubble';

interface MessageRowProps {
  msg: EnrichedMessage;
  older: EnrichedMessage | null; // chronologically previous
  newer: EnrichedMessage | null; // chronologically next
  isGroup: boolean;
  isLastOutgoing: boolean;
  accentColor?: string | null;
  // Take the message so the list can pass STABLE callbacks (the per-row binding
  // happens here, inside the memoized row, not in the list's renderItem).
  onRetry?: (msg: EnrichedMessage) => void;
  onLongPress?: (msg: EnrichedMessage) => void;
  /** Jump to a replied-to message by its guid (tap the reply quote). */
  onJumpToReply?: (originatorGuid: string) => void;
  /** Briefly flashed when this row is the jump target. */
  isHighlighted?: boolean;
}

/**
 * One message row: optional date separator + sender header + bubble + status.
 * Memoized so the chat screen's frequent state changes (typing, reply, edit,
 * selection) don't re-render every message — only an actual message change does.
 */
export const MessageRow = React.memo(function MessageRow({
  msg,
  older,
  newer,
  isGroup,
  isLastOutgoing,
  accentColor,
  onRetry,
  onLongPress,
  onJumpToReply,
  isHighlighted,
}: MessageRowProps): React.JSX.Element {
  const theme = useTheme();
  const tail = showTail(msg, newer);
  const header = showSenderHeader(msg, older, isGroup);
  const separator = showDateSeparator(msg, older);
  const status = isLastOutgoing ? statusFor(msg) : null;
  const breaksGroup = !older || !sameSender(msg, older);
  // Reaction badges overflow the bubble top; reserve room so they don't clip.
  const hasReactions = (msg.reactions?.length ?? 0) > 0;
  const marginTop = separator || breaksGroup ? 8 : 0;

  const originator = msg.threadOriginatorGuid;
  return (
    <View
      style={[
        { marginTop: Math.max(marginTop, hasReactions ? 16 : 0) },
        isHighlighted ? { backgroundColor: `${theme.color.tint}22`, borderRadius: 8 } : null,
      ]}
    >
      {separator ? (
        <Text style={[styles.separator, { color: theme.color.tertiaryLabel }]}>
          {formatSeparatorDate(msg.dateCreated)}
        </Text>
      ) : null}
      {header ? (
        <Text style={[styles.sender, { color: theme.color.tertiaryLabel }]}>{msg.senderName}</Text>
      ) : null}
      <MessageBubble
        msg={msg}
        showTail={tail}
        accentColor={accentColor}
        onRetry={onRetry ? () => onRetry(msg) : undefined}
        onLongPress={onLongPress ? () => onLongPress(msg) : undefined}
        onJumpToReply={onJumpToReply && originator ? () => onJumpToReply(originator) : undefined}
      />
      {status ? (
        <Text style={[styles.status, { color: theme.color.tertiaryLabel }]}>{status}</Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  separator: { textAlign: 'center', fontSize: 12, marginVertical: 10 },
  sender: { fontSize: 12, marginLeft: 24, marginBottom: 2 },
  status: { fontSize: 11, textAlign: 'right', marginRight: 14, marginTop: 2 },
});
