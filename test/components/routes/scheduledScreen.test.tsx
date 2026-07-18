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
import type { ScheduledRow } from '@db/repositories';

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

// The full `@ui` barrel drags in native/ESM modules (expo-video/expo-image/ky). The screen only
// needs `Screen` + `useTheme`, so swap the barrel for its two lightweight submodules.
jest.mock('@ui', () => ({
  ...jest.requireActual('@ui/theme'),
  ...jest.requireActual('@ui/primitives'),
}));
jest.mock('@db/useReactiveQuery', () => ({ useReactiveQuery: jest.fn() }));
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
import { useReactiveQuery } from '@db/useReactiveQuery';
// eslint-disable-next-line import/first
import { cancelScheduled, syncScheduledFromServer } from '@/services/send';
// eslint-disable-next-line import/first
import { useDialogStore } from '@ui/dialog/dialogStore';

const mockUseReactiveQuery = useReactiveQuery as jest.Mock;
const mockCancelScheduled = cancelScheduled as jest.Mock;
const mockSyncScheduled = syncScheduledFromServer as jest.Mock;

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
  // The screen now reads `{ pending, history }` (pending list + sent/errored COMPLETED history).
  mockUseReactiveQuery.mockReturnValue({
    data: { pending, history },
    isLoading: false,
    error: null,
  });
}

beforeEach(() => {
  setRows([]);
  mockCancelScheduled.mockResolvedValue(undefined);
  mockSyncScheduled.mockResolvedValue(undefined);
  useDialogStore.setState({ current: null, queue: [] });
});

describe('ScheduledScreen', () => {
  it('reconciles server-scheduled rows on mount', async () => {
    await renderWithTheme(<ScheduledScreen />);
    await waitFor(() => expect(mockSyncScheduled).toHaveBeenCalled());
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
    expect(mockCancelScheduled).toHaveBeenCalledWith(row);
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

  it('surfaces sent + failed messages under a COMPLETED section (no longer vanishing silently)', async () => {
    setRows(
      [makeRow({ id: 1, text: 'still pending' })],
      [
        makeRow({ id: 2, text: 'delivered fine', status: 'sent' }),
        makeRow({ id: 3, text: 'never sent', status: 'error' }),
      ],
    );
    await renderWithTheme(<ScheduledScreen />);
    expect(screen.getByText('COMPLETED')).toBeTruthy();
    // The status label carries a `· <date>` suffix, so match on the status substring.
    expect(screen.getByText(/✓ Sent/)).toBeTruthy();
    expect(screen.getByText(/Failed to send/)).toBeTruthy();
    // A completed row shows Clear (remove from history), not Cancel.
    expect(screen.getByText('still pending')).toBeTruthy();
    expect(screen.getAllByText('Clear').length).toBeGreaterThan(0);
  });
});
