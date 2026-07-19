import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useChats } from '@features/conversations/useChats';
import type { InboxRow } from '@db/repositories';
import { Screen, ScreenHeader } from '../primitives';
import { useTheme } from '../theme';
import { useChatNavigator } from '../useChatNavigator';
import { ChatActionsSheet, type ChatActionTarget, toChatActionTarget } from './ChatActionsSheet';
import { ConversationTile } from './ConversationTile';

/** Hoisted list separator: an inline `ItemSeparatorComponent={() => …}` closure is a fresh
 * component TYPE every render, so the list would unmount/remount each separator on re-render. */
export function InboxSeparator(): React.JSX.Element {
  const theme = useTheme();
  return <View style={[styles.separator, { backgroundColor: theme.color.separator }]} />;
}

interface FilteredChatListScreenProps {
  title: string;
  emptyText: string;
  /** Which inbox rows this list shows. Pass a module-scope function so it's stable. */
  filter: (row: InboxRow) => boolean;
  /** Widen the reactive query to include archived chats (the Archived list needs them). */
  includeArchived?: boolean;
}

/**
 * A filtered flat conversation list under a back-titled header (Archived / Unknown Senders).
 * Long-press a row → the pin/mute/archive/delete sheet.
 */
export function FilteredChatListScreen({
  title,
  emptyText,
  filter,
  includeArchived = false,
}: FilteredChatListScreenProps): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const openChatNav = useChatNavigator();
  const { data } = useChats(includeArchived);
  const rows = useMemo(() => (data ?? []).filter(filter), [data, filter]);

  const openChat = useCallback(
    (guid: string): void => openChatNav(`/chat/${encodeURIComponent(guid)}`),
    [openChatNav],
  );
  const [actionTarget, setActionTarget] = useState<ChatActionTarget | null>(null);
  const onLongPress = useCallback((row: InboxRow): void => {
    setActionTarget(toChatActionTarget(row));
  }, []);

  return (
    <Screen>
      <ScreenHeader title={title} onBack={() => router.back()} />

      <FlashList
        data={rows}
        keyExtractor={(r: InboxRow) => r.guid}
        renderItem={({ item }: { item: InboxRow }) => (
          <ConversationTile row={item} onPress={openChat} onLongPress={onLongPress} />
        )}
        ItemSeparatorComponent={InboxSeparator}
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={[styles.empty, { color: theme.color.secondaryLabel }]}>{emptyText}</Text>
          </View>
        }
        contentContainerStyle={styles.listContent}
      />
      <ChatActionsSheet target={actionTarget} onClose={() => setActionTarget(null)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 76 },
  listContent: { paddingBottom: 24 },
  center: { paddingTop: 80, alignItems: 'center' },
  empty: { fontSize: 16 },
});
