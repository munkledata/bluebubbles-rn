/**
 * ScheduledScreen route (app/(app)/scheduled.tsx): the pending scheduled-message list.
 *
 * The data source (`useReactiveQuery`) is mocked in-file with controlled rows, so the
 * suite tests the SCREEN'S own behavior rather than the reactive DB plumbing:
 *   - it reconciles server-scheduled rows on mount (`syncScheduledFromServer`);
 *   - each row renders its text + schedule and routes to the editor on tap;
 *   - Cancel calls `cancelScheduled(item)`, and a rejected cancel surfaces a dialog;
 *   - the empty list shows the "No scheduled messages" placeholder.
 *
 * Mock note: a jest.mock factory must NOT dereference an outer `const mock…` at factory-eval
 * time (ES imports hoist above the const initializers → still `undefined`). So the factories
 * create their `jest.fn()`s inline and we grab references AFTER import. The dialog store is
 * the REAL singleton.
 */
import React from 'react';
import { renderWithTheme, screen, fireEvent, waitFor, act } from '../support/renderWithTheme';

const mockPush = jest.fn();
const mockBack = jest.fn();

jest.mock('@shopify/flash-list', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
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

// The full `@ui` barrel drags in native/ESM modules (expo-video/expo-image/ky). The screen only
// needs `Screen` + `useTheme`, so swap the barrel for its two lightweight submodules.
jest.mock('@ui', () => ({
  ...jest.requireActual('@ui/theme'),
  ...jest.requireActual('@ui/primitives'),
}));
jest.mock('@db/useReactiveQuery', () => ({ useReactiveQuery: jest.fn() }));
jest.mock('@db/database', () => ({ getDatabase: jest.fn(() => ({ testDb: true })) }));
jest.mock('@db/repositories', () => ({
  ...jest.requireActual('@db/repositories'),
  deleteScheduledHistory: jest.fn(),
}));
jest.mock('@/services/send', () => ({
  cancelScheduled: jest.fn(),
  syncScheduledFromServer: jest.fn(),
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush, back: mockBack }) }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// eslint-disable-next-line import/first
import ScheduledScreen from '../../../app/(app)/scheduled';
// eslint-disable-next-line import/first
import { getDatabase } from '@db/database';
// eslint-disable-next-line import/first
import { deleteScheduledHistory, type ScheduledRow } from '@db/repositories';
// eslint-disable-next-line import/first
import { useReactiveQuery } from '@db/useReactiveQuery';
// eslint-disable-next-line import/first
import { cancelScheduled, syncScheduledFromServer } from '@/services/send';
// eslint-disable-next-line import/first
import { useDialogStore } from '@ui/dialog/dialogStore';
// eslint-disable-next-line import/first
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

const mockUseReactiveQuery = useReactiveQuery as jest.Mock;
const mockGetDatabase = getDatabase as jest.Mock;
const mockCancelScheduled = cancelScheduled as jest.Mock;
const mockSyncScheduled = syncScheduledFromServer as jest.Mock;
const mockDeleteScheduledHistory = deleteScheduledHistory as jest.Mock;

const PRIVATE_PENDING_BODY = 'scheduled-private-pending-body-4fd2';
const PRIVATE_HISTORY_BODY = 'scheduled-private-history-body-a91c';
const TEST_DATABASE = { kind: 'scheduled-screen-test-db' };

function retainConfiguredPress(node: { props: Record<string, unknown> }): () => void {
  const responder = node.props.onStartShouldSetResponder;
  if (typeof responder !== 'function') {
    throw new Error('Expected an accessible Pressable responder callback');
  }
  const readConfig = (
    responder as typeof responder & {
      testOnly_pressabilityConfig?: () => { onPress?: (event: object) => void };
    }
  ).testOnly_pressabilityConfig;
  if (typeof readConfig !== 'function') {
    throw new Error('Expected React Native test-only Pressability configuration');
  }
  const onPress = readConfig().onPress;
  if (typeof onPress !== 'function') throw new Error('Expected configured Pressable onPress');
  return () => onPress({ nativeEvent: {} });
}

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

function makeRow(overrides: Partial<ScheduledRow> = {}): ScheduledRow {
  return {
    id: 1,
    serverId: null,
    chatGuid: 'iMessage;-;+15551230000',
    text: 'Happy birthday!',
    scheduledFor: 1_700_000_000_000,
    status: 'pending',
    ...overrides,
  };
}

function setRows(pending: ScheduledRow[], history: ScheduledRow[] = []): void {
  // The screen reads `{ pending, history }` (pending list + completed/uncertain history).
  mockUseReactiveQuery.mockReturnValue({
    data: { pending, history },
    isLoading: false,
    error: null,
  });
}

beforeEach(() => {
  resumeRealtimeDeliveries();
  jest.clearAllMocks();
  setRows([]);
  mockGetDatabase.mockReturnValue(TEST_DATABASE);
  mockCancelScheduled.mockResolvedValue(undefined);
  mockSyncScheduled.mockResolvedValue(undefined);
  mockDeleteScheduledHistory.mockResolvedValue(undefined);
  useDialogStore.setState({ current: null, queue: [] });
});

afterEach(() => {
  resumeRealtimeDeliveries();
});

describe('ScheduledScreen', () => {
  it('reconciles server-scheduled rows on mount', async () => {
    await renderWithTheme(<ScheduledScreen />);
    await waitFor(() => expect(mockSyncScheduled).toHaveBeenCalledTimes(1));
    const originalLease = mockSyncScheduled.mock.calls[0]?.[0];
    expect(originalLease).toEqual(expect.objectContaining({ isCurrent: expect.any(Function) }));
    expect(originalLease.isCurrent()).toBe(true);
  });

  it('shows the empty placeholder when there are no scheduled messages', async () => {
    setRows([]);
    await renderWithTheme(<ScheduledScreen />);
    expect(screen.getByText('No scheduled messages')).toBeTruthy();
  });

  it('renders each scheduled row with its text', async () => {
    setRows([makeRow({ id: 7, text: 'See you soon' }), makeRow({ id: 8, text: 'On my way' })]);
    await renderWithTheme(<ScheduledScreen />);
    expect(screen.getByText('See you soon')).toBeTruthy();
    expect(screen.getByText('On my way')).toBeTruthy();
  });

  it('routes to the editor when a row is tapped', async () => {
    setRows([makeRow({ id: 42, text: 'Edit me' })]);
    await renderWithTheme(<ScheduledScreen />);
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Edit scheduled message: Edit me'));
    });
    expect(mockPush).toHaveBeenCalledWith('/scheduled-edit/42');
  });

  it('cancels the row through cancelScheduled', async () => {
    const row = makeRow({ id: 5, text: 'Cancel me' });
    setRows([row]);
    await renderWithTheme(<ScheduledScreen />);
    await act(async () => {
      fireEvent.press(screen.getByText('Cancel'));
    });
    const originalLease = mockSyncScheduled.mock.calls[0]?.[0];
    expect(originalLease).toEqual(expect.objectContaining({ isCurrent: expect.any(Function) }));
    expect(mockCancelScheduled).toHaveBeenCalledWith(row, originalLease);
  });

  it('shows a dialog when the cancel fails', async () => {
    mockCancelScheduled.mockRejectedValue(new Error('offline'));
    setRows([makeRow({ id: 9, text: 'Cancel me' })]);
    await renderWithTheme(<ScheduledScreen />);
    await act(async () => {
      fireEvent.press(screen.getByText('Cancel'));
    });
    await waitFor(() => expect(useDialogStore.getState().current?.title).toBe('Scheduled'));
  });

  it('goes back from the header', async () => {
    await renderWithTheme(<ScheduledScreen />);
    await act(async () => {
      fireEvent.press(screen.getByText('‹ Back'));
    });
    expect(mockBack).toHaveBeenCalled();
  });

  it('shows a compact recurrence label on recurring rows', async () => {
    setRows([
      makeRow({ id: 11, text: 'standup ping', recurrence: 'daily' }),
      makeRow({ id: 12, text: 'one-off', recurrence: null }),
    ]);
    await renderWithTheme(<ScheduledScreen />);
    expect(screen.getByText(/Repeats daily/)).toBeTruthy();
    // The one-shot row's subtitle carries no recurrence tag.
    expect(screen.queryAllByText(/Repeats/)).toHaveLength(1);
  });

  it('surfaces sent, failed, and legacy-uncertain messages without encouraging a duplicate', async () => {
    setRows(
      [makeRow({ id: 1, text: 'still pending' })],
      [
        makeRow({ id: 2, text: 'delivered fine', status: 'sent' }),
        makeRow({ id: 3, text: 'never sent', status: 'error' }),
        makeRow({
          id: 4,
          text: 'old ambiguous handoff',
          status: 'uncertain',
          recurrence: 'daily',
        }),
      ],
    );
    await renderWithTheme(<ScheduledScreen />);
    expect(screen.getByText('COMPLETED')).toBeTruthy();
    // The status label carries a `· <date>` suffix, so match on the status substring.
    expect(screen.getByText(/✓ Sent/)).toBeTruthy();
    expect(screen.getByText(/Failed to send/)).toBeTruthy();
    expect(screen.getByText(/Delivery uncertain — check conversation/)).toBeTruthy();
    expect(screen.queryByText(/Repeats/)).toBeNull();
    // A completed row shows Clear (remove from history), not Cancel.
    expect(screen.getByText('still pending')).toBeTruthy();
    expect(screen.getAllByText('Clear').length).toBeGreaterThan(0);
  });

  it('keeps exact row actions bound to the account that mounted them', async () => {
    const pending = makeRow({ id: 701, text: PRIVATE_PENDING_BODY });
    const history = makeRow({ id: 702, text: PRIVATE_HISTORY_BODY, status: 'sent' });
    setRows([pending], [history]);
    await renderWithTheme(<ScheduledScreen />);
    await waitFor(() => expect(mockSyncScheduled).toHaveBeenCalledTimes(1));
    const originalLease = mockSyncScheduled.mock.calls[0]?.[0];
    expect(originalLease).toEqual(expect.objectContaining({ isCurrent: expect.any(Function) }));
    expect(originalLease.isCurrent()).toBe(true);

    expect(screen.getByText('Scheduled')).toBeTruthy();
    expect(screen.getByText(PRIVATE_PENDING_BODY)).toBeTruthy();
    expect(screen.getByText(PRIVATE_HISTORY_BODY)).toBeTruthy();
    expect(screen.getByLabelText(`Edit scheduled message: ${PRIVATE_PENDING_BODY}`)).toBeTruthy();
    expect(
      screen.getByLabelText(`Scheduled message ✓ Sent: ${PRIVATE_HISTORY_BODY}`),
    ).toBeDisabled();

    const retainedCancel = retainConfiguredPress(screen.getByRole('button', { name: 'Cancel' }));
    const retainedClear = retainConfiguredPress(
      screen.getByRole('button', { name: 'Remove from history' }),
    );

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Remove from history' }));
    });
    await waitFor(() =>
      expect(mockDeleteScheduledHistory).toHaveBeenCalledWith(TEST_DATABASE, history.id),
    );
    mockDeleteScheduledHistory.mockClear();

    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    expect(originalLease.isCurrent()).toBe(false);
    mockCancelScheduled.mockRejectedValueOnce(new Error('stale account cancel'));
    await act(async () => {
      retainedCancel();
      retainedClear();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockCancelScheduled).toHaveBeenCalledWith(pending, originalLease);
    expect(mockDeleteScheduledHistory).not.toHaveBeenCalled();
    expect(useDialogStore.getState().current).toBeNull();
  });

  it('shows the fixed Scheduled dialog when a current Clear fails', async () => {
    const history = makeRow({ id: 801, text: 'clear failure row', status: 'error' });
    mockDeleteScheduledHistory.mockRejectedValueOnce(new Error('private database failure'));
    setRows([], [history]);
    await renderWithTheme(<ScheduledScreen />);

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Remove from history' }));
    });

    await waitFor(() => expect(useDialogStore.getState().current?.title).toBe('Scheduled'));
    expect(useDialogStore.getState().current?.message).toBe('Couldn’t clear that history item.');
  });

  it('holds Disconnect until an admitted current Clear settles', async () => {
    const history = makeRow({ id: 901, text: 'deferred clear row', status: 'sent' });
    const deletion = deferred<void>();
    mockDeleteScheduledHistory.mockReturnValueOnce(deletion.promise);
    setRows([], [history]);
    await renderWithTheme(<ScheduledScreen />);

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Remove from history' }));
    });
    await waitFor(() =>
      expect(mockDeleteScheduledHistory).toHaveBeenCalledWith(TEST_DATABASE, history.id),
    );

    let drained = false;
    const drain = pauseRealtimeDeliveries().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    await act(async () => {
      deletion.resolve(undefined);
      await drain;
    });
    expect(drained).toBe(true);
    expect(useDialogStore.getState().current).toBeNull();
  });
});
