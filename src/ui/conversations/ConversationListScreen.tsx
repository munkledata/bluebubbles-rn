import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { refreshInbox } from '@/services';
import { useChatMatches } from '@features/search/useChatMatches';
import type { InboxRow } from '@db/repositories';
import { resolveTitle } from '@utils';
import { Screen, TextField, usePullToRefresh } from '../primitives';
import { useTheme } from '../theme';
import { ChatActionsSheet, type ChatActionTarget } from './ChatActionsSheet';
import { ConversationTile } from './ConversationTile';
import { PinnedGrid } from './PinnedGrid';

/** Phase 3 inbox: a live (reactive) FlashList of iOS conversation tiles. */
export function ConversationListScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [search, setSearch] = useState('');
  // Matched chats come from the SHARED hook the search page also uses, so the two searches return
  // the SAME set (resolved name/participants OR message content, incl. decoded edited/SMS text).
  const { data, isLoading, error } = useChatMatches(search);
  const rows = data ?? [];
  // Pull-to-refresh: incremental sync. The list sits below the fixed header → no offset.
  const { refreshControl } = usePullToRefresh(refreshInbox);

  // Stable so the memoized ConversationTile doesn't re-render every list update.
  const openChat = useCallback(
    (guid: string): void => {
      router.push(`/chat/${encodeURIComponent(guid)}`);
    },
    [router],
  );

  // Long-press a tile → pin/mute/archive/delete sheet. Stable so the memoized tiles hold.
  const [actionTarget, setActionTarget] = useState<ChatActionTarget | null>(null);
  const onLongPress = useCallback((row: InboxRow): void => {
    setActionTarget({
      guid: row.guid,
      title: resolveTitle(row),
      isPinned: !!row.isPinned,
      isArchived: !!row.isArchived,
      muted: row.muteType === 'mute',
    });
  }, []);

  // Pinned chats render in a grid above the list (iOS); while searching, show a flat list.
  const searching = search.trim().length > 0;
  const pinned = useMemo(
    () => (searching ? [] : rows.filter((r) => r.isPinned)),
    [rows, searching],
  );
  const listData = useMemo(
    () => (searching ? rows : rows.filter((r) => !r.isPinned)),
    [rows, searching],
  );

  // The title + search are PINNED (rendered above the list, so they don't scroll away).
  const fixedHeader = (
    <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
      <View style={styles.titleRow}>
        <Text style={[styles.largeTitle, { color: theme.color.label }]}>Messages</Text>
        <View style={styles.headerActions}>
          <Pressable
            onPress={() => router.push('/new-chat')}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="New message"
          >
            <Text style={[styles.compose, { color: theme.color.tint }]}>✎</Text>
          </Pressable>
          <Pressable
            onPress={() => router.push('/settings')}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Settings"
          >
            <Text style={[styles.gear, { color: theme.color.tint }]}>⚙︎</Text>
          </Pressable>
        </View>
      </View>
      <View style={styles.searchWrap}>
        <TextField
          placeholder="Search"
          autoCapitalize="none"
          autoCorrect={false}
          value={search}
          onChangeText={setSearch}
          style={styles.searchInput}
        />
        {search.length > 0 ? (
          <Pressable
            onPress={() => setSearch('')}
            hitSlop={10}
            style={styles.clearButton}
            accessibilityRole="button"
            accessibilityLabel="Clear search"
          >
            <Text style={[styles.clearIcon, { color: theme.color.tertiaryLabel }]}>✕</Text>
          </Pressable>
        ) : null}
      </View>
      <Pressable
        onPress={() => router.push('/search')}
        hitSlop={6}
        style={styles.searchMessages}
        accessibilityRole="button"
        accessibilityLabel="Search messages"
      >
        <Text style={[styles.searchMessagesText, { color: theme.color.tint }]}>
          🔍 Search Messages
        </Text>
      </Pressable>
    </View>
  );

  // The pinned-chats grid scrolls WITH the list (it's content, like iOS).
  const listHeader =
    pinned.length > 0 ? (
      <View style={styles.pinnedWrap}>
        <PinnedGrid rows={pinned} onPress={openChat} onLongPress={onLongPress} />
      </View>
    ) : null;

  const ListFooter = (
    <Pressable
      onPress={() => router.push('/archived')}
      style={styles.archivedRow}
      accessibilityRole="button"
      accessibilityLabel="Archived conversations"
    >
      <Text style={[styles.archivedText, { color: theme.color.secondaryLabel }]}>🗄️ Archived</Text>
    </Pressable>
  );

  return (
    <Screen>
      {fixedHeader}
      <View style={styles.list}>
        <FlashList
          data={listData}
          keyExtractor={(r: InboxRow) => r.guid}
          refreshControl={refreshControl}
          renderItem={({ item }: { item: InboxRow }) => (
            <ConversationTile row={item} onPress={openChat} onLongPress={onLongPress} />
          )}
          ListHeaderComponent={listHeader}
          ListFooterComponent={listData.length > 0 ? ListFooter : null}
          ItemSeparatorComponent={() => (
            <View style={[styles.separator, { backgroundColor: theme.color.separator }]} />
          )}
          ListEmptyComponent={
            isLoading ? (
              <View style={styles.center}>
                <ActivityIndicator color={theme.color.tint} />
              </View>
            ) : (
              <View style={styles.center}>
                <Text style={[styles.emptyText, { color: theme.color.secondaryLabel }]}>
                  {error
                    ? `Couldn’t load conversations`
                    : search
                      ? 'No matches'
                      : 'No Conversations'}
                </Text>
              </View>
            )
          }
          contentContainerStyle={styles.listContent}
        />
      </View>
      <ChatActionsSheet target={actionTarget} onClose={() => setActionTarget(null)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 16, paddingBottom: 8 },
  list: { flex: 1 },
  pinnedWrap: { paddingHorizontal: 16 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  largeTitle: { fontSize: 34, fontWeight: '700', marginBottom: 10 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 18 },
  compose: { fontSize: 24, marginBottom: 10 },
  gear: { fontSize: 26, marginBottom: 10 },
  // Relative wrapper so the clear button can overlay the field's right edge. paddingRight on the
  // input keeps typed text from running under the ✕.
  searchWrap: { justifyContent: 'center' },
  searchInput: { marginBottom: 0, paddingRight: 38 },
  clearButton: { position: 'absolute', right: 12, top: 0, bottom: 16, justifyContent: 'center' },
  clearIcon: { fontSize: 16, fontWeight: '600' },
  searchMessages: { paddingTop: 8, paddingBottom: 2 },
  searchMessagesText: { fontSize: 14, fontWeight: '500' },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 76 },
  listContent: { paddingBottom: 24 },
  center: { paddingTop: 80, alignItems: 'center' },
  emptyText: { fontSize: 16 },
  archivedRow: { alignItems: 'center', paddingVertical: 16 },
  archivedText: { fontSize: 15, fontWeight: '500' },
});
