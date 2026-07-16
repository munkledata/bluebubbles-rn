import React, { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { EnrichedMessage } from '@features/conversations/useMessages';
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
import { useRedactedModeStore } from '@state/redactedModeStore';
import {
  buildGroupEventText,
  formatSeparatorDate,
  formatTime,
  isGroupEvent,
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
import { MessageSwipeWrapper } from './MessageSwipeWrapper';
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
  /** Swipe the bubble right past the threshold → set this message as the reply target. */
  onSwipeReply?: (msg: EnrichedMessage) => void;
  /** Briefly flashed when this row is the jump target. */
  isHighlighted?: boolean;
  /** Multi-select mode: rows show a check circle and taps toggle membership. */
  selecting?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (msg: EnrichedMessage) => void;
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
  onSwipeReply,
  isHighlighted,
  selecting,
  isSelected,
  onToggleSelect,
}: MessageRowProps): React.JSX.Element {
  const theme = useTheme();
  const redacted = useRedactedModeStore((s) => s.enabled);
  const showTimestamps = useFeatureSettingsStore((s) => s.showDeliveryTimestamps);
  // A group/chat event (someone added/left, a rename, …) renders as its own centered line, so it
  // must not merge into a neighbour's same-sender bubble run — treat an adjacent event as absent
  // for grouping (a normal message next to one still gets its header/tail). The real `older` is
  // kept for the date separator so an event doesn't spawn a spurious one.
  const olderMsg = older && !isGroupEvent(older) ? older : null;
  const newerMsg = newer && !isGroupEvent(newer) ? newer : null;
  const tail = showTail(msg, newerMsg);
  const header = showSenderHeader(msg, olderMsg, isGroup);
  const separator = showDateSeparator(msg, older);
  const status = isLastOutgoing && showTimestamps ? statusFor(msg) : null;
  const breaksGroup = !olderMsg || !sameSender(msg, olderMsg);
  // Reaction badges overflow the bubble top; reserve room so they don't clip.
  const hasReactions = (msg.reactions?.length ?? 0) > 0;
  const marginTop = separator || breaksGroup ? 8 : 0;

  // Over a wallpaper these non-bubble texts have no backing, so each sits in a frosted pill
  // (same chip language as the header/composer controls) with the theme label colour — the pill
  // supplies the contrast, which a bare halo/shadow can't guarantee on a busy photo.
  const overlay = overlayTextStyle(hasBackground, theme.color.tertiaryLabel, theme.color.label);
  const pill = overlayPillStyle(hasBackground, theme.color.background);

  // Per-row bindings for the memoized MessageBubble, stable while `msg` and the (already stable)
  // outer handlers are unchanged — a fresh arrow per render would defeat the bubble's memo.
  const originator = msg.threadOriginatorGuid;
  const handleRetry = useCallback(() => onRetry?.(msg), [onRetry, msg]);
  const handleLongPress = useCallback(() => onLongPress?.(msg), [onLongPress, msg]);
  const handleJumpToReply = useCallback(() => {
    if (originator) onJumpToReply?.(originator);
  }, [onJumpToReply, originator]);
  const handleSwipeReply = useCallback(() => onSwipeReply?.(msg), [onSwipeReply, msg]);

  // Group / chat-event system message → a centered event line instead of a bubble. Every name in
  // the line (the actor, the affected participant, and a renamed-to title) can leak identity, so
  // each is masked under redacted mode.
  if (isGroupEvent(msg)) {
    const eventText = buildGroupEventText({
      itemType: msg.itemType,
      groupActionType: msg.groupActionType,
      groupTitle: redacted && msg.groupTitle != null ? '…' : msg.groupTitle,
      otherHandleName:
        redacted && msg.otherHandleName
          ? redactTitle(msg.otherHandleName, true)
          : msg.otherHandleName,
      senderName: redacted ? redactTitle(msg.senderName ?? '', true) : msg.senderName,
      isFromMe: msg.isFromMe,
    });
    return (
      <View style={{ marginTop: separator ? 8 : 4 }}>
        {separator ? (
          <Text style={[styles.separator, overlay, pill ? [styles.separatorPill, pill] : null]}>
            {formatSeparatorDate(msg.dateCreated)}
          </Text>
        ) : null}
        <Text style={[styles.groupEvent, overlay, pill ? [styles.groupEventPill, pill] : null]}>
          {eventText}
        </Text>
      </View>
    );
  }

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
      onRetry={onRetry ? handleRetry : undefined}
      onLongPress={onLongPress ? handleLongPress : undefined}
      onJumpToReply={onJumpToReply && originator ? handleJumpToReply : undefined}
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
        selecting ? styles.selectingRow : null,
      ]}
    >
      {separator ? (
        <Text style={[styles.separator, overlay, pill ? [styles.separatorPill, pill] : null]}>
          {formatSeparatorDate(msg.dateCreated)}
        </Text>
      ) : null}
      {/* Horizontal swipe on the bubble content: drag left peeks this message's sent time; drag
          right past the threshold sets it as the reply target. The separator + status stay put. */}
      <MessageSwipeWrapper
        timestamp={formatTime(msg.dateCreated ?? 0)}
        onReply={onSwipeReply ? handleSwipeReply : undefined}
      >
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
      </MessageSwipeWrapper>
      {status ? (
        <Text style={[styles.status, overlay, pill ? [styles.statusPill, pill] : null]}>
          {status}
        </Text>
      ) : null}
      {selecting ? (
        <>
          {/* Check circle in the gutter the selectingRow padding opens up. */}
          <View
            style={[
              styles.selectCheck,
              isSelected
                ? { backgroundColor: theme.color.tint, borderColor: theme.color.tint }
                : { borderColor: theme.color.tertiaryLabel },
            ]}
            pointerEvents="none"
          >
            {isSelected ? <Text style={styles.selectCheckMark}>✓</Text> : null}
          </View>
          {/* Full-row tap target: in select mode taps toggle membership (and the overlay
              intentionally blocks the bubble's own press/long-press interactions). */}
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={onToggleSelect ? () => onToggleSelect(msg) : undefined}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: !!isSelected }}
            accessibilityLabel={isSelected ? 'Deselect message' : 'Select message'}
          />
        </>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  separator: { textAlign: 'center', fontSize: 12, marginVertical: 10 },
  // Centered group/chat-event line (e.g. "Alice added Bob to the conversation.").
  groupEvent: { textAlign: 'center', fontSize: 12, marginVertical: 4, paddingHorizontal: 24 },
  groupEventPill: { alignSelf: 'center' },
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
  // Multi-select: pad a left gutter for the check circle; the absolute-fill Pressable captures taps.
  selectingRow: { paddingLeft: 34 },
  selectCheck: {
    position: 'absolute',
    left: 8,
    top: '50%',
    marginTop: -11,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectCheckMark: { color: '#fff', fontSize: 13, fontWeight: '700' },
  // Pill-backed variants (wallpaper set): hug the text instead of stretching full-width, so the
  // frosted chip wraps the label. Alignment moves from textAlign to alignSelf.
  senderPill: { alignSelf: 'flex-start' },
  separatorPill: { alignSelf: 'center' },
  statusPill: { alignSelf: 'flex-end' },
  editedPill: { alignSelf: 'flex-start' },
});
