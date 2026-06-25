import { FlashList, type FlashListRef } from '@shopify/flash-list';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { retry } from '@/services/send';
import type { EnrichedMessage } from '@features/conversations/useMessages';
import { usePullToRefresh } from '../primitives';
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
  /** Pull-to-refresh action (re-sync this thread). Omit to disable the gesture. */
  onRefresh?: () => Promise<unknown>;
  /** A message guid to scroll to + highlight once on open (set when arriving from a search hit). */
  focusGuid?: string;
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
  onRefresh,
  focusGuid,
}: MessageListProps): React.JSX.Element {
  const theme = useTheme();
  // Hooks must run unconditionally; a no-op when no refresh action is wired. The element is
  // memoized inside the hook so FlashList's layout stays stable across the frequent re-renders.
  const { refreshControl } = usePullToRefresh(onRefresh ?? (() => Promise.resolve()));

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

  // Opened from a search hit → once the target row is loaded, scroll to + highlight it (once per
  // target). Runs when `rows` first include the guid (loads are async). The timer is intentionally
  // NOT cleared on a reactive `rows` update — that mustn't cancel the one-shot jump; `focusedRef`
  // bounds it to one scroll per target. If the target is outside the loaded window, this no-ops and
  // the chat just opens normally.
  const focusedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focusGuid || focusedRef.current === focusGuid) return;
    const index = rows.findIndex((m) => m.guid === focusGuid);
    if (index < 0) return;
    focusedRef.current = focusGuid;
    setTimeout(() => {
      listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.4 });
      setHighlightGuid(focusGuid);
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
      highlightTimer.current = setTimeout(() => setHighlightGuid(null), 2200);
    }, 350);
  }, [focusGuid, rows]);

  return (
    <View style={styles.flex}>
      <FlashList
        ref={listRef}
        data={rows}
        keyExtractor={(m: EnrichedMessage) => m.guid}
        maintainVisibleContentPosition={{ startRenderingFromBottom: true }}
        refreshControl={onRefresh ? refreshControl : undefined}
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
