import React, { useEffect, useRef } from 'react';
import { Animated, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import { isHorizontalSwipe } from '@utils';
import { useReduceMotionPreferenceRef } from '../hooks/useReduceMotionPreference';
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
  const activeSnap = useRef<Animated.CompositeAnimation | null>(null);
  const leftW = (left?.length ?? 0) * ACTION_W;
  const rightW = (right?.length ?? 0) * ACTION_W;
  // The responder is created once; ref the CURRENT widths so a later change to the action sets
  // (same MessageSwipeWrapper onReplyRef pattern) isn't stale inside its closures.
  const widthsRef = useRef({ leftW, rightW });
  widthsRef.current = { leftW, rightW };

  const stopActiveSnap = (): boolean => {
    const animation = activeSnap.current;
    activeSnap.current = null;
    animation?.stop();
    return animation != null;
  };

  const reduceMotion = useReduceMotionPreferenceRef((enabled) => {
    // A setting change must not move a row under the user's finger. Only finish an automatic
    // snap that this row currently owns.
    if (enabled && stopActiveSnap()) tx.setValue(offset.current);
  });

  const snap = (to: number): void => {
    stopActiveSnap();
    offset.current = to;
    if (reduceMotion.current !== false) {
      tx.setValue(to);
      return;
    }

    const animation = Animated.spring(tx, {
      toValue: to,
      useNativeDriver: true,
      bounciness: 0,
      speed: 20,
    });
    activeSnap.current = animation;
    animation.start(() => {
      if (activeSnap.current === animation) activeSnap.current = null;
    });
  };

  // Re-center when the row is recycled to a different chat (guards against offset bleed).
  useEffect(() => {
    stopActiveSnap();
    offset.current = 0;
    tx.setValue(0);
  }, [resetKey, tx]);

  useEffect(
    () => () => {
      stopActiveSnap();
    },
    [],
  );

  const responderRef = useRef<ReturnType<typeof PanResponder.create> | null>(null);
  if (responderRef.current === null) {
    responderRef.current = PanResponder.create({
      // Never claim on touch-start, so taps/long-press reach the child.
      onStartShouldSetPanResponder: () => false,
      // Claim only a mostly-horizontal drag (so vertical list scrolling still works) — in BOTH the
      // bubble and capture phases so the swipe is recognised before the FlashList scroll engages.
      onMoveShouldSetPanResponder: (_e, g) => isHorizontalSwipe(g.dx, g.dy),
      onMoveShouldSetPanResponderCapture: (_e, g) => isHorizontalSwipe(g.dx, g.dy),
      onPanResponderGrant: () => {
        // A fresh finger owns the value now; stop an older automatic snap without moving it.
        stopActiveSnap();
      },
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
      // Once we own the drag, refuse to hand it back to the scroll view (same OEM scroll-steal fix
      // as the message-row swipe); on Android, block the native scroll once the gesture is granted.
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderTerminate: () => snap(0),
    });
  }
  const responder = responderRef.current;

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
