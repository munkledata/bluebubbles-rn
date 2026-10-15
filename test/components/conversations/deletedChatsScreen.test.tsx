/**
 * DeletedChatsScreen owns the presentation boundary around the RECOVERY-02 repository/service.
 * The FlashList and data hook are controlled here so the suite can prove paging, restore feedback,
 * and immediate old-account concealment without claiming real SQL, transport, or device behavior.
 */
import React from 'react';
import { StyleSheet, type ViewStyle } from 'react-native';
import { act, fireEvent, renderWithTheme, screen, waitFor } from '../support/renderWithTheme';
import type { DialogButton } from '@ui/dialog/dialogStore';
import { contrastRatio, readableTextOn } from '@ui/theme/adaptiveFromImage';
import type { DeletedChatPage, DeletedChatRow } from '@db/repositories';
import { listDeletedChats } from '@db/repositories';
import { ApiError } from '@core/api/errors';
import { DeletedChatRestoreUnsafeError, restoreDeletedChat } from '@/services';

const mockBack = jest.fn();
const mockShowDialog = jest.fn();
const mockUnsubscribe = jest.fn();
const mockUseReactiveQuery = jest.fn();
const mockListProps: { current: Record<string, unknown> } = { current: {} };
const mockLease = {
  generation: 29,
  current: true,
  isCurrent(): boolean {
    return this.current;
  },
};
let mockInvalidationListener: (() => void) | null = null;

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
  const FlashList = (props: {
    data?: unknown[];
    renderItem?: (info: { item: unknown; index: number }) => unknown;
    keyExtractor?: (item: unknown) => string;
    ListEmptyComponent?: unknown;
    ListFooterComponent?: unknown;
  }) => {
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
      { testID: 'deleted-conversations-list' },
      body,
      asNode(props.ListFooterComponent),
    );
  };
  return { FlashList };
});

jest.mock('expo-router', () => ({ useRouter: () => ({ back: mockBack }) }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@ui/dialog/dialogStore', () => ({
  showDialog: (...args: unknown[]) => mockShowDialog(...args),
}));
jest.mock('@db/useReactiveQuery', () => ({
  useReactiveQuery: (...args: unknown[]) => mockUseReactiveQuery(...args),
}));
jest.mock('@db/repositories', () => ({ listDeletedChats: jest.fn() }));
jest.mock('@/services', () => ({
  restoreDeletedChat: jest.fn(),
  DeletedChatRestoreUnsafeError: class DeletedChatRestoreUnsafeError extends Error {},
}));
jest.mock('@/services/realtime/deliveryCoordinator', () => ({
  captureRealtimeDeliveryLease: () => mockLease,
  subscribeRealtimeGenerationInvalidation: (generation: number, listener: () => void) => {
    if (generation !== mockLease.generation) throw new Error('Subscribed to the wrong account');
    mockInvalidationListener = listener;
    return mockUnsubscribe;
  },
}));

// eslint-disable-next-line import/first
import { DeletedChatsScreen } from '@ui/conversations/DeletedChatsScreen';

const mockListDeletedChats = jest.mocked(listDeletedChats);
const mockRestoreDeletedChat = jest.mocked(restoreDeletedChat);
const PRIVATE_TITLE = 'Synthetic deleted conversation A-71c9';
const SECOND_TITLE = 'Synthetic deleted conversation B-28de';

const firstRow: DeletedChatRow = {
  id: 1,
  guid: 'iMessage;-;synthetic-deleted-a-71c9',
  chatIdentifier: 'synthetic-a@example.test',
  displayName: null,
  customName: PRIVATE_TITLE,
  style: 45,
  deletedAt: Date.UTC(2026, 7, 20, 12),
  participantCount: 1,
  participantNames: 'Synthetic A',
  participantAvatars: null,
  participantColors: null,
  handleServices: 'iMessage',
};
const secondRow: DeletedChatRow = {
  ...firstRow,
  id: 2,
  guid: 'iMessage;-;synthetic-deleted-b-28de',
  chatIdentifier: 'synthetic-b@example.test',
  customName: SECOND_TITLE,
  deletedAt: Date.UTC(2026, 7, 19, 12),
};

interface QueryState {
  data: DeletedChatPage | null;
  isLoading: boolean;
  error: Error | null;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

let mockQueryState: QueryState;

function readyState(hasMore = true): QueryState {
  return { data: { rows: [firstRow, secondRow], hasMore }, isLoading: false, error: null };
}

function latestQueryCall(): [
  () => Promise<DeletedChatPage>,
  string[],
  unknown[],
  { enabled: boolean },
] {
  const call = mockUseReactiveQuery.mock.calls.at(-1);
  if (!call) throw new Error('Expected DeletedChatsScreen to call useReactiveQuery');
  return call as unknown as ReturnType<typeof latestQueryCall>;
}

function latestListEndReached(): () => void {
  const callback = mockListProps.current.onEndReached;
  if (typeof callback !== 'function') throw new Error('Expected a FlashList onEndReached callback');
  return callback as () => void;
}

function lastDialog(): { title: string; message: string | undefined; buttons: DialogButton[] } {
  const call = mockShowDialog.mock.calls.at(-1);
  if (!call) throw new Error('Expected a dialog');
  return { title: call[0], message: call[1], buttons: call[2] ?? [] };
}

function dialogAction(dialog: ReturnType<typeof lastDialog>, label: string): () => void {
  const action = dialog.buttons.find((button) => button.text === label)?.onPress;
  if (!action) throw new Error(`Expected dialog action ${label}`);
  return action;
}

async function retireAccount(): Promise<void> {
  mockLease.current = false;
  await act(async () => {
    if (!mockInvalidationListener) throw new Error('Expected an account invalidation listener');
    mockInvalidationListener();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLease.current = true;
  mockInvalidationListener = null;
  mockListProps.current = {};
  mockQueryState = readyState();
  mockUseReactiveQuery.mockImplementation(() => mockQueryState);
  mockListDeletedChats.mockResolvedValue(mockQueryState.data!);
  mockRestoreDeletedChat.mockResolvedValue({
    messages: 0,
    historyExhausted: true,
    restored: true,
  });
});

it('queries every dependency at 50 rows, renders accessible rows, and caps growth at 250', async () => {
  await renderWithTheme(<DeletedChatsScreen />);

  expect(screen.getByText('Deleted Conversations')).toBeTruthy();
  expect(screen.getByText(PRIVATE_TITLE)).toBeTruthy();
  expect(screen.getAllByText(/^Deleted \d/)).toHaveLength(2);
  const restoreButton = screen.getByRole('button', { name: `Restore ${PRIVATE_TITLE}` });
  expect(restoreButton.props.accessibilityState).toEqual({ disabled: false, busy: false });
  const restoreButtonStyle = StyleSheet.flatten(restoreButton.props.style) as ViewStyle;
  const restoreTextStyle = StyleSheet.flatten(screen.getAllByText('Restore')[0]?.props.style) as {
    color?: string;
  };
  const restoreBackground = restoreButtonStyle.backgroundColor;
  const restoreForeground = restoreTextStyle.color;
  if (typeof restoreBackground !== 'string' || typeof restoreForeground !== 'string') {
    throw new Error('Expected concrete Restore button colors');
  }
  expect(restoreButtonStyle.minHeight).toBe(44);
  expect(restoreForeground).toBe(readableTextOn(restoreBackground));
  expect(contrastRatio(restoreForeground, restoreBackground)).toBeGreaterThanOrEqual(4.5);

  const [run, tables, deps, options] = latestQueryCall();
  expect(tables).toEqual(['chats', 'messages', 'chat_handles', 'handles', 'kv']);
  expect(deps).toEqual([50]);
  expect(options).toEqual({ enabled: true });
  await run();
  expect(mockListDeletedChats).toHaveBeenCalledWith(undefined, { limit: 50 });

  await act(async () => {
    for (let index = 0; index < 5; index += 1) latestListEndReached()();
  });
  const [cappedRun, , cappedDeps] = latestQueryCall();
  expect(cappedDeps).toEqual([250]);
  await cappedRun();
  expect(mockListDeletedChats).toHaveBeenLastCalledWith(undefined, { limit: 250 });

  await fireEvent.press(screen.getByText('‹ Back'));
  expect(mockBack).toHaveBeenCalledTimes(1);
});

it('says so when more deleted conversations exist than the 250 it can list', async () => {
  const capNotice = 'Only the 250 most recently deleted conversations are shown.';
  await renderWithTheme(<DeletedChatsScreen />);
  expect(screen.queryByText(capNotice)).toBeNull();

  await act(async () => {
    for (let index = 0; index < 5; index += 1) latestListEndReached()();
  });

  expect(latestQueryCall()[2]).toEqual([250]);
  expect(screen.getByText(capNotice)).toBeTruthy();
});

it('shows no cap notice once every deleted conversation is listed', async () => {
  const view = await renderWithTheme(<DeletedChatsScreen />);
  await act(async () => {
    for (let index = 0; index < 5; index += 1) latestListEndReached()();
  });
  expect(latestQueryCall()[2]).toEqual([250]);

  // Restoring some leaves no more than the 250 the screen can list.
  mockQueryState = readyState(false);
  await act(async () => {
    await view.rerender(<DeletedChatsScreen />);
  });

  expect(screen.queryByText(/most recently deleted conversations are shown/)).toBeNull();
});

it('announces loading and failure while retaining a truthful empty state', async () => {
  mockQueryState = { data: null, isLoading: true, error: null };
  const view = await renderWithTheme(<DeletedChatsScreen />);
  expect(screen.getByText('Loading deleted conversations…').props.accessibilityLiveRegion).toBe(
    'polite',
  );

  mockQueryState = { data: null, isLoading: false, error: new Error('private raw DB error') };
  await view.rerender(<DeletedChatsScreen />);
  const error = screen.getByRole('alert');
  expect(error.props.children).toBe('Couldn’t load deleted conversations.');
  expect(error.props.accessibilityLiveRegion).toBe('assertive');
  expect(JSON.stringify(view.toJSON())).not.toContain('private raw DB error');

  mockQueryState = { data: { rows: [], hasMore: false }, isLoading: false, error: null };
  await view.rerender(<DeletedChatsScreen />);
  expect(screen.getByText('No deleted conversations.')).toBeTruthy();
});

it('confirms the bounded restore, locks every row while busy, and reports success', async () => {
  const restore = deferred<Awaited<ReturnType<typeof restoreDeletedChat>>>();
  mockRestoreDeletedChat.mockReturnValue(restore.promise);
  await renderWithTheme(<DeletedChatsScreen />);

  await fireEvent.press(screen.getByRole('button', { name: `Restore ${PRIVATE_TITLE}` }));
  const confirm = lastDialog();
  expect([confirm.title, confirm.message]).toEqual([
    'Restore Conversation',
    `Restore “${PRIVATE_TITLE}” and re-download its 500 most recent messages? Older history remains available through a full Local Cache Repair.`,
  ]);
  expect(confirm.buttons.map((button) => [button.text, button.style])).toEqual([
    ['Cancel', 'cancel'],
    ['Restore', undefined],
  ]);
  expect(confirm.buttons[0]?.onPress).toBeUndefined();

  await act(async () => {
    dialogAction(confirm, 'Restore')();
  });
  expect(mockRestoreDeletedChat).toHaveBeenCalledWith(firstRow.guid, firstRow.deletedAt);
  expect(
    screen.getByRole('button', { name: `Restore ${PRIVATE_TITLE}` }).props.accessibilityState,
  ).toEqual({ disabled: true, busy: true });
  expect(
    screen.getByRole('button', { name: `Restore ${SECOND_TITLE}` }).props.accessibilityState,
  ).toEqual({ disabled: true, busy: false });

  await act(async () => {
    restore.resolve({ messages: 123, historyExhausted: true, restored: true });
    await restore.promise;
  });
  await waitFor(() => expect(lastDialog().title).toBe('Conversation Restored'));
  expect(lastDialog().message).toBe('123 recent messages were refreshed.');
  expect(
    screen.getByRole('button', { name: `Restore ${PRIVATE_TITLE}` }).props.accessibilityState,
  ).toEqual({ disabled: false, busy: false });
});

it.each([
  [
    'an unsafe restore',
    () => new DeletedChatRestoreUnsafeError(),
    'Gator could not safely restore this conversation from its recent history. Run Local Cache Repair, then try again.',
  ],
  [
    'an unreachable Mac',
    () => new ApiError('no_connection', 'offline'),
    'Gator couldn’t reach your Mac. Check the connection, then try again.',
  ],
] as const)('says what stopped %s', async (_label, makeError, message) => {
  mockRestoreDeletedChat.mockRejectedValue(makeError());
  await renderWithTheme(<DeletedChatsScreen />);

  await fireEvent.press(screen.getByRole('button', { name: `Restore ${PRIVATE_TITLE}` }));
  await act(async () => {
    dialogAction(lastDialog(), 'Restore')();
  });
  await waitFor(() => expect(lastDialog().title).toBe('Restore Stopped'));
  expect(lastDialog().message).toBe(message);
});

it('reports a fixed safe failure and releases the restore controls', async () => {
  const rawError = 'private restore transport details 5f2a';
  mockRestoreDeletedChat.mockRejectedValue(new Error(rawError));
  await renderWithTheme(<DeletedChatsScreen />);

  await fireEvent.press(screen.getByRole('button', { name: `Restore ${PRIVATE_TITLE}` }));
  await act(async () => {
    dialogAction(lastDialog(), 'Restore')();
  });
  await waitFor(() => expect(lastDialog().title).toBe('Restore Stopped'));
  expect(lastDialog().message).toBe('The restore stopped before it finished. Try again.');
  expect(JSON.stringify(mockShowDialog.mock.calls)).not.toContain(rawError);
  expect(
    screen.getByRole('button', { name: `Restore ${PRIVATE_TITLE}` }).props.accessibilityState,
  ).toEqual({ disabled: false, busy: false });
});

it('removes retained old-account rows and blocks their saved confirmation callback', async () => {
  await renderWithTheme(<DeletedChatsScreen />);
  await fireEvent.press(screen.getByRole('button', { name: `Restore ${PRIVATE_TITLE}` }));
  const retainedRestore = dialogAction(lastDialog(), 'Restore');

  await retireAccount();
  expect(latestQueryCall()[3]).toEqual({ enabled: false });
  expect(screen.queryByText(PRIVATE_TITLE)).toBeNull();
  expect(screen.queryByRole('button', { name: `Restore ${PRIVATE_TITLE}` })).toBeNull();
  expect(screen.getByRole('alert').props.children).toBe(
    'Conversation account changed. Go back and reopen Deleted Conversations.',
  );

  await act(async () => retainedRestore());
  expect(mockRestoreDeletedChat).not.toHaveBeenCalled();
  expect(mockShowDialog).toHaveBeenCalledTimes(1);
});

it('conceals an in-flight restore and suppresses its late old-account result', async () => {
  const restore = deferred<Awaited<ReturnType<typeof restoreDeletedChat>>>();
  mockRestoreDeletedChat.mockReturnValue(restore.promise);
  await renderWithTheme(<DeletedChatsScreen />);
  await fireEvent.press(screen.getByRole('button', { name: `Restore ${PRIVATE_TITLE}` }));
  await act(async () => dialogAction(lastDialog(), 'Restore')());
  expect(mockRestoreDeletedChat).toHaveBeenCalledTimes(1);

  await retireAccount();
  expect(screen.queryByText(PRIVATE_TITLE)).toBeNull();

  await act(async () => {
    restore.resolve({ messages: 321, historyExhausted: true, restored: true });
    await restore.promise;
  });
  expect(mockShowDialog).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(mockShowDialog.mock.calls)).not.toContain('321');
});
