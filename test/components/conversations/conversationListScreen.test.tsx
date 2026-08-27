/**
 * ConversationListScreen (src/ui/conversations/ConversationListScreen.tsx): the inbox. Data arrives
 * from the reactive `useChats` hook (mocked in-file with controlled rows). This suite locks in the
 * SCREEN'S own logic, not the tile/grid internals (those are covered separately):
 *   - pinned rows split into PinnedGrid (header) while the rest render as list tiles;
 *   - a chat that's pinned does NOT also appear in the list, and vice-versa;
 *   - empty / loading / error states;
 *   - typing in the bottom search bar swaps the list for SearchResultsView; clearing restores it;
 *   - header actions and tile taps route via expo-router; long-press opens the actions sheet;
 *   - the reveal-the-newest-thread scroll: WHEN it fires, that it's non-animated, that it keeps
 *     re-issuing (content-size change AND one deferred frame) until the user drags, that a later
 *     message re-arms it, and that it stops re-issuing once its arm window has passed;
 *   - the re-land-on-return scroll: a LATER focus (back from a chat) and an AppState resume both
 *     scroll to the top, mount-focus and backgrounding do not, and a drag still wins.
 *
 * In-file mocks:
 *   - `@shopify/flash-list` → a plain renderer honoring data + Header/Empty/Footer slots. It also
 *     forwards its ref (`scrollToTop`) and records its props: the screen's scroll behavior is only
 *     observable through those, and an earlier version of this mock swallowed the ref, which is
 *     precisely why the inbox shipped never scrolling for the chat already at the top.
 *     MOCK LIMIT: it renders a plain View, so it cannot reproduce FlashList's
 *     maintainVisibleContentPosition offset correction — the deferred scroll AGAINST which the
 *     corrective scroll is racing on device. These tests prove the screen ISSUES the corrective
 *     scrolls (and when it stops); they cannot prove one SURVIVES the correction. That last step is
 *     device-only: scroll the inbox down, have a chat below the fold receive a SHORT (one-line)
 *     message — a pure reorder, no content-height change — and confirm row 0 lands and stays.
 *   - `@features/conversations/useChats` → controllable `{ data, isLoading, error }` (real hook hits
 *     the reactive DB).
 *   - `expo-router` (useRouter/usePathname, plus a `useFocusEffect` that registers its callback so
 *     a test can replay a re-focus) + `react-native-safe-area-context` (useSafeAreaInsets) → the RN
 *     navigation/inset natives.
 *   - `@/services` (refreshInbox) → jest.fn (its barrel pulls native modules).
 *   - child components ConversationTile / PinnedGrid / SearchResultsView / ChatActionsSheet → light
 *     probes, so the assertions are about the SCREEN'S split/search/route wiring.
 */
import React from 'react';
import { AppState } from 'react-native';
import { renderWithTheme, screen, fireEvent, waitFor, act } from '../support/renderWithTheme';
import type { InboxRow } from '@db/repositories';

const mockPush = jest.fn();
const mockScrollToTop = jest.fn();
/** Focus callbacks the mounted screen registered — `emitFocus()` replays them as a re-focus. */
const mockFocusCallbacks: Array<() => void> = [];
/** Last props the screen handed the list — the config-level guard reads the scroll handlers here. */
const mockListProps: { current: Record<string, unknown> } = { current: {} };

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
      onContentSizeChange?: () => void;
      onScrollBeginDrag?: () => void;
    },
    ref: unknown,
  ) {
    // The imperative handle is the whole point: without it `listRef.current` is null and every
    // corrective scroll is silently unobservable.
    ReactLib.useImperativeHandle(ref, () => ({ scrollToTop: mockScrollToTop }), []);
    mockListProps.current = props as unknown as Record<string, unknown>;
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
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => '/home',
  // Mirrors React Navigation: the effect runs when the screen gains focus — which INCLUDES mount,
  // the case the screen deliberately skips. Registering the callback here lets `emitFocus()` drive
  // a later focus (coming back from a chat), which the real hook would fire and nothing else can.
  useFocusEffect: (cb: () => void) => {
    const ReactLib = require('react');
    ReactLib.useEffect(() => {
      cb();
      mockFocusCallbacks.push(cb);
      return () => {
        const i = mockFocusCallbacks.indexOf(cb);
        if (i >= 0) mockFocusCallbacks.splice(i, 1);
      };
    }, [cb]);
  },
}));
// Insets default to zero (what almost every test wants) but are MUTABLE, so the bottom-inset
// suite below can hand the search bar a realistic 48dp navigation bar.
let mockInsetBottom = 0;
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: mockInsetBottom, left: 0, right: 0 }),
}));
// The search bar collapses its nav-bar reservation while the keyboard is up (union, not sum — see
// Composer.tsx's paddingBottom). RNTL has no soft keyboard, so drive the hook directly.
let mockKbVisible = false;
jest.mock('@ui/hooks/useKeyboardVisible', () => ({
  useKeyboardVisible: () => mockKbVisible,
}));
jest.mock('@/services', () => ({ refreshInbox: jest.fn() }));
jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));
// "Mark all read" is the one header action that WRITES — and it writes to EVERY chat. Stub just
// that repository fn, keeping the rest of the real barrel. It MUST be mocked at the barrel
// (`@db/repositories`), not at `@db/repositories/chats`: mocking the submodule does NOT reach
// the barrel's `export *` re-export, so the screen would still get the real function.
jest.mock('@db/repositories', () => ({
  ...jest.requireActual('@db/repositories'),
  markAllChatsReadLocalWithinTransaction: jest.fn(),
}));

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
    PinnedGrid: (props: {
      rows: { guid: string }[];
      onPress: (g: string) => void;
      onLongPress: (row: { guid: string }) => void;
    }) =>
      ReactLib.createElement(
        View,
        null,
        props.rows.map((r) =>
          ReactLib.createElement(
            Pressable,
            {
              key: r.guid,
              testID: `pinned-${r.guid}`,
              onPress: () => props.onPress(r.guid),
              onLongPress: () => props.onLongPress(r),
            },
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
  const { Text, View } = require('react-native');
  return {
    // The screen maps rows through the REAL toChatActionTarget; only the sheet is probed.
    toChatActionTarget: jest.requireActual('@ui/conversations/ChatActionsSheet').toChatActionTarget,
    ChatActionsSheet: (props: {
      target: {
        guid: string;
        moveEarlierGuid?: string | null;
        moveLaterGuid?: string | null;
      } | null;
    }) =>
      ReactLib.createElement(View, null, [
        ReactLib.createElement(
          Text,
          { key: 'actions', testID: 'actions' },
          props.target ? props.target.guid : 'none',
        ),
        ReactLib.createElement(
          Text,
          { key: 'neighbors', testID: 'pin-neighbors' },
          props.target
            ? `${props.target.moveEarlierGuid ?? 'none'}|${props.target.moveLaterGuid ?? 'none'}`
            : 'none|none',
        ),
      ]),
  };
});

// eslint-disable-next-line import/first
import { ConversationListScreen } from '@ui/conversations/ConversationListScreen';
// eslint-disable-next-line import/first
import { useChats } from '@features/conversations/useChats';
// eslint-disable-next-line import/first
import { getDatabase } from '@db/database';
// eslint-disable-next-line import/first
import { markAllChatsReadLocalWithinTransaction } from '@db/repositories';
// eslint-disable-next-line import/first
import { useDialogStore } from '@ui/dialog/dialogStore';
// eslint-disable-next-line import/first
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

const useChatsMock = useChats as jest.Mock;
const mockGetDatabase = getDatabase as jest.Mock;
const markAllReadWithinTransactionMock = markAllChatsReadLocalWithinTransaction as jest.Mock;
const ACCOUNT_A_DATABASE = {
  kind: 'conversation-list-account-a-db',
  run: jest.fn(async (_statement: unknown) => undefined),
};
const ACCOUNT_B_DATABASE = {
  kind: 'conversation-list-account-b-db',
  run: jest.fn(async (_statement: unknown) => undefined),
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function sqlStatementText(value: unknown): string {
  if (!value || typeof value !== 'object' || !('queryChunks' in value)) return '';
  const chunks = (value as { queryChunks: Array<{ value?: unknown }> }).queryChunks;
  return chunks
    .flatMap((chunk) => (Array.isArray(chunk.value) ? chunk.value : []))
    .filter((part): part is string => typeof part === 'string')
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

function expectDbRunSequence(db: { run: jest.Mock }, expected: string[]): void {
  expect(db.run.mock.calls.map(([statement]) => sqlStatementText(statement))).toEqual(expected);
}

beforeEach(() => {
  resumeRealtimeDeliveries();
  // The confirm dialog lives in the store (AppDialog is mounted at the app root, not here).
  useDialogStore.setState({ current: null, queue: [] });
  // Reset in beforeEach, never afterEach: an afterEach mutation lands on a still-mounted tree.
  mockScrollToTop.mockClear();
  mockListProps.current = {};
  mockFocusCallbacks.length = 0;
  mockInsetBottom = 0;
  mockKbVisible = false;
  mockGetDatabase.mockReset().mockReturnValue(ACCOUNT_A_DATABASE);
  markAllReadWithinTransactionMock.mockReset().mockResolvedValue(undefined);
  ACCOUNT_A_DATABASE.run.mockReset().mockResolvedValue(undefined);
  ACCOUNT_B_DATABASE.run.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  resumeRealtimeDeliveries();
});

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

  it('Mark all read confirms first, and only the confirm button writes to the DB', async () => {
    setChats({ data: [makeRow({ guid: 'l1' })] });
    await renderWithTheme(<ConversationListScreen />);

    fireEvent.press(screen.getByLabelText('Mark all read'));
    await waitFor(() => expect(useDialogStore.getState().current?.title).toBe('Mark All Read'));
    const dlg = useDialogStore.getState().current!;
    expect(dlg.message).toBe('Mark every conversation as read?');
    expect(dlg.buttons.map((b) => b.text)).toEqual(['Cancel', 'Mark All Read']);
    // Opening the confirm must not touch the DB — the handler runs synchronously, so a missing
    // gate would already show up here.
    expect(markAllReadWithinTransactionMock).not.toHaveBeenCalled();

    // Cancel is a pure no-op (no handler at all).
    await act(async () => {
      dlg.buttons.find((b) => b.text === 'Cancel')?.onPress?.();
    });
    expect(markAllReadWithinTransactionMock).not.toHaveBeenCalled();

    // The destructive-ish confirm is what actually clears every badge.
    await act(async () => {
      dlg.buttons.find((b) => b.text === 'Mark All Read')?.onPress?.();
    });
    await waitFor(() => expect(markAllReadWithinTransactionMock).toHaveBeenCalledTimes(1));
    expect(markAllReadWithinTransactionMock).toHaveBeenCalledWith(expect.any(Object));
    expectDbRunSequence(ACCOUNT_A_DATABASE, ['BEGIN IMMEDIATE', 'COMMIT']);
  });

  it('drops a delayed Mark All Read callback retained from the previous account', async () => {
    setChats({ data: [makeRow({ guid: 'same-guid' })] });
    await renderWithTheme(<ConversationListScreen />);
    fireEvent.press(screen.getByLabelText('Mark all read'));
    await waitFor(() => expect(useDialogStore.getState().current?.title).toBe('Mark All Read'));
    const retainedConfirm = useDialogStore
      .getState()
      .current?.buttons.find((button) => button.text === 'Mark All Read')?.onPress;

    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    mockGetDatabase.mockReturnValue(ACCOUNT_B_DATABASE);
    await act(async () => {
      retainedConfirm?.();
    });

    expect(markAllReadWithinTransactionMock).not.toHaveBeenCalled();
    expect(ACCOUNT_A_DATABASE.run).not.toHaveBeenCalled();
    expect(ACCOUNT_B_DATABASE.run).not.toHaveBeenCalled();
  });

  it('rolls back admitted Mark All Read when Disconnect retires its account mid-write', async () => {
    const write = deferred<void>();
    markAllReadWithinTransactionMock.mockReturnValueOnce(write.promise);
    setChats({ data: [makeRow({ guid: 'same-guid' })] });
    await renderWithTheme(<ConversationListScreen />);
    fireEvent.press(screen.getByLabelText('Mark all read'));
    await waitFor(() => expect(useDialogStore.getState().current?.title).toBe('Mark All Read'));
    const confirm = useDialogStore
      .getState()
      .current?.buttons.find((button) => button.text === 'Mark All Read')?.onPress;

    let drain: Promise<void> | undefined;
    try {
      await act(async () => {
        confirm?.();
      });
      await waitFor(() => expect(markAllReadWithinTransactionMock).toHaveBeenCalledTimes(1));

      let drained = false;
      drain = pauseRealtimeDeliveries().then(() => {
        drained = true;
      });
      mockGetDatabase.mockReturnValue(ACCOUNT_B_DATABASE);
      await Promise.resolve();
      expect(drained).toBe(false);

      await act(async () => {
        write.resolve(undefined);
        await drain;
      });
      expect(drained).toBe(true);
      expectDbRunSequence(ACCOUNT_A_DATABASE, ['BEGIN IMMEDIATE', 'ROLLBACK']);
      expect(ACCOUNT_B_DATABASE.run).not.toHaveBeenCalled();
    } finally {
      write.resolve(undefined);
      drain ??= pauseRealtimeDeliveries();
      await Promise.allSettled([drain]);
      resumeRealtimeDeliveries();
    }
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

  it('passes the displayed pinned neighbors into the reorder sheet', async () => {
    setChats({
      data: [
        makeRow({ guid: 'pin-a', isPinned: 1 }),
        makeRow({ guid: 'pin-b', isPinned: 1 }),
        makeRow({ guid: 'pin-c', isPinned: 1 }),
      ],
    });
    await renderWithTheme(<ConversationListScreen />);
    fireEvent(await screen.findByTestId('pinned-pin-b'), 'longPress');
    expect((await screen.findByTestId('pin-neighbors')).props.children).toBe('pin-a|pin-c');
  });
});

/**
 * Revealing the newest thread. The inbox is anchored by FlashList v2's
 * maintainVisibleContentPosition, so a chat that bumps to the top while the user is scrolled down
 * stays above the fold unless the screen scrolls. The trigger is the newest latestMessageDate
 * across ALL visible rows (pinned included) — NOT "row 0 changed identity", which never fired for
 * the commonest case of all: the conversation already at the top getting another message.
 */
describe('ConversationListScreen — reveal the newest thread', () => {
  // The corrective scroll's deferred re-issue is a requestAnimationFrame, and whether a REAL frame
  // happens to land inside an awaited act() is luck — which would make every call count below
  // flaky. Capture the frames instead of running them: the counts are then exact, and the deferred
  // scroll fires only in the tests that explicitly flush it.
  let frames: FrameRequestCallback[] = [];
  let restoreRaf = (): void => {};
  beforeEach(() => {
    frames = [];
    const spy = jest
      .spyOn(global, 'requestAnimationFrame')
      // The queue length doubles as the handle: always ≥ 1, so it never reads as falsy.
      .mockImplementation((cb: FrameRequestCallback): number => frames.push(cb));
    restoreRaf = (): void => {
      spy.mockRestore();
    };
  });
  afterEach(() => {
    restoreRaf();
  });
  /** Run whatever the screen queued, the way the next display refresh would. */
  function flushFrames(): void {
    for (const cb of frames.splice(0, frames.length)) cb(0);
  }

  // Re-drive the reactive hook the way a DB write does, then let the screen re-render.
  async function drive(
    view: { rerender: (ui: React.ReactElement) => void },
    state: { data?: InboxRow[]; isLoading?: boolean; error?: unknown },
  ): Promise<void> {
    setChats(state);
    await act(async () => {
      view.rerender(<ConversationListScreen />);
    });
  }

  it('seeds the baseline on the first data arrival without scrolling', async () => {
    setChats({ data: [makeRow({ guid: 'a', latestMessageDate: 1_000 })] });
    await renderWithTheme(<ConversationListScreen />);
    expect(mockScrollToTop).not.toHaveBeenCalled();
  });

  // THE reported bug: an active conversation is already at row 0, so its guid never changes.
  it('scrolls when the chat ALREADY at the top receives a newer message', async () => {
    setChats({ data: [makeRow({ guid: 'a', latestMessageDate: 1_000 })] });
    const view = await renderWithTheme(<ConversationListScreen />);

    await drive(view, { data: [makeRow({ guid: 'a', latestMessageDate: 2_000 })] });
    // animated:false — an animated scroll is cancelled by FlashList's deferred offset correction.
    expect(mockScrollToTop).toHaveBeenCalledWith({ animated: false });
    expect(mockScrollToTop).toHaveBeenCalledTimes(1);
  });

  it('scrolls when a different chat bumps to the top with a newer message', async () => {
    setChats({
      data: [
        makeRow({ guid: 'a', latestMessageDate: 2_000 }),
        makeRow({ guid: 'b', latestMessageDate: 1_000 }),
      ],
    });
    const view = await renderWithTheme(<ConversationListScreen />);

    await drive(view, {
      data: [
        makeRow({ guid: 'b', latestMessageDate: 3_000 }),
        makeRow({ guid: 'a', latestMessageDate: 2_000 }),
      ],
    });
    expect(mockScrollToTop).toHaveBeenCalledWith({ animated: false });
  });

  // The nastiest case, and the one the whole loop exists for: a chat below the fold bumps to row 0
  // with a ONE-LINE message. That's a pure reorder — the content height is identical, so
  // onContentSizeChange never fires — while FlashList still runs its deferred offset correction a
  // commit later and scrolls back to keep the old row 0 stationary. The deferred frame is the only
  // re-issue that can land after that correction.
  it('re-issues the corrective scroll one frame later, with no content-size change at all', async () => {
    setChats({
      data: [
        makeRow({ guid: 'a', latestMessageDate: 2_000 }),
        makeRow({ guid: 'b', latestMessageDate: 1_000 }),
      ],
    });
    const view = await renderWithTheme(<ConversationListScreen />);

    await drive(view, {
      data: [
        makeRow({ guid: 'b', latestMessageDate: 3_000 }),
        makeRow({ guid: 'a', latestMessageDate: 2_000 }),
      ],
    });
    expect(mockScrollToTop).toHaveBeenCalledTimes(1);

    flushFrames();
    expect(mockScrollToTop).toHaveBeenCalledTimes(2);
    expect(mockScrollToTop).toHaveBeenLastCalledWith({ animated: false });
  });

  it('drops the pending deferred scroll when the user drags first', async () => {
    setChats({ data: [makeRow({ guid: 'a', latestMessageDate: 1_000 })] });
    const view = await renderWithTheme(<ConversationListScreen />);

    await drive(view, { data: [makeRow({ guid: 'a', latestMessageDate: 2_000 })] });
    expect(mockScrollToTop).toHaveBeenCalledTimes(1);

    // The frame is already queued when the finger lands; it must find the loop disarmed.
    (mockListProps.current.onScrollBeginDrag as () => void)();
    flushFrames();
    expect(mockScrollToTop).toHaveBeenCalledTimes(1);
  });

  // Archiving/deleting the top chat surfaces an OLDER one — the list content changed but nothing
  // new arrived, so yanking the viewport would be wrong.
  it('does not scroll when an OLDER chat surfaces (the top chat was archived)', async () => {
    setChats({
      data: [
        makeRow({ guid: 'a', latestMessageDate: 2_000 }),
        makeRow({ guid: 'b', latestMessageDate: 1_000 }),
      ],
    });
    const view = await renderWithTheme(<ConversationListScreen />);

    await drive(view, { data: [makeRow({ guid: 'b', latestMessageDate: 1_000 })] });
    expect(mockScrollToTop).not.toHaveBeenCalled();
  });

  // The trigger reads a max over the VISIBLE rows, and that SET changes without a message arriving:
  // toggling "Filter Unknown Senders", a background contacts sync flipping a chat's hasKnownSender
  // 0→1, un-archiving an old thread. Each drops the max and then restores it. The baseline is a
  // monotonic high-water mark precisely so the restore isn't read as a brand-new message.
  it('does not scroll when an old chat merely re-enters the visible set', async () => {
    setChats({
      data: [
        makeRow({ guid: 'a', latestMessageDate: 3_000 }),
        makeRow({ guid: 'b', latestMessageDate: 5_000 }),
      ],
    });
    const view = await renderWithTheme(<ConversationListScreen />);

    // b leaves the visible set (the filter went on / it was archived): the max drops to 3_000.
    await drive(view, { data: [makeRow({ guid: 'a', latestMessageDate: 3_000 })] });
    expect(mockScrollToTop).not.toHaveBeenCalled();

    // b comes back carrying its OLD date. Nothing was sent or received.
    await drive(view, {
      data: [
        makeRow({ guid: 'a', latestMessageDate: 3_000 }),
        makeRow({ guid: 'b', latestMessageDate: 5_000 }),
      ],
    });
    flushFrames();
    expect(mockScrollToTop).not.toHaveBeenCalled();

    // …and a genuine message after that still scrolls — the high-water mark mustn't go inert.
    await drive(view, {
      data: [
        makeRow({ guid: 'b', latestMessageDate: 6_000 }),
        makeRow({ guid: 'a', latestMessageDate: 3_000 }),
      ],
    });
    expect(mockScrollToTop).toHaveBeenCalledTimes(1);
  });

  // Pinned rows live in the header grid, not listData — the old row-0 trigger couldn't even see
  // them, so a user who pins their important chats had a completely inert inbox.
  it('scrolls when a PINNED chat receives a newer message', async () => {
    setChats({
      data: [
        makeRow({ guid: 'p', isPinned: 1, latestMessageDate: 1_000 }),
        makeRow({ guid: 'l', latestMessageDate: 900 }),
      ],
    });
    const view = await renderWithTheme(<ConversationListScreen />);

    await drive(view, {
      data: [
        makeRow({ guid: 'p', isPinned: 1, latestMessageDate: 2_000 }),
        makeRow({ guid: 'l', latestMessageDate: 900 }),
      ],
    });
    expect(mockScrollToTop).toHaveBeenCalledWith({ animated: false });
  });

  // useReactiveQuery nulls `data` on ANY query error; nulling the baseline there would make the
  // next successful pass merely re-seed and swallow a real bump.
  it('keeps the baseline through a failed/empty pass and still scrolls on recovery', async () => {
    setChats({ data: [makeRow({ guid: 'a', latestMessageDate: 1_000 })] });
    const view = await renderWithTheme(<ConversationListScreen />);

    await drive(view, { data: undefined, error: new Error('db down') });
    expect(mockScrollToTop).not.toHaveBeenCalled();

    await drive(view, { data: [makeRow({ guid: 'a', latestMessageDate: 2_000 })] });
    expect(mockScrollToTop).toHaveBeenCalledWith({ animated: false });
  });

  it('never scrolls while searching, and exiting search fires no stale scroll', async () => {
    setChats({ data: [makeRow({ guid: 'a', latestMessageDate: 1_000 })] });
    const view = await renderWithTheme(<ConversationListScreen />);

    fireEvent.changeText(screen.getByPlaceholderText('Search messages & chats'), 'hello');
    await screen.findByTestId('search');

    await drive(view, { data: [makeRow({ guid: 'a', latestMessageDate: 2_000 })] });
    expect(mockScrollToTop).not.toHaveBeenCalled();

    // The baseline advanced under the search results, so restoring the list is not a bump.
    fireEvent.press(screen.getByLabelText('Clear search'));
    expect(await screen.findByTestId('tile-a')).toBeTruthy();
    expect(mockScrollToTop).not.toHaveBeenCalled();
  });

  // Config-level guard (same spirit as messageSwipeWrapper's PanResponder assertions): the loop is
  // invisible in the rendered output, so pin the handlers and their behavior. Deleting either prop
  // silently restores the one-shot scroll that FlashList's offset correction cancels.
  it('runs the convergence loop until the user drags', async () => {
    setChats({ data: [makeRow({ guid: 'a', latestMessageDate: 1_000 })] });
    const view = await renderWithTheme(<ConversationListScreen />);

    const onContentSizeChange = mockListProps.current.onContentSizeChange;
    const onScrollBeginDrag = mockListProps.current.onScrollBeginDrag;
    expect(typeof onContentSizeChange).toBe('function');
    expect(typeof onScrollBeginDrag).toBe('function');

    // Before any bump the loop is idle — content growth alone must not hijack the viewport.
    (onContentSizeChange as () => void)();
    expect(mockScrollToTop).not.toHaveBeenCalled();

    await drive(view, { data: [makeRow({ guid: 'a', latestMessageDate: 2_000 })] });
    expect(mockScrollToTop).toHaveBeenCalledTimes(1);

    // A late row-height change (a preview wrapping to two lines) re-issues the scroll…
    (mockListProps.current.onContentSizeChange as () => void)();
    expect(mockScrollToTop).toHaveBeenCalledTimes(2);

    // …until a finger-down drag hands the list back to the user.
    (mockListProps.current.onScrollBeginDrag as () => void)();
    (mockListProps.current.onContentSizeChange as () => void)();
    expect(mockScrollToTop).toHaveBeenCalledTimes(2);

    // …and the NEXT message re-arms it. A one-way "the user took over" latch would satisfy every
    // assertion above while making the inbox reveal exactly one message per app launch and then go
    // inert for the rest of the session.
    await drive(view, { data: [makeRow({ guid: 'a', latestMessageDate: 3_000 })] });
    expect(mockScrollToTop).toHaveBeenCalledTimes(3);
    (mockListProps.current.onContentSizeChange as () => void)();
    expect(mockScrollToTop).toHaveBeenCalledTimes(4);
  });

  // A drag is the only disarm a FINGER can produce, but plenty of scrolls never involve one:
  // TalkBack's swipe-to-next-item moves the list through the accessibility API and emits no drag.
  // Without the arm window such a reader would be pulled back to row 0 by every later content-size
  // change, with no gesture available to stop it.
  it('stops re-issuing once the arm window has passed, even with no drag', async () => {
    setChats({ data: [makeRow({ guid: 'a', latestMessageDate: 1_000 })] });
    const view = await renderWithTheme(<ConversationListScreen />);

    await drive(view, { data: [makeRow({ guid: 'a', latestMessageDate: 2_000 })] });
    expect(mockScrollToTop).toHaveBeenCalledTimes(1);

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
    try {
      (mockListProps.current.onContentSizeChange as () => void)();
      flushFrames();
      expect(mockScrollToTop).toHaveBeenCalledTimes(1);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

/**
 * Coming BACK to the inbox re-lands it at the top unconditionally. The "reveal the newest thread"
 * loop above can only fire for a message the screen WATCHED arrive; these two triggers cover the
 * returns where it didn't — the texts landed while the user was inside a chat, or while the app was
 * backgrounded, and the arm window closed long before they looked at the list again.
 */
describe('ConversationListScreen — re-land at the top on return', () => {
  // Keep the screen's deliberate deferred correction out of awaited act() timing. The RN Jest
  // preset implements requestAnimationFrame with setTimeout(0), so leaving it real makes an exact
  // immediate-call assertion depend on whether that timer happens to fire before act() returns.
  let frames: FrameRequestCallback[] = [];
  let restoreRaf = (): void => {};
  beforeEach(() => {
    frames = [];
    const spy = jest
      .spyOn(global, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback): number => frames.push(cb));
    restoreRaf = (): void => {
      spy.mockRestore();
    };
  });
  afterEach(() => {
    restoreRaf();
  });

  function flushFrames(): void {
    for (const cb of frames.splice(0, frames.length)) cb(0);
  }

  /** Replay the registered focus callbacks, as navigating back to this screen would. */
  async function emitFocus(): Promise<void> {
    await act(async () => {
      for (const cb of [...mockFocusCallbacks]) cb();
    });
  }

  // The screen's AppState subscribers, so a test can drive a resume. Installed for EVERY test in
  // this block and deliberately never restored — same pattern as chatScreenReadMarker.test.tsx.
  // HARNESS TRAP: `mockRestore()` does NOT give jest-expo's AppState its behavior back; the
  // restored `addEventListener` returns `undefined`, so the screen's `sub.remove()` throws on the
  // next unmount. (Verified: the untouched mock returns `{remove}`, the restored one returns
  // undefined.) That is a jest-expo artifact, not a product bug — leave the spy in place.
  const appStateHandlers: Array<(s: string) => void> = [];
  beforeEach(() => {
    appStateHandlers.length = 0;
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((
      _type: string,
      handler: (s: string) => void,
    ) => {
      appStateHandlers.push(handler);
      return { remove: jest.fn() };
    }) as unknown as typeof AppState.addEventListener);
  });

  /** Drive an AppState transition through the screen's own listener. */
  async function emitAppState(state: string): Promise<void> {
    await act(async () => {
      for (const h of [...appStateHandlers]) h(state);
    });
  }

  it('does NOT scroll on the first focus — mount is not a return', async () => {
    setChats({ data: [makeRow({ guid: 'a', latestMessageDate: 1_000 })] });
    await renderWithTheme(<ConversationListScreen />);
    expect(mockFocusCallbacks).toHaveLength(1); // the hook really is wired up
    expect(mockScrollToTop).not.toHaveBeenCalled();
  });

  // Back from a chat: the inbox stayed MOUNTED the whole time and kept its scroll offset, so no
  // amount of new data would have moved it — only the focus event can.
  it('scrolls to the top when the inbox regains focus', async () => {
    setChats({ data: [makeRow({ guid: 'a', latestMessageDate: 1_000 })] });
    await renderWithTheme(<ConversationListScreen />);

    await emitFocus();
    // Non-animated for the same reason the reveal loop is: an animated scroll gets cancelled by
    // FlashList's deferred offset correction.
    expect(mockScrollToTop).toHaveBeenCalledWith({ animated: false });
  });

  // THE reported bug: messages arrive while the app is backgrounded, so the reveal loop either
  // never ran or ran and expired unseen. Focus was never lost, so only AppState can catch this.
  it('scrolls to the top when the app resumes', async () => {
    setChats({ data: [makeRow({ guid: 'a', latestMessageDate: 1_000 })] });
    await renderWithTheme(<ConversationListScreen />);
    expect(mockScrollToTop).not.toHaveBeenCalled();

    await emitAppState('active');
    expect(mockScrollToTop).toHaveBeenCalledWith({ animated: false });
  });

  it('does not scroll when the app merely goes to the background', async () => {
    setChats({ data: [makeRow({ guid: 'a', latestMessageDate: 1_000 })] });
    await renderWithTheme(<ConversationListScreen />);

    await emitAppState('background');
    expect(mockScrollToTop).not.toHaveBeenCalled();
  });

  // The return scroll goes through the same requestScrollToTop, so it must inherit the convergence
  // loop's escape hatch: the moment a finger drags, the list belongs to the user again.
  it('re-issues after a return, but a drag still hands the list back', async () => {
    setChats({ data: [makeRow({ guid: 'a', latestMessageDate: 1_000 })] });
    await renderWithTheme(<ConversationListScreen />);

    await emitFocus();
    expect(mockScrollToTop).toHaveBeenCalledTimes(1);

    // The deliberate next-frame correction re-lands after FlashList's own offset correction.
    flushFrames();
    expect(mockScrollToTop).toHaveBeenCalledTimes(2);

    // A later return arms another correction, but dragging before its frame hands ownership back.
    await emitFocus();
    expect(mockScrollToTop).toHaveBeenCalledTimes(3);
    (mockListProps.current.onScrollBeginDrag as () => void)();
    flushFrames();
    (mockListProps.current.onContentSizeChange as () => void)();
    expect(mockScrollToTop).toHaveBeenCalledTimes(3);
  });
});

/**
 * Accessibility: the search field must GROW with the system font scale rather than clip.
 * A fixed `height` cannot contain scaled text, and on device at font_scale 1.5 the placeholder
 * lost the tops and tails of its glyphs — a silent failure, since nothing errors and the field
 * still works. Asserting on the resolved style is the only jest-visible signal (RNTL cannot
 * change the OS font scale), so this is a config-level guard like the MessageList
 * keyboardShouldPersistTaps one.
 */
describe('ConversationListScreen search field sizing', () => {
  it('sizes the search input with minHeight, never a fixed height', async () => {
    setChats({ data: [makeRow({ guid: 'a' })] });
    await renderWithTheme(<ConversationListScreen />);

    const input = screen.getByPlaceholderText('Search messages & chats');
    const flat = Object.assign({}, ...[input.props.style].flat(Infinity).filter(Boolean));

    expect(flat.height).toBeUndefined();
    expect(flat.minHeight).toBe(38);
    // Padding is what actually buys the scaled glyphs their room.
    expect(flat.paddingVertical).toBeGreaterThan(0);
  });
});

/**
 * The bottom search bar's safe-area reservation — the inbox half of the "empty band above the
 * keyboard" fix (the chat half is conversations/composerKeyboardInset.test.tsx).
 *
 * THE RULE: the reservation is the UNION of the keyboard and the navigation bar, never their SUM.
 * `useSafeAreaInsets().bottom` is the nav-bar inset and does not shrink when the keyboard opens,
 * but Android's IME inset already spans that strip — reserving both leaves a nav-bar-tall band of
 * dead space above the keyboard. Config-level, like the search-field sizing guard above: the gap
 * itself is device-only, the arithmetic is not.
 */
describe('ConversationListScreen search bar bottom inset', () => {
  const NAV_BAR = 48;

  /** The search bar is the input's grandparent — walk up rather than add a testID for one test. */
  function searchBarPaddingBottom(): number {
    const input = screen.getByPlaceholderText('Search messages & chats');
    const bar = input.parent?.parent;
    const flat = Object.assign({}, ...[bar?.props.style].flat(Infinity).filter(Boolean));
    return flat.paddingBottom;
  }

  it('clears the navigation bar while the keyboard is DOWN', async () => {
    mockInsetBottom = NAV_BAR;
    setChats({ data: [makeRow({ guid: 'a' })] });
    await renderWithTheme(<ConversationListScreen />);
    expect(searchBarPaddingBottom()).toBe(NAV_BAR);
  });

  it('COLLAPSES the navigation-bar reservation while the keyboard is UP', async () => {
    mockInsetBottom = NAV_BAR;
    mockKbVisible = true;
    setChats({ data: [makeRow({ guid: 'a' })] });
    await renderWithTheme(<ConversationListScreen />);
    // The keyboard covers the nav-bar strip; reserving it again is the band. 0 (not the composer's
    // 8) is deliberate — it is what this screen already worked out to, so the fix stays a no-op here.
    expect(searchBarPaddingBottom()).toBe(0);
  });

  it('keeps a 10dp floor when the device reports no bottom inset at all', async () => {
    mockInsetBottom = 0;
    setChats({ data: [makeRow({ guid: 'a' })] });
    await renderWithTheme(<ConversationListScreen />);
    expect(searchBarPaddingBottom()).toBe(10);
  });
});
