import React from 'react';
import { AccessibilityInfo } from 'react-native';
import { act, fireEvent, renderWithTheme, screen, waitFor } from '../support/renderWithTheme';
import type { ThemeTokens } from '@ui/theme/tokens';

const mockBack = jest.fn();
const mockDatabase = {};
const mockListCustomThemes = jest.fn();
const mockGetCustomThemeByIdWithinTransaction = jest.fn();
const mockCreateCustomTheme = jest.fn();
const mockUpdateCustomTheme = jest.fn();
const mockDeleteCustomTheme = jest.fn();
const mockKvGetWithinTransaction = jest.fn();
const mockKvSetWithinTransaction = jest.fn();
const mockIsReduceMotionEnabled = AccessibilityInfo.isReduceMotionEnabled as jest.MockedFunction<
  typeof AccessibilityInfo.isReduceMotionEnabled
>;
const mockAddEventListener = AccessibilityInfo.addEventListener as jest.Mock;
const mockTransactionContext = Object.freeze({ __transactionContext: true });
const mockWithDbTransaction = jest.fn(
  async (
    _db: unknown,
    task: (context: unknown) => Promise<unknown>,
    guard?: () => boolean,
  ): Promise<unknown> => {
    if (guard && !guard()) throw new Error('commit guard rejected before BEGIN');
    const value = await task(mockTransactionContext);
    if (guard && !guard()) throw new Error('commit guard rejected before COMMIT');
    return value;
  },
);

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

jest.mock('@ui', () => {
  const React = jest.requireActual('react') as typeof import('react');
  const { Pressable, Text } = jest.requireActual('react-native') as typeof import('react-native');
  const { gatorTheme } = jest.requireActual('@ui/theme/tokens') as {
    gatorTheme: ThemeTokens;
  };
  return {
    ...jest.requireActual('@ui/theme'),
    ...jest.requireActual('@ui/primitives'),
    ThemeStudio: ({
      onApply,
      onCancel,
      initialName,
      title,
      cancelRequest = 0,
    }: {
      onApply: (tokens: ThemeTokens, name: string) => Promise<void>;
      onCancel: () => void;
      initialName: string;
      title: string;
      cancelRequest?: number;
    }) => {
      const lastCancelRequest = React.useRef(cancelRequest);
      React.useEffect(() => {
        if (cancelRequest === lastCancelRequest.current) return;
        lastCancelRequest.current = cancelRequest;
        onCancel();
      }, [cancelRequest, onCancel]);

      return React.createElement(
        React.Fragment,
        null,
        React.createElement(Text, { testID: 'mock-theme-identity' }, `${title}:${initialName}`),
        React.createElement(
          Pressable,
          {
            accessibilityRole: 'button',
            accessibilityLabel: 'Cancel mock theme',
            onPress: onCancel,
          },
          React.createElement(Text, null, 'Cancel mock theme'),
        ),
        React.createElement(
          Pressable,
          {
            accessibilityRole: 'button',
            accessibilityLabel: 'Save mock theme',
            onPress: () => void onApply(gatorTheme, initialName),
          },
          React.createElement(Text, null, 'Save mock theme'),
        ),
      );
    },
  };
});
jest.mock('expo-router', () => ({ useRouter: () => ({ back: mockBack }) }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@db/repositories', () => ({
  ...jest.requireActual('@db/repositories'),
  listCustomThemes: (...args: unknown[]) => mockListCustomThemes(...args),
  getCustomThemeByIdWithinTransaction: (...args: unknown[]) =>
    mockGetCustomThemeByIdWithinTransaction(...args),
  createCustomThemeWithinTransaction: (...args: unknown[]) => mockCreateCustomTheme(...args),
  updateCustomThemeWithinTransaction: (...args: unknown[]) => mockUpdateCustomTheme(...args),
  deleteCustomThemeWithinTransaction: (...args: unknown[]) => mockDeleteCustomTheme(...args),
  kvGetWithinTransaction: (...args: unknown[]) => mockKvGetWithinTransaction(...args),
  kvSetWithinTransaction: (...args: unknown[]) => mockKvSetWithinTransaction(...args),
}));
jest.mock('@db/transaction', () => ({
  withDbTransaction: (
    db: unknown,
    task: (context: unknown) => Promise<unknown>,
    guard?: () => boolean,
  ) => mockWithDbTransaction(db, task, guard),
}));
jest.mock('@ui/dialog/dialogStore', () => ({ showDialog: jest.fn() }));
jest.mock('@/services/databaseControl', () => ({
  ensureDatabase: jest.fn(async () => mockDatabase),
}));

// eslint-disable-next-line import/first
import ThemesScreen from '../../../app/(app)/themes';
// eslint-disable-next-line import/first
import { showDialog } from '@ui/dialog/dialogStore';
// eslint-disable-next-line import/first
import { gatorTheme } from '@ui/theme/tokens';
// eslint-disable-next-line import/first
import { useThemeStore } from '@state/themeStore';
// eslint-disable-next-line import/first
import { getDatabase } from '@db/database';
// eslint-disable-next-line import/first
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

const mockShowDialog = showDialog as jest.Mock;
const mockGetDatabase = getDatabase as jest.Mock;
let reduceMotionListener: ((enabled: boolean) => void) | undefined;
let removeReduceMotionListener: jest.Mock;
const ROW = {
  id: 7,
  name: 'Account A Theme',
  mode: 'dark',
  tokens: JSON.stringify(gatorTheme),
};

beforeEach(() => {
  resumeRealtimeDeliveries();
  jest.clearAllMocks();
  reduceMotionListener = undefined;
  removeReduceMotionListener = jest.fn();
  mockIsReduceMotionEnabled.mockReset().mockResolvedValue(false);
  mockAddEventListener.mockReset().mockImplementation((event, listener) => {
    expect(event).toBe('reduceMotionChanged');
    reduceMotionListener = listener as (enabled: boolean) => void;
    return { remove: removeReduceMotionListener };
  });
  mockListCustomThemes.mockResolvedValue([ROW]);
  mockGetCustomThemeByIdWithinTransaction.mockResolvedValue(ROW);
  mockCreateCustomTheme.mockResolvedValue(91);
  mockUpdateCustomTheme.mockResolvedValue(undefined);
  mockDeleteCustomTheme.mockResolvedValue(undefined);
  mockKvGetWithinTransaction.mockResolvedValue(null);
  mockKvSetWithinTransaction.mockResolvedValue(undefined);
  mockGetDatabase.mockReturnValue(mockDatabase);
  useThemeStore.setState({ customThemeId: null, customTokens: null });
});

afterEach(() => {
  resumeRealtimeDeliveries();
});

async function settleMotionPreference(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
  expect(mockIsReduceMotionEnabled).toHaveBeenCalledTimes(1);
}

async function emitReduceMotion(enabled: boolean): Promise<void> {
  expect(reduceMotionListener).toBeDefined();
  await act(async () => reduceMotionListener?.(enabled));
}

function editorModal() {
  return screen.getByTestId('global-theme-studio-modal');
}

async function closeEditor(): Promise<void> {
  const onRequestClose = editorModal().props.onRequestClose as () => void;
  await act(async () => onRequestClose());
  await waitFor(() => expect(screen.queryByTestId('global-theme-studio-modal')).toBeNull());
}

describe('ThemesScreen reduced motion', () => {
  it('latches an unresolved opening at none and applies later false only after reopening', async () => {
    const preference = deferred<boolean>();
    mockIsReduceMotionEnabled.mockReturnValue(preference.promise);
    const view = await renderWithTheme(<ThemesScreen />);
    await screen.findByText('Account A Theme');

    await fireEvent.press(screen.getByText('＋'));
    expect(editorModal().props.animationType).toBe('none');

    await act(async () => {
      preference.resolve(false);
      await preference.promise;
    });
    await view.rerender(<ThemesScreen />);
    expect(editorModal().props.animationType).toBe('none');

    await closeEditor();
    await fireEvent.press(screen.getByText('＋'));
    expect(editorModal().props.animationType).toBe('slide');
    expect(mockAddEventListener).toHaveBeenCalledTimes(1);
    expect(mockIsReduceMotionEnabled).toHaveBeenCalledTimes(1);
  });

  it('keeps a visible slide stable across live true and a visible none stable across live false', async () => {
    const view = await renderWithTheme(<ThemesScreen />);
    await screen.findByText('Account A Theme');
    await settleMotionPreference();
    const addText = screen.getByText('＋');
    if (!addText.parent) throw new Error('Expected the add-theme Pressable');
    const retainedNewTheme = retainConfiguredPress(addText.parent);

    await fireEvent.press(screen.getByText('Edit'));
    expect(editorModal().props.animationType).toBe('slide');
    expect(screen.getByTestId('mock-theme-identity').props.children).toBe(
      'Edit Theme:Account A Theme',
    );
    await emitReduceMotion(true);
    await view.rerender(<ThemesScreen />);
    expect(editorModal().props.animationType).toBe('slide');

    // Invoke the exact opener captured before the live setting change. It cannot replace either
    // the motion decision or the edit payload of the already-visible opening.
    await act(async () => retainedNewTheme());
    expect(editorModal().props.animationType).toBe('slide');
    expect(screen.getByTestId('mock-theme-identity').props.children).toBe(
      'Edit Theme:Account A Theme',
    );

    await fireEvent.press(screen.getByRole('button', { name: 'Cancel mock theme' }));
    expect(screen.queryByTestId('global-theme-studio-modal')).toBeNull();
    await fireEvent.press(screen.getByText('Edit'));
    expect(editorModal().props.animationType).toBe('none');

    await emitReduceMotion(false);
    await view.rerender(<ThemesScreen />);
    expect(editorModal().props.animationType).toBe('none');
    await fireEvent.press(screen.getByRole('button', { name: 'Save mock theme' }));
    await waitFor(() => expect(screen.queryByTestId('global-theme-studio-modal')).toBeNull());
    expect(mockUpdateCustomTheme).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByText('Edit'));
    expect(editorModal().props.animationType).toBe('slide');
  });

  it.each([
    ['enabled', true, 'none'],
    ['query failure', new Error('motion preference unavailable'), 'slide'],
  ] as const)('uses the expected opening after initial %s', async (_label, result, expected) => {
    if (result instanceof Error) mockIsReduceMotionEnabled.mockRejectedValue(result);
    else mockIsReduceMotionEnabled.mockResolvedValue(result);
    mockListCustomThemes.mockResolvedValue([]);
    await renderWithTheme(<ThemesScreen />);
    await settleMotionPreference();

    await fireEvent.press(screen.getByText('＋'));
    expect(editorModal().props.animationType).toBe(expected);
  });

  it('lets a synchronous registration event beat a stale query and removes the owner once', async () => {
    const staleQuery = deferred<boolean>();
    mockIsReduceMotionEnabled.mockReturnValue(staleQuery.promise);
    mockAddEventListener.mockImplementation((event, listener) => {
      expect(event).toBe('reduceMotionChanged');
      reduceMotionListener = listener as (enabled: boolean) => void;
      reduceMotionListener(true);
      return { remove: removeReduceMotionListener };
    });
    mockListCustomThemes.mockResolvedValue([]);
    const view = await renderWithTheme(<ThemesScreen />);

    await act(async () => {
      staleQuery.resolve(false);
      await staleQuery.promise;
    });
    await fireEvent.press(screen.getByText('＋'));
    expect(editorModal().props.animationType).toBe('none');

    await closeEditor();
    await emitReduceMotion(false);
    await fireEvent.press(screen.getByText('＋'));
    expect(editorModal().props.animationType).toBe('slide');

    await view.unmount();
    expect(removeReduceMotionListener).toHaveBeenCalledTimes(1);
  });
});

describe('ThemesScreen account ownership', () => {
  it('hides resolved rows and an open editor as soon as the mounted account is retired', async () => {
    const view = await renderWithTheme(<ThemesScreen />);
    expect(await screen.findByText('Account A Theme')).toBeTruthy();
    await fireEvent.press(screen.getByText('Edit'));
    expect(await screen.findByRole('button', { name: 'Save mock theme' })).toBeTruthy();

    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    await view.rerender(<ThemesScreen />);

    expect(screen.queryByText('Account A Theme')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save mock theme' })).toBeNull();
  });

  it('discards a delayed account-A list read instead of rendering it after reconnect', async () => {
    const oldRows = deferred<(typeof ROW)[]>();
    mockListCustomThemes.mockReset().mockReturnValueOnce(oldRows.promise);
    await renderWithTheme(<ThemesScreen />);
    await waitFor(() => expect(mockListCustomThemes).toHaveBeenCalledTimes(1));

    let pauseFinished = false;
    const pause = pauseRealtimeDeliveries().then(() => {
      pauseFinished = true;
    });
    await act(async () => {
      await Promise.resolve();
    });
    // The short DB read was admitted before Disconnect, so teardown drains it.
    expect(pauseFinished).toBe(false);

    await act(async () => {
      oldRows.resolve([ROW]);
      await oldRows.promise;
      await pause;
    });
    resumeRealtimeDeliveries();

    expect(screen.queryByText('Account A Theme')).toBeNull();
  });

  it('makes a retained delete-confirmation callback inert after the screen account is retired', async () => {
    await renderWithTheme(<ThemesScreen />);
    expect(await screen.findByText('Account A Theme')).toBeTruthy();

    await fireEvent.press(screen.getByText('Delete'));
    const buttons = mockShowDialog.mock.calls[0]?.[2] as
      Array<{ text: string; onPress?: () => void | Promise<void> }> | undefined;
    const confirm = buttons?.find((button) => button.text === 'Delete')?.onPress;
    expect(confirm).toBeDefined();

    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    await act(async () => {
      await confirm?.();
    });

    expect(mockDeleteCustomTheme).not.toHaveBeenCalled();
    expect(mockWithDbTransaction).not.toHaveBeenCalled();
  });

  it('does not let an old edit Modal update a same-id row in account B', async () => {
    await renderWithTheme(<ThemesScreen />);
    expect(await screen.findByText('Account A Theme')).toBeTruthy();
    await fireEvent.press(screen.getByText('Edit'));
    expect(await screen.findByRole('button', { name: 'Save mock theme' })).toBeTruthy();

    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    await fireEvent.press(await screen.findByRole('button', { name: 'Save mock theme' }));

    expect(mockUpdateCustomTheme).not.toHaveBeenCalled();
    expect(mockCreateCustomTheme).not.toHaveBeenCalled();
    expect(useThemeStore.getState().customThemeId).toBeNull();
  });

  it('rolls an admitted create toward the old account and never applies its tokens after revocation', async () => {
    const create = deferred<number>();
    mockCreateCustomTheme.mockReset().mockReturnValueOnce(create.promise);
    mockListCustomThemes.mockResolvedValue([]);
    await renderWithTheme(<ThemesScreen />);
    await waitFor(() => expect(mockListCustomThemes).toHaveBeenCalledTimes(1));
    await fireEvent.press(screen.getByText('＋'));
    const save = await screen.findByRole('button', { name: 'Save mock theme' });
    await fireEvent.press(save);
    await waitFor(() => expect(mockCreateCustomTheme).toHaveBeenCalledTimes(1));

    let pauseFinished = false;
    const pause = pauseRealtimeDeliveries().then(() => {
      pauseFinished = true;
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(pauseFinished).toBe(false);

    await act(async () => {
      create.resolve(91);
      await create.promise;
      await pause;
    });
    resumeRealtimeDeliveries();

    // Revocation is observed immediately after the awaited create, so the transaction never starts
    // its second write and its guard rejects the COMMIT. No stale Zustand theme reaches account B.
    expect(mockKvSetWithinTransaction).not.toHaveBeenCalled();
    const guard = mockWithDbTransaction.mock.calls[0]?.[2] as (() => boolean) | undefined;
    expect(guard?.()).toBe(false);
    expect(useThemeStore.getState()).toMatchObject({
      customThemeId: null,
      customTokens: null,
    });
  });

  it('re-reads and durably selects a current custom-theme row before applying it in memory', async () => {
    await renderWithTheme(<ThemesScreen />);
    await fireEvent.press(await screen.findByText('Account A Theme'));

    await waitFor(() =>
      expect(mockKvSetWithinTransaction).toHaveBeenCalledWith(
        mockTransactionContext,
        'theme.custom',
        '7',
      ),
    );
    expect(mockGetCustomThemeByIdWithinTransaction).toHaveBeenCalledWith(mockTransactionContext, 7);
    expect(useThemeStore.getState()).toMatchObject({
      customThemeId: 7,
      customTokens: gatorTheme,
    });
  });

  it('clears a deleted persisted pointer without overwriting a newer in-memory theme', async () => {
    mockKvGetWithinTransaction.mockResolvedValue('7');
    await renderWithTheme(<ThemesScreen />);
    const deleteButton = await screen.findByText('Delete');
    await act(async () => {
      useThemeStore.setState({ customThemeId: 8, customTokens: gatorTheme });
    });
    await fireEvent.press(deleteButton);
    const buttons = mockShowDialog.mock.calls[0]?.[2] as
      Array<{ text: string; onPress?: () => void | Promise<void> }> | undefined;

    await act(async () => {
      await buttons?.find((button) => button.text === 'Delete')?.onPress?.();
    });
    await waitFor(() =>
      expect(mockDeleteCustomTheme).toHaveBeenCalledWith(mockTransactionContext, 7),
    );
    await waitFor(() => expect(mockListCustomThemes).toHaveBeenCalledTimes(2));

    expect(mockKvGetWithinTransaction).toHaveBeenCalledWith(mockTransactionContext, 'theme.custom');
    expect(mockKvSetWithinTransaction).toHaveBeenCalledWith(
      mockTransactionContext,
      'theme.custom',
      '',
    );
    expect(useThemeStore.getState()).toMatchObject({
      customThemeId: 8,
      customTokens: gatorTheme,
    });
  });

  it('preserves a different persisted pointer while clearing deleted in-memory state', async () => {
    mockKvGetWithinTransaction.mockResolvedValue('8');
    await renderWithTheme(<ThemesScreen />);
    const deleteButton = await screen.findByText('Delete');
    await act(async () => {
      useThemeStore.setState({ customThemeId: 7, customTokens: gatorTheme });
    });
    await fireEvent.press(deleteButton);
    const buttons = mockShowDialog.mock.calls[0]?.[2] as
      Array<{ text: string; onPress?: () => void | Promise<void> }> | undefined;

    await act(async () => {
      await buttons?.find((button) => button.text === 'Delete')?.onPress?.();
    });
    await waitFor(() =>
      expect(mockDeleteCustomTheme).toHaveBeenCalledWith(mockTransactionContext, 7),
    );
    await waitFor(() => expect(mockListCustomThemes).toHaveBeenCalledTimes(2));

    expect(mockKvSetWithinTransaction).not.toHaveBeenCalled();
    expect(useThemeStore.getState()).toMatchObject({
      customThemeId: null,
      customTokens: null,
    });
  });

  it('durably reverts to the built-in preset before clearing in-memory custom tokens', async () => {
    await renderWithTheme(<ThemesScreen />);
    await screen.findByText('Account A Theme');
    await act(async () => {
      useThemeStore.setState({ customThemeId: 7, customTokens: gatorTheme });
    });
    const revert = await screen.findByText('Revert to built-in preset');

    await fireEvent.press(revert);
    await waitFor(() =>
      expect(mockKvSetWithinTransaction).toHaveBeenCalledWith(
        mockTransactionContext,
        'theme.custom',
        '',
      ),
    );
    expect(useThemeStore.getState()).toMatchObject({
      customThemeId: null,
      customTokens: null,
    });
  });
});
