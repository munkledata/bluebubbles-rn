/**
 * ConversationListScreen (src/ui/conversations/ConversationListScreen.tsx): the inbox. Data arrives
 * from the reactive `useChats` hook (mocked in-file with controlled rows). This suite locks in the
 * SCREEN'S own logic, not the tile/grid internals (those are covered separately):
 *   - pinned rows split into PinnedGrid (header) while the rest render as list tiles;
 *   - a chat that's pinned does NOT also appear in the list, and vice-versa;
 *   - empty / loading / error states;
 *   - typing in the bottom search bar swaps the list for SearchResultsView; clearing restores it;
 *   - header actions and tile taps route via expo-router; long-press opens the actions sheet.
 *
 * In-file mocks:
 *   - `@shopify/flash-list` → a plain renderer honoring data + Header/Empty/Footer slots.
 *   - `@features/conversations/useChats` → controllable `{ data, isLoading, error }` (real hook hits
 *     the reactive DB).
 *   - `expo-router` (useRouter) + `react-native-safe-area-context` (useSafeAreaInsets) → the RN
 *     navigation/inset natives.
 *   - `@/services` (refreshInbox) → jest.fn (its barrel pulls native modules).
 *   - child components ConversationTile / PinnedGrid / SearchResultsView / ChatActionsSheet → light
 *     probes, so the assertions are about the SCREEN'S split/search/route wiring.
 */
import React from 'react';
import { renderWithTheme, screen, fireEvent, waitFor } from '../support/renderWithTheme';
import type { InboxRow } from '@db/repositories';

const mockPush = jest.fn();

jest.mock('@shopify/flash-list', () => {
  const ReactLib = require('react');
  const { View } = require('react-native');
  const asNode = (c: unknown): unknown => {
    if (c == null) return null;
    if (ReactLib.isValidElement(c)) return c;
    if (typeof c === 'function') return ReactLib.createElement(c as React.ComponentType);
    return c;
  };
  const FlashList = ReactLib.forwardRef(function FlashList(
    props: {
      data?: unknown[];
      renderItem?: (a: { item: unknown; index: number }) => unknown;
      keyExtractor?: (i: unknown) => string;
      ListHeaderComponent?: unknown;
      ListEmptyComponent?: unknown;
      ListFooterComponent?: unknown;
    },
    _ref: unknown,
  ) {
    const {
      data = [],
      renderItem,
      keyExtractor,
      ListHeaderComponent,
      ListEmptyComponent,
      ListFooterComponent,
    } = props;
    const body =
      data.length === 0
        ? asNode(ListEmptyComponent)
        : data.map((item: unknown, index: number) =>
            ReactLib.createElement(
              View,
              { key: keyExtractor ? keyExtractor(item) : String(index) },
              renderItem ? renderItem({ item, index }) : null,
            ),
          );
    return ReactLib.createElement(
      View,
      null,
      asNode(ListHeaderComponent),
      body,
      asNode(ListFooterComponent),
    );
  });
  return { FlashList };
});

jest.mock('@features/conversations/useChats', () => ({ useChats: jest.fn() }));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@/services', () => ({ refreshInbox: jest.fn() }));

jest.mock('@ui/conversations/ConversationTile', () => {
  const ReactLib = require('react');
  const { Pressable, Text } = require('react-native');
  return {
    ConversationTile: (props: {
      row: { guid: string };
      onPress: (g: string) => void;
      onLongPress?: (r: unknown) => void;
    }) =>
      ReactLib.createElement(
        Pressable,
        {
          testID: `tile-${props.row.guid}`,
          onPress: () => props.onPress(props.row.guid),
          onLongPress: () => props.onLongPress?.(props.row),
        },
        ReactLib.createElement(Text, null, props.row.guid),
      ),
  };
});

jest.mock('@ui/conversations/PinnedGrid', () => {
  const ReactLib = require('react');
  const { View, Pressable, Text } = require('react-native');
  return {
    PinnedGrid: (props: { rows: { guid: string }[]; onPress: (g: string) => void }) =>
      ReactLib.createElement(
        View,
        null,
        props.rows.map((r) =>
          ReactLib.createElement(
            Pressable,
            { key: r.guid, testID: `pinned-${r.guid}`, onPress: () => props.onPress(r.guid) },
            ReactLib.createElement(Text, null, r.guid),
          ),
        ),
      ),
  };
});

jest.mock('@ui/conversations/SearchResultsView', () => {
  const ReactLib = require('react');
  const { Text } = require('react-native');
  return {
    SearchResultsView: (props: { query: string }) =>
      ReactLib.createElement(Text, { testID: 'search' }, `search:${props.query}`),
  };
});

jest.mock('@ui/conversations/ChatActionsSheet', () => {
  const ReactLib = require('react');
  const { Text } = require('react-native');
  return {
    // The screen maps rows through the REAL toChatActionTarget; only the sheet is probed.
    toChatActionTarget: jest.requireActual('@ui/conversations/ChatActionsSheet')
      .toChatActionTarget,
    ChatActionsSheet: (props: { target: { guid: string } | null }) =>
      ReactLib.createElement(
        Text,
        { testID: 'actions' },
        props.target ? props.target.guid : 'none',
      ),
  };
});

// eslint-disable-next-line import/first
import { ConversationListScreen } from '@ui/conversations/ConversationListScreen';
// eslint-disable-next-line import/first
import { useChats } from '@features/conversations/useChats';

const useChatsMock = useChats as jest.Mock;

function makeRow(overrides: Partial<InboxRow> = {}): InboxRow {
  return {
    id: 1,
    guid: 'iMessage;-;+15551230000',
    chatIdentifier: '+15551230000',
    displayName: null,
    customName: null,
    customColor: null,
    style: 45,
    isPinned: 0,
    isArchived: 0,
    muteType: null,
    latestMessageDate: 1_700_000_000_000,
    lastReadMessageGuid: null,
    lastText: 'hey there',
    lastSubject: null,
    lastIsFromMe: 0,
    lastHasAttachments: 0,
    lastDate: 1_700_000_000_000,
    lastGuid: 'm1',
    lastAssociatedType: null,
    lastError: 0,
    participantCount: 1,
    participantNames: 'Alice',
    participantAvatars: null,
    handleServices: null,
    unreadCount: 0,
    hasKnownSender: 1,
    ...overrides,
  };
}

function setChats(state: { data?: InboxRow[]; isLoading?: boolean; error?: unknown }): void {
  useChatsMock.mockReturnValue({
    data: state.data,
    isLoading: state.isLoading ?? false,
    error: state.error ?? null,
  });
}

describe('ConversationListScreen — pinned/list split', () => {
  it('renders pinned rows in the grid and the rest as list tiles', async () => {
    setChats({
      data: [
        makeRow({ guid: 'p1', isPinned: 1 }),
        makeRow({ guid: 'l1', isPinned: 0 }),
        makeRow({ guid: 'l2', isPinned: 0 }),
      ],
    });
    await renderWithTheme(<ConversationListScreen />);
    expect(screen.getByTestId('pinned-p1')).toBeTruthy();
    expect(screen.getByTestId('tile-l1')).toBeTruthy();
    expect(screen.getByTestId('tile-l2')).toBeTruthy();
    // A pinned chat is NOT also a list tile, and a list chat is NOT in the pinned grid.
    expect(screen.queryByTestId('tile-p1')).toBeNull();
    expect(screen.queryByTestId('pinned-l1')).toBeNull();
  });

  it('renders no pinned grid when nothing is pinned', async () => {
    setChats({ data: [makeRow({ guid: 'l1' }), makeRow({ guid: 'l2' })] });
    await renderWithTheme(<ConversationListScreen />);
    expect(screen.queryByTestId('pinned-l1')).toBeNull();
    expect(screen.queryByTestId('pinned-l2')).toBeNull();
    expect(screen.getByTestId('tile-l1')).toBeTruthy();
  });
});

describe('ConversationListScreen — list states', () => {
  it('shows "No Conversations" when the inbox is empty', async () => {
    setChats({ data: [], isLoading: false });
    await renderWithTheme(<ConversationListScreen />);
    expect(screen.getByText('No Conversations')).toBeTruthy();
  });

  it('shows neither empty nor error copy while loading (the spinner branch)', async () => {
    setChats({ data: undefined, isLoading: true });
    const view = await renderWithTheme(<ConversationListScreen />);
    // The loading branch renders an ActivityIndicator, NOT the empty/error text — so both text
    // branches are absent while the screen is still mounted with content.
    expect(screen.queryByText('No Conversations')).toBeNull();
    expect(screen.queryByText('Couldn’t load conversations')).toBeNull();
    expect(view.toJSON()).not.toBeNull();
    // The title still renders (the list area is just showing the spinner).
    expect(screen.getByText('Messages')).toBeTruthy();
  });

  it('shows the error copy when the query failed', async () => {
    setChats({ data: [], isLoading: false, error: new Error('db down') });
    await renderWithTheme(<ConversationListScreen />);
    expect(screen.getByText('Couldn’t load conversations')).toBeTruthy();
  });
});

describe('ConversationListScreen — search', () => {
  it('swaps the list for SearchResultsView when typing, and restores it when cleared', async () => {
    setChats({ data: [makeRow({ guid: 'l1' })] });
    await renderWithTheme(<ConversationListScreen />);
    expect(screen.getByTestId('tile-l1')).toBeTruthy();

    fireEvent.changeText(screen.getByPlaceholderText('Search messages & chats'), 'hello');
    const results = await screen.findByTestId('search');
    expect(results.props.children).toBe('search:hello');
    expect(screen.queryByTestId('tile-l1')).toBeNull();

    // The clear button appears while searching; pressing it restores the list.
    fireEvent.press(screen.getByLabelText('Clear search'));
    expect(await screen.findByTestId('tile-l1')).toBeTruthy();
    expect(screen.queryByTestId('search')).toBeNull();
  });
});

describe('ConversationListScreen — navigation & actions', () => {
  it('routes the header actions via expo-router', async () => {
    setChats({ data: [makeRow({ guid: 'l1' })] });
    await renderWithTheme(<ConversationListScreen />);

    // Await after each press: fireEvent on a Pressable schedules its internal pressed-state update,
    // and an un-awaited one leaks an act() into the next test's render (harness rule 1).
    fireEvent.press(screen.getByLabelText('New message'));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/new-chat'));
    fireEvent.press(screen.getByLabelText('FaceTime'));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/facetime'));
    fireEvent.press(screen.getByLabelText('Settings'));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/settings'));
  });

  it('opens a chat (encoded guid) when a tile is tapped', async () => {
    setChats({ data: [makeRow({ guid: 'iMessage;-;+1' })] });
    await renderWithTheme(<ConversationListScreen />);
    // findBy (not getBy): the reactive list commits async under React 19, and a preceding test's
    // settling act can defer this render a tick — retry until the tile mounts.
    fireEvent.press(await screen.findByTestId('tile-iMessage;-;+1'));
    expect(mockPush).toHaveBeenCalledWith(`/chat/${encodeURIComponent('iMessage;-;+1')}`);
  });

  it('opens the actions sheet with the row on long-press', async () => {
    setChats({ data: [makeRow({ guid: 'l1' })] });
    await renderWithTheme(<ConversationListScreen />);
    fireEvent(await screen.findByTestId('tile-l1'), 'longPress');
    const actions = await screen.findByTestId('actions');
    expect(actions.props.children).toBe('l1');
  });
});
