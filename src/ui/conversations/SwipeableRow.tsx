import React, { useEffect, useRef } from 'react';
import { Animated, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon } from '../primitives';

export interface SwipeAction {
  key: string;
  label: string;
  icon: string;
  color: string;
  onPress: () => void;
}

interface SwipeableRowProps {
  /** Actions revealed by swiping RIGHT (shown on the left edge). */
  left?: SwipeAction[];
  /** Actions revealed by swiping LEFT (shown on the right edge). */
  right?: SwipeAction[];
  /** Changing this closes/re-centers the row — pass the item id so a RECYCLED FlashList row
   *  never inherits the previous item's open-swipe offset. */
  resetKey: string;
  children: React.ReactNode;
}

const ACTION_W = 76; // width per action button
const OPEN_THRESHOLD = 40; // drag past this (px) to snap open on release

/**
 * A dependency-light swipeable row built on RN's own `PanResponder` + `Animated` — deliberately
 * NOT gesture-handler/Reanimated (this project ships animations on the RN `Animated` API only, and
 * the Reanimated worklet plugin isn't configured). Horizontal drags reveal the action panels;
 * vertical drags fall through to the list scroll, and a tap falls through to the child (we only
 * claim the responder once a mostly-horizontal move exceeds a small threshold).
 *
 * NOTE: needs on-device verification of the gesture feel + FlashList scroll interaction.
 */
export function SwipeableRow({
  left,
  right,
  resetKey,
  children,
}: SwipeableRowProps): React.JSX.Element {
  const tx = useRef(new Animated.Value(0)).current;
  const offset = useRef(0); // committed open offset (0 = closed)
  const leftW = (left?.length ?? 0) * ACTION_W;
  const rightW = (right?.length ?? 0) * ACTION_W;
  // The responder is created once; ref the CURRENT widths so a later change to the action sets
  // (same MessageSwipeWrapper onReplyRef pattern) isn't stale inside its closures.
  const widthsRef = useRef({ leftW, rightW });
  widthsRef.current = { leftW, rightW };

  const snap = (to: number): void => {
    offset.current = to;
    Animated.spring(tx, { toValue: to, useNativeDriver: true, bounciness: 0, speed: 20 }).start();
  };

  // Re-center when the row is recycled to a different chat (guards against offset bleed).
  useEffect(() => {
    offset.current = 0;
    tx.setValue(0);
  }, [resetKey, tx]);

  const responder = useRef(
    PanResponder.create({
      // Never claim on touch-start, so taps/long-press reach the child.
      onStartShouldSetPanResponder: () => false,
      // Claim only a mostly-horizontal drag (so vertical list scrolling still works).
      onMoveShouldSetPanResponder: (_e, g) =>
        Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
      onPanResponderMove: (_e, g) => {
        let next = offset.current + g.dx;
        // Clamp to the available action width per side (no overscroll past the panel).
        next = Math.max(-widthsRef.current.rightW, Math.min(widthsRef.current.leftW, next));
        tx.setValue(next);
      },
      onPanResponderRelease: (_e, g) => {
        const next = offset.current + g.dx;
        const { leftW: lw, rightW: rw } = widthsRef.current;
        if (next <= -OPEN_THRESHOLD && rw > 0) snap(-rw);
        else if (next >= OPEN_THRESHOLD && lw > 0) snap(lw);
        else snap(0);
      },
      onPanResponderTerminate: () => snap(0),
    }),
  ).current;

  const fire = (a: SwipeAction): void => {
    snap(0);
    a.onPress();
  };

  return (
    <View style={styles.wrap}>
      {/* Left panel (revealed on swipe-right), pinned to the left edge behind the row. */}
      {leftW > 0 ? (
        <View style={[styles.panel, styles.panelLeft]}>
          {left!.map((a) => (
            <ActionButton key={a.key} action={a} onPress={() => fire(a)} />
          ))}
        </View>
      ) : null}
      {/* Right panel (revealed on swipe-left), pinned to the right edge behind the row. */}
      {rightW > 0 ? (
        <View style={[styles.panel, styles.panelRight]}>
          {right!.map((a) => (
            <ActionButton key={a.key} action={a} onPress={() => fire(a)} />
          ))}
        </View>
      ) : null}
      <Animated.View style={{ transform: [{ translateX: tx }] }} {...responder.panHandlers}>
        {children}
      </Animated.View>
    </View>
  );
}

function ActionButton({
  action,
  onPress,
}: {
  action: SwipeAction;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.action, { backgroundColor: action.color }]}
      accessibilityRole="button"
      accessibilityLabel={action.label}
    >
      <Icon
        name={action.icon as React.ComponentProps<typeof Icon>['name']}
        size={20}
        color="#fff"
      />
      <Text style={styles.actionLabel}>{action.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'relative', overflow: 'hidden' },
  panel: { position: 'absolute', top: 0, bottom: 0, flexDirection: 'row' },
  panelLeft: { left: 0 },
  panelRight: { right: 0 },
  action: { width: ACTION_W, alignItems: 'center', justifyContent: 'center', gap: 3 },
  actionLabel: { color: '#fff', fontSize: 11, fontWeight: '600' },
});
