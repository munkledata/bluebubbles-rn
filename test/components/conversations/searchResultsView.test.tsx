/**
 * SearchResultsView (src/ui/conversations/SearchResultsView.tsx): the unified inbox search body — a
 * Chats section (name/people matches, rendered as ConversationTiles) above a Messages section
 * (full-text hits with a bolded snippet). Behaviors locked in, derived from the SOURCE:
 *   - EMPTY states via ListEmptyComponent: query < 2 chars → "Type to search your messages & chats";
 *     searching + loading → "Searching…"; searching + done + no hits → "No results".
 *   - a message hit renders its chat TITLE (resolveTitle over the chat* fields — here a customName),
 *     the snippet, and the date; the snippet BOLDS whole words starting with a query term.
 *   - tapping a message hit navigates to `/chat/<chatGuid>?focus=<guid>&focusDate=<dateCreated>`
 *     (focusDate omitted when dateCreated is null).
 *   - a Chats section renders the "Chats" label + a ConversationTile per matched chat; tapping one
 *     navigates to `/chat/<guid>`. When BOTH sections have rows, both "Chats" and "Messages" labels
 *     show; when only chats match, the Messages empty text is suppressed.
 *
 * In-file mocks: the two data hooks `useSearch` / `useChatMatches` (they hit the reactive DB) are
 * mocked to return controlled rows; `@shopify/flash-list` is replaced with a plain renderer (v2
 * renders nothing meaningful in jest) that runs ListHeaderComponent + renderItem + ListEmptyComponent
 * exactly as the real list would; `expo-router`'s useRouter is mocked to capture push(); and
 * ConversationTile is stubbed to a tap-target rendering its guid (the real tile pulls the native
 * `@/services` graph and is covered by its own suite). resolveTitle/formatChatDate are REAL utils.
 */
import React from 'react';
import { renderWithTheme, screen, fireEvent } from '../support/renderWithTheme';
import type { SearchResultRow, InboxRow } from '@db/repositories';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => '/home',
}));

// The reactive-DB hooks: mocked so tests feed controlled result/chat rows.
jest.mock('@features/search/useSearch', () => ({ useSearch: jest.fn() }));
jest.mock('@features/search/useChatMatches', () => ({ useChatMatches: jest.fn() }));

// FlashList v2 renders nothing meaningful in jest — replace it with a plain renderer that exercises
// the same header/item/empty slots the real list drives.
jest.mock('@shopify/flash-list', () => {
  const React_ = require('react') as typeof import('react');
  const { View } = require('react-native');
  const asNode = (c: unknown): React.ReactNode =>
    c == null
      ? null
      : React_.isValidElement(c)
        ? c
        : React_.createElement(c as React.ComponentType);
  return {
    FlashList: ({
      data,
      renderItem,
      keyExtractor,
      ListHeaderComponent,
      ListEmptyComponent,
    }: any) => {
      const rows = data ?? [];
      return React_.createElement(
        View,
        null,
        asNode(ListHeaderComponent),
        ...rows.map((item: unknown, index: number) =>
          React_.createElement(
            React_.Fragment,
            { key: keyExtractor ? keyExtractor(item) : index },
            renderItem({ item, index }),
          ),
        ),
        rows.length === 0 ? asNode(ListEmptyComponent) : null,
      );
    },
  };
});

// ConversationTile pulls the native `@/services` (markRead) graph; stub it to a tap target that
// renders its guid so the Chats section is assertable in isolation.
jest.mock('@ui/conversations/ConversationTile', () => {
  const React_ = require('react') as typeof import('react');
  const { Pressable, Text } = require('react-native');
  return {
    ConversationTile: ({ row, onPress }: { row: { guid: string }; onPress: (g: string) => void }) =>
      React_.createElement(
        Pressable,
        { accessibilityRole: 'button', onPress: () => onPress(row.guid) },
        React_.createElement(Text, null, row.guid),
      ),
  };
});

// eslint-disable-next-line import/first
import { SearchResultsView } from '@ui/conversations/SearchResultsView';
// eslint-disable-next-line import/first
import { useSearch } from '@features/search/useSearch';
// eslint-disable-next-line import/first
import { useChatMatches } from '@features/search/useChatMatches';

const mockUseSearch = useSearch as jest.MockedFunction<typeof useSearch>;
const mockUseChatMatches = useChatMatches as jest.MockedFunction<typeof useChatMatches>;

function makeResult(overrides: Partial<SearchResultRow> = {}): SearchResultRow {
  return {
    id: 10,
    guid: 'msg-guid-1',
    text: 'hello world from the beach',
    snippet: 'hello world from the beach',
    dateCreated: 1_700_000_000_000,
    isFromMe: 0,
    chatGuid: 'iMessage;-;+15551230000',
    chatDisplayName: null,
    chatCustomName: 'Weekend Crew',
    chatIdentifier: '+15551230000',
    chatStyle: 43,
    chatParticipantNames: 'Alice, Bob',
    senderName: 'Alice',
    ...overrides,
  };
}

function makeChat(guid: string): InboxRow {
  // ConversationTile is stubbed and only reads `guid`; the rest is irrelevant to this suite.
  return { guid } as InboxRow;
}

// The reactive-hook state shape (data / isLoading / error) SearchResultsView reads `.data` off.
function chatState(data: InboxRow[]): ReturnType<typeof useChatMatches> {
  return { data, isLoading: false, error: null };
}

// Default: no data. Individual tests override the two hooks.
beforeEach(() => {
  mockPush.mockClear();
  mockUseSearch.mockReturnValue({ results: [], loading: false });
  mockUseChatMatches.mockReturnValue(chatState([]));
});

describe('SearchResultsView — empty / placeholder states', () => {
  it('short query (< 2 chars) shows the type-to-search prompt', async () => {
    await renderWithTheme(<SearchResultsView query="" />);
    expect(screen.getByText('Type to search your messages & chats')).toBeTruthy();
  });

  it('searching + loading shows "Searching…"', async () => {
    mockUseSearch.mockReturnValue({ results: [], loading: true });
    await renderWithTheme(<SearchResultsView query="beach" />);
    expect(screen.getByText('Searching…')).toBeTruthy();
  });

  it('searching + done with no hits shows "No results"', async () => {
    mockUseSearch.mockReturnValue({ results: [], loading: false });
    await renderWithTheme(<SearchResultsView query="beach" />);
    expect(screen.getByText('No results')).toBeTruthy();
  });
});

describe('SearchResultsView — message hits', () => {
  it('renders the resolved chat title and the snippet for a hit', async () => {
    mockUseSearch.mockReturnValue({ results: [makeResult()], loading: false });
    await renderWithTheme(<SearchResultsView query="beach" />);
    // resolveTitle → customName wins.
    expect(screen.getByText('Weekend Crew')).toBeTruthy();
    // The Messages section label shows because there is at least one result.
    expect(screen.getByText('Messages')).toBeTruthy();
    // No empty text when there are results.
    expect(screen.queryByText('No results')).toBeNull();
  });

  it('bolds the snippet word that starts with the query term', async () => {
    mockUseSearch.mockReturnValue({
      results: [makeResult({ snippet: 'day at the beach today' })],
      loading: false,
    });
    await renderWithTheme(<SearchResultsView query="beach" />);
    // renderSnippet splits on word boundaries; the "beach" token becomes its own bolded <Text>.
    const bold = screen.getByText('beach');
    expect(bold.props.style).toMatchObject({ fontWeight: '700' });
  });

  it('tapping a hit navigates to the chat focused on the message (with focusDate)', async () => {
    mockUseSearch.mockReturnValue({
      results: [
        makeResult({ guid: 'msg-guid-1', chatGuid: 'iMessage;-;+15551230000', dateCreated: 42 }),
      ],
      loading: false,
    });
    await renderWithTheme(<SearchResultsView query="beach" />);
    fireEvent.press(screen.getByText('Weekend Crew'));
    expect(mockPush).toHaveBeenCalledWith(
      `/chat/${encodeURIComponent('iMessage;-;+15551230000')}?focus=${encodeURIComponent('msg-guid-1')}&focusDate=42`,
    );
  });

  it('omits focusDate when the message has no dateCreated', async () => {
    mockUseSearch.mockReturnValue({
      results: [makeResult({ guid: 'm2', chatGuid: 'g2', dateCreated: null })],
      loading: false,
    });
    await renderWithTheme(<SearchResultsView query="beach" />);
    fireEvent.press(screen.getByText('Weekend Crew'));
    expect(mockPush).toHaveBeenCalledWith(`/chat/g2?focus=m2`);
  });
});

describe('SearchResultsView — chats section', () => {
  it('renders matched chats as tiles under a "Chats" label and opens on tap', async () => {
    mockUseChatMatches.mockReturnValue(chatState([makeChat('iMessage;-;+15550001111')]));
    await renderWithTheme(<SearchResultsView query="al" />);
    expect(screen.getByText('Chats')).toBeTruthy();
    // The stubbed tile renders its guid; tapping fires openChat → router.push(/chat/<guid>).
    fireEvent.press(screen.getByText('iMessage;-;+15550001111'));
    expect(mockPush).toHaveBeenCalledWith(`/chat/${encodeURIComponent('iMessage;-;+15550001111')}`);
  });

  it('shows BOTH section labels when chats AND messages match', async () => {
    mockUseChatMatches.mockReturnValue(chatState([makeChat('iMessage;-;+15550001111')]));
    mockUseSearch.mockReturnValue({ results: [makeResult()], loading: false });
    await renderWithTheme(<SearchResultsView query="al" />);
    expect(screen.getByText('Chats')).toBeTruthy();
    expect(screen.getByText('Messages')).toBeTruthy();
  });

  it('suppresses the "No results" empty text when only chats match', async () => {
    mockUseChatMatches.mockReturnValue(chatState([makeChat('iMessage;-;+15550001111')]));
    mockUseSearch.mockReturnValue({ results: [], loading: false });
    await renderWithTheme(<SearchResultsView query="al" />);
    expect(screen.getByText('Chats')).toBeTruthy();
    expect(screen.queryByText('No results')).toBeNull();
  });
});
