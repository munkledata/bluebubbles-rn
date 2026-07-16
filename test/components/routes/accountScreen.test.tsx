/**
 * AccountScreen route (app/(app)/account.tsx): the iMessage account + alias picker,
 * backed by TanStack Query (['server','icloud-account']).
 *
 * Locks in the query wiring:
 *   - the resolved account query renders the Apple ID / name / alias rows;
 *   - a failed query shows the error state, and "Try again" refetches into success;
 *   - picking an alias calls setActiveAlias and moves the checkmark via the query cache;
 *   - a non-vetted alias is disabled (never calls setActiveAlias);
 *   - a failed alias change surfaces the Account dialog and keeps the old selection.
 *
 * Each test gets a FRESH QueryClient (retry off so errors surface immediately; gcTime
 * Infinity so no GC timers linger past the test).
 */
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  renderWithTheme,
  screen,
  fireEvent,
  waitFor,
  act,
  within,
} from '../support/renderWithTheme';

const mockPush = jest.fn();
const mockBack = jest.fn();

// The full `@ui` barrel drags in the conversation/attachment tree (expo-video/expo-image/ky —
// native/ESM modules jest-expo can't load). The screen only needs `Screen` + `useTheme`.
jest.mock('@ui', () => ({
  ...jest.requireActual('@ui/theme'),
  ...jest.requireActual('@ui/primitives'),
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush, back: mockBack }) }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@/services', () => ({ http: {} }));
// Keep the real module shape (schemas); replace only the calls the screen makes.
jest.mock('@core/api/endpoints/icloud', () => ({
  ...jest.requireActual('@core/api/endpoints/icloud'),
  getAccountInfo: jest.fn(),
  setActiveAlias: jest.fn(),
}));

// eslint-disable-next-line import/first
import AccountScreen from '../../../app/(app)/account';
// eslint-disable-next-line import/first
import * as icloudApi from '@core/api/endpoints/icloud';
// eslint-disable-next-line import/first
import { useDialogStore } from '@ui/dialog/dialogStore';

const mockGetAccountInfo = icloudApi.getAccountInfo as jest.Mock;
const mockSetActiveAlias = icloudApi.setActiveAlias as jest.Mock;

const ACCOUNT = {
  appleId: 'user@icloud.com',
  displayName: 'Gator User',
  activeAlias: 'a@icloud.com',
  aliases: ['a@icloud.com', 'b@icloud.com'],
  vettedAliases: null,
  loginStatusMessage: null,
};

async function renderScreen(): Promise<void> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  await renderWithTheme(
    <QueryClientProvider client={client}>
      <AccountScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  useDialogStore.setState({ current: null, queue: [] });
  mockGetAccountInfo.mockResolvedValue(ACCOUNT);
  mockSetActiveAlias.mockResolvedValue({ activeAlias: 'b@icloud.com' });
});

describe('AccountScreen — account query', () => {
  it('renders the account rows and marks the active alias once the query resolves', async () => {
    await renderScreen();
    expect(await screen.findByText('user@icloud.com')).toBeTruthy();
    expect(screen.getByText('Gator User')).toBeTruthy();
    const activeRow = screen.getByRole('button', { name: /a@icloud\.com/ });
    expect(within(activeRow).getByText('✓')).toBeTruthy();
    expect(
      within(screen.getByRole('button', { name: /b@icloud\.com/ })).queryByText('✓'),
    ).toBeNull();
  });

  it('shows the error state, and Try again refetches into success', async () => {
    mockGetAccountInfo.mockRejectedValueOnce(new Error('helper down'));
    await renderScreen();
    expect(await screen.findByText(/Couldn.t load your account/)).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByText('Try again'));
    });
    expect(await screen.findByText('user@icloud.com')).toBeTruthy();
    expect(mockGetAccountInfo).toHaveBeenCalledTimes(2);
  });
});

describe('AccountScreen — alias picker', () => {
  it('picking an alias calls setActiveAlias and moves the checkmark via the query cache', async () => {
    await renderScreen();
    await screen.findByText('user@icloud.com');
    await act(async () => {
      fireEvent.press(screen.getByText('b@icloud.com'));
    });
    await waitFor(() =>
      expect(mockSetActiveAlias).toHaveBeenCalledWith(expect.anything(), 'b@icloud.com'),
    );
    await waitFor(() =>
      expect(
        within(screen.getByRole('button', { name: /b@icloud\.com/ })).getByText('✓'),
      ).toBeTruthy(),
    );
    expect(
      within(screen.getByRole('button', { name: /a@icloud\.com/ })).queryByText('✓'),
    ).toBeNull();
  });

  it('a non-vetted alias is disabled and never calls setActiveAlias', async () => {
    mockGetAccountInfo.mockResolvedValue({ ...ACCOUNT, vettedAliases: ['a@icloud.com'] });
    await renderScreen();
    await screen.findByText('user@icloud.com');
    await act(async () => {
      fireEvent.press(screen.getByText('b@icloud.com'));
    });
    expect(mockSetActiveAlias).not.toHaveBeenCalled();
  });

  it('a failed alias change shows the Account dialog and keeps the old selection', async () => {
    mockSetActiveAlias.mockRejectedValue(new Error('not enabled'));
    await renderScreen();
    await screen.findByText('user@icloud.com');
    await act(async () => {
      fireEvent.press(screen.getByText('b@icloud.com'));
    });
    await waitFor(() => expect(useDialogStore.getState().current?.title).toBe('Account'));
    expect(
      within(screen.getByRole('button', { name: /a@icloud\.com/ })).getByText('✓'),
    ).toBeTruthy();
    expect(
      within(screen.getByRole('button', { name: /b@icloud\.com/ })).queryByText('✓'),
    ).toBeNull();
  });
});
