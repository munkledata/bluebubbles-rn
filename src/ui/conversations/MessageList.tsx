import { FlashList, type FlashListRef } from '@shopify/flash-list';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { retry } from '@/services/send';
import type { EnrichedMessage } from '@features/conversations/useMessages';
import { useTheme } from '../theme';
import { MessageRow } from './MessageRow';

interface MessageListProps {
  chatGuid: string;
  isGroup: boolean;
  /** Newest-first messages (the chat screen owns the single useMessages subscription). */
  messages: EnrichedMessage[];
  accentColor?: string | null;
  /** A chat background image is set → unbacked overlay text needs a legibility scrim. */
  hasBackground?: boolean;
  onLongPressMessage?: (msg: EnrichedMessage) => void;
}

// FlashList v2 has no `inverted`; render chronological (oldest→newest) and start
// from the bottom so the newest message is visible and the list stays pinned.
export function MessageList({
  chatGuid,
  isGroup,
  messages,
  accentColor,
  hasBackground,
  onLongPressMessage,
}: MessageListProps): React.JSX.Element {
  const theme = useTheme();

  // messages is newest-first; reverse to chronological for display.
  const rows = useMemo(() => messages.slice().reverse(), [messages]);
  // Newest outgoing message = the LAST isFromMe in chronological order.
  const lastOutgoingId = useMemo(
    () => rows.reduce<number>((acc, r) => (r.isFromMe === 1 ? r.id : acc), -1),
    [rows],
  );

  // Stable handlers so the memoized MessageRow isn't re-rendered by a fresh
  // closure on every list update (the row binds the message itself).
  const handleRetry = useCallback(
    (m: EnrichedMessage) => void retry(m.guid, { chatGuid, text: m.text ?? '' }),
    [chatGuid],
  );

  // Tap a reply quote → scroll to the original message + briefly highlight it.
  const listRef = useRef<FlashListRef<EnrichedMessage>>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [highlightGuid, setHighlightGuid] = useState<string | null>(null);
  const jumpToReply = useCallback((originatorGuid: string): void => {
    const index = rowsRef.current.findIndex((m) => m.guid === originatorGuid);
    if (index < 0) return; // the original isn't in the loaded window
    listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.4 });
    setHighlightGuid(originatorGuid);
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlightGuid(null), 1600);
  }, []);

  return (
    <View style={styles.flex}>
      <FlashList
        ref={listRef}
        data={rows}
        keyExtractor={(m: EnrichedMessage) => m.guid}
        maintainVisibleContentPosition={{ startRenderingFromBottom: true }}
        renderItem={({ item, index }: { item: EnrichedMessage; index: number }) => (
          <MessageRow
            msg={item}
            older={rows[index - 1] ?? null}
            newer={rows[index + 1] ?? null}
            isGroup={isGroup}
            accentColor={accentColor}
            hasBackground={hasBackground}
            isLastOutgoing={item.id === lastOutgoingId}
            onRetry={handleRetry}
            onLongPress={onLongPressMessage}
            onJumpToReply={jumpToReply}
            isHighlighted={item.guid === highlightGuid}
          />
        )}
        contentContainerStyle={styles.content}
      />
      {rows.length === 0 ? (
        <View style={styles.empty} pointerEvents="none">
          <Text style={[styles.emptyText, { color: theme.color.tertiaryLabel }]}>
            No messages yet
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingVertical: 12 },
  empty: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: { fontSize: 15 },
});
