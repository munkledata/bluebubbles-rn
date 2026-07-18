import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { showDialog } from '@ui/dialog/dialogStore';
import { getDatabase } from '@db/database';
import {
  deleteChatLocal,
  setChatArchive,
  setChatMute,
  type InboxRow,
} from '@db/repositories';
import { markRead, markUnread } from '@/services';
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
import { useRedactedModeStore } from '@state/redactedModeStore';
import {
  avatarSeed,
  buildPreview,
  dedupeParticipants,
  formatChatDate,
  isGroupRow,
  participantAvatars,
  participantList,
  redactPreview,
  redactTitle,
  resolveChatService,
  resolveTitle,
} from '@utils';
import { Avatar, GroupAvatar, Icon, ServiceBadge } from '../primitives';
import { useTheme } from '../theme';
import { SwipeableRow, type SwipeAction } from './SwipeableRow';

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
  // Service pill (iMessage / SMS / RCS) — same treatment for all three, coloured to match the
  // bubble palette. Resolved from the participant handle service (not just the guid prefix) so an
  // SMS-only contact/shortcode reads SMS even when its guid was reported as iMessage. De-duplicated
  // participant photos for the group collage (a contact with two handles otherwise renders twice).
  const service = resolveChatService(row.guid, row.handleServices);
  const badge =
    service === 'RCS'
      ? { label: 'RCS', color: theme.color.bubble.rcsBackground }
      : service === 'SMS'
        ? { label: 'SMS', color: theme.color.bubble.smsBackground }
        : service === 'iMessage'
          ? { label: 'iMessage', color: theme.color.bubble.senderBackground }
          : null;
  const groupParts = dedupeParticipants(
    participantList(row.participantNames),
    participantAvatars(row.participantAvatars),
  );

  const confirmDelete = (): void => {
    showDialog(
      'Delete Conversation',
      `Delete “${title}”? This removes it from this device (not from the server).`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => void deleteChatLocal(getDatabase(), row.guid),
        },
      ],
    );
  };

  // Swipe-right reveals Read/Unread; swipe-left reveals Mute, Archive, Delete (same set as the
  // long-press sheet). iOS-ish colors.
  const leftActions: SwipeAction[] = [
    {
      key: 'read',
      label: unread ? 'Read' : 'Unread',
      icon: unread ? 'mail-open-outline' : 'mail-unread-outline',
      color: '#34C759',
      onPress: () => (unread ? void markRead(row.guid) : void markUnread(row.guid)),
    },
  ];
  const rightActions: SwipeAction[] = [
    {
      key: 'mute',
      label: muted ? 'Unmute' : 'Mute',
      icon: muted ? 'notifications-outline' : 'notifications-off-outline',
      color: '#FF9500',
      onPress: () => void setChatMute(getDatabase(), row.guid, muted ? null : 'mute'),
    },
    {
      key: 'archive',
      label: row.isArchived ? 'Unarchive' : 'Archive',
      icon: 'archive-outline',
      color: '#8E8E93',
      onPress: () => void setChatArchive(getDatabase(), row.guid, !row.isArchived),
    },
    {
      key: 'delete',
      label: 'Delete',
      icon: 'trash-outline',
      color: '#FF3B30',
      onPress: confirmDelete,
    },
  ];

  return (
    <SwipeableRow resetKey={row.guid} left={leftActions} right={rightActions}>
      <Pressable
        onPress={() => onPress(row.guid)}
        onLongPress={onLongPress ? () => onLongPress(row) : undefined}
        delayLongPress={350}
        style={({ pressed }) => [
          styles.tile,
          compact ? styles.tileCompact : null,
          { backgroundColor: theme.color.background },
          pressed ? { backgroundColor: theme.color.secondaryBackground } : null,
        ]}
        accessibilityRole="button"
        accessibilityLabel={`${title}. ${unread ? `${row.unreadCount} unread. ` : ''}${preview}`}
        accessibilityHint="Double tap to open, or long press for actions"
      >
        <View style={styles.leading}>
          {/* Unread is now signalled by the count badge on the right, so the leading gutter is
              always the spacer (keeps avatars aligned across read/unread rows). */}
          <View style={styles.dotSpacer} />
          {group ? (
            <GroupAvatar
              // Redacted mode masks the monogram + photo with deterministic seeded tiles
              // (distinct per person, but revealing neither name nor photo).
              names={redacted ? ['Contact', 'Contact'] : groupParts.names}
              uris={redacted ? [] : groupParts.uris}
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
          <View style={styles.titleRow}>
            <Text
              numberOfLines={1}
              style={[
                styles.title,
                { color: theme.color.label, fontWeight: unread ? '600' : '500' },
              ]}
            >
              {title}
            </Text>
            {badge ? (
              <ServiceBadge
                label={badge.label}
                color={badge.color}
                // Pale gator-green label on the deep-green RCS pill; other services keep white.
                textColor={service === 'RCS' ? '#EAF7EC' : undefined}
              />
            ) : null}
          </View>
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
            {unread ? (
              <View style={[styles.countBadge, { backgroundColor: theme.color.tint }]}>
                <Text style={styles.countText} numberOfLines={1}>
                  {row.unreadCount > 99 ? '99+' : row.unreadCount}
                </Text>
              </View>
            ) : null}
            {muted ? (
              <Icon name="notifications-off-outline" size={14} color={theme.color.tertiaryLabel} />
            ) : null}
            <Text style={[styles.chevron, { color: theme.color.separator }]}>›</Text>
          </View>
        </View>
      </Pressable>
    </SwipeableRow>
  );
});

const styles = StyleSheet.create({
  tile: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingRight: 12 },
  tileCompact: { paddingVertical: 6 },
  // width sizes the avatar column; the avatar is left-anchored, so the extra width past the
  // avatar (≈62px of content) becomes breathing room between the photo and the name/preview.
  leading: { flexDirection: 'row', alignItems: 'center', width: 74, paddingLeft: 6 },
  dotSpacer: { width: 10, marginRight: 6 },
  center: { flex: 1, paddingRight: 8 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
  title: { fontSize: 17, flexShrink: 1 },
  preview: { fontSize: 15, lineHeight: 20 },
  trailing: { alignItems: 'flex-end', minWidth: 52 },
  time: { fontSize: 13, marginBottom: 4 },
  trailingRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  chevron: { fontSize: 18, fontWeight: '600' },
  // Unread count pill (accent-colored — gator-green under the Gator theme, blue under OLED Dark).
  countBadge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
});
