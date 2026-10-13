import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { showDialog } from '@ui/dialog/dialogStore';
import { getDatabase } from '@db/database';
import { listDeletedChats, type DeletedChatRow } from '@db/repositories';
import { useReactiveQuery } from '@db/useReactiveQuery';
import { restoreDeletedChat } from '@/services';
import { subscribeRealtimeGenerationInvalidation } from '@/services/realtime/deliveryCoordinator';
import { resolveTitle } from '@utils';
import { Screen, ScreenHeader } from '../primitives';
import { readableTextOn, useTheme } from '../theme';
import { useScreenAccountLease } from '@ui/hooks/useScreenAccountLease';

const PAGE_SIZE = 50;
const TABLES = ['chats', 'messages', 'chat_handles', 'handles', 'kv'];
const ACCOUNT_CHANGED_COPY =
  'Conversation account changed. Go back and reopen Deleted Conversations.';

/** Soft-deleted conversations stay recoverable without making them visible in normal chat lists. */
export function DeletedChatsScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const accountLease = useScreenAccountLease();
  const [accountRetired, setAccountRetired] = useState(() => !accountLease.isCurrent());
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [restoringGuid, setRestoringGuid] = useState<string | null>(null);

  useLayoutEffect(
    () =>
      subscribeRealtimeGenerationInvalidation(accountLease.generation, () => {
        setAccountRetired(true);
        setRestoringGuid(null);
      }),
    [accountLease],
  );

  const accountCurrent = !accountRetired && accountLease.isCurrent();
  const { data, isLoading, error } = useReactiveQuery(
    () => listDeletedChats(getDatabase(), { limit }),
    TABLES,
    [limit],
    { enabled: accountCurrent },
  );
  // `useReactiveQuery` clears disabled data in an effect. Mask it at render time too so a retiring
  // account cannot commit one frame of its deleted-conversation titles or restore actions.
  const rows = useMemo(() => (accountCurrent ? (data?.rows ?? []) : []), [accountCurrent, data]);

  const confirmRestore = useCallback(
    (row: DeletedChatRow): void => {
      if (!accountLease.isCurrent() || restoringGuid) return;
      const title = resolveTitle(row);
      showDialog(
        'Restore Conversation',
        `Restore “${title}” and re-download its 500 most recent messages? Older history remains available through a full Local Cache Repair.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Restore',
            onPress: () => {
              if (!accountLease.isCurrent()) return;
              setRestoringGuid(row.guid);
              void restoreDeletedChat(row.guid, row.deletedAt)
                .then((result) => {
                  if (!accountLease.isCurrent()) return;
                  showDialog(
                    'Conversation Restored',
                    `${result.messages.toLocaleString()} recent messages were refreshed.`,
                  );
                })
                .catch(() => {
                  if (accountLease.isCurrent()) {
                    showDialog(
                      'Restore Stopped',
                      'Gator could not prove a safe unread boundary from the bounded history. Run Local Cache Repair, then try again.',
                    );
                  }
                })
                .finally(() => {
                  if (accountLease.isCurrent()) setRestoringGuid(null);
                });
            },
          },
        ],
      );
    },
    [accountLease, restoringGuid],
  );

  const renderItem = useCallback(
    ({ item }: { item: DeletedChatRow }): React.JSX.Element => {
      const restoring = restoringGuid === item.guid;
      const disabled = restoringGuid != null || !accountCurrent;
      const restoreForeground = readableTextOn(theme.color.tint);
      return (
        <View style={[styles.row, { borderBottomColor: theme.color.separator }]}>
          <View style={styles.details}>
            <Text numberOfLines={1} style={[styles.title, { color: theme.color.label }]}>
              {resolveTitle(item)}
            </Text>
            <Text style={[styles.subtitle, { color: theme.color.secondaryLabel }]}>
              Deleted {new Date(item.deletedAt).toLocaleDateString()}
            </Text>
          </View>
          <Pressable
            onPress={() => confirmRestore(item)}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={`Restore ${resolveTitle(item)}`}
            accessibilityState={{ disabled, busy: restoring }}
            style={[styles.restoreButton, { backgroundColor: theme.color.tint }]}
          >
            {restoring ? (
              <ActivityIndicator size="small" color={restoreForeground} />
            ) : (
              <Text style={[styles.restoreText, { color: restoreForeground }]}>Restore</Text>
            )}
          </Pressable>
        </View>
      );
    },
    [accountCurrent, confirmRestore, restoringGuid, theme],
  );

  return (
    <Screen>
      <ScreenHeader title="Deleted Conversations" onBack={() => router.back()} />
      {!accountCurrent ? (
        <View style={styles.empty}>
          <Text
            accessibilityRole="alert"
            accessibilityLiveRegion="assertive"
            style={[styles.emptyText, { color: theme.color.secondaryLabel }]}
          >
            {ACCOUNT_CHANGED_COPY}
          </Text>
        </View>
      ) : (
        <FlashList
          data={rows}
          keyExtractor={(row: DeletedChatRow) => row.guid}
          renderItem={renderItem}
          onEndReached={() => {
            if (data?.hasMore) setLimit((current) => Math.min(current + PAGE_SIZE, 250));
          }}
          onEndReachedThreshold={0.5}
          ListEmptyComponent={
            <View style={styles.empty}>
              {isLoading ? (
                <>
                  <ActivityIndicator color={theme.color.tint} />
                  <Text
                    accessibilityLiveRegion="polite"
                    style={[styles.emptyText, { color: theme.color.secondaryLabel }]}
                  >
                    Loading deleted conversations…
                  </Text>
                </>
              ) : (
                <Text
                  accessibilityRole={error ? 'alert' : undefined}
                  accessibilityLiveRegion={error ? 'assertive' : undefined}
                  style={[styles.emptyText, { color: theme.color.secondaryLabel }]}
                >
                  {error ? 'Couldn’t load deleted conversations.' : 'No deleted conversations.'}
                </Text>
              )}
            </View>
          }
          contentContainerStyle={styles.content}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 24 },
  row: {
    minHeight: 72,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  details: { flex: 1, gap: 4 },
  title: { fontSize: 16, fontWeight: '600' },
  subtitle: { fontSize: 13 },
  restoreButton: {
    minWidth: 82,
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  restoreText: { fontSize: 14, fontWeight: '600' },
  empty: { paddingTop: 80, alignItems: 'center', gap: 12 },
  emptyText: { fontSize: 16, textAlign: 'center' },
});
