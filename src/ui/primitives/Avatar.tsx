import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';

interface AvatarProps {
  /** Display name or handle address used for initials + deterministic color. */
  name: string;
  size?: number;
  /** Override the auto-generated color (e.g. a per-handle color from settings). */
  color?: string;
  /** Contact photo (file:// or data: uri). When set, renders the image instead of initials. */
  uri?: string | null;
}

// iOS-ish avatar palette (used when colorfulAvatars is on; falls back here otherwise).
const PALETTE = [
  '#FF6B6B',
  '#FFA94D',
  '#FFD43B',
  '#69DB7C',
  '#4DABF7',
  '#9775FA',
  '#F783AC',
  '#3BC9DB',
];

function colorFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length]!;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.charAt(0).toUpperCase();
  return (parts[0]!.charAt(0) + parts[parts.length - 1]!.charAt(0)).toUpperCase();
}

/**
 * Circular contact avatar: a photo when available, else initials on a color.
 * Decorative (`accessible={false}`) — the tile/header alongside it announces the
 * name; memoized so it doesn't recompute when the parent re-renders.
 */
export const Avatar = React.memo(function Avatar({
  name,
  size = 40,
  color,
  uri,
}: AvatarProps): React.JSX.Element {
  if (uri) {
    return (
      <Image
        accessible={false}
        source={{ uri }}
        style={{ width: size, height: size, borderRadius: size / 2 }}
      />
    );
  }
  const backgroundColor = color ?? colorFor(name);
  return (
    <View
      accessible={false}
      style={[
        styles.circle,
        { width: size, height: size, borderRadius: size / 2, backgroundColor },
      ]}
    >
      <Text style={[styles.text, { fontSize: size * 0.4 }]}>{initials(name)}</Text>
    </View>
  );
});

const styles = StyleSheet.create({
  circle: { alignItems: 'center', justifyContent: 'center' },
  text: { color: '#FFFFFF', fontWeight: '600' },
});
