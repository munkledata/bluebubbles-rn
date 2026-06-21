import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { useTheme } from '../theme';

/** iOS "…" typing bubble: three dots pulsing in a received-style bubble. */
export function TypingBubble(): React.JSX.Element {
  const theme = useTheme();
  const d0 = useRef(new Animated.Value(0.3)).current;
  const d1 = useRef(new Animated.Value(0.3)).current;
  const d2 = useRef(new Animated.Value(0.3)).current;
  const dots = [d0, d1, d2];

  useEffect(() => {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={styles.anchor}>
      <View
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
