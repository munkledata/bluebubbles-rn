import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type ListRenderItemInfo,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ChatDocumentRow, ChatLink } from '@db/repositories';
import {
  CHAT_FILES,
  CHAT_LINKS,
  CHAT_PHOTOS,
  CHAT_VIDEOS,
} from '@features/conversations/chatAttachmentSources';
import { useChatPagedRows } from '@features/conversations/useChatPagedRows';
import {
  subscribeRealtimeGenerationInvalidation,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import { safeOpenUrl } from '@utils';
import { SharedDocumentRow } from '../attachments/FileChip';
import { showDialog, useDialogStore } from '../dialog/dialogStore';
import { Screen, ScreenHeader } from '../primitives';
import { readableTextOn, useTheme } from '../theme';
import { showExternalOpenFailure } from '../toast/external-open-feedback';
import { useChatNavigator } from '../useChatNavigator';
import { useScreenAccountLease } from '@ui/hooks/useScreenAccountLease';
import { MediaThumb } from './MediaSections';

export type ChatAttachmentsTab = 'photos' | 'videos' | 'files' | 'links';

const TABS: ReadonlyArray<{ id: ChatAttachmentsTab; label: string }> = [
  { id: 'photos', label: 'Photos' },
  { id: 'videos', label: 'Videos' },
  { id: 'files', label: 'Files' },
  { id: 'links', label: 'Links' },
];

/** Parse the route's `tab` parameter; anything unknown opens Photos. */
export function parseChatAttachmentsTab(value: string | string[] | undefined): ChatAttachmentsTab {
  const raw = Array.isArray(value) ? value[0] : value;
  return TABS.some((t) => t.id === raw) ? (raw as ChatAttachmentsTab) : 'photos';
}

const ACCOUNT_CHANGED_COPY = 'Conversation account changed. Go back and reopen All Attachments.';
const GRID_COLUMNS = 3;
const GRID_GAP = 4;

interface ChatAttachmentsScreenProps {
  chatGuid: string | null;
  initialTab?: ChatAttachmentsTab;
}

/**
 * Every photo, video, file and link in one chat, paged 50 at a time. Tapping opens the item;
 * long-pressing offers "Show in Chat". Account retirement removes every private row immediately.
 */
export function ChatAttachmentsScreen({
  chatGuid,
  initialTab = 'photos',
}: ChatAttachmentsScreenProps): React.JSX.Element {
  const router = useRouter();
  const theme = useTheme();
  const accountLease = useScreenAccountLease();
  const [tab, setTab] = useState<ChatAttachmentsTab>(initialTab);
  const ownerMountedRef = useRef(true);
  const accountRetiredRef = useRef(!accountLease.isCurrent());
  const [accountRetired, setAccountRetired] = useState(accountRetiredRef.current);

  useLayoutEffect(() => {
    ownerMountedRef.current = true;
    const unsubscribe = subscribeRealtimeGenerationInvalidation(accountLease.generation, () => {
      accountRetiredRef.current = true;
      setAccountRetired(true);
    });
    return () => {
      ownerMountedRef.current = false;
      unsubscribe();
    };
  }, [accountLease]);

  const ownerIsCurrent = useCallback(
    (): boolean =>
      ownerMountedRef.current && !accountRetiredRef.current && accountLease.isCurrent(),
    [accountLease],
  );
  const accountCurrent = !accountRetired && ownerIsCurrent();

  return (
    <Screen>
      <ScreenHeader title="All Attachments" onBack={() => router.back()} />
      {accountCurrent ? (
        <>
          <View accessibilityRole="tablist" style={styles.tabs}>
            {TABS.map((t) => {
              const selected = t.id === tab;
              return (
                <Pressable
                  key={t.id}
                  onPress={() => setTab(t.id)}
                  accessibilityRole="tab"
                  accessibilityState={{ selected }}
                  style={[
                    styles.tab,
                    {
                      backgroundColor: selected
                        ? theme.color.tint
                        : theme.color.secondaryBackground,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.tabText,
                      { color: selected ? readableTextOn(theme.color.tint) : theme.color.label },
                    ]}
                  >
                    {t.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {chatGuid == null ? (
            <CenteredMessage text="This All Attachments link is invalid." />
          ) : (
            <AttachmentsTab
              key={`${chatGuid}|${tab}`}
              tab={tab}
              chatGuid={chatGuid}
              accountLease={accountLease}
              ownerIsCurrent={ownerIsCurrent}
            />
          )}
        </>
      ) : (
        <View style={styles.center}>
          <Text
            accessibilityRole="alert"
            accessibilityLabel={ACCOUNT_CHANGED_COPY}
            style={[styles.message, { color: theme.color.secondaryLabel }]}
          >
            {ACCOUNT_CHANGED_COPY}
          </Text>
        </View>
      )}
    </Screen>
  );
}

interface AttachmentsTabProps {
  tab: ChatAttachmentsTab;
  chatGuid: string;
  accountLease: RealtimeDeliveryLease;
  ownerIsCurrent: () => boolean;
}

/** One mounted tab: its own paged read, so switching tabs never mixes rows. */
function AttachmentsTab(props: AttachmentsTabProps): React.JSX.Element {
  const mountedRef = useRef(true);
  const menuRef = useRef<number | null>(null);
  const { ownerIsCurrent, chatGuid } = props;
  const openChat = useChatNavigator();

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // A menu left open must not outlive its tab or its account.
  useEffect(
    () => () => {
      if (menuRef.current != null) useDialogStore.getState().dismissById(menuRef.current);
    },
    [],
  );

  const screenIsCurrent = useCallback(
    (): boolean => mountedRef.current && ownerIsCurrent(),
    [ownerIsCurrent],
  );
  const showInChat = useCallback(
    (messageGuid: string, title: string): void => {
      if (!screenIsCurrent()) return;
      menuRef.current = showDialog(title, undefined, [
        {
          text: 'Show in Chat',
          onPress: () => {
            menuRef.current = null;
            if (!screenIsCurrent()) return;
            openChat(
              `/chat/${encodeURIComponent(chatGuid)}?focus=${encodeURIComponent(messageGuid)}`,
            );
          },
        },
        { text: 'Cancel', style: 'cancel', onPress: () => (menuRef.current = null) },
      ]);
    },
    [chatGuid, openChat, screenIsCurrent],
  );

  const shared = { ...props, screenIsCurrent, showInChat };
  if (props.tab === 'links') return <LinkList {...shared} />;
  if (props.tab === 'files') return <FileList {...shared} />;
  return <MediaGrid {...shared} kind={props.tab === 'photos' ? 'photo' : 'video'} />;
}

interface ListProps extends AttachmentsTabProps {
  screenIsCurrent: () => boolean;
  showInChat: (messageGuid: string, title: string) => void;
}

function MediaGrid({
  kind,
  chatGuid,
  accountLease,
  screenIsCurrent,
  showInChat,
}: ListProps & { kind: 'photo' | 'video' }): React.JSX.Element {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const size = Math.floor((width - 32 - GRID_GAP * (GRID_COLUMNS - 1)) / GRID_COLUMNS);
  const state = useChatPagedRows(
    kind === 'photo' ? CHAT_PHOTOS : CHAT_VIDEOS,
    chatGuid,
    accountLease,
    screenIsCurrent(),
  );
  const total = state.data?.items.length ?? 0;
  const renderItem = useCallback(
    ({ item, index }: ListRenderItemInfo<ChatDocumentRow>): React.JSX.Element => (
      <MediaThumb
        att={item}
        kind={kind}
        glyph={kind === 'photo' ? '🖼' : '▶'}
        position={index + 1}
        total={total}
        size={size}
        onPress={() => {
          if (screenIsCurrent()) router.push(`/media/${encodeURIComponent(item.guid)}`);
        }}
        onLongPress={() => showInChat(item.messageGuid, kind === 'photo' ? 'Photo' : 'Video')}
      />
    ),
    [kind, total, size, router, screenIsCurrent, showInChat],
  );
  return (
    <PagedList
      state={state}
      testID={`chat-attachments-${kind}s`}
      numColumns={GRID_COLUMNS}
      columnWrapperStyle={styles.gridRow}
      keyExtractor={(item) => item.guid}
      renderItem={renderItem}
      noun={kind === 'photo' ? 'photos' : 'videos'}
    />
  );
}

function FileList({
  chatGuid,
  accountLease,
  screenIsCurrent,
  showInChat,
}: ListProps): React.JSX.Element {
  const state = useChatPagedRows(CHAT_FILES, chatGuid, accountLease, screenIsCurrent());
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<ChatDocumentRow>): React.JSX.Element => (
      <SharedDocumentRow
        attachment={item}
        accountLease={accountLease}
        screenIsCurrent={screenIsCurrent}
        onLongPress={() => showInChat(item.messageGuid, item.transferName ?? 'File')}
      />
    ),
    [accountLease, screenIsCurrent, showInChat],
  );
  return (
    <PagedList
      state={state}
      testID="chat-attachments-files"
      keyExtractor={(item) => item.guid}
      renderItem={renderItem}
      noun="files"
      separated
    />
  );
}

function LinkList({
  chatGuid,
  accountLease,
  screenIsCurrent,
  showInChat,
}: ListProps): React.JSX.Element {
  const theme = useTheme();
  const state = useChatPagedRows(CHAT_LINKS, chatGuid, accountLease, screenIsCurrent());
  const openingRef = useRef(false);
  const openLink = useCallback(
    (url: string): void => {
      if (!screenIsCurrent() || openingRef.current) return;
      openingRef.current = true;
      void (async () => {
        try {
          const opened = await safeOpenUrl(url);
          if (!opened && screenIsCurrent()) showExternalOpenFailure();
        } catch {
          if (screenIsCurrent()) showExternalOpenFailure();
        } finally {
          openingRef.current = false;
        }
      })();
    },
    [screenIsCurrent],
  );
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<ChatLink>): React.JSX.Element => (
      <Pressable
        onPress={() => openLink(item.url)}
        onLongPress={() => showInChat(item.messageGuid, 'Link')}
        accessibilityRole="link"
        accessibilityLabel={`Shared link: ${item.url}`}
        style={styles.linkRow}
      >
        <Text numberOfLines={2} style={[styles.linkText, { color: theme.color.tint }]}>
          {item.url}
        </Text>
      </Pressable>
    ),
    [openLink, showInChat, theme.color.tint],
  );
  return (
    <PagedList
      state={state}
      testID="chat-attachments-links"
      keyExtractor={(item) => item.url}
      renderItem={renderItem}
      noun="links"
      separated
    />
  );
}

interface PagedListProps<T> {
  state: ReturnType<typeof useChatPagedRows<T>>;
  testID: string;
  keyExtractor: (item: T) => string;
  renderItem: (info: ListRenderItemInfo<T>) => React.JSX.Element;
  noun: string;
  numColumns?: number;
  columnWrapperStyle?: object;
  separated?: boolean;
}

/** Loading, error, empty and "load more" handling shared by every tab. */
function PagedList<T>({
  state,
  testID,
  keyExtractor,
  renderItem,
  noun,
  numColumns,
  columnWrapperStyle,
  separated,
}: PagedListProps<T>): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { data, error, isLoading, hasMore, loadingMore, loadMoreError, loadMore, retry } = state;

  if (error) {
    return (
      <View style={styles.center}>
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
          style={[styles.message, { color: theme.color.destructive }]}
        >
          Couldn’t load {noun}.
        </Text>
        <Pressable onPress={retry} accessibilityRole="button" style={styles.retry}>
          <Text style={[styles.retryText, { color: theme.color.tint }]}>Try Again</Text>
        </Pressable>
      </View>
    );
  }
  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.color.tint} />
        <Text
          accessibilityLiveRegion="polite"
          style={[styles.message, { color: theme.color.label }]}
        >
          Loading {noun}…
        </Text>
      </View>
    );
  }

  return (
    <FlatList
      testID={testID}
      data={data?.items ?? []}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      numColumns={numColumns}
      columnWrapperStyle={columnWrapperStyle}
      ItemSeparatorComponent={separated ? Separator : undefined}
      contentContainerStyle={[
        styles.listContent,
        numColumns != null && styles.gridContent,
        { paddingBottom: Math.max(insets.bottom, 20) },
      ]}
      onEndReached={hasMore ? loadMore : undefined}
      onEndReachedThreshold={0.5}
      ListEmptyComponent={<CenteredMessage text={`No ${noun} in this conversation.`} />}
      ListFooterComponent={
        loadingMore ? (
          <View style={styles.footer}>
            <ActivityIndicator color={theme.color.tint} />
            <Text style={[styles.footerText, { color: theme.color.secondaryLabel }]}>
              Loading more…
            </Text>
          </View>
        ) : loadMoreError ? (
          <View style={styles.footer}>
            <Text
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
              style={[styles.footerText, { color: theme.color.destructive }]}
            >
              Couldn’t load more {noun}. The ones above are still available.
            </Text>
            <Pressable onPress={retry} accessibilityRole="button" style={styles.retry}>
              <Text style={[styles.retryText, { color: theme.color.tint }]}>Try Again</Text>
            </Pressable>
          </View>
        ) : null
      }
    />
  );
}

function Separator(): React.JSX.Element {
  const theme = useTheme();
  return <View style={[styles.separator, { backgroundColor: theme.color.separator }]} />;
}

function CenteredMessage({ text }: { text: string }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.center}>
      <Text style={[styles.message, { color: theme.color.secondaryLabel }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 8 },
  tab: {
    flex: 1,
    minHeight: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  tabText: { fontSize: 14, fontWeight: '600' },
  listContent: { flexGrow: 1 },
  gridContent: { paddingHorizontal: 16, gap: GRID_GAP },
  gridRow: { gap: GRID_GAP },
  center: { flex: 1, paddingTop: 80, paddingHorizontal: 24, alignItems: 'center', gap: 12 },
  message: { textAlign: 'center', fontSize: 15, lineHeight: 21 },
  retry: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 },
  retryText: { fontSize: 16, fontWeight: '600' },
  footer: { paddingVertical: 18, paddingHorizontal: 24, alignItems: 'center', gap: 6 },
  footerText: { textAlign: 'center', fontSize: 13, lineHeight: 18 },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
  linkRow: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 10 },
  linkText: { fontSize: 15 },
});
