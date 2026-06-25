import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { refreshInbox } from '@/services';
import { useChats } from '@features/conversations/useChats';
import type { InboxRow } from '@db/repositories';
import { resolveTitle } from '@utils';
import { Screen, usePullToRefresh } from '../primitives';
import { useTheme } from '../theme';
import { ChatActionsSheet, type ChatActionTarget } from './ChatActionsSheet';
import { ConversationTile } from './ConversationTile';
import { PinnedGrid } from './PinnedGrid';
import { SearchResultsView } from './SearchResultsView';

/** Phase 3 inbox: a live (reactive) FlashList of iOS conversation tiles, with a BOTTOM search bar
 * that swaps the list for the unified search results (chats + message hits) the moment you type. */
export function ConversationListScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [search, setSearch] = useState('');
  const { data, isLoading, error } = useChats();
  const rows = data ?? [];
  // Pull-to-refresh: incremental sync. The list sits below the fixed title → no offset.
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

  // Typing in the bottom bar replaces the conversation list with the unified search results.
  const searching = search.trim().length > 0;
  // Pinned chats render in a grid above the list (iOS).
  const pinned = useMemo(() => rows.filter((r) => r.isPinned), [rows]);
  const listData = useMemo(() => rows.filter((r) => !r.isPinned), [rows]);

  // The large title + actions stay PINNED at the top.
  const titleRow = (
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

  // The search bar lives at the BOTTOM; `padding` lifts it above the keyboard (Android edge-to-edge,
  // RN 0.85 / Expo SDK 56 default) — same pattern as the chat composer.
  const searchBar = (
    <View
      style={[
        styles.searchBar,
        {
          paddingBottom: Math.max(insets.bottom, 10),
          borderTopColor: theme.color.separator,
          backgroundColor: theme.color.background,
        },
      ]}
    >
      <View style={styles.searchWrap}>
        <TextInput
          placeholder="Search messages & chats"
          placeholderTextColor={theme.color.tertiaryLabel}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          value={search}
          onChangeText={setSearch}
          style={[
            styles.searchInput,
            { color: theme.color.label, backgroundColor: theme.color.secondaryBackground },
          ]}
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
    </View>
  );

  return (
    <Screen>
      <KeyboardAvoidingView style={styles.flex} behavior="padding">
        {titleRow}
        <View style={styles.list}>
          {searching ? (
            <SearchResultsView query={search} />
          ) : (
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
                      {error ? `Couldn’t load conversations` : 'No Conversations'}
                    </Text>
                  </View>
                )
              }
              contentContainerStyle={styles.listContent}
            />
          )}
        </View>
        {searchBar}
      </KeyboardAvoidingView>
      <ChatActionsSheet target={actionTarget} onClose={() => setActionTarget(null)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: { paddingHorizontal: 16, paddingBottom: 8 },
  list: { flex: 1 },
  pinnedWrap: { paddingHorizontal: 16 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  largeTitle: { fontSize: 34, fontWeight: '700', marginBottom: 10 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 18 },
  compose: { fontSize: 24, marginBottom: 10 },
  gear: { fontSize: 26, marginBottom: 10 },
  // Bottom search bar. Relative wrapper so the clear ✕ can overlay the field's right edge;
  // paddingRight on the input keeps typed text from running under it.
  searchBar: { paddingHorizontal: 12, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth },
  searchWrap: { justifyContent: 'center' },
  searchInput: {
    height: 38,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingRight: 38,
    fontSize: 16,
  },
  clearButton: {
    position: 'absolute',
    right: 10,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  clearIcon: { fontSize: 16, fontWeight: '600' },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 76 },
  listContent: { paddingBottom: 24 },
  center: { paddingTop: 80, alignItems: 'center' },
  emptyText: { fontSize: 16 },
  archivedRow: { alignItems: 'center', paddingVertical: 16 },
  archivedText: { fontSize: 15, fontWeight: '500' },
});
