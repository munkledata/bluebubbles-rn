/**
 * FolderConversationListScreen owns the folder-search presentation boundary. The data hook and
 * FlashList are controlled here so these tests prove Unicode-safe input/debounce, account
 * concealment, and list wiring without claiming real SQL, native IME, or device behavior.
 */
import React from 'react';
import type { CustomFolderInboxPage, InboxRow } from '@db/repositories';
import type { CustomFolderChatsState } from '@features/conversations/useCustomFolderChats';
import { act, fireEvent, renderWithTheme, screen } from '../support/renderWithTheme';

const mockBack = jest.fn();
const mockPush = jest.fn();
const mockOpenChat = jest.fn();
const mockLoadMore = jest.fn();
const mockRetry = jest.fn();
const mockUnsubscribe = jest.fn();
const mockScrollToOffset = jest.fn();
const mockListProps: { current: Record<string, unknown> } = { current: {} };
const mockLease = {
  generation: 73,
  current: true,
  isCurrent(): boolean {
    return this.current;
  },
};
let mockInvalidationListener: (() => void) | null = null;
let mockFolderState: CustomFolderChatsState;
const mockUseCustomFolderChats = jest.fn(
  (_folderId: number | null, _lease: unknown, _search: string, _enabled: boolean) =>
    mockFolderState,
);

jest.mock('@shopify/flash-list', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  const asNode = (component: unknown): unknown => {
    if (component == null || ReactLib.isValidElement(component)) return component;
    if (typeof component === 'function') return ReactLib.createElement(component);
    return component;
  };
  const FlashList = ReactLib.forwardRef(function FlashList(
    props: {
      data?: unknown[];
      renderItem?: (info: { item: unknown; index: number }) => unknown;
      keyExtractor?: (item: unknown) => string;
      ListEmptyComponent?: unknown;
      ListFooterComponent?: unknown;
    },
    ref: unknown,
  ) {
    ReactLib.useImperativeHandle(ref, () => ({ scrollToOffset: mockScrollToOffset }), []);
    mockListProps.current = props as unknown as Record<string, unknown>;
    const data = props.data ?? [];
    const body =
      data.length === 0
        ? asNode(props.ListEmptyComponent)
        : data.map((item, index) =>
            ReactLib.createElement(
              View,
              { key: props.keyExtractor?.(item) ?? String(index) },
              props.renderItem?.({ item, index }),
            ),
          );
    return ReactLib.createElement(
      View,
      { testID: 'folder-conversation-list' },
      body,
      asNode(props.ListFooterComponent),
    );
  });
  return { FlashList };
});

jest.mock('@features/conversations/useCustomFolderChats', () => ({
  useCustomFolderChats: (...args: [number | null, unknown, string, boolean]) =>
    mockUseCustomFolderChats(...args),
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: mockBack, push: mockPush }),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@ui/hooks/useKeyboardVisible', () => ({ useKeyboardVisible: () => false }));
jest.mock('@ui/useChatNavigator', () => ({ useChatNavigator: () => mockOpenChat }));
jest.mock('@/services/realtime/deliveryCoordinator', () => ({
  captureRealtimeDeliveryLease: () => mockLease,
  subscribeRealtimeGenerationInvalidation: (generation: number, listener: () => void) => {
    if (generation !== mockLease.generation) throw new Error('Subscribed to the wrong account');
    mockInvalidationListener = listener;
    return mockUnsubscribe;
  },
}));
jest.mock('@ui/conversations/ConversationTile', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pressable, Text } = require('react-native');
  return {
    ConversationTile: (props: {
      row: { guid: string };
      onPress: (guid: string) => void;
      onLongPress: (row: unknown) => void;
    }) =>
      ReactLib.createElement(
        Pressable,
        {
          testID: `folder-tile-${props.row.guid}`,
          onPress: () => props.onPress(props.row.guid),
          onLongPress: () => props.onLongPress(props.row),
        },
        ReactLib.createElement(Text, null, props.row.guid),
      ),
  };
});
jest.mock('@ui/conversations/ChatActionsSheet', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require('react-native');
  return {
    toChatActionTarget: (row: { guid: string }) => ({ guid: row.guid }),
    ChatActionsSheet: (props: { target: { guid: string } | null }) =>
      ReactLib.createElement(
        Text,
        { testID: 'folder-actions-target' },
        props.target?.guid ?? 'none',
      ),
  };
});
jest.mock('@ui/conversations/FilteredChatListScreen', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  return { InboxSeparator: () => ReactLib.createElement(View) };
});

// eslint-disable-next-line import/first
import { FolderConversationListScreen } from '@ui/conversations/FolderConversationListScreen';

const PRIVATE_FOLDER = 'Synthetic private folder 73';
const row: InboxRow = {
  id: 1,
  guid: 'iMessage;-;synthetic-folder-73@example.test',
  chatIdentifier: 'synthetic-folder-73@example.test',
  displayName: null,
  customName: 'Synthetic folder conversation 73',
  customColor: null,
  style: 45,
  isPinned: 0,
  isArchived: 0,
  muteType: null,
  latestMessageDate: 1_700_000_000_000,
  lastReadMessageGuid: null,
  lastText: 'Synthetic preview',
  lastSubject: null,
  lastIsFromMe: 0,
  lastHasAttachments: 0,
  lastDate: 1_700_000_000_000,
  lastGuid: 'synthetic-message-73',
  lastAssociatedType: null,
  lastError: 0,
  participantCount: 1,
  participantNames: 'Synthetic Person',
  participantAvatars: null,
  handleServices: 'iMessage',
  unreadCount: 0,
  hasKnownSender: 1,
};

function readyPage(): CustomFolderInboxPage {
  return {
    folder: { id: 7, name: PRIVATE_FOLDER, sortOrder: 0, chatCount: 2 },
    availableCount: 1,
    matchingCount: 1,
    hasMore: true,
    rows: [row],
  };
}

function readyState(): CustomFolderChatsState {
  const data = readyPage();
  return {
    data,
    folder: data.folder,
    isLoading: false,
    error: null,
    hasMore: true,
    loadingMore: false,
    loadMoreError: null,
    loadMore: mockLoadMore,
    retry: mockRetry,
  };
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockLease.current = true;
  mockInvalidationListener = null;
  mockListProps.current = {};
  mockFolderState = readyState();
  mockUseCustomFolderChats.mockImplementation(() => mockFolderState);
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

it('bounds emoji by Unicode code point in JavaScript and debounces the exact bounded query', async () => {
  await renderWithTheme(<FolderConversationListScreen folderId={7} />);
  const input = screen.getByPlaceholderText('Search this folder');
  const requested = '🫧'.repeat(129);
  const bounded = '🫧'.repeat(128);

  await fireEvent.changeText(input, requested);
  expect(Array.from(screen.getByPlaceholderText('Search this folder').props.value)).toHaveLength(
    128,
  );
  expect(mockUseCustomFolderChats).toHaveBeenLastCalledWith(7, mockLease, '', true);

  await advance(249);
  expect(mockUseCustomFolderChats).toHaveBeenLastCalledWith(7, mockLease, '', true);
  await advance(1);
  expect(mockUseCustomFolderChats).toHaveBeenLastCalledWith(7, mockLease, bounded, true);

  // Android's native maxLength counts UTF-16 units. Two units per permitted code point lets all
  // 128 emoji through while retaining a conservative native ceiling for very large pasted input.
  expect(screen.getByPlaceholderText('Search this folder').props.maxLength).toBe(256);
});

it('normalizes the settled query and clears a too-short search immediately', async () => {
  await renderWithTheme(<FolderConversationListScreen folderId={7} />);
  const input = screen.getByPlaceholderText('Search this folder');

  await fireEvent.changeText(input, '  e\u0301x  ');
  await advance(250);
  expect(mockUseCustomFolderChats).toHaveBeenLastCalledWith(7, mockLease, 'éx', true);

  await fireEvent.changeText(input, ' a ');
  expect(mockUseCustomFolderChats).toHaveBeenLastCalledWith(7, mockLease, '', true);
  expect(screen.getByText('Type at least 2 characters to search this folder.')).toBeTruthy();

  await fireEvent.press(screen.getByRole('button', { name: 'Clear folder search' }));
  expect(screen.getByPlaceholderText('Search this folder').props.value).toBe('');
});

it('wires rows and paging, then immediately conceals the old account on retirement', async () => {
  const view = await renderWithTheme(<FolderConversationListScreen folderId={7} />);

  expect(screen.getByText(PRIVATE_FOLDER)).toBeTruthy();
  expect(screen.getByText('1 of 2 saved conversations available')).toBeTruthy();
  const tile = screen.getByTestId(`folder-tile-${row.guid}`);
  await fireEvent.press(tile);
  expect(mockOpenChat).toHaveBeenCalledWith(`/chat/${encodeURIComponent(row.guid)}`);

  await fireEvent(tile, 'longPress');
  expect(screen.getByTestId('folder-actions-target').props.children).toBe(row.guid);
  const onEndReached = mockListProps.current.onEndReached;
  if (typeof onEndReached !== 'function') throw new Error('Expected folder list paging callback');
  onEndReached();
  expect(mockLoadMore).toHaveBeenCalledTimes(1);

  mockLease.current = false;
  await act(async () => {
    if (!mockInvalidationListener) throw new Error('Expected account invalidation listener');
    mockInvalidationListener();
  });
  expect(screen.queryByText(PRIVATE_FOLDER)).toBeNull();
  expect(screen.queryByTestId(`folder-tile-${row.guid}`)).toBeNull();
  expect(screen.queryByTestId('folder-actions-target')).toBeNull();
  const retiredTree = JSON.stringify(view.toJSON());
  expect(retiredTree).not.toContain(PRIVATE_FOLDER);
  expect(retiredTree).not.toContain(row.guid);
});
