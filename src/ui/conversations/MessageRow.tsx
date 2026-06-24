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
import { Avatar } from '../primitives';
import { useTheme } from '../theme';
import { MessageBubble } from './MessageBubble';

interface MessageRowProps {
  msg: EnrichedMessage;
  older: EnrichedMessage | null; // chronologically previous
  newer: EnrichedMessage | null; // chronologically next
  isGroup: boolean;
  isLastOutgoing: boolean;
  accentColor?: string | null;
  /** A chat background is set → add a subtle text shadow so these unbacked, non-bubble
   *  texts (date separator, sender header, status line) stay legible over the image. */
  hasBackground?: boolean;
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
  hasBackground,
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

  // Over a chat background these non-bubble texts have no backing, so add a soft scrim
  // (a contrasting text shadow) ONLY when a background is set. The shadow colour is the
  // opposite of the text colour so it works on both light + dark backgrounds/themes.
  const scrim = hasBackground
    ? ({
        textShadowColor: theme.mode === 'dark' ? '#000000CC' : '#FFFFFFCC',
        textShadowRadius: 3,
      } as const)
    : null;

  const originator = msg.threadOriginatorGuid;
  // In a GROUP, received messages get the sender's avatar to their left — but only on the LAST
  // bubble of a consecutive run (the tail); earlier bubbles in the run reserve the same gutter so
  // they stay aligned. Own messages + 1:1 chats need no avatar (it's obvious who's talking).
  const showAvatar = isGroup && msg.isFromMe !== 1;

  const headerNode = header ? (
    <Text style={[styles.sender, { color: theme.color.tertiaryLabel }, scrim]}>
      {msg.senderName}
    </Text>
  ) : null;
  const bubbleNode = (
    <MessageBubble
      msg={msg}
      showTail={tail}
      accentColor={accentColor}
      onRetry={onRetry ? () => onRetry(msg) : undefined}
      onLongPress={onLongPress ? () => onLongPress(msg) : undefined}
      onJumpToReply={onJumpToReply && originator ? () => onJumpToReply(originator) : undefined}
    />
  );

  return (
    <View
      style={[
        { marginTop: Math.max(marginTop, hasReactions ? 16 : 0) },
        isHighlighted ? { backgroundColor: `${theme.color.tint}22`, borderRadius: 8 } : null,
      ]}
    >
      {separator ? (
        <Text style={[styles.separator, { color: theme.color.tertiaryLabel }, scrim]}>
          {formatSeparatorDate(msg.dateCreated)}
        </Text>
      ) : null}
      {showAvatar ? (
        <View style={styles.avatarRow}>
          <View style={styles.avatarSlot}>
            {tail ? (
              <Avatar name={msg.senderName ?? msg.senderAddress ?? '?'} uri={msg.senderAvatar} size={26} />
            ) : null}
          </View>
          <View style={styles.bubbleCol}>
            {headerNode}
            {bubbleNode}
          </View>
        </View>
      ) : (
        <>
          {headerNode}
          {bubbleNode}
        </>
      )}
      {status ? (
        <Text style={[styles.status, { color: theme.color.tertiaryLabel }, scrim]}>{status}</Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  separator: { textAlign: 'center', fontSize: 12, marginVertical: 10 },
  sender: { fontSize: 12, marginLeft: 24, marginBottom: 2 },
  status: { fontSize: 11, textAlign: 'right', marginRight: 14, marginTop: 2 },
  // Group received-message layout: [ avatar gutter | sender header + bubble ]. The avatar aligns
  // to the bottom (next to the last bubble of the run); the bubble keeps its own marginHorizontal,
  // so the existing sender marginLeft still lines up within the column.
  avatarRow: { flexDirection: 'row', alignItems: 'flex-end' },
  avatarSlot: { width: 32, paddingLeft: 6, paddingBottom: 3, justifyContent: 'flex-end' },
  bubbleCol: { flex: 1 },
});
