import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { InboxRow } from '@db/repositories';
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
import { useRedactedModeStore } from '@state/redactedModeStore';
import {
  avatarSeed,
  buildPreview,
  formatChatDate,
  isGroupRow,
  participantAvatars,
  participantList,
  redactPreview,
  redactTitle,
  resolveTitle,
} from '@utils';
import { Avatar, GroupAvatar, Icon } from '../primitives';
import { useTheme } from '../theme';

interface ConversationTileProps {
  row: InboxRow;
  onPress: (guid: string) => void;
  // Long-press → chat actions (pin/mute/archive/delete). Takes the row so the inbox
  // can pass a STABLE callback (the binding happens here, inside the memoized tile).
  onLongPress?: (row: InboxRow) => void;
}

/** One iOS Messages-style conversation row. Memoized so an update to one chat
 * doesn't re-render every other row (the inbox FlashList passes a stable onPress). */
export const ConversationTile = React.memo(function ConversationTile({
  row,
  onPress,
  onLongPress,
}: ConversationTileProps): React.JSX.Element {
  const theme = useTheme();
  const redacted = useRedactedModeStore((s) => s.enabled);
  const compact = useFeatureSettingsStore((s) => s.compactChatList);
  const unread = row.unreadCount > 0;
  const title = redactTitle(resolveTitle(row), redacted);
  const preview = redactPreview(buildPreview(row), redacted);
  const group = isGroupRow(row);
  const muted = row.muteType === 'mute';

  return (
    <Pressable
      onPress={() => onPress(row.guid)}
      onLongPress={onLongPress ? () => onLongPress(row) : undefined}
      delayLongPress={350}
      style={({ pressed }) => [
        styles.tile,
        compact ? styles.tileCompact : null,
        pressed ? { backgroundColor: theme.color.secondaryBackground } : null,
      ]}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${unread ? 'Unread. ' : ''}${preview}`}
      accessibilityHint="Double tap to open, or long press for actions"
    >
      <View style={styles.leading}>
        {unread ? (
          <View style={[styles.dot, { backgroundColor: theme.color.tint }]} />
        ) : (
          <View style={styles.dotSpacer} />
        )}
        {group ? (
          <GroupAvatar
            // Redacted mode masks the monogram + photo with deterministic seeded tiles
            // (distinct per person, but revealing neither name nor photo).
            names={redacted ? ['Contact', 'Contact'] : participantList(row.participantNames)}
            uris={redacted ? [] : participantAvatars(row.participantAvatars)}
            seeds={redacted ? participantList(row.participantNames) : undefined}
          />
        ) : (
          <Avatar
            name={avatarSeed(row)}
            uri={redacted ? null : participantAvatars(row.participantAvatars)[0]}
            seed={redacted ? avatarSeed(row) : undefined}
          />
        )}
      </View>

      <View style={styles.center}>
        <Text
          numberOfLines={1}
          style={[styles.title, { color: theme.color.label, fontWeight: unread ? '600' : '500' }]}
        >
          {title}
        </Text>
        <Text
          numberOfLines={compact ? 1 : 2}
          style={[styles.preview, { color: theme.color.secondaryLabel }]}
        >
          {preview}
        </Text>
      </View>

      <View style={styles.trailing}>
        <Text style={[styles.time, { color: theme.color.tertiaryLabel }]}>
          {formatChatDate(row.lastDate)}
        </Text>
        <View style={styles.trailingRow}>
          {muted ? (
            <Icon name="notifications-off-outline" size={14} color={theme.color.tertiaryLabel} />
          ) : null}
          <Text style={[styles.chevron, { color: theme.color.separator }]}>›</Text>
        </View>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  tile: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingRight: 12 },
  tileCompact: { paddingVertical: 6 },
  leading: { flexDirection: 'row', alignItems: 'center', width: 64, paddingLeft: 6 },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 6 },
  dotSpacer: { width: 10, marginRight: 6 },
  center: { flex: 1, paddingRight: 8 },
  title: { fontSize: 17, marginBottom: 2 },
  preview: { fontSize: 15, lineHeight: 20 },
  trailing: { alignItems: 'flex-end', minWidth: 52 },
  time: { fontSize: 13, marginBottom: 4 },
  trailingRow: { flexDirection: 'row', alignItems: 'center' },
  chevron: { fontSize: 18, fontWeight: '600' },
});
