import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useChatHeader } from '@features/conversations/useChatHeader';
import { useFaceTime } from '@features/facetime/useFaceTime';
import { useRedactedModeStore } from '@state/redactedModeStore';
import {
  avatarSeed,
  dedupeParticipants,
  isGroupRow,
  participantAvatars,
  participantList,
  redactTitle,
  resolveChatService,
  resolveTitle,
} from '@utils';
import { Avatar, GroupAvatar, Icon, ServiceBadge } from '../primitives';
import { useTheme, withAlpha } from '../theme';

interface ConversationHeaderProps {
  chatGuid: string;
  /** A chat wallpaper is set → tint the bar translucent so the image shows through (no black bar). */
  translucent?: boolean;
}

/** iOS conversation nav bar: back chevron + centered avatar + title. */
export function ConversationHeader({
  chatGuid,
  translucent = false,
}: ConversationHeaderProps): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { data } = useChatHeader(chatGuid);
  const { startCall } = useFaceTime();
  const redacted = useRedactedModeStore((s) => s.enabled);
  const title = redactTitle(data ? resolveTitle(data) : '', redacted);
  const group = data ? isGroupRow(data) : false;
  // Over a wallpaper the bar disappears and each control floats in its own frosted bubble.
  const chip = withAlpha(theme.color.background, 0.62);
  const bubble = translucent ? [styles.bubble, { backgroundColor: chip }] : null;
  const service = resolveChatService(chatGuid, data?.handleServices);
  const badge =
    service === 'RCS'
      ? { label: 'RCS', color: theme.color.bubble.rcsBackground }
      : service === 'SMS'
        ? { label: 'SMS', color: theme.color.bubble.smsBackground }
        : service === 'iMessage'
          ? { label: 'iMessage', color: theme.color.bubble.senderBackground }
          : null;
  const parts = data
    ? dedupeParticipants(
        participantList(data.participantNames),
        participantAvatars(data.participantAvatars),
      )
    : { names: [] as string[], uris: [] as (string | null)[] };

  return (
    <View
      style={[
        styles.header,
        {
          paddingTop: insets.top + 6,
          backgroundColor: translucent ? 'transparent' : theme.color.background,
          borderBottomColor: translucent ? 'transparent' : theme.color.separator,
        },
      ]}
    >
      <View style={styles.leftGroup}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={12}
          style={styles.side}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <View style={bubble}>
            <Text style={[styles.back, { color: theme.color.tint }]}>‹</Text>
          </View>
        </Pressable>
      </View>
      <Pressable
        onPress={() => router.push(`/chat-settings/${encodeURIComponent(chatGuid)}`)}
        style={styles.center}
        accessibilityRole="button"
        accessibilityLabel={title ? `${title}, chat details` : 'Chat details'}
      >
        {data ? (
          <View style={translucent ? [styles.avatarBubble, { backgroundColor: chip }] : null}>
            {group ? (
              <GroupAvatar names={parts.names} uris={parts.uris} size={30} />
            ) : (
              <Avatar
                name={avatarSeed(data)}
                size={30}
                uri={participantAvatars(data.participantAvatars)[0]}
              />
            )}
          </View>
        ) : null}
        <View style={styles.titleRow}>
          <Text
            numberOfLines={1}
            style={[
              styles.title,
              { color: theme.color.label },
              translucent ? [styles.titlePill, { backgroundColor: chip }] : null,
            ]}
          >
            {title}
          </Text>
          {badge ? <ServiceBadge label={badge.label} color={badge.color} /> : null}
        </View>
      </Pressable>
      <View style={styles.rightGroup}>
        <Pressable
          onPress={() => void startCall({ chatGuid, video: true })}
          hitSlop={12}
          style={styles.side}
          accessibilityRole="button"
          accessibilityLabel="Start FaceTime call"
        >
          <View style={bubble}>
            <Icon name="videocam-outline" size={24} color={theme.color.tint} />
          </View>
        </Pressable>
        <Pressable
          onPress={() => router.push('/scheduled')}
          hitSlop={12}
          style={styles.side}
          accessibilityRole="button"
          accessibilityLabel="View scheduled messages"
        >
          <View style={bubble}>
            <Icon name="calendar-outline" size={24} color={theme.color.tint} />
          </View>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: 8,
    paddingHorizontal: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  // Equal-width side groups (88 = two 44 slots) keep the centered title balanced even
  // though the left has one button and the right has two.
  leftGroup: {
    width: 88,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  rightGroup: { width: 88, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' },
  side: { width: 44, alignItems: 'center', justifyContent: 'center' },
  back: { fontSize: 34, fontWeight: '300', lineHeight: 36 },
  center: { flex: 1, alignItems: 'center', gap: 2 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 5, maxWidth: '90%' },
  title: { fontSize: 15, fontWeight: '600', flexShrink: 1 },
  // Floating-over-wallpaper chrome: each control sits in its own frosted bubble.
  bubble: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  avatarBubble: { borderRadius: 999, padding: 3 },
  titlePill: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 12,
    overflow: 'hidden',
    marginTop: 1,
  },
});
