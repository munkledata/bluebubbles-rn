import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { InboxRow } from '@db/repositories';
import { useCustomFolderChats } from '@features/conversations/useCustomFolderChats';
import {
  captureRealtimeDeliveryLease,
  subscribeRealtimeGenerationInvalidation,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import { useKeyboardVisible } from '../hooks/useKeyboardVisible';
import { Icon, Screen, ScreenHeader } from '../primitives';
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
}

const MAX_FOLDER_SEARCH_CODE_POINTS = 128;

function boundFolderSearchInput(value: string): string {
  return Array.from(value).slice(0, MAX_FOLDER_SEARCH_CODE_POINTS).join('');
}

function normalizeFolderSearchInput(value: string): string {
  return Array.from(value.normalize('NFC').trim()).slice(0, MAX_FOLDER_SEARCH_CODE_POINTS).join('');
}

/** Account-owned wrapper; changing folders remounts the search draft under its new owner. */
export function FolderConversationListScreen({
  folderId,
}: FolderConversationListScreenProps): React.JSX.Element {
  const [accountLease] = useState(() => captureRealtimeDeliveryLease());
  const [accountRetired, setAccountRetired] = useState(() => !accountLease.isCurrent());

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
      key={folderId ?? 'invalid'}
      folderId={folderId}
      accountLease={accountLease}
      enabled={accountCurrent}
    />
  );
}

function FolderConversationListAttempt({
  folderId,
  accountLease,
  enabled,
}: FolderConversationListAttemptProps): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const kbVisible = useKeyboardVisible();
  const openChatNav = useChatNavigator();
  const [searchText, setSearchText] = useState('');
  const normalizedSearch = normalizeFolderSearchInput(searchText);
  const searchMode = normalizedSearch.length > 0;
  const searchEligible = Array.from(normalizedSearch).length >= 2;
  const [settledSearch, setSettledSearch] = useState(() =>
    searchEligible ? normalizedSearch : '',
  );
  const onSearchTextChange = useCallback((value: string): void => {
    const bounded = boundFolderSearchInput(value);
    setSearchText(bounded);
    if (Array.from(normalizeFolderSearchInput(bounded)).length < 2) setSettledSearch('');
  }, []);

  useEffect(() => {
    if (!searchEligible) return;
    const timer = setTimeout(() => setSettledSearch(normalizedSearch), 250);
    return () => clearTimeout(timer);
  }, [normalizedSearch, searchEligible]);

  const searchQuery = searchEligible ? settledSearch : '';
  const searchWaiting = searchEligible && searchQuery !== normalizedSearch;
  const { data, folder, error, isLoading, hasMore, loadingMore, loadMoreError, loadMore, retry } =
    useCustomFolderChats(folderId, accountLease, searchQuery, enabled);
  const listRef = useRef<FlashListRef<InboxRow>>(null);
  const [actionTarget, setActionTarget] = useState<ChatActionTarget | null>(null);
  const openChat = useCallback(
    (guid: string): void => {
      Keyboard.dismiss();
      openChatNav(`/chat/${encodeURIComponent(guid)}`);
    },
    [openChatNav],
  );
  const onLongPress = useCallback((row: InboxRow): void => {
    Keyboard.dismiss();
    setActionTarget(toChatActionTarget(row));
  }, []);
  const renderItem = useCallback(
    ({ item }: { item: InboxRow }): React.JSX.Element => (
      <ConversationTile row={item} onPress={openChat} onLongPress={onLongPress} />
    ),
    [onLongPress, openChat],
  );

  useEffect(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [searchQuery, searchMode]);

  const title = folder?.name ?? data?.folder.name ?? 'Conversation Folder';
  const unavailableCount = data == null ? 0 : data.folder.chatCount - data.availableCount;
  const savedConversationLabel =
    data?.folder.chatCount === 1 ? 'saved conversation' : 'saved conversations';
  const emptyText =
    data?.folder.chatCount === 0
      ? 'No conversations have been added to this folder.'
      : 'No folder conversations are currently available. Their folder memberships remain saved, and a conversation will appear here again if it returns.';
  const searchSettled = searchMode && searchEligible && !searchWaiting;
  const searchBar =
    folderId == null ? null : (
      <View
        style={[
          styles.searchBar,
          {
            paddingBottom: kbVisible ? 0 : Math.max(insets.bottom, 10),
            borderTopColor: theme.color.separator,
            backgroundColor: theme.color.background,
          },
        ]}
      >
        <View style={[styles.searchShell, { backgroundColor: theme.color.secondaryBackground }]}>
          <Icon name="search" size={18} color={theme.color.secondaryLabel} />
          <TextInput
            value={searchText}
            onChangeText={onSearchTextChange}
            maxLength={MAX_FOLDER_SEARCH_CODE_POINTS}
            placeholder="Search this folder"
            placeholderTextColor={theme.color.tertiaryLabel}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            accessibilityLabel={`Search conversations in ${folder?.name ?? 'this folder'}`}
            accessibilityHint="Searches names, participants, and locally synced message text in currently available conversations"
            style={[styles.searchInput, { color: theme.color.label }]}
          />
          {searchText.length > 0 ? (
            <Pressable
              onPress={() => onSearchTextChange('')}
              accessibilityRole="button"
              accessibilityLabel="Clear folder search"
              hitSlop={8}
              style={styles.clearSearch}
            >
              <Icon name="close-circle" size={19} color={theme.color.tertiaryLabel} />
            </Pressable>
          ) : null}
        </View>
        <Text style={[styles.searchHelp, { color: theme.color.secondaryLabel }]}>
          Searches names, participants, and locally synced message text. It doesn’t search the
          server.
        </Text>
      </View>
    );

  return (
    <Screen>
      <ScreenHeader
        title={title}
        onBack={() => {
          Keyboard.dismiss();
          router.back();
        }}
        right={
          folderId != null ? (
            <Pressable
              onPress={() => {
                Keyboard.dismiss();
                router.push(`/folders/edit?folderId=${folderId}`);
              }}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={
                folder ? `Rename or delete ${folder.name}` : 'Rename or delete this folder'
              }
            >
              <Text style={[styles.edit, { color: theme.color.tint }]}>Edit</Text>
            </Pressable>
          ) : null
        }
      />

      <KeyboardAvoidingView style={styles.flex} behavior="padding" enabled={kbVisible}>
        <View style={styles.flex}>
          {folderId == null ? (
            <CenteredMessage text="This folder link is invalid." />
          ) : searchWaiting ? (
            <CenteredLoading text="Searching…" />
          ) : error ? (
            <View style={styles.center}>
              <Text
                selectable
                accessibilityRole="alert"
                accessibilityLiveRegion="assertive"
                style={[styles.message, { color: theme.color.destructive }]}
              >
                {searchSettled ? 'Couldn’t search this folder.' : 'Couldn’t load this folder.'}
              </Text>
              <Pressable onPress={retry} accessibilityRole="button" style={styles.retry}>
                <Text style={[styles.retryText, { color: theme.color.tint }]}>Try Again</Text>
              </Pressable>
            </View>
          ) : isLoading ? (
            searchMode ? (
              <CenteredLoading text="Searching…" />
            ) : (
              <ActivityIndicator style={styles.loading} color={theme.color.tint} />
            )
          ) : data == null ? (
            <CenteredMessage text="This folder no longer exists." />
          ) : searchMode && !searchEligible ? (
            <CenteredMessage text="Type at least 2 characters to search this folder." live />
          ) : (
            <>
              <View style={[styles.summary, { borderBottomColor: theme.color.separator }]}>
                <Text
                  selectable
                  accessibilityLiveRegion={searchSettled ? 'polite' : 'none'}
                  style={[styles.summaryCount, { color: theme.color.label }]}
                >
                  {searchSettled ? (
                    <>
                      {data.matchingCount.toLocaleString()} of{' '}
                      {data.availableCount.toLocaleString()} available{' '}
                      {data.availableCount === 1 ? 'conversation' : 'conversations'}{' '}
                      {data.matchingCount === 1 ? 'matches' : 'match'}
                    </>
                  ) : (
                    <>
                      {data.availableCount.toLocaleString()} of{' '}
                      {data.folder.chatCount.toLocaleString()} {savedConversationLabel} available
                    </>
                  )}
                </Text>
                {unavailableCount > 0 ? (
                  <Text
                    selectable
                    style={[styles.summaryNote, { color: theme.color.secondaryLabel }]}
                  >
                    {searchSettled ? (
                      <>
                        Search covers currently available conversations;{' '}
                        {unavailableCount.toLocaleString()} saved{' '}
                        {unavailableCount === 1 ? 'conversation is' : 'conversations are'} not
                        currently available.
                      </>
                    ) : (
                      <>
                        {unavailableCount.toLocaleString()}{' '}
                        {unavailableCount === 1 ? 'conversation is' : 'conversations are'} not
                        currently available.{' '}
                        {unavailableCount === 1
                          ? 'Its membership remains'
                          : 'Their memberships remain'}{' '}
                        saved; {unavailableCount === 1 ? 'it will appear' : 'each will appear'}{' '}
                        again if the conversation returns.
                      </>
                    )}
                  </Text>
                ) : null}
              </View>
              <FlashList
                ref={listRef}
                data={data.rows}
                keyExtractor={(row: InboxRow) => row.guid}
                renderItem={renderItem}
                ItemSeparatorComponent={InboxSeparator}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
                onEndReached={hasMore ? loadMore : undefined}
                onEndReachedThreshold={0.5}
                ListFooterComponent={
                  loadingMore ? (
                    <View style={styles.listFooter}>
                      <ActivityIndicator color={theme.color.tint} />
                      <Text style={[styles.footerText, { color: theme.color.secondaryLabel }]}>
                        Loading more…
                      </Text>
                    </View>
                  ) : loadMoreError ? (
                    <View style={styles.listFooter}>
                      <Text
                        accessibilityRole="alert"
                        accessibilityLiveRegion="assertive"
                        style={[styles.footerText, { color: theme.color.destructive }]}
                      >
                        Couldn’t update this list. Existing conversations are still shown.
                      </Text>
                      <Pressable onPress={retry} accessibilityRole="button" style={styles.retry}>
                        <Text style={[styles.retryText, { color: theme.color.tint }]}>
                          Try Again
                        </Text>
                      </Pressable>
                    </View>
                  ) : null
                }
                ListEmptyComponent={
                  <View style={styles.empty}>
                    <Text
                      selectable
                      accessibilityLiveRegion={searchSettled ? 'polite' : 'none'}
                      style={[styles.message, { color: theme.color.secondaryLabel }]}
                    >
                      {searchSettled ? 'No available conversations match this search.' : emptyText}
                    </Text>
                  </View>
                }
                contentContainerStyle={styles.listContent}
              />
            </>
          )}
        </View>
        {searchBar}
      </KeyboardAvoidingView>
      <ChatActionsSheet target={actionTarget} onClose={() => setActionTarget(null)} />
    </Screen>
  );
}

function CenteredLoading({ text }: { text: string }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.center}>
      <ActivityIndicator color={theme.color.tint} />
      <Text accessibilityLiveRegion="polite" style={[styles.message, { color: theme.color.label }]}>
        {text}
      </Text>
    </View>
  );
}

function CenteredMessage({
  text,
  live = false,
}: {
  text: string;
  live?: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.center}>
      <Text
        selectable
        accessibilityLiveRegion={live ? 'polite' : 'none'}
        style={[styles.message, { color: theme.color.secondaryLabel }]}
      >
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  edit: { fontSize: 16, fontWeight: '600', textAlign: 'right' },
  loading: { paddingTop: 80 },
  center: { paddingTop: 80, paddingHorizontal: 24, alignItems: 'center', gap: 12 },
  message: { textAlign: 'center', fontSize: 15, lineHeight: 21 },
  retry: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 },
  retryText: { fontSize: 16, fontWeight: '600' },
  listFooter: { paddingVertical: 16, paddingHorizontal: 24, alignItems: 'center', gap: 6 },
  footerText: { textAlign: 'center', fontSize: 13, lineHeight: 18 },
  summary: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  summaryCount: { fontSize: 13, lineHeight: 18, fontVariant: ['tabular-nums'] },
  summaryNote: { fontSize: 12, lineHeight: 17, paddingTop: 3 },
  empty: { paddingTop: 72, paddingHorizontal: 24, alignItems: 'center' },
  listContent: { paddingBottom: 24 },
  searchBar: {
    paddingHorizontal: 12,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  searchShell: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 12,
    borderRadius: 12,
  },
  searchInput: { flex: 1, minWidth: 0, paddingVertical: 8, fontSize: 16 },
  searchHelp: { fontSize: 12, lineHeight: 17, paddingHorizontal: 4, paddingTop: 4 },
  clearSearch: {
    width: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
