/**
 * Archived route (app/(app)/archived.tsx): a thin wrapper over FilteredChatListScreen showing
 * ARCHIVED conversations. Data arrives from the reactive `useChats(true)` (include-archived) hook,
 * mocked in-file with controlled rows. This suite locks in the wrapper + shared screen's logic:
 *   - it renders ONLY rows whose `isArchived` is truthy, even though the hook returns archived +
 *     non-archived (the include-archived flag widens the query; the screen re-filters);
 *   - the empty-state copy shows when nothing is archived;
 *   - tapping a row routes to the chat with an ENCODED guid via expo-router;
 *   - long-pressing a row opens ChatActionsSheet with the row's target (guid/title/pinned/…);
 *   - the header Back button routes via router.back().
 *
 * In-file mocks: @shopify/flash-list (plain renderer honoring data + Empty slot), useChats
 * (controllable data), expo-router (push/back), safe-area insets, `@/services` (the real
 * ChatActionsSheet module pulls it), and light probes for ConversationTile / ChatActionsSheet
 * (Screen + theme stay REAL — same pattern as conversationListScreen.test.tsx).
 */
import React from 'react';
import { renderWithTheme, screen, fireEvent, waitFor } from '../support/renderWithTheme';
import type { InboxRow } from '@db/repositories';

const mockPush = jest.fn();
const mockBack = jest.fn();

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
      ListEmptyComponent?: unknown;
    },
    _ref: unknown,
  ) {
    const { data = [], renderItem, keyExtractor, ListEmptyComponent } = props;
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
    return ReactLib.createElement(View, null, body);
  });
  return { FlashList };
});

jest.mock('@features/conversations/useChats', () => ({ useChats: jest.fn() }));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush, back: mockBack }) }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// The real ChatActionsSheet module (loaded below for toChatActionTarget) imports `markRead`
// from the services barrel, which pulls native modules at import — stub it.
jest.mock('@/services', () => ({ markRead: jest.fn() }));

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

jest.mock('@ui/conversations/ChatActionsSheet', () => {
  const ReactLib = require('react');
  const { Text } = require('react-native');
  return {
    // The screen maps rows through the REAL toChatActionTarget; only the sheet is probed.
    toChatActionTarget: jest.requireActual('@ui/conversations/ChatActionsSheet').toChatActionTarget,
    ChatActionsSheet: (props: { target: { guid: string } | null }) =>
      ReactLib.createElement(
        Text,
        { testID: 'actions' },
        props.target ? props.target.guid : 'none',
      ),
  };
});

// eslint-disable-next-line import/first
import ArchivedScreen from '../../../app/(app)/archived';
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
    ...overrides,
  } as InboxRow;
}

function setChats(data: InboxRow[] | undefined): void {
  useChatsMock.mockReturnValue({ data, isLoading: false, error: null });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('ArchivedScreen — filtering', () => {
  it('renders only archived rows even though the hook returns archived + non-archived', async () => {
    setChats([
      makeRow({ guid: 'a1', isArchived: 1 }),
      makeRow({ guid: 'a2', isArchived: 1 }),
      makeRow({ guid: 'live1', isArchived: 0 }),
    ]);
    await renderWithTheme(<ArchivedScreen />);
    expect(screen.getByTestId('tile-a1')).toBeTruthy();
    expect(screen.getByTestId('tile-a2')).toBeTruthy();
    // A non-archived row is filtered out client-side.
    expect(screen.queryByTestId('tile-live1')).toBeNull();
    // The header still renders.
    expect(screen.getByText('Archived')).toBeTruthy();
  });

  it('shows the empty-state copy when nothing is archived', async () => {
    setChats([makeRow({ guid: 'live1', isArchived: 0 })]);
    await renderWithTheme(<ArchivedScreen />);
    expect(screen.getByText('No archived conversations')).toBeTruthy();
    expect(screen.queryByTestId('tile-live1')).toBeNull();
  });

  it('tolerates an undefined data payload (hook still loading)', async () => {
    setChats(undefined);
    await renderWithTheme(<ArchivedScreen />);
    expect(screen.getByText('No archived conversations')).toBeTruthy();
  });
});

describe('ArchivedScreen — navigation & actions', () => {
  it('opens a chat with an encoded guid when a row is tapped', async () => {
    setChats([makeRow({ guid: 'iMessage;-;+1', isArchived: 1 })]);
    await renderWithTheme(<ArchivedScreen />);
    fireEvent.press(await screen.findByTestId('tile-iMessage;-;+1'));
    expect(mockPush).toHaveBeenCalledWith(`/chat/${encodeURIComponent('iMessage;-;+1')}`);
  });

  it('opens the actions sheet with the row target on long-press', async () => {
    setChats([makeRow({ guid: 'a1', isArchived: 1 })]);
    await renderWithTheme(<ArchivedScreen />);
    fireEvent(await screen.findByTestId('tile-a1'), 'longPress');
    const actions = await screen.findByTestId('actions');
    expect(actions.props.children).toBe('a1');
  });

  it('routes Back via router.back()', async () => {
    setChats([makeRow({ guid: 'a1', isArchived: 1 })]);
    await renderWithTheme(<ArchivedScreen />);
    fireEvent.press(screen.getByText('‹ Back'));
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
  });
});
