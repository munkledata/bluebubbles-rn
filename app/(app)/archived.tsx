import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useChats } from '@features/conversations/useChats';
import type { InboxRow } from '@db/repositories';
import { resolveTitle } from '@utils';
import { ChatActionsSheet, type ChatActionTarget, ConversationTile, Screen, useTheme } from '@ui';

/** Archived conversations: a flat list; long-press → unarchive / pin / delete. */
export default function ArchivedScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { data } = useChats(true); // include archived
  const archived = useMemo(() => (data ?? []).filter((r) => r.isArchived), [data]);

  const openChat = useCallback(
    (guid: string): void => router.push(`/chat/${encodeURIComponent(guid)}`),
    [router],
  );
  const [actionTarget, setActionTarget] = useState<ChatActionTarget | null>(null);
  const onLongPress = useCallback((row: InboxRow): void => {
    setActionTarget({
      guid: row.guid,
      title: resolveTitle(row),
      isPinned: !!row.isPinned,
      isArchived: !!row.isArchived,
      muted: row.muteType === 'mute',
      unread: (row.unreadCount ?? 0) > 0,
    });
  }, []);

  return (
    <Screen>
      <View
        style={[
          styles.header,
          { paddingTop: insets.top + 8, borderBottomColor: theme.color.separator },
        ]}
      >
        <Pressable onPress={() => router.back()} hitSlop={8} accessibilityRole="button">
          <Text style={[styles.back, { color: theme.color.tint }]}>‹ Back</Text>
        </Pressable>
        <Text style={[styles.title, { color: theme.color.label }]}>Archived</Text>
        <View style={styles.spacer} />
      </View>

      <FlashList
        data={archived}
        keyExtractor={(r: InboxRow) => r.guid}
        renderItem={({ item }: { item: InboxRow }) => (
          <ConversationTile row={item} onPress={openChat} onLongPress={onLongPress} />
        )}
        ItemSeparatorComponent={() => (
          <View style={[styles.separator, { backgroundColor: theme.color.separator }]} />
        )}
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={[styles.empty, { color: theme.color.secondaryLabel }]}>
              No archived conversations
            </Text>
          </View>
        }
        contentContainerStyle={styles.listContent}
      />
      <ChatActionsSheet target={actionTarget} onClose={() => setActionTarget(null)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  back: { fontSize: 17, width: 70 },
  title: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '600' },
  spacer: { width: 70 },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 76 },
  listContent: { paddingBottom: 24 },
  center: { paddingTop: 80, alignItems: 'center' },
  empty: { fontSize: 16 },
});
