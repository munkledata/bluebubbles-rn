import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { InboxRow } from '@db/repositories';
import { useRedactedModeStore } from '@state/redactedModeStore';
import {
  avatarSeed,
  dedupeParticipants,
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
        const unread = row.unreadCount > 0;
        const parts = dedupeParticipants(
          participantList(row.participantNames),
          participantAvatars(row.participantAvatars),
        );
        return (
          <Pressable
            key={row.guid}
            style={styles.cell}
            onPress={() => onPress(row.guid)}
            onLongPress={() => onLongPress(row)}
            delayLongPress={350}
            accessibilityRole="button"
            // Unread belongs IN the label: the dot below is the only unread signal in the grid and
            // a decorative view announces nothing, so TalkBack users would otherwise never hear it.
            accessibilityLabel={`Pinned conversation: ${title}${unread ? ', unread' : ''}`}
          >
            <View style={styles.avatarWrap}>
              {isGroupRow(row) ? (
                <GroupAvatar
                  names={redacted ? ['Contact', 'Contact'] : parts.names}
                  uris={redacted ? [] : parts.uris}
                  seeds={redacted ? participantList(row.participantNames) : undefined}
                  size={64}
                />
              ) : (
                <Avatar
                  name={avatarSeed(row)}
                  uri={redacted ? null : participantAvatars(row.participantAvatars)[0]}
                  seed={redacted ? avatarSeed(row) : undefined}
                  size={64}
                />
              )}
              {/* Presence only, never the count — the cell is ~64px and a number would crowd the
                  avatar. The ring is the page background so the dot reads over a photo's edge.
                  Not gated on redacted mode: "there is something unread" leaks nothing about who
                  or what, and it's the whole point of pinning a chat. */}
              {unread ? (
                <View
                  style={[
                    styles.unreadDot,
                    { backgroundColor: theme.color.tint, borderColor: theme.color.background },
                  ]}
                  testID={`pinned-unread-${row.guid}`}
                  accessible={false}
                />
              ) : null}
            </View>
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
  // Sized by the avatar so the absolutely-positioned dot has a determined box to hang off.
  avatarWrap: { width: 64, height: 64 },
  unreadDot: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
  },
  name: { fontSize: 12, marginTop: 4, maxWidth: 80, textAlign: 'center' },
});
