import React from 'react';
import { StyleSheet } from 'react-native';
import { act, fireEvent, renderWithTheme, screen, waitFor } from '../support/renderWithTheme';
import type { LogEntry } from '@core/secure';

const mockBack = jest.fn();
const mockClearLogs = jest.fn<Promise<boolean>, []>();
const mockShowDialog = jest.fn();
let mockCleanupConfirmed = false;
let mockBootIssues: Array<{
  stage: string;
  level: 'degraded' | 'diagnostic';
  code: string;
  userMessage?: string;
}> = [];

jest.mock('@shopify/flash-list', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  const asNode = (component: unknown): unknown => {
    if (component == null || ReactLib.isValidElement(component)) return component;
    return typeof component === 'function'
      ? ReactLib.createElement(component as React.ComponentType)
      : component;
  };
  const FlashList = ({
    data = [],
    renderItem,
    keyExtractor,
    ListEmptyComponent,
  }: {
    data?: unknown[];
    renderItem?: (args: { item: unknown; index: number }) => unknown;
    keyExtractor?: (item: unknown, index: number) => string;
    ListEmptyComponent?: unknown;
  }) =>
    ReactLib.createElement(
      View,
      null,
      data.length === 0
        ? asNode(ListEmptyComponent)
        : data.map((item, index) =>
            ReactLib.createElement(
              View,
              { key: keyExtractor?.(item, index) ?? String(index) },
              renderItem?.({ item, index }),
            ),
          ),
    );
  return { FlashList };
});

jest.mock('expo-router', () => ({ useRouter: () => ({ back: mockBack }) }));
jest.mock('@features/boot/useForegroundBootState', () => ({
  useForegroundBootState: () => ({
    status: 'ready',
    runId: 1,
    mode: 'connected',
    issues: mockBootIssues,
  }),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@ui', () => ({
  ...jest.requireActual('@ui/theme'),
  Screen: jest.requireActual('@ui/primitives/Screen').Screen,
  ScreenHeader: jest.requireActual('@ui/primitives/ScreenHeader').ScreenHeader,
}));
jest.mock('@/services/logging/fileLogSink', () => ({
  fileLogSink: {
    clear: async () => {
      const cleared = await mockClearLogs();
      if (cleared) mockCleanupConfirmed = true;
      return cleared;
    },
    hasConfirmedCleanup: () => mockCleanupConfirmed,
  },
}));
jest.mock('@ui/dialog/dialogStore', () => ({
  showDialog: (title: string, message?: string) => mockShowDialog(title, message),
}));

// eslint-disable-next-line import/first
import { memoryLogSink } from '@core/secure';
// eslint-disable-next-line import/first
import LogsScreen from '../../../app/(app)/logs';

const errorEntry: LogEntry = {
  level: 'error',
  message: '[socket] connection failed',
  meta: JSON.stringify({ errorName: 'TypeError', response: 'raw-error-canary' }),
  timestamp: Date.UTC(2026, 7, 6, 12, 34, 56),
};
const infoEntry: LogEntry = {
  level: 'info',
  message: 'non-error-canary',
  meta: 'non-error-meta-canary',
  timestamp: Date.UTC(2026, 7, 6, 12, 35, 56),
};
const cleanupIssue = {
  stage: 'persistent-logs',
  level: 'degraded',
  code: 'persistent-log-init-failed',
} as const;

describe('LogsScreen error-only sharing', () => {
  let entriesSpy: jest.SpyInstance<LogEntry[], []>;
  let shareSpy: jest.SpyInstance;

  beforeEach(() => {
    mockBootIssues = [];
    mockCleanupConfirmed = false;
    mockClearLogs.mockResolvedValue(true);
    entriesSpy = jest.spyOn(memoryLogSink, 'entries');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    shareSpy = jest.spyOn(require('react-native').Share, 'share').mockResolvedValue({
      action: 'dismissedAction',
    });
  });

  afterEach(() => {
    entriesSpy.mockRestore();
    shareSpy.mockRestore();
  });

  it('labels and disables the action when the full snapshot has no shareable errors', async () => {
    entriesSpy.mockReturnValue([infoEntry]);

    await renderWithTheme(<LogsScreen />);

    const action = screen.getByRole('button', { name: 'Share errors' });
    expect(action.props.accessibilityState).toEqual({ disabled: true, busy: false });
    await fireEvent.press(action);
    expect(shareSpy).not.toHaveBeenCalled();
  });

  it('shares errors from the full snapshot even when the active filter hides them', async () => {
    entriesSpy.mockReturnValue([infoEntry, errorEntry]);
    await renderWithTheme(<LogsScreen />);

    await fireEvent.press(screen.getByRole('button', { name: 'INFO' }));
    await waitFor(() => expect(screen.queryByText('[socket] connection failed')).toBeNull());

    await fireEvent.press(screen.getByRole('button', { name: 'Share errors' }));

    expect(shareSpy).toHaveBeenCalledTimes(1);
    const [{ message }] = shareSpy.mock.calls[0] as [{ message: string }];
    expect(message).toContain('socket.connection_failed');
    expect(message).not.toContain('non-error-canary');
    expect(message).not.toContain('non-error-meta-canary');
    expect(message).not.toContain('raw-error-canary');
  });

  it('surfaces a share-sheet failure without retaining the native error', async () => {
    entriesSpy.mockReturnValue([errorEntry]);
    shareSpy.mockRejectedValue(new Error('private Android share failure'));
    await renderWithTheme(<LogsScreen />);

    await fireEvent.press(screen.getByRole('button', { name: 'Share errors' }));

    await waitFor(() =>
      expect(mockShowDialog).toHaveBeenCalledWith(
        'App Logs',
        'Gator could not open the share sheet. Please try again.',
      ),
    );
    expect(JSON.stringify(mockShowDialog.mock.calls)).not.toContain(
      'private Android share failure',
    );
  });

  it('surfaces a saved-file clear failure instead of silently claiming success', async () => {
    entriesSpy.mockReturnValue([errorEntry]);
    mockClearLogs.mockResolvedValue(false);
    await renderWithTheme(<LogsScreen />);

    await fireEvent.press(screen.getByRole('button', { name: 'Clear' }));

    await waitFor(() =>
      expect(mockShowDialog).toHaveBeenCalledWith(
        'App Logs',
        expect.stringContaining('could not remove the saved log file'),
      ),
    );
    expect(screen.getByText(/^\[socket\] connection failed/)).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Clear' }).props.accessibilityState).toEqual({
        disabled: false,
        busy: false,
      }),
    );
  });

  it('keeps cleanup remediation visible and confirms the restart step after Clear', async () => {
    mockBootIssues = [cleanupIssue];
    entriesSpy.mockReturnValueOnce([errorEntry]).mockReturnValue([]);
    await renderWithTheme(<LogsScreen />);

    expect(screen.getByRole('alert').props.accessibilityLabel).toContain(
      'Older App Logs could not be verified safely',
    );

    await fireEvent.press(screen.getByRole('button', { name: 'Clear' }));

    await waitFor(() =>
      expect(screen.getByRole('alert').props.accessibilityLabel).toContain(
        'Saved App Logs were removed',
      ),
    );
    expect(screen.getByText('Restart needed')).toBeTruthy();
    expect(screen.getByRole('alert').props.accessibilityLabel).toContain(
      'Fully close and reopen Gator',
    );
  });

  it('preserves the confirmed restart step after the route remounts', async () => {
    mockBootIssues = [cleanupIssue];
    entriesSpy.mockReturnValue([errorEntry]);
    const first = await renderWithTheme(<LogsScreen />);

    await fireEvent.press(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(screen.getByText('Restart needed')).toBeTruthy());

    await first.unmount();
    await renderWithTheme(<LogsScreen />);

    expect(screen.getByText('Restart needed')).toBeTruthy();
    expect(screen.getByRole('alert').props.accessibilityLabel).toContain(
      'Fully close and reopen Gator',
    );
  });

  it('confirms a successful Clear when the cleanup issue appears while Clear is pending', async () => {
    const pending = Promise.withResolvers<boolean>();
    mockClearLogs.mockReturnValue(pending.promise);
    entriesSpy.mockReturnValue([errorEntry]);
    const view = await renderWithTheme(<LogsScreen />);

    await fireEvent.press(screen.getByRole('button', { name: 'Clear' }));
    mockBootIssues = [cleanupIssue];
    await view.rerender(<LogsScreen />);
    expect(screen.getByText('Cleanup needed')).toBeTruthy();

    await act(async () => {
      pending.resolve(true);
      await pending.promise;
    });

    await waitFor(() => expect(screen.getByText('Restart needed')).toBeTruthy());
  });

  it('keeps the cleanup warning unresolved when native Clear rejects', async () => {
    mockBootIssues = [cleanupIssue];
    mockClearLogs.mockRejectedValue(new Error('private native clear failure'));
    entriesSpy.mockReturnValue([errorEntry]);
    await renderWithTheme(<LogsScreen />);

    await fireEvent.press(screen.getByRole('button', { name: 'Clear' }));

    await waitFor(() =>
      expect(mockShowDialog).toHaveBeenCalledWith(
        'App Logs',
        expect.stringContaining('could not remove the saved log file'),
      ),
    );
    expect(screen.getByText('Cleanup needed')).toBeTruthy();
    expect(screen.getByRole('alert').props.accessibilityLabel).toContain('Tap Clear');
    expect(JSON.stringify(mockShowDialog.mock.calls)).not.toContain('private native clear failure');
  });

  it('keeps filters and remediation actions in separate wrapping rows', async () => {
    entriesSpy.mockReturnValue([errorEntry]);
    await renderWithTheme(<LogsScreen />);

    expect(StyleSheet.flatten(screen.getByTestId('log-filter-controls').props.style)).toMatchObject(
      {
        flexDirection: 'row',
        flexWrap: 'wrap',
      },
    );
    expect(StyleSheet.flatten(screen.getByTestId('log-action-controls').props.style)).toMatchObject(
      {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'flex-end',
      },
    );
    expect(
      StyleSheet.flatten(screen.getByRole('button', { name: 'ALL' }).props.style),
    ).toMatchObject({
      minWidth: 48,
      minHeight: 48,
    });
    expect(
      StyleSheet.flatten(screen.getByRole('button', { name: 'Clear' }).props.style),
    ).toMatchObject({
      minWidth: 48,
      minHeight: 48,
    });
  });

  it('keeps actions disabled until native storage confirms Clear', async () => {
    entriesSpy.mockReturnValueOnce([errorEntry]).mockReturnValue([]);
    const pending = Promise.withResolvers<boolean>();
    mockClearLogs.mockReturnValue(pending.promise);
    await renderWithTheme(<LogsScreen />);

    await fireEvent.press(screen.getByRole('button', { name: 'Clear' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Clear' }).props.accessibilityState).toEqual({
        disabled: true,
        busy: true,
      }),
    );
    expect(screen.getByRole('button', { name: 'Share errors' }).props.accessibilityState).toEqual({
      disabled: true,
      busy: false,
    });
    expect(screen.getByText(/^\[socket\] connection failed/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Clear' }));
    expect(mockClearLogs).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(true);
      await pending.promise;
    });
    await waitFor(() => expect(screen.getByText('No log entries yet')).toBeTruthy());
  });

  it('prevents repeated Share or Clear actions while the share sheet is pending', async () => {
    entriesSpy.mockReturnValue([errorEntry]);
    const pending = Promise.withResolvers<{ action: string }>();
    shareSpy.mockReturnValue(pending.promise);
    await renderWithTheme(<LogsScreen />);

    await fireEvent.press(screen.getByRole('button', { name: 'Share errors' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Share errors' }).props.accessibilityState).toEqual(
        { disabled: true, busy: true },
      ),
    );
    expect(screen.getByRole('button', { name: 'Clear' }).props.accessibilityState).toEqual({
      disabled: true,
      busy: false,
    });
    await fireEvent.press(screen.getByRole('button', { name: 'Share errors' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Clear' }));
    expect(shareSpy).toHaveBeenCalledTimes(1);
    expect(mockClearLogs).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve({ action: 'dismissedAction' });
      await pending.promise;
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Share errors' }).props.accessibilityState).toEqual(
        { disabled: false, busy: false },
      ),
    );
  });

  it('renders an unknown label instead of throwing on a corrupt timestamp', async () => {
    entriesSpy.mockReturnValue([{ ...errorEntry, timestamp: 1e300 }]);

    await renderWithTheme(<LogsScreen />);

    expect(screen.getByText(/UNKNOWN TIME/)).toBeTruthy();
  });
});
