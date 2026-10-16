import React, { useLayoutEffect, useMemo, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { useReduceMotionPreference } from '../hooks/useReduceMotionPreference';
import { useTheme } from '../theme';

const PULSE_MIN_OPACITY = 0.3;
const STATIC_OPACITY = 1;

/** iOS "…" typing bubble: three dots pulsing in a received-style bubble. */
export function TypingBubble(): React.JSX.Element {
  const theme = useTheme();
  const reduceMotion = useReduceMotionPreference();
  const d0 = useRef(new Animated.Value(STATIC_OPACITY)).current;
  const d1 = useRef(new Animated.Value(STATIC_OPACITY)).current;
  const d2 = useRef(new Animated.Value(STATIC_OPACITY)).current;
  const dots = useMemo(() => [d0, d1, d2], [d0, d1, d2]);

  useLayoutEffect(() => {
    if (reduceMotion !== false) {
      dots.forEach((dot) => dot.setValue(STATIC_OPACITY));
      return;
    }

    dots.forEach((dot) => dot.setValue(PULSE_MIN_OPACITY));
    const anims = dots.map((d, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 180),
          Animated.timing(d, { toValue: 1, duration: 400, useNativeDriver: true }),
          Animated.timing(d, { toValue: 0.3, duration: 400, useNativeDriver: true }),
        ]),
      ),
    );
    anims.forEach((a) => a.start());
    return () => anims.forEach((a) => a.stop());
  }, [dots, reduceMotion]);

  return (
    <View style={styles.anchor}>
      <View
        accessible
        style={[styles.bubble, { backgroundColor: theme.color.bubble.receivedBackgroundBottom }]}
        accessibilityLabel="Typing"
      >
        {dots.map((d, i) => (
          <Animated.View
            key={i}
            style={[styles.dot, { backgroundColor: theme.color.tertiaryLabel, opacity: d }]}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  anchor: { alignSelf: 'flex-start', marginHorizontal: 10, marginVertical: 4 },
  bubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 18,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
