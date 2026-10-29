import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../theme';
import { Avatar } from './Avatar';

interface GroupAvatarProps {
  names: string[];
  size?: number;
  /** Contact photo uris positionally aligned with `names` (null = none). */
  uris?: (string | null)[];
  /** Last-known handle colors positionally aligned with `names` (null = generated fallback). */
  colors?: (string | null)[];
  /** The group's own downloaded photo. When set it replaces the two member pictures. */
  photoUri?: string | null;
}

/**
 * The group's own photo when it has one; otherwise two overlapped member avatars (back top-left,
 * front bottom-right).
 */
export function GroupAvatar({
  names,
  size = 40,
  uris,
  colors,
  photoUri,
}: GroupAvatarProps): React.JSX.Element {
  const theme = useTheme();
  if (photoUri) {
    return (
      <Avatar name={names[0] ?? '?'} size={size} uri={photoUri} color={colors?.[0] ?? undefined} />
    );
  }
  const inner = Math.round(size * 0.66);
  const back = names[0] ?? '?';
  const front = names[1] ?? names[0] ?? '?';

  return (
    <View style={{ width: size, height: size }}>
      <View style={styles.back}>
        <Avatar name={back} size={inner} uri={uris?.[0]} color={colors?.[0] ?? undefined} />
      </View>
      <View
        style={[
          styles.front,
          { borderColor: theme.color.background, borderRadius: (inner + 4) / 2 },
        ]}
      >
        <Avatar
          name={front}
          size={inner}
          uri={uris?.[1] ?? uris?.[0]}
          color={colors?.[1] ?? colors?.[0] ?? undefined}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  back: { position: 'absolute', top: 0, left: 0 },
  front: { position: 'absolute', bottom: 0, right: 0, borderWidth: 2 },
});
