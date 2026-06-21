import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

interface ProgressRingProps {
  /** null = indeterminate (no Content-Length) → spinner only. */
  progress: number | null;
  size?: number;
  color?: string;
}

/**
 * Lightweight download indicator (no SVG/Skia dep): a translucent disc with a
 * spinner, plus a percentage when the total size is known.
 */
export function ProgressRing({
  progress,
  size = 52,
  color = '#fff',
}: ProgressRingProps): React.JSX.Element {
  const pct = progress == null ? null : Math.round(progress * 100);
  return (
    <View style={[styles.disc, { width: size, height: size, borderRadius: size / 2 }]}>
      <ActivityIndicator color={color} />
      {pct != null ? <Text style={[styles.pct, { color }]}>{pct}%</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  disc: { alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.45)' },
  pct: { fontSize: 11, fontWeight: '700', marginTop: 2 },
});
