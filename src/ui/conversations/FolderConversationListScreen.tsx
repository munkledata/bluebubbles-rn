import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { useCallback, useLayoutEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { InboxRow } from '@db/repositories';
import { useCustomFolderChats } from '@features/conversations/useCustomFolderChats';
import {
  captureRealtimeDeliveryLease,
  subscribeRealtimeGenerationInvalidation,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import { Screen, ScreenHeader } from '../primitives';
import { useTheme } from '../theme';
import { useChatNavigator } from '../useChatNavigator';
import { ChatActionsSheet, type ChatActionTarget, toChatActionTarget } from './ChatActionsSheet';
import { ConversationTile } from './ConversationTile';
import { InboxSeparator } from './FilteredChatListScreen';

interface FolderConversationListScreenProps {
  folderId: number | null;
}

interface FolderConversationListAttemptProps {
  folderId: number | null;
  accountLease: RealtimeDeliveryLease;
  enabled: boolean;
  onRetry: () => void;
}

/** Account-owned wrapper; changing the attempt key gives a failed reactive read a clean retry. */
export function FolderConversationListScreen({
  folderId,
}: FolderConversationListScreenProps): React.JSX.Element {
  const [accountLease] = useState(() => captureRealtimeDeliveryLease());
  const [accountRetired, setAccountRetired] = useState(() => !accountLease.isCurrent());
  const [attempt, setAttempt] = useState(0);

  useLayoutEffect(
    () =>
      subscribeRealtimeGenerationInvalidation(accountLease.generation, () => {
        setAccountRetired(true);
      }),
    [accountLease],
  );

  const accountCurrent = !accountRetired && accountLease.isCurrent();
  if (!accountCurrent) return <Screen />;

  return (
    <FolderConversationListAttempt
      key={`${folderId ?? 'invalid'}:${attempt}`}
      folderId={folderId}
      accountLease={accountLease}
      enabled={accountCurrent}
      onRetry={() => setAttempt((current) => current + 1)}
    />
  );
}

function FolderConversationListAttempt({
  folderId,
  accountLease,
  enabled,
  onRetry,
}: FolderConversationListAttemptProps): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const openChatNav = useChatNavigator();
  const { data, error, isLoading, hasMore, loadMore } = useCustomFolderChats(
    folderId,
    accountLease,
    enabled,
  );
  const [actionTarget, setActionTarget] = useState<ChatActionTarget | null>(null);
  const openChat = useCallback(
    (guid: string): void => openChatNav(`/chat/${encodeURIComponent(guid)}`),
    [openChatNav],
  );
  const onLongPress = useCallback((row: InboxRow): void => {
    setActionTarget(toChatActionTarget(row));
  }, []);
  const renderItem = useCallback(
    ({ item }: { item: InboxRow }): React.JSX.Element => (
      <ConversationTile row={item} onPress={openChat} onLongPress={onLongPress} />
    ),
    [onLongPress, openChat],
  );

  const title = data?.folder.name ?? 'Conversation Folder';
  const unavailableCount = data == null ? 0 : data.folder.chatCount - data.availableCount;
  const savedConversationLabel =
    data?.folder.chatCount === 1 ? 'saved conversation' : 'saved conversations';
  const emptyText =
    data?.folder.chatCount === 0
      ? 'No conversations have been added to this folder.'
      : 'No folder conversations are currently available. Their folder memberships remain saved, and a conversation will appear here again if it returns.';

  return (
    <Screen>
      <ScreenHeader
        title={title}
        onBack={() => router.back()}
        right={
          folderId != null ? (
            <Pressable
              onPress={() => router.push(`/folders/edit?folderId=${folderId}`)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={
                data ? `Rename or delete ${data.folder.name}` : 'Rename or delete this folder'
              }
            >
              <Text style={[styles.edit, { color: theme.color.tint }]}>Edit</Text>
            </Pressable>
          ) : null
        }
      />

      {folderId == null ? (
        <CenteredMessage text="This folder link is invalid." />
      ) : error ? (
        <View style={styles.center}>
          <Text
            selectable
            accessibilityRole="alert"
            accessibilityLiveRegion="assertive"
            style={[styles.message, { color: theme.color.destructive }]}
          >
            Couldn’t load this folder.
          </Text>
          <Pressable onPress={onRetry} accessibilityRole="button" style={styles.retry}>
            <Text style={[styles.retryText, { color: theme.color.tint }]}>Try Again</Text>
          </Pressable>
        </View>
      ) : isLoading || data == null ? (
        isLoading ? (
          <ActivityIndicator style={styles.loading} color={theme.color.tint} />
        ) : (
          <CenteredMessage text="This folder no longer exists." />
        )
      ) : (
        <>
          <View style={[styles.summary, { borderBottomColor: theme.color.separator }]}>
            <Text selectable style={[styles.summaryCount, { color: theme.color.label }]}>
              {data.availableCount.toLocaleString()} of {data.folder.chatCount.toLocaleString()}{' '}
              {savedConversationLabel} available
            </Text>
            {unavailableCount > 0 ? (
              <Text selectable style={[styles.summaryNote, { color: theme.color.secondaryLabel }]}>
                {unavailableCount.toLocaleString()}{' '}
                {unavailableCount === 1 ? 'conversation is' : 'conversations are'} not currently
                available.{' '}
                {unavailableCount === 1 ? 'Its membership remains' : 'Their memberships remain'}{' '}
                saved; {unavailableCount === 1 ? 'it will appear' : 'each will appear'} again if the
                conversation returns.
              </Text>
            ) : null}
          </View>
          <FlashList
            data={data.rows}
            keyExtractor={(row: InboxRow) => row.guid}
            renderItem={renderItem}
            ItemSeparatorComponent={InboxSeparator}
            onEndReached={hasMore ? loadMore : undefined}
            onEndReachedThreshold={0.5}
            ListEmptyComponent={
              <View style={styles.empty}>
                <Text selectable style={[styles.message, { color: theme.color.secondaryLabel }]}>
                  {emptyText}
                </Text>
              </View>
            }
            contentContainerStyle={styles.listContent}
          />
          <ChatActionsSheet target={actionTarget} onClose={() => setActionTarget(null)} />
        </>
      )}
    </Screen>
  );
}

function CenteredMessage({ text }: { text: string }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.center}>
      <Text selectable style={[styles.message, { color: theme.color.secondaryLabel }]}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  edit: { fontSize: 16, fontWeight: '600', textAlign: 'right' },
  loading: { paddingTop: 80 },
  center: { paddingTop: 80, paddingHorizontal: 24, alignItems: 'center', gap: 12 },
  message: { textAlign: 'center', fontSize: 15, lineHeight: 21 },
  retry: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 },
  retryText: { fontSize: 16, fontWeight: '600' },
  summary: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  summaryCount: { fontSize: 13, lineHeight: 18, fontVariant: ['tabular-nums'] },
  summaryNote: { fontSize: 12, lineHeight: 17, paddingTop: 3 },
  empty: { paddingTop: 72, paddingHorizontal: 24, alignItems: 'center' },
  listContent: { paddingBottom: 24 },
});
