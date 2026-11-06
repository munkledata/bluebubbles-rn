import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { avatarLetterSpec } from '@core/avatar';
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
  const {
    initials: letters,
    background: backgroundColor,
    foreground,
  } = avatarLetterSpec(name, color);
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
