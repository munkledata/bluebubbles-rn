import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text } from 'react-native';
import type { BubbleEffect } from '@core/effects';
import { useReduceMotionPreference } from '../../hooks/useReduceMotionPreference';
import { useTheme } from '../../theme';

interface BubbleEffectViewProps {
  effect: BubbleEffect;
  children: React.ReactNode;
}

/**
 * Plays an iMessage bubble send-effect once when the message first renders, using
 * RN's built-in Animated (no Reanimated). Invisible-ink hides the content behind
 * a tap-to-reveal overlay instead of animating.
 */
export function BubbleEffectView({ effect, children }: BubbleEffectViewProps): React.JSX.Element {
  const reduceMotion = useReduceMotionPreference();

  if (effect === 'invisibleInk') {
    return <InvisibleInk reduceMotion={reduceMotion}>{children}</InvisibleInk>;
  }
  return (
    <AnimatedEntrance effect={effect} reduceMotion={reduceMotion}>
      {children}
    </AnimatedEntrance>
  );
}

function AnimatedEntrance({
  effect,
  reduceMotion,
  children,
}: {
  effect: Exclude<BubbleEffect, 'invisibleInk'>;
  reduceMotion: boolean | null;
  children: React.ReactNode;
}): React.JSX.Element {
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(1)).current;
  const entranceConsumed = useRef(false);

  useLayoutEffect(() => {
    if (reduceMotion === null || entranceConsumed.current) {
      scale.setValue(1);
      opacity.setValue(1);
      return;
    }

    entranceConsumed.current = true;
    if (reduceMotion) {
      scale.setValue(1);
      opacity.setValue(1);
      return;
    }

    let anim: Animated.CompositeAnimation;
    if (effect === 'slam') {
      // Drops in oversized, then slams to size with a spring overshoot.
      scale.setValue(1.7);
      opacity.setValue(0);
      anim = Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: 110, useNativeDriver: true }),
        Animated.sequence([
          Animated.timing(scale, {
            toValue: 0.9,
            duration: 170,
            easing: Easing.in(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.spring(scale, { toValue: 1, friction: 4, tension: 140, useNativeDriver: true }),
        ]),
      ]);
    } else if (effect === 'loud') {
      // Appears small then SHOUTS big and settles.
      scale.setValue(0.6);
      anim = Animated.sequence([
        Animated.spring(scale, { toValue: 1.28, friction: 3, tension: 120, useNativeDriver: true }),
        Animated.spring(scale, { toValue: 1, friction: 5, tension: 120, useNativeDriver: true }),
      ]);
    } else {
      // gentle: grows in softly.
      scale.setValue(0.3);
      opacity.setValue(0.4);
      anim = Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: 1000, useNativeDriver: true }),
        Animated.timing(scale, {
          toValue: 1,
          duration: 1200,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]);
    }
    anim.start();
    // Stop if the row unmounts mid-animation (FlashList recycles rows).
    return () => anim.stop();
  }, [effect, opacity, reduceMotion, scale]);

  return <Animated.View style={{ opacity, transform: [{ scale }] }}>{children}</Animated.View>;
}

function InvisibleInk({
  children,
  reduceMotion,
}: {
  children: React.ReactNode;
  reduceMotion: boolean | null;
}): React.JSX.Element {
  const theme = useTheme();
  const [revealed, setRevealed] = useState(false);
  const contentOpacity = useRef(new Animated.Value(0.04)).current;
  const overlayOpacity = useRef(new Animated.Value(1)).current;
  const revealAnim = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => () => revealAnim.current?.stop(), []); // stop if unmounted mid-reveal

  useLayoutEffect(() => {
    if (!revealed || !reduceMotion) return;
    revealAnim.current?.stop();
    revealAnim.current = null;
    contentOpacity.setValue(1);
    overlayOpacity.setValue(0);
  }, [contentOpacity, overlayOpacity, reduceMotion, revealed]);

  const reveal = (): void => {
    setRevealed(true);
    if (reduceMotion !== false) {
      contentOpacity.setValue(1);
      overlayOpacity.setValue(0);
      return;
    }

    revealAnim.current = Animated.parallel([
      Animated.timing(contentOpacity, { toValue: 1, duration: 450, useNativeDriver: true }),
      Animated.timing(overlayOpacity, { toValue: 0, duration: 450, useNativeDriver: true }),
    ]);
    revealAnim.current.start();
  };

  return (
    <Pressable
      onPress={revealed ? undefined : reveal}
      accessible={!revealed}
      accessibilityRole={revealed ? undefined : 'button'}
      accessibilityLabel={revealed ? undefined : 'Reveal invisible ink message'}
    >
      <Animated.View
        style={{ opacity: contentOpacity }}
        accessibilityElementsHidden={!revealed}
        importantForAccessibility={revealed ? 'auto' : 'no-hide-descendants'}
      >
        {children}
      </Animated.View>
      {!revealed ? (
        <Animated.View
          pointerEvents="none"
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[
            StyleSheet.absoluteFill,
            styles.overlay,
            { opacity: overlayOpacity, backgroundColor: theme.color.secondaryBackground },
          ]}
        >
          <Text style={[styles.hint, { color: theme.color.secondaryLabel }]}>✨ Tap to reveal</Text>
        </Animated.View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  overlay: { alignItems: 'center', justifyContent: 'center', borderRadius: 18, margin: 1 },
  hint: { fontSize: 13, fontWeight: '500' },
});
