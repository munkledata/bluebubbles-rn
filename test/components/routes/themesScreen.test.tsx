import React from 'react';
import { act, fireEvent, renderWithTheme, screen, waitFor } from '../support/renderWithTheme';
import type { ThemeTokens } from '@ui/theme/tokens';

const mockBack = jest.fn();
const mockDatabase = {};
const mockListCustomThemes = jest.fn();
const mockGetCustomThemeById = jest.fn();
const mockCreateCustomTheme = jest.fn();
const mockUpdateCustomTheme = jest.fn();
const mockDeleteCustomTheme = jest.fn();
const mockKvGet = jest.fn();
const mockKvSetWithinTransaction = jest.fn();
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
      initialName,
    }: {
      onApply: (tokens: ThemeTokens, name: string) => Promise<void>;
      initialName: string;
    }) =>
      React.createElement(
        Pressable,
        {
          accessibilityRole: 'button',
          accessibilityLabel: 'Save mock theme',
          onPress: () => void onApply(gatorTheme, initialName),
        },
        React.createElement(Text, null, 'Save mock theme'),
      ),
  };
});
jest.mock('expo-router', () => ({ useRouter: () => ({ back: mockBack }) }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@db/repositories', () => ({
  ...jest.requireActual('@db/repositories'),
  listCustomThemes: (...args: unknown[]) => mockListCustomThemes(...args),
  getCustomThemeById: (...args: unknown[]) => mockGetCustomThemeById(...args),
  createCustomThemeWithinTransaction: (...args: unknown[]) => mockCreateCustomTheme(...args),
  updateCustomThemeWithinTransaction: (...args: unknown[]) => mockUpdateCustomTheme(...args),
  deleteCustomThemeWithinTransaction: (...args: unknown[]) => mockDeleteCustomTheme(...args),
  kvGet: (...args: unknown[]) => mockKvGet(...args),
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
const ROW = {
  id: 7,
  name: 'Account A Theme',
  mode: 'dark',
  tokens: JSON.stringify(gatorTheme),
};

beforeEach(() => {
  resumeRealtimeDeliveries();
  jest.clearAllMocks();
  mockListCustomThemes.mockResolvedValue([ROW]);
  mockGetCustomThemeById.mockResolvedValue(ROW);
  mockCreateCustomTheme.mockResolvedValue(91);
  mockUpdateCustomTheme.mockResolvedValue(undefined);
  mockDeleteCustomTheme.mockResolvedValue(undefined);
  mockKvGet.mockResolvedValue(null);
  mockKvSetWithinTransaction.mockResolvedValue(undefined);
  mockGetDatabase.mockReturnValue(mockDatabase);
  useThemeStore.setState({ customThemeId: null, customTokens: null });
});

afterEach(() => {
  resumeRealtimeDeliveries();
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

    // The transaction callback reached its second statement, but the guard rejected the COMMIT.
    // Real withDbTransaction rolls this whole unit back; most importantly, no stale Zustand theme
    // is published into the replacement account.
    expect(mockKvSetWithinTransaction).toHaveBeenCalledWith(
      mockTransactionContext,
      'theme.custom',
      '91',
    );
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
    expect(mockGetCustomThemeById).toHaveBeenCalledWith(mockDatabase, 7);
    expect(useThemeStore.getState()).toMatchObject({
      customThemeId: 7,
      customTokens: gatorTheme,
    });
  });

  it('clears a deleted persisted pointer without overwriting a newer in-memory theme', async () => {
    mockKvGet.mockResolvedValue('7');
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

    expect(mockKvGet).toHaveBeenCalledWith(mockDatabase, 'theme.custom');
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
    mockKvGet.mockResolvedValue('8');
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
