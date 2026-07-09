import { FlashList, type FlashListRef } from '@shopify/flash-list';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { discardMessage, retry } from '@/services/send';
import type { EnrichedMessage } from '@features/conversations/useMessages';
import { chatServiceFromGuid } from '@utils';
import { usePullToRefresh } from '../primitives';
import { useTheme } from '../theme';
import { MessageRow } from './MessageRow';
import { FailedMessageSheet } from './FailedMessageSheet';
import { overlayPillStyle, overlayTextStyle } from './overlayText';

interface MessageListProps {
  chatGuid: string;
  isGroup: boolean;
  /** Newest-first messages (the chat screen owns the single useMessages subscription). */
  messages: EnrichedMessage[];
  accentColor?: string | null;
  /** A chat background image is set → unbacked overlay text needs a legibility pill. */
  hasBackground?: boolean;
  /** Extra content padding when the list runs under a floating (wallpaper-mode) header, so the
   *  resting scroll positions clear the bar + its edge fade. Also offsets the refresh spinner. */
  topInset?: number;
  /** Same, for the floating composer at the bottom. */
  bottomInset?: number;
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
  topInset = 0,
  bottomInset = 0,
  onLongPressMessage,
  onRefresh,
  focusGuid,
}: MessageListProps): React.JSX.Element {
  const theme = useTheme();
  // Hooks must run unconditionally; a no-op when no refresh action is wired. The element is
  // memoized inside the hook so FlashList's layout stays stable across the frequent re-renders.
  // The spinner offset drops it below a floating header instead of under it.
  const { refreshControl } = usePullToRefresh(
    onRefresh ?? (() => Promise.resolve()),
    topInset || undefined,
  );

  // Resting content clears the floating bars + their edge fades; scrolled content still travels
  // through the padding zones (under the bars), which is what the fades are for.
  const contentStyle = useMemo(
    () => ({ paddingTop: 12 + topInset, paddingBottom: 12 + bottomInset }),
    [topInset, bottomInset],
  );

  // The chat's own outgoing service (from its guid) — from-me rows have no joined handle, so this
  // is what colours an outgoing SMS/RCS bubble. A stable primitive (chatGuid is stable), memo-safe.
  const chatService = useMemo(() => chatServiceFromGuid(chatGuid), [chatGuid]);

  // messages is newest-first; reverse to chronological for display.
  const rows = useMemo(() => messages.slice().reverse(), [messages]);
  // Newest outgoing message = the LAST isFromMe in chronological order.
  const lastOutgoingId = useMemo(
    () => rows.reduce<number>((acc, r) => (r.isFromMe === 1 ? r.id : acc), -1),
    [rows],
  );

  // Stable handlers so the memoized MessageRow isn't re-rendered by a fresh
  // closure on every list update (the row binds the message itself).
  // Tapping the "!" on a not-delivered message opens a themed sheet (Try Again / Delete) instead
  // of silently discarding it. Try Again re-sends — and for a failed picture it RE-UPLOADS the
  // image (from its retained on-disk path), not just the (empty) text.
  const [failed, setFailed] = useState<EnrichedMessage | null>(null);
  const handleRetry = useCallback((m: EnrichedMessage) => setFailed(m), []);
  const failedImage = useMemo(() => {
    const att = failed?.attachments.find((a) => a.localPath);
    return att?.localPath
      ? {
          uri: att.localPath,
          name: att.transferName ?? 'attachment',
          mimeType: att.mimeType ?? 'application/octet-stream',
          size: att.totalBytes ?? 0,
          width: att.width ?? undefined,
          height: att.height ?? undefined,
        }
      : undefined;
  }, [failed]);

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

  // Opened from a search hit → land on that message. The list is bottom-anchored, so an old target
  // is far above the first render and `scrollToIndex` to it silently no-ops (the row isn't measured
  // yet). Instead we REMOUNT the list keyed to the target with `initialScrollIndex` — a reliable
  // mount-time scroll — once the target is in the loaded window. If it's not loaded, the chat just
  // opens normally (no jump).
  const focusIndex = useMemo(
    () => (focusGuid ? rows.findIndex((m) => m.guid === focusGuid) : -1),
    [focusGuid, rows],
  );
  const focusReady = focusGuid != null && focusIndex >= 0;
  // Highlight the target once it's mounted in view (once per target); nudge it toward center.
  const focusedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focusReady || focusedRef.current === focusGuid) return;
    focusedRef.current = focusGuid ?? null;
    setHighlightGuid(focusGuid ?? null);
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlightGuid(null), 3000);
    setTimeout(() => {
      try {
        listRef.current?.scrollToIndex({ index: focusIndex, animated: false, viewPosition: 0.35 });
      } catch {
        // initialScrollIndex already placed it; centering is best-effort.
      }
    }, 450);
  }, [focusReady, focusGuid, focusIndex]);

  // Reveal the user's OWN just-sent message even if they'd scrolled up: when a NEW message from me
  // lands as the chronological tail, jump to the end. (Incoming-while-near-bottom is handled natively
  // by autoscrollToBottomThreshold on the list below; this covers the scrolled-up sender, where that
  // threshold won't fire.) Ref-diff because `rows` is a fresh array on every reactive tick — gate on
  // a genuine append (length grew AND a new tail guid) so in-place updates (sending→sent, localPath
  // writes, reaction joins) and a temp→real guid swap don't re-fire, and the first population just
  // sets the baseline (startRenderingFromBottom already positions the cold render at the bottom).
  const lastTailRef = useRef<{ guid: string | null; len: number }>({ guid: null, len: 0 });
  useEffect(() => {
    const prev = lastTailRef.current;
    const last = rows[rows.length - 1] ?? null;
    const appended = prev.len > 0 && rows.length > prev.len && !!last && last.guid !== prev.guid;
    lastTailRef.current = { guid: last?.guid ?? null, len: rows.length };
    if (appended && last?.isFromMe === 1) {
      listRef.current?.scrollToEnd({ animated: true });
    }
  }, [rows]);

  return (
    <View style={styles.flex}>
      <FlashList
        // Remount keyed to the focus target so initialScrollIndex (mount-time) lands on it.
        key={focusReady ? `focus-${focusGuid}` : 'list'}
        ref={listRef}
        data={rows}
        keyExtractor={(m: EnrichedMessage) => m.guid}
        initialScrollIndex={focusReady ? focusIndex : undefined}
        // startRenderingFromBottom positions the COLD render at the newest message; the threshold is
        // what makes the list auto-follow appended messages (unset → -1 → FlashList never auto-scrolls).
        // 0.2 = auto-scroll to a new bottom row only when the user is within ~20% of a screen of the
        // bottom, so incoming messages reveal themselves without yanking a user reading older history.
        maintainVisibleContentPosition={
          focusReady
            ? undefined
            : { startRenderingFromBottom: true, autoscrollToBottomThreshold: 0.2 }
        }
        refreshControl={onRefresh ? refreshControl : undefined}
        renderItem={({ item, index }: { item: EnrichedMessage; index: number }) => (
          <MessageRow
            msg={item}
            older={rows[index - 1] ?? null}
            newer={rows[index + 1] ?? null}
            isGroup={isGroup}
            accentColor={accentColor}
            chatService={chatService}
            hasBackground={hasBackground}
            isLastOutgoing={item.id === lastOutgoingId}
            onRetry={handleRetry}
            onLongPress={onLongPressMessage}
            onJumpToReply={jumpToReply}
            isHighlighted={item.guid === highlightGuid}
          />
        )}
        contentContainerStyle={contentStyle}
      />
      {rows.length === 0 ? (
        <View style={styles.empty} pointerEvents="none">
          <Text
            style={[
              styles.emptyText,
              overlayTextStyle(hasBackground, theme.color.tertiaryLabel, theme.color.label),
              overlayPillStyle(hasBackground, theme.color.background),
            ]}
          >
            No messages yet
          </Text>
        </View>
      ) : null}
      <FailedMessageSheet
        visible={failed !== null}
        isAttachment={failedImage !== undefined}
        onClose={() => setFailed(null)}
        onRetry={() => {
          if (failed) void retry(failed.guid, { chatGuid, text: failed.text ?? '', image: failedImage });
        }}
        onDelete={() => {
          if (failed) void discardMessage(failed.guid);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
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
