import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { InboxRow } from '@db/repositories';
import { useRedactedModeStore } from '@state/redactedModeStore';
import {
  avatarSeed,
  isGroupRow,
  participantAvatars,
  participantList,
  redactTitle,
  resolveTitle,
} from '@utils';
import { Avatar, GroupAvatar } from '../primitives';
import { useTheme } from '../theme';

interface PinnedGridProps {
  rows: InboxRow[];
  onPress: (guid: string) => void;
  onLongPress: (row: InboxRow) => void;
}

/** iOS pinned-conversations grid: large circular avatars above the inbox list. */
export function PinnedGrid({
  rows,
  onPress,
  onLongPress,
}: PinnedGridProps): React.JSX.Element | null {
  const theme = useTheme();
  const redacted = useRedactedModeStore((s) => s.enabled);
  if (rows.length === 0) return null;
  return (
    <View style={styles.grid}>
      {rows.map((row) => {
        const title = redactTitle(resolveTitle(row), redacted);
        return (
          <Pressable
            key={row.guid}
            style={styles.cell}
            onPress={() => onPress(row.guid)}
            onLongPress={() => onLongPress(row)}
            delayLongPress={350}
            accessibilityRole="button"
            accessibilityLabel={`Pinned conversation: ${title}`}
          >
            {isGroupRow(row) ? (
              <GroupAvatar
                names={redacted ? ['Contact', 'Contact'] : participantList(row.participantNames)}
                uris={redacted ? [] : participantAvatars(row.participantAvatars)}
                size={64}
              />
            ) : (
              <Avatar
                name={redacted ? 'Contact' : avatarSeed(row)}
                uri={redacted ? null : participantAvatars(row.participantAvatars)[0]}
                size={64}
              />
            )}
            <Text numberOfLines={1} style={[styles.name, { color: theme.color.secondaryLabel }]}>
              {title}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 8, paddingBottom: 6 },
  cell: { width: '25%', alignItems: 'center', paddingVertical: 8 },
  name: { fontSize: 12, marginTop: 4, maxWidth: 80, textAlign: 'center' },
});
