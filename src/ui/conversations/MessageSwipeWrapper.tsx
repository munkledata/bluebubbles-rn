import React, { useRef } from 'react';
import { Animated, PanResponder, StyleSheet, View } from 'react-native';
import { isReplyTrigger, REPLY_TRIGGER_PX, swipeTranslate, TIMESTAMP_REVEAL_MAX } from '@utils';
import { Icon } from '../primitives';
import { useTheme } from '../theme';

interface MessageSwipeWrapperProps {
  /** This message's formatted sent time, revealed by dragging the row left. */
  timestamp: string;
  /** Set this message as the reply target (drag right past the threshold). Omit → no reply pull. */
  onReply?: () => void;
  children: React.ReactNode;
}

/**
 * Per-row horizontal swipe on a message (RN `PanResponder` + `Animated` — same dependency-light
 * pattern as `SwipeableRow`; no gesture-handler/Reanimated):
 *  - drag LEFT: the row slides out to reveal ITS sent time on the right (peek, springs back) —
 *    the swipe-to-reveal-timestamps parity feature, done per-row;
 *  - drag RIGHT past the threshold: sets the message as the reply target (iMessage swipe-to-reply),
 *    with a reply glyph fading in as the pull approaches the trigger.
 * Taps/long-presses fall through (never claims on touch-start); vertical drags stay with the list.
 *
 * NOTE: gesture feel needs on-device verification (jest can't drive native touches).
 */
export function MessageSwipeWrapper({
  timestamp,
  onReply,
  children,
}: MessageSwipeWrapperProps): React.JSX.Element {
  const theme = useTheme();
  const tx = useRef(new Animated.Value(0)).current;
  // The responder is created once; ref the latest onReply so the bound-per-render closure
  // (row-memo pattern) isn't stale inside it.
  const onReplyRef = useRef(onReply);
  onReplyRef.current = onReply;

  const settle = (): void => {
    Animated.spring(tx, { toValue: 0, useNativeDriver: true, bounciness: 0, speed: 20 }).start();
  };

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      // Claim only a mostly-horizontal drag so vertical list scrolling is untouched.
      onMoveShouldSetPanResponder: (_e, g) =>
        Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
      onPanResponderMove: (_e, g) => tx.setValue(swipeTranslate(g.dx, !!onReplyRef.current)),
      onPanResponderRelease: (_e, g) => {
        if (isReplyTrigger(g.dx, !!onReplyRef.current)) onReplyRef.current?.();
        settle();
      },
      onPanResponderTerminate: settle,
    }),
  ).current;

  return (
    <View style={styles.wrap}>
      {/* Sent-time label at the right edge; fades in as the row slides left over it. */}
      <Animated.Text
        style={[
          styles.timestamp,
          {
            color: theme.color.tertiaryLabel,
            opacity: tx.interpolate({
              inputRange: [-TIMESTAMP_REVEAL_MAX, -TIMESTAMP_REVEAL_MAX / 3, 0],
              outputRange: [1, 0.35, 0],
              extrapolate: 'clamp',
            }),
          },
        ]}
        pointerEvents="none"
      >
        {timestamp}
      </Animated.Text>
      {onReply ? (
        <Animated.View
          style={[
            styles.replyGlyph,
            {
              opacity: tx.interpolate({
                inputRange: [0, REPLY_TRIGGER_PX * 0.6, REPLY_TRIGGER_PX],
                outputRange: [0, 0.3, 1],
                extrapolate: 'clamp',
              }),
            },
          ]}
          pointerEvents="none"
        >
          <Icon name="arrow-undo" size={18} color={theme.color.tint} />
        </Animated.View>
      ) : null}
      <Animated.View style={{ transform: [{ translateX: tx }] }} {...responder.panHandlers}>
        {children}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'relative' },
  timestamp: {
    position: 'absolute',
    right: 10,
    top: 0,
    bottom: 0,
    fontSize: 11,
    textAlignVertical: 'center',
  },
  replyGlyph: { position: 'absolute', left: 10, top: 0, bottom: 0, justifyContent: 'center' },
});
