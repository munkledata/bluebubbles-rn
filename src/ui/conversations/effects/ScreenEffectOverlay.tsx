import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, useWindowDimensions, View } from 'react-native';
import type { ScreenEffect } from '@core/effects';

interface ScreenEffectOverlayProps {
  effect: ScreenEffect;
  onDone: () => void;
}

const COLORS = ['#FF3B30', '#FF9500', '#FFCC00', '#34C759', '#007AFF', '#AF52DE', '#FF2D55'];
const DURATION_MS = 2600;

interface Particle {
  key: number;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  size: number;
  color: string;
  radius: number;
  spin: number;
}

function buildParticles(effect: ScreenEffect, w: number, h: number): Particle[] {
  const rand = (a: number, b: number): number => a + Math.random() * (b - a);
  const color = (): string => COLORS[Math.floor(Math.random() * COLORS.length)]!;
  const n = effect === 'balloons' ? 16 : 36;
  return Array.from({ length: n }, (_, key) => {
    if (effect === 'confetti' || effect === 'celebration') {
      const sx = rand(0, w);
      return {
        key,
        startX: sx,
        startY: -30,
        endX: sx + rand(-60, 60),
        endY: h + 40,
        size: rand(7, 13),
        color: color(),
        radius: 2,
        spin: rand(180, 720),
      };
    }
    if (effect === 'balloons') {
      const sx = rand(0, w);
      return {
        key,
        startX: sx,
        startY: h + 60,
        endX: sx + rand(-40, 40),
        endY: -80,
        size: rand(26, 40),
        color: color(),
        radius: 20,
        spin: rand(-20, 20),
      };
    }
    // fireworks / love / lasers / echo / spotlight: burst from the centre.
    const angle = rand(0, Math.PI * 2);
    const dist = rand(w * 0.2, w * 0.55);
    return {
      key,
      startX: w / 2,
      startY: h / 2,
      endX: w / 2 + Math.cos(angle) * dist,
      endY: h / 2 + Math.sin(angle) * dist,
      size: effect === 'love' ? rand(14, 24) : rand(6, 12),
      color: effect === 'love' ? '#FF2D55' : color(),
      radius: effect === 'love' ? 12 : 3,
      spin: rand(0, 360),
    };
  });
}

/**
 * Full-screen iMessage send-effect, JS particles via a single Animated value
 * (one native animation drives all particles). Auto-dismisses; tap to skip.
 * No Skia/Reanimated — a future high-fidelity renderer can swap in behind this.
 */
export function ScreenEffectOverlay({
  effect,
  onDone,
}: ScreenEffectOverlayProps): React.JSX.Element {
  const { width, height } = useWindowDimensions();
  const t = useRef(new Animated.Value(0)).current;
  const particles = useMemo(() => buildParticles(effect, width, height), [effect, width, height]);

  useEffect(() => {
    let cancelled = false;
    const anim = Animated.timing(t, {
      toValue: 1,
      duration: DURATION_MS,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    });
    anim.start(({ finished }) => {
      // Don't fire onDone for a superseded/stopped run (would clear a newer effect).
      if (finished && !cancelled) onDone();
    });
    return () => {
      cancelled = true;
      anim.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effect]);

  // pointerEvents="none": particles float OVER the chat without blocking scroll/taps
  // (iMessage effects are non-interactive); it auto-dismisses after DURATION_MS.
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {particles.map((p) => (
        <Animated.View
          key={p.key}
          style={{
            position: 'absolute',
            width: p.size,
            height: p.size,
            borderRadius: p.radius,
            backgroundColor: p.color,
            opacity: t.interpolate({ inputRange: [0, 0.1, 0.8, 1], outputRange: [0, 1, 1, 0] }),
            transform: [
              {
                translateX: t.interpolate({ inputRange: [0, 1], outputRange: [p.startX, p.endX] }),
              },
              {
                translateY: t.interpolate({ inputRange: [0, 1], outputRange: [p.startY, p.endY] }),
              },
              {
                rotate: t.interpolate({
                  inputRange: [0, 1],
                  outputRange: ['0deg', `${p.spin}deg`],
                }),
              },
            ],
          }}
        />
      ))}
    </View>
  );
}
