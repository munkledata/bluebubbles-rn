import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { EnrichedMessage } from '@features/conversations/useMessages';
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
import { useRedactedModeStore } from '@state/redactedModeStore';
import {
  formatSeparatorDate,
  redactTitle,
  sameSender,
  showDateSeparator,
  showSenderHeader,
  showTail,
  statusFor,
} from '@utils';
import { Avatar } from '../primitives';
import { useTheme } from '../theme';
import { MessageBubble } from './MessageBubble';
import { overlayPillStyle, overlayTextStyle } from './overlayText';

interface MessageRowProps {
  msg: EnrichedMessage;
  older: EnrichedMessage | null; // chronologically previous
  newer: EnrichedMessage | null; // chronologically next
  isGroup: boolean;
  isLastOutgoing: boolean;
  accentColor?: string | null;
  /** The chat's own outgoing service (from its guid) — colours from-me SMS/RCS bubbles. */
  chatService?: 'iMessage' | 'SMS' | 'RCS' | null;
  /** A chat background is set → back these unbacked, non-bubble texts (date separator,
   *  sender header, status line) with a frosted pill so they stay legible over the image. */
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
  chatService,
  hasBackground,
  onRetry,
  onLongPress,
  onJumpToReply,
  isHighlighted,
}: MessageRowProps): React.JSX.Element {
  const theme = useTheme();
  const redacted = useRedactedModeStore((s) => s.enabled);
  const showTimestamps = useFeatureSettingsStore((s) => s.showDeliveryTimestamps);
  const tail = showTail(msg, newer);
  const header = showSenderHeader(msg, older, isGroup);
  const separator = showDateSeparator(msg, older);
  const status = isLastOutgoing && showTimestamps ? statusFor(msg) : null;
  const breaksGroup = !older || !sameSender(msg, older);
  // Reaction badges overflow the bubble top; reserve room so they don't clip.
  const hasReactions = (msg.reactions?.length ?? 0) > 0;
  const marginTop = separator || breaksGroup ? 8 : 0;

  // Over a wallpaper these non-bubble texts have no backing, so each sits in a frosted pill
  // (same chip language as the header/composer controls) with the theme label colour — the pill
  // supplies the contrast, which a bare halo/shadow can't guarantee on a busy photo.
  const overlay = overlayTextStyle(hasBackground, theme.color.tertiaryLabel, theme.color.label);
  const pill = overlayPillStyle(hasBackground, theme.color.background);

  const originator = msg.threadOriginatorGuid;
  // In a GROUP, received messages get the sender's avatar to their left — but only on the LAST
  // bubble of a consecutive run (the tail); earlier bubbles in the run reserve the same gutter so
  // they stay aligned. Own messages + 1:1 chats need no avatar (it's obvious who's talking).
  const showAvatar = isGroup && msg.isFromMe !== 1;
  const isEdited = !msg.dateRetracted && !!msg.dateEdited;

  const headerNode = header ? (
    <Text style={[styles.sender, overlay, pill ? [styles.senderPill, pill] : null]}>
      {redacted ? redactTitle(msg.senderName ?? '', true) : msg.senderName}
    </Text>
  ) : null;
  const bubbleNode = (
    <MessageBubble
      msg={msg}
      showTail={tail}
      accentColor={accentColor}
      hasBackground={hasBackground}
      chatService={chatService}
      onRetry={onRetry ? () => onRetry(msg) : undefined}
      onLongPress={onLongPress ? () => onLongPress(msg) : undefined}
      onJumpToReply={onJumpToReply && originator ? () => onJumpToReply(originator) : undefined}
      // In the avatar row the avatar aligns to the bubble's bottom; defer "Edited" to below the row
      // (rendered by MessageRow) so the avatar doesn't drop to the label's level.
      deferEdited={showAvatar}
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
        <Text style={[styles.separator, overlay, pill ? [styles.separatorPill, pill] : null]}>
          {formatSeparatorDate(msg.dateCreated)}
        </Text>
      ) : null}
      {showAvatar ? (
        <>
          <View style={styles.avatarRow}>
            <View style={styles.avatarSlot}>
              {tail ? (
                <Avatar
                  name={msg.senderName ?? msg.senderAddress ?? '?'}
                  uri={redacted ? null : msg.senderAvatar}
                  seed={redacted ? (msg.senderAddress ?? msg.senderName ?? '?') : undefined}
                  size={26}
                />
              ) : null}
            </View>
            <View style={styles.bubbleCol}>
              {headerNode}
              {bubbleNode}
            </View>
          </View>
          {/* Below the avatar row so the avatar stays aligned to the bubble, not this label. */}
          {isEdited ? (
            <Text style={[styles.editedAvatar, overlay, pill ? [styles.editedPill, pill] : null]}>
              Edited
            </Text>
          ) : null}
        </>
      ) : (
        <>
          {headerNode}
          {bubbleNode}
        </>
      )}
      {status ? (
        <Text style={[styles.status, overlay, pill ? [styles.statusPill, pill] : null]}>
          {status}
        </Text>
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
  // "Edited" for a group received message, rendered under the avatar row and indented past the
  // avatar gutter (32) + the bubble's own margin (≈14) so it sits under the bubble text.
  editedAvatar: { fontSize: 11, marginTop: 2, marginLeft: 46 },
  // Pill-backed variants (wallpaper set): hug the text instead of stretching full-width, so the
  // frosted chip wraps the label. Alignment moves from textAlign to alignSelf.
  senderPill: { alignSelf: 'flex-start' },
  separatorPill: { alignSelf: 'center' },
  statusPill: { alignSelf: 'flex-end' },
  editedPill: { alignSelf: 'flex-start' },
});
