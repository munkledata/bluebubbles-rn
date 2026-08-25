import { FlashList, type FlashListRef } from '@shopify/flash-list';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { discardMessage, retry } from '@/services/send';
import {
  captureRealtimeDeliveryLease,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import type { EnrichedMessage } from '@features/conversations/useMessages';
import {
  chatServiceFromGuid,
  initialPinState,
  isGroupEvent,
  pinExplicitly,
  pinOnDragStart,
  pinOnMomentumEnd,
  pinOnScroll,
  unpinExplicitly,
  type BubbleRect,
  type ScrollPinState,
} from '@utils';
import {
  useReduceMotionPreference,
  useReduceMotionPreferenceRef,
} from '../hooks/useReduceMotionPreference';
import { usePullToRefresh } from '../primitives';
import { readableTextOn, useTheme, withAlpha } from '../theme';
import { MessageRow } from './MessageRow';
import { FailedMessageSheet } from './FailedMessageSheet';
import { ReactionDetailsSheet } from './ReactionDetailsSheet';
import { overlayPillStyle, overlayTextStyle } from './overlayText';

interface MessageListProps {
  chatGuid: string;
  isGroup: boolean;
  /** Newest-first messages (the chat screen owns the single useMessages subscription). */
  messages: EnrichedMessage[];
  accentColor?: string | null;
  /**
   * The chat's own outgoing service, resolved by the chat screen from the guid AND the participant
   * handle service (so an SMS-only thread reported with an `iMessage;-;` guid still colours its
   * from-me bubbles green). Omit → fall back to the guid prefix alone.
   */
  chatService?: 'iMessage' | 'SMS' | 'RCS' | null;
  /** A chat background image is set → unbacked overlay text needs a legibility pill. */
  hasBackground?: boolean;
  /** Extra content padding when the list runs under a floating (wallpaper-mode) header, so the
   *  resting scroll positions clear the bar + its edge fade. Also offsets the refresh spinner. */
  topInset?: number;
  /** Same, for the floating composer at the bottom. */
  bottomInset?: number;
  onLongPressMessage?: (msg: EnrichedMessage, rect: BubbleRect) => void;
  /** Swipe a bubble right past the threshold → set it as the reply target. */
  onSwipeReply?: (msg: EnrichedMessage) => void;
  /** Pull-to-refresh action (re-sync this thread). Omit to disable the gesture. */
  onRefresh?: () => Promise<unknown>;
  /** Scrolled to the OLDEST loaded message → grow the window (load older history). Omit or return
   *  when there's nothing more to load. */
  onLoadOlder?: () => void;
  /** A message guid to scroll to + highlight once on open (set when arriving from a search hit). */
  focusGuid?: string;
  /** Multi-select mode: the selected guids (null/undefined = off) + the toggle callback. */
  selectedGuids?: Set<string> | null;
  onToggleSelect?: (msg: EnrichedMessage) => void;
  /** Present while the list shows an ANCHORED window (search hit / unread jump): the scroll-to-
   *  bottom button becomes an exit hatch — the screen clears the anchor and the chat returns to
   *  the live newest window. The window's own bottom is NOT the newest message, so a plain
   *  scrollToEnd would lie. */
  onExitAnchor?: () => void;
  /** Mount-account lease for delayed failed-message sheet actions. */
  accountLease?: RealtimeDeliveryLease;
}

function distFromBottomOf(e: NativeSyntheticEvent<NativeScrollEvent>): number {
  const { contentSize, contentOffset, layoutMeasurement } = e.nativeEvent;
  return contentSize.height - contentOffset.y - layoutMeasurement.height;
}

// FlashList v2 has no `inverted`; render chronological (oldest→newest) and start
// from the bottom so the newest message is visible and the list stays pinned
// (the scrollPin convergence loop below is what "pinned" means).
export function MessageList({
  chatGuid,
  isGroup,
  messages,
  accentColor,
  chatService: chatServiceProp,
  hasBackground,
  topInset = 0,
  bottomInset = 0,
  onLongPressMessage,
  onSwipeReply,
  onRefresh,
  onLoadOlder,
  focusGuid,
  selectedGuids,
  onToggleSelect,
  onExitAnchor,
  accountLease,
}: MessageListProps): React.JSX.Element {
  const theme = useTheme();
  const reduceMotion = useReduceMotionPreference();
  const reduceMotionRef = useReduceMotionPreferenceRef();
  const [screenLease] = useState(() => accountLease ?? captureRealtimeDeliveryLease());
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

  // The chat's own outgoing service — from-me rows have no joined handle, so this is what colours an
  // outgoing SMS/RCS bubble. Prefer the handle-resolved value the screen passes; else the guid prefix.
  const chatService = chatServiceProp ?? chatServiceFromGuid(chatGuid);

  // messages is newest-first; reverse to chronological for display.
  const rows = useMemo(() => messages.slice().reverse(), [messages]);
  // Newest outgoing message = the LAST isFromMe in chronological order. Skip group events (an own
  // "You named the conversation" is isFromMe but carries no delivery status).
  const lastOutgoingId = useMemo(
    () => rows.reduce<number>((acc, r) => (r.isFromMe === 1 && !isGroupEvent(r) ? r.id : acc), -1),
    [rows],
  );

  // Stable handlers so the memoized MessageRow isn't re-rendered by a fresh
  // closure on every list update (the row binds the message itself).
  // Tapping the "!" on a not-delivered message opens a themed sheet (Try Again / Delete) instead
  // of silently discarding it. Try Again re-sends — and for a failed picture it RE-UPLOADS the
  // image (from its retained on-disk path), not just the (empty) text.
  // Held by GUID, then re-read from the live rows on every reactive tick — never as a frozen copy
  // of the message. The automatic retry drain runs every 20 s and flips a failed bubble to
  // 'sending' before its POST, so a snapshot taken when the sheet opened goes stale while the
  // sheet is still on screen, and Try Again / Delete then act on a message that is mid-flight or
  // already delivered. The sheet closes itself the moment its row stops being a failed one.
  const [failedGuid, setFailedGuid] = useState<string | null>(null);
  const failed = useMemo(
    () => (failedGuid ? (rows.find((m) => m.guid === failedGuid) ?? null) : null),
    [failedGuid, rows],
  );
  const stillFailed = failed != null && (failed.sendState === 'error' || failed.error !== 0);
  // Render-phase reset (React's "adjust state when the data changes" pattern), not an effect: the
  // target must be FORGOTTEN, not merely hidden, or a retry that fails again re-opens a sheet the
  // user never asked for a second time.
  if (failedGuid !== null && !stillFailed) setFailedGuid(null);
  const handleRetry = useCallback((m: EnrichedMessage) => setFailedGuid(m.guid), []);
  // Tap a message's reaction badges → open the "who reacted" sheet (owned here, like FailedMessageSheet).
  const [reactionsFor, setReactionsFor] = useState<EnrichedMessage | null>(null);
  const handleShowReactions = useCallback((m: EnrichedMessage) => setReactionsFor(m), []);
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

  // ---- pinned-to-bottom follow model (pure decisions in @utils scrollPin, node-tested) --------
  // `pinned` = follow the newest message: while pinned, EVERY content-size change re-scrolls to
  // the end (onContentSizeChange below) — a convergence loop that self-heals late row-height
  // changes (URL-preview cards popping in, image boxes) which made one-shot corrective scrolls
  // land short. Only a user DRAG can unpin; reaching the bottom again re-pins. A ref carries the
  // state on the hot scroll path (no re-render per event); `fabVisible` mirrors it for the button.
  const listRef = useRef<FlashListRef<EnrichedMessage>>(null);
  const pinRef = useRef<ScrollPinState>(initialPinState(!focusReady));
  const [fabVisible, setFabVisible] = useState(focusReady);
  // Incoming messages appended while unpinned — the FAB badge. Reset on every re-pin.
  const [missed, setMissed] = useState(0);
  // Anchored (search-hit / unread-jump) sessions freeze the pin machine: the window's bottom is
  // NOT the newest message, so nothing may pin/unpin there — the FAB exit hatch is the way back.
  const focusReadyRef = useRef(focusReady);
  focusReadyRef.current = focusReady;
  const applyPin = useCallback((next: ScrollPinState): void => {
    const flipped = next.pinned !== pinRef.current.pinned;
    pinRef.current = next;
    if (flipped) {
      setFabVisible(!next.pinned);
      if (next.pinned) setMissed(0);
    }
  }, []);
  // Entering an anchored session unpins; leaving one (jump cleared → focusReady drops) re-pins —
  // the anchored→normal data swap then converges to the newest row via onContentSizeChange.
  useEffect(() => {
    applyPin(focusReady ? unpinExplicitly(pinRef.current) : pinExplicitly(pinRef.current));
  }, [focusReady, applyPin]);

  // Tap a reply quote → scroll to the original message + briefly highlight it. Unpins first: the
  // user asked to READ something above, so content growth must not yank them back down.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // Deferred scroll for a just-sent (appended) message — see the appended branch below.
  const appendRaf = useRef<number | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [highlightGuid, setHighlightGuid] = useState<string | null>(null);
  const jumpToReply = useCallback(
    (originatorGuid: string): void => {
      const index = rowsRef.current.findIndex((m) => m.guid === originatorGuid);
      if (index < 0) return; // the original isn't in the loaded window
      applyPin(unpinExplicitly(pinRef.current));
      listRef.current?.scrollToIndex({
        index,
        animated: reduceMotionRef.current === false,
        viewPosition: 0.4,
      });
      setHighlightGuid(originatorGuid);
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
      highlightTimer.current = setTimeout(() => setHighlightGuid(null), 1600);
    },
    [applyPin, reduceMotionRef],
  );
  // Highlight the target once it's mounted in view (once per target); nudge it toward center.
  const focusedRef = useRef<string | null>(null);
  const focusScrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The centering nudge must read the index at FIRE time, never close over it: `focusIndex` is
  // recomputed when the anchored window finally lands (useReactiveQuery keeps serving the PREVIOUS
  // deps' rows until then, and a mid-session jump doesn't remount — `jump` isn't in the screen's
  // key), so the value captured 450ms earlier is normally stale. Out of range FlashList ignores it
  // and the nudge is merely lost; IN range — a deep unread backlog, a ThreadSheet jump near the top
  // of the window — it actively yanked the reader to the WRONG message half a second after landing.
  const focusIndexRef = useRef(focusIndex);
  focusIndexRef.current = focusIndex;
  useEffect(() => {
    if (!focusReady || focusedRef.current === focusGuid) return;
    focusedRef.current = focusGuid ?? null;
    setHighlightGuid(focusGuid ?? null);
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlightGuid(null), 3000);
    if (focusScrollTimer.current) clearTimeout(focusScrollTimer.current);
    focusScrollTimer.current = setTimeout(() => {
      // -1 = the target left the loaded window while the timer was pending; scrollToIndex(-1)
      // would be a scroll to nowhere.
      const index = focusIndexRef.current;
      if (index < 0) return;
      try {
        listRef.current?.scrollToIndex({ index, animated: false, viewPosition: 0.35 });
      } catch {
        // initialScrollIndex already placed it; centering is best-effort.
      }
    }, 450);
  }, [focusReady, focusGuid]);

  // Unmount: clear all delayed one-shots so a late fire can't setState/scroll a dead list.
  useEffect(
    () => () => {
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
      if (focusScrollTimer.current) clearTimeout(focusScrollTimer.current);
      if (appendRaf.current != null) cancelAnimationFrame(appendRaf.current);
    },
    [],
  );

  // Land at the newest message once FlashList has MEASURED itself. `onLoad` fires after the
  // first-render layout is committed, so scrollToEnd here computes against real row heights —
  // a bare rAF/effect ran too early and, on a tall window, landed SHORT (dropping the user into
  // mid-history, showing old texts). Paired with `startRenderingFromBottom` (which anchors the
  // cold render) this makes a normal open reliably start at the bottom. Skipped for a
  // search/notification open (focusReady), which keeps its `initialScrollIndex` jump. Fires once
  // per mount; the list is keyed by chat guid, so switching threads re-mounts and re-anchors.
  const onListLoad = useCallback((): void => {
    if (focusReady) return;
    listRef.current?.scrollToEnd({ animated: false });
  }, [focusReady]);

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!focusReadyRef.current) applyPin(pinOnScroll(pinRef.current, distFromBottomOf(e)));
    },
    [applyPin],
  );
  // A finger-down drag is the only signal that can lead to an unpin — programmatic scrolls and
  // FlashList's own autoscroll never emit it, so a short-landing scrollToEnd can't self-unpin.
  const onScrollBeginDrag = useCallback((): void => {
    if (!focusReadyRef.current) applyPin(pinOnDragStart(pinRef.current));
  }, [applyPin]);
  // Momentum end closes the drag session. Android fires momentum for ANIMATED programmatic
  // scrolls too, so this transition may re-pin but never unpins (see scrollPin).
  const onMomentumScrollEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!focusReadyRef.current) applyPin(pinOnMomentumEnd(pinRef.current, distFromBottomOf(e)));
    },
    [applyPin],
  );
  // THE convergence loop: while pinned, any content growth (appended rows, a URL-preview card
  // popping in, an image box) re-lands the list at the bottom. Native scrollToEnd recomputes
  // from the CURRENT content height, so repeated calls converge where one-shots landed short.
  const onContentSizeChange = useCallback((): void => {
    if (pinRef.current.pinned) listRef.current?.scrollToEnd({ animated: false });
  }, []);

  // The list's viewport RESIZES from the bottom — keyboard open/close (the chat screen's
  // KeyboardAvoidingView), the typing bubble or the selection bar appearing —
  // and FlashList keeps its scroll offset, so the newest messages slide behind the composer.
  // While pinned, re-land at the bottom on ANY height change. This hangs off the wrapper's
  // onLayout, which fires AFTER the resize is committed, so the metrics are fresh — the old
  // keyboardDidShow + one-frame-rAF version raced the KAV layout and could land the newest text
  // behind the keyboard with no recovery. A reader scrolled up (unpinned) is left alone.
  const listHeightRef = useRef(0);
  const onWrapperLayout = useCallback((e: LayoutChangeEvent): void => {
    const h = e.nativeEvent.layout.height;
    const prev = listHeightRef.current;
    listHeightRef.current = h;
    if (prev > 0 && h !== prev && pinRef.current.pinned) {
      listRef.current?.scrollToEnd({ animated: false });
    }
  }, []);

  // Tail-append watcher. Ref-diff because `rows` is a fresh array on every reactive tick — gate on
  // a genuine append (length grew AND a new tail guid) so in-place updates (sending→sent, localPath
  // writes, reaction joins) and a temp→real guid swap don't re-fire.
  //  - Own message appended → RE-PIN (even from deep in history; pinExplicitly survives the
  //    animated scroll's own events) + reveal it. The pinned convergence loop can't cover this:
  //    a scrolled-up sender is unpinned by definition.
  //  - Incoming appended while unpinned → count it on the FAB badge instead of yanking the reader.
  //    (Incoming while PINNED is landed by onContentSizeChange + FlashList's autoscroll.)
  const lastTailRef = useRef<{ guid: string | null; len: number }>({ guid: null, len: 0 });
  useEffect(() => {
    const prev = lastTailRef.current;
    const last = rows[rows.length - 1] ?? null;
    const appended = prev.len > 0 && rows.length > prev.len && !!last && last.guid !== prev.guid;
    lastTailRef.current = { guid: last?.guid ?? null, len: rows.length };
    if (!appended || !last) return;
    if (last.isFromMe === 1) {
      if (!focusReadyRef.current) applyPin(pinExplicitly(pinRef.current));
      // Defer a frame so FlashList has laid out/measured the newly-appended tail row before we
      // scroll — otherwise scrollToEnd computes against the pre-append content height and lands
      // short, leaving the just-sent bubble hidden below the fold.
      if (appendRaf.current != null) cancelAnimationFrame(appendRaf.current);
      appendRaf.current = requestAnimationFrame(() =>
        listRef.current?.scrollToEnd({ animated: reduceMotionRef.current === false }),
      );
    } else if (!pinRef.current.pinned) {
      setMissed((n) => n + 1);
    }
  }, [rows, applyPin, reduceMotionRef]);

  // The floating "jump to newest" button: shows whenever the list isn't following the newest
  // message. In an anchored session it EXITS the anchor (the screen clears it and the chat
  // returns to the live window); otherwise it re-pins and scrolls.
  const onFabPress = useCallback((): void => {
    if (onExitAnchor) {
      onExitAnchor();
      return;
    }
    applyPin(pinExplicitly(pinRef.current));
    listRef.current?.scrollToEnd({ animated: reduceMotionRef.current === false });
  }, [onExitAnchor, applyPin, reduceMotionRef]);
  const showFab = onExitAnchor != null || (fabVisible && rows.length > 0);

  return (
    <View style={styles.flex} onLayout={onWrapperLayout} testID="message-list-wrapper">
      <FlashList
        // Remount keyed to the focus target so initialScrollIndex (mount-time) lands on it; else
        // keyed by chat guid so a REUSED screen instance (a chat opened via replace over another
        // chat) re-mounts the list and re-runs onLoad → lands the new thread at its newest message.
        key={focusReady ? `focus-${focusGuid}` : `list-${chatGuid}`}
        ref={listRef}
        data={rows}
        keyExtractor={(m: EnrichedMessage) => m.guid}
        initialScrollIndex={focusReady ? focusIndex : undefined}
        // Land at the newest message after first-render measurement (normal open). See onListLoad.
        onLoad={onListLoad}
        // startRenderingFromBottom positions the COLD render at the newest message; the threshold is
        // what makes the list auto-follow appended messages (unset → -1 → FlashList never auto-scrolls).
        // 0.2 = auto-scroll to a new bottom row only when the user is within ~20% of a screen of the
        // bottom, so incoming messages reveal themselves without yanking a user reading older history.
        maintainVisibleContentPosition={
          focusReady
            ? undefined
            : {
                startRenderingFromBottom: true,
                autoscrollToBottomThreshold: 0.2,
                // FlashList otherwise defaults its near-bottom auto-follow to animated.
                animateAutoScrollToBottom: reduceMotion === false,
              }
        }
        // MUST be "handled" (the RN default is "never"). Under "never", while the keyboard is up
        // ANY touch on the list dismisses it AND the children never receive that touch — which
        // silently killed swipe-to-reply whenever the composer had focus. Measured identically on
        // two OEMs (Pixel 10 Pro XL / Android 17 and Galaxy S25 Ultra / Android 16):
        //   keyboard CLOSED → 4/4 and 12/12 replies      keyboard OPEN → 0/6 on BOTH
        // and a 3-way probe confirmed the mechanism: a tap OR a horizontal swipe dismissed the
        // keyboard (a vertical scroll correctly did not), and it fired for taps on bubbles, on the
        // gaps between them, and on empty row space alike — i.e. list-wide, not the bubble's
        // Pressable. Every other scrollable here already sets "handled" (Composer, AttachmentTray,
        // SearchResultsView, settings, new-chat…); this list was the one that
        // missed it. Jest can't catch it — RNTL has no soft keyboard.
        keyboardShouldPersistTaps="handled"
        refreshControl={onRefresh ? refreshControl : undefined}
        onScroll={onScroll}
        onScrollBeginDrag={onScrollBeginDrag}
        onMomentumScrollEnd={onMomentumScrollEnd}
        onContentSizeChange={onContentSizeChange}
        scrollEventThrottle={16}
        // Reaching the START of the (chronological) data = scrolled to the oldest loaded message →
        // load older history. maintainVisibleContentPosition keeps the viewport pinned as the
        // newly-prepended older rows come in, so the scroll doesn't jump.
        onStartReached={onLoadOlder}
        onStartReachedThreshold={0.5}
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
            onSwipeReply={onSwipeReply}
            selecting={selectedGuids != null}
            isSelected={selectedGuids?.has(item.guid) ?? false}
            onToggleSelect={onToggleSelect}
            onJumpToReply={jumpToReply}
            onShowReactions={handleShowReactions}
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
      {showFab ? (
        <Pressable
          onPress={onFabPress}
          style={[
            styles.fab,
            {
              bottom: 16 + bottomInset,
              // Frosted over a wallpaper (the overlay-chip language); an elevated surface otherwise.
              backgroundColor: hasBackground
                ? withAlpha(theme.color.background, 0.62)
                : theme.color.secondaryBackground,
              borderColor: theme.color.separator,
            },
          ]}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Scroll to newest message"
        >
          <Text style={[styles.fabGlyph, { color: theme.color.tint }]}>↓</Text>
          {missed > 0 ? (
            <View style={[styles.fabBadge, { backgroundColor: theme.color.tint }]}>
              <Text style={[styles.fabBadgeText, { color: readableTextOn(theme.color.tint) }]}>
                {missed > 99 ? '99+' : missed}
              </Text>
            </View>
          ) : null}
        </Pressable>
      ) : null}
      <FailedMessageSheet
        visible={stillFailed}
        isAttachment={failedImage !== undefined}
        errorDetail={failed?.errorMessage}
        onClose={() => setFailedGuid(null)}
        onRetry={() => {
          // The GUID is all `retry` needs — it re-POSTs the queue payload under the same temp id.
          // Passing the bubble's text/image is what made a failed contact card go out as a plain
          // message reading the contact's name, and dropped a reply's target / effect / subject /
          // mentions, none of which this component can see.
          if (stillFailed && failed) void retry(failed.guid, screenLease);
        }}
        onDelete={() => {
          if (stillFailed && failed) void discardMessage(failed.guid, Date.now(), screenLease);
        }}
      />
      <ReactionDetailsSheet
        data={reactionsFor ? { reactions: reactionsFor.reactions } : null}
        onClose={() => setReactionsFor(null)}
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
  // Floating "jump to newest" button (above the composer; badge = messages missed while unpinned).
  fab: {
    position: 'absolute',
    right: 16,
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 3,
  },
  fabGlyph: { fontSize: 20, fontWeight: '600', lineHeight: 24 },
  fabBadge: {
    position: 'absolute',
    top: -6,
    right: -6,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fabBadgeText: { fontSize: 11, fontWeight: '700' },
});
