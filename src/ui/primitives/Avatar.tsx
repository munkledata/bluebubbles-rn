import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { normalizeHandleColor } from '@core/models';
import { readableTextOn } from '../theme/adaptiveFromImage';
import { Icon } from './Icon';

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

/**
 * The first LETTER (any script) of the first and last words. Punctuation, digits and emoji never
 * count, so "(555) 123-4567" or "+1 555…" no longer show "(5" or "+". Empty when the name has no
 * letters at all; the avatar then shows a person glyph instead.
 */
function initials(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .map((word) => word.match(/\p{L}/u)?.[0] ?? '')
    .filter(Boolean);
  if (letters.length === 0) return '';
  if (letters.length === 1) return letters[0]!.toUpperCase();
  return (letters[0]! + letters[letters.length - 1]!).toUpperCase();
}

/**
 * Circular contact avatar: a photo when available, else initials (or a person glyph) on a color.
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
  const backgroundColor = normalizeHandleColor(color) ?? colorFor(name);
  const foreground = readableTextOn(backgroundColor);
  const letters = initials(name);
  return (
    <View
      accessible={false}
      style={[
        styles.circle,
        { width: size, height: size, borderRadius: size / 2, backgroundColor },
      ]}
    >
      {letters ? (
        <Text style={[styles.text, { color: foreground, fontSize: size * 0.4 }]}>{letters}</Text>
      ) : (
        <Icon name="person" size={Math.round(size * 0.55)} color={foreground} />
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  circle: { alignItems: 'center', justifyContent: 'center' },
  text: { fontWeight: '600' },
});
