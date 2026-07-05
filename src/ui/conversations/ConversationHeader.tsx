import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useChatHeader } from '@features/conversations/useChatHeader';
import { useFaceTime } from '@features/facetime/useFaceTime';
import { useRedactedModeStore } from '@state/redactedModeStore';
import {
  avatarSeed,
  isGroupRow,
  isRcsChatGuid,
  participantAvatars,
  participantList,
  redactTitle,
  resolveTitle,
} from '@utils';
import { Avatar, GroupAvatar, Icon, ServiceBadge } from '../primitives';
import { useTheme } from '../theme';

interface ConversationHeaderProps {
  chatGuid: string;
}

/** iOS conversation nav bar: back chevron + centered avatar + title. */
export function ConversationHeader({ chatGuid }: ConversationHeaderProps): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { data } = useChatHeader(chatGuid);
  const { startCall } = useFaceTime();
  const redacted = useRedactedModeStore((s) => s.enabled);
  const title = redactTitle(data ? resolveTitle(data) : '', redacted);
  const group = data ? isGroupRow(data) : false;
  const isRcs = isRcsChatGuid(chatGuid);

  return (
    <View
      style={[
        styles.header,
        {
          paddingTop: insets.top + 6,
          backgroundColor: theme.color.background,
          borderBottomColor: theme.color.separator,
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
          <Text style={[styles.back, { color: theme.color.tint }]}>‹</Text>
        </Pressable>
      </View>
      <Pressable
        onPress={() => router.push(`/chat-settings/${encodeURIComponent(chatGuid)}`)}
        style={styles.center}
        accessibilityRole="button"
        accessibilityLabel={title ? `${title}, chat details` : 'Chat details'}
      >
        {data ? (
          group ? (
            <GroupAvatar
              names={participantList(data.participantNames)}
              uris={participantAvatars(data.participantAvatars)}
              size={30}
            />
          ) : (
            <Avatar
              name={avatarSeed(data)}
              size={30}
              uri={participantAvatars(data.participantAvatars)[0]}
            />
          )
        ) : null}
        <View style={styles.titleRow}>
          <Text numberOfLines={1} style={[styles.title, { color: theme.color.label }]}>
            {title}
          </Text>
          {isRcs ? <ServiceBadge label="RCS" /> : null}
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
          <Icon name="videocam-outline" size={24} color={theme.color.tint} />
        </Pressable>
        <Pressable
          onPress={() => router.push('/scheduled')}
          hitSlop={12}
          style={styles.side}
          accessibilityRole="button"
          accessibilityLabel="View scheduled messages"
        >
          <Icon name="calendar-outline" size={24} color={theme.color.tint} />
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
});
