import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { reactionMeta, type ReactionBaseType } from '@core/reactions/reactionType';
import type { ReactionRow } from '@db/repositories';
import { useTheme } from '../theme';

interface ReactionClusterProps {
  reactions: ReactionRow[];
  isFromMe: boolean;
  /** Tap the badges → open the "who reacted" detail. Omit to keep the cluster non-interactive. */
  onPress?: () => void;
}

/**
 * Tapback badges pinned to the top edge of a bubble — one badge per distinct
 * type. Sits on the reacted bubble's near corner (your outgoing bubble → top-
 * left; a received bubble → top-right). Yours render tinted. When `onPress` is
 * given the cluster is tappable (opens the reactor list); otherwise it's inert
 * and lets touches fall through to the bubble.
 */
export function ReactionCluster({
  reactions,
  isFromMe,
  onPress,
}: ReactionClusterProps): React.JSX.Element | null {
  const theme = useTheme();
  if (reactions.length === 0) return null;
  // One badge per distinct classic type OR distinct emoji glyph ('emoji::<glyph>' keys).
  const keyOf = (r: (typeof reactions)[number]): string =>
    r.baseType === 'emoji' ? `emoji::${r.emoji ?? ''}` : r.baseType;
  const glyphOf = (key: string): string =>
    key.startsWith('emoji::')
      ? key.slice('emoji::'.length)
      : reactionMeta(key as ReactionBaseType).emoji;
  const keys = [...new Set(reactions.map(keyOf))];
  const mine = new Set(reactions.filter((r) => r.isFromMe).map(keyOf));

  const Container = onPress ? Pressable : View;
  return (
    <Container
      style={[styles.row, isFromMe ? styles.left : styles.right]}
      // Inert by default so taps fall through to the bubble; interactive (and touch-capturing)
      // only when a press handler is wired.
      pointerEvents={onPress ? 'box-only' : 'none'}
      onPress={onPress}
      hitSlop={6}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={onPress ? 'View who reacted' : undefined}
    >
      {keys.map((k) => (
        <View
          key={k}
          style={[
            styles.badge,
            {
              backgroundColor: mine.has(k)
                ? theme.color.tint
                : theme.color.bubble.receivedBackgroundBottom,
              borderColor: theme.color.background,
            },
          ]}
        >
          <Text style={styles.emoji}>{glyphOf(k)}</Text>
        </View>
      ))}
    </Container>
  );
}

const styles = StyleSheet.create({
  row: { position: 'absolute', top: -14, flexDirection: 'row', gap: 2 },
  left: { left: 2 },
  right: { right: 2 },
  badge: {
    minWidth: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1.5,
    paddingHorizontal: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emoji: { fontSize: 12 },
});
