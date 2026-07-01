import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../theme';
import { Avatar } from './Avatar';

interface GroupAvatarProps {
  names: string[];
  size?: number;
  /** Contact photo uris positionally aligned with `names` (null = none). */
  uris?: (string | null)[];
  /**
   * Redacted mode: per-participant seeds (positionally aligned with `names`). When set, each
   * inner tile renders a deterministic, non-identifying seeded avatar instead of the name/photo.
   */
  seeds?: string[];
}

/** Two overlapped avatars for group chats (back top-left, front bottom-right). */
export function GroupAvatar({ names, size = 40, uris, seeds }: GroupAvatarProps): React.JSX.Element {
  const theme = useTheme();
  const inner = Math.round(size * 0.66);
  const back = names[0] ?? '?';
  const front = names[1] ?? names[0] ?? '?';
  const backSeed = seeds?.[0];
  const frontSeed = seeds?.[1] ?? seeds?.[0];

  return (
    <View style={{ width: size, height: size }}>
      <View style={styles.back}>
        <Avatar name={back} size={inner} uri={uris?.[0]} seed={backSeed} />
      </View>
      <View
        style={[
          styles.front,
          { borderColor: theme.color.background, borderRadius: (inner + 4) / 2 },
        ]}
      >
        <Avatar name={front} size={inner} uri={uris?.[1] ?? uris?.[0]} seed={frontSeed} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  back: { position: 'absolute', top: 0, left: 0 },
  front: { position: 'absolute', bottom: 0, right: 0, borderWidth: 2 },
});
