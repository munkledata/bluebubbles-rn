import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useChatHeader } from '@features/conversations/useChatHeader';
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

interface ConversationHeaderProps {
  chatGuid: string;
}

/** iOS conversation nav bar: back chevron + centered avatar + title. */
export function ConversationHeader({ chatGuid }: ConversationHeaderProps): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { data } = useChatHeader(chatGuid);
  const redacted = useRedactedModeStore((s) => s.enabled);
  const title = redactTitle(data ? resolveTitle(data) : '', redacted);
  const group = data ? isGroupRow(data) : false;

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
      <Pressable
        onPress={() => router.back()}
        hitSlop={12}
        style={styles.side}
        accessibilityRole="button"
        accessibilityLabel="Go back"
      >
        <Text style={[styles.back, { color: theme.color.tint }]}>‹</Text>
      </Pressable>
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
        <Text numberOfLines={1} style={[styles.title, { color: theme.color.label }]}>
          {title}
        </Text>
      </Pressable>
      <Pressable
        onPress={() => router.push('/scheduled')}
        hitSlop={12}
        style={styles.side}
        accessibilityRole="button"
        accessibilityLabel="View scheduled messages"
      >
        <Text style={styles.calendar}>🗓️</Text>
      </Pressable>
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
  side: { width: 44, alignItems: 'center', justifyContent: 'center' },
  back: { fontSize: 34, fontWeight: '300', lineHeight: 36 },
  center: { flex: 1, alignItems: 'center', gap: 2 },
  title: { fontSize: 15, fontWeight: '600', maxWidth: '90%' },
  calendar: { fontSize: 20 },
});
