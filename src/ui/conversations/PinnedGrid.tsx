import React from 'react';
import { type AccessibilityActionEvent, Pressable, StyleSheet, Text, View } from 'react-native';
import type { InboxRow, PinnedOrderMoveDirection } from '@db/repositories';
import {
  avatarSeed,
  dedupeParticipantDetails,
  isGroupRow,
  participantAvatars,
  participantColors,
  participantList,
  primaryParticipantColor,
  resolveTitle,
} from '@utils';
import { Avatar, GroupAvatar } from '../primitives';
import { useTheme } from '../theme';

interface PinnedGridProps {
  rows: InboxRow[];
  onPress: (guid: string) => void;
  onLongPress: (row: InboxRow) => void;
  onMove?: (guid: string, adjacentGuid: string, direction: PinnedOrderMoveDirection) => void;
}

/** iOS pinned-conversations grid: large circular avatars above the inbox list. */
export function PinnedGrid({
  rows,
  onPress,
  onLongPress,
  onMove,
}: PinnedGridProps): React.JSX.Element | null {
  const theme = useTheme();
  if (rows.length === 0) return null;
  return (
    <View style={styles.grid}>
      {rows.map((row, index) => {
        const title = resolveTitle(row);
        const unread = row.unreadCount > 0;
        const colors = participantColors(row.participantColors);
        const parts = dedupeParticipantDetails(
          participantList(row.participantNames),
          participantAvatars(row.participantAvatars),
          colors,
        );
        const earlierGuid = rows[index - 1]?.guid ?? null;
        const laterGuid = rows[index + 1]?.guid ?? null;
        const accessibilityActions = [
          { name: 'longpress', label: 'Show conversation actions' },
          ...(onMove && earlierGuid ? [{ name: 'moveEarlier', label: 'Move earlier' }] : []),
          ...(onMove && laterGuid ? [{ name: 'moveLater', label: 'Move later' }] : []),
        ];
        const handleAccessibilityAction = (event: AccessibilityActionEvent): void => {
          switch (event.nativeEvent.actionName) {
            case 'longpress':
              onLongPress(row);
              break;
            case 'moveEarlier':
              if (earlierGuid) onMove?.(row.guid, earlierGuid, 'earlier');
              break;
            case 'moveLater':
              if (laterGuid) onMove?.(row.guid, laterGuid, 'later');
              break;
          }
        };
        return (
          <Pressable
            key={row.guid}
            style={styles.cell}
            onPress={() => onPress(row.guid)}
            onLongPress={() => onLongPress(row)}
            delayLongPress={350}
            accessibilityRole="button"
            accessibilityActions={accessibilityActions}
            accessibilityHint="Double tap and hold for conversation actions"
            onAccessibilityAction={handleAccessibilityAction}
            // Unread belongs IN the label: the dot below is the only unread signal in the grid and
            // a decorative view announces nothing, so TalkBack users would otherwise never hear it.
            accessibilityLabel={`Pinned conversation: ${title}${unread ? ', unread' : ''}`}
          >
            <View style={styles.avatarWrap}>
              {isGroupRow(row) ? (
                <GroupAvatar
                  names={parts.names}
                  uris={parts.uris}
                  colors={parts.colors}
                  size={64}
                />
              ) : (
                <Avatar
                  name={avatarSeed(row)}
                  uri={participantAvatars(row.participantAvatars)[0]}
                  color={primaryParticipantColor(row.participantColors)}
                  size={64}
                />
              )}
              {/* Presence only, never the count — the cell is ~64px and a number would crowd the
                  avatar. The ring is the page background so the dot reads over a photo's edge.
                  Presence alone says only that there is something unread, and it's the whole point
                  of pinning a chat. */}
              {unread ? (
                <View
                  style={[
                    styles.unreadDot,
                    { backgroundColor: theme.color.tint, borderColor: theme.color.background },
                  ]}
                  testID={`pinned-unread-${index}`}
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
