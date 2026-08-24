/**
 * AccountScreen route (app/(app)/account.tsx): the iMessage account + alias picker,
 * backed by a generation-scoped TanStack Query key (['server','icloud-account',generation]).
 *
 * Locks in the query wiring:
 *   - the resolved account query renders the Apple ID / name / alias rows;
 *   - a failed query shows the error state, and "Try again" refetches into success;
 *   - picking an alias calls setActiveAlias and moves the checkmark via the query cache;
 *   - a non-vetted alias is disabled (never calls setActiveAlias);
 *   - a failed alias change surfaces the Account dialog, clears its saving state, and can retry;
 *   - account generations keep separate query-cache entries and stale callbacks cannot cross them.
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
// eslint-disable-next-line import/first
import { ApiError, UnimplementedEndpointError } from '@core/api/errors';
// eslint-disable-next-line import/first
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

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

const OTHER_ACCOUNT = {
  ...ACCOUNT,
  appleId: 'next@icloud.com',
  displayName: 'Next User',
  activeAlias: 'next@icloud.com',
  aliases: ['next@icloud.com'],
};

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

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
}

async function renderScreen(client = makeQueryClient()) {
  const view = await renderWithTheme(
    <QueryClientProvider client={client}>
      <AccountScreen />
    </QueryClientProvider>,
  );
  return { client, view };
}

beforeEach(() => {
  resumeRealtimeDeliveries();
  jest.clearAllMocks();
  useDialogStore.setState({ current: null, queue: [] });
  mockGetAccountInfo.mockResolvedValue(ACCOUNT);
  mockSetActiveAlias.mockResolvedValue({ activeAlias: 'b@icloud.com' });
});

afterEach(() => {
  resumeRealtimeDeliveries();
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

  it('retires already-resolved account details when their generation is revoked', async () => {
    await renderScreen();
    expect(await screen.findByText('user@icloud.com')).toBeTruthy();

    await act(async () => {
      await pauseRealtimeDeliveries();
    });

    expect(screen.queryByText('user@icloud.com')).toBeNull();
    expect(screen.queryByText('Gator User')).toBeNull();
    expect(screen.queryByText('Apple ID')).toBeNull();
  });

  it('goes back from the header', async () => {
    await renderScreen();
    await screen.findByText('user@icloud.com');
    await act(async () => {
      fireEvent.press(screen.getByText('‹ Back'));
    });
    expect(mockBack).toHaveBeenCalledTimes(1);
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

  it('a 404 (Unimplemented) is the calm "unsupported" state, not an error', async () => {
    // getAccountInfo remaps the server's 404 → UnimplementedEndpointError; the screen must route
    // that to `status: 'unsupported'` — a distinct branch from 'error'. Nothing is broken, so the
    // copy must NOT blame the connection and must NOT offer a retry that can only 404 again.
    mockGetAccountInfo.mockRejectedValueOnce(new UnimplementedEndpointError('/icloud/account'));
    await renderScreen();
    // Awaiting this first means the branch's commit has already happened — so the two absence
    // checks below read that same commit and are not vacuous.
    expect(await screen.findByText(/doesn.t provide iMessage account details yet/)).toBeTruthy();
    expect(screen.queryByText(/Couldn.t load your account/)).toBeNull();
    expect(screen.queryByText(/Private API helper on your Mac may be off/)).toBeNull();
    expect(screen.queryByText('Try again')).toBeNull();
    // The 'ready' rows must not render either (no account data was fetched).
    expect(screen.queryByText('Apple ID')).toBeNull();
  });

  it('a 500 blames the Private API helper, not the connection (helper-off case)', async () => {
    mockGetAccountInfo.mockRejectedValueOnce(new ApiError('server_error', 'Server error', 500));
    await renderScreen();
    expect(await screen.findByText(/Private API helper on your Mac may be off/)).toBeTruthy();
    // Still recoverable the same way.
    expect(screen.getByText('Try again')).toBeTruthy();
  });

  it('discards a delayed old-account GET before the next account reads the cache', async () => {
    const oldResponse = deferred<typeof ACCOUNT>();
    mockGetAccountInfo.mockReset().mockReturnValueOnce(oldResponse.promise);
    const client = makeQueryClient();
    const { view } = await renderScreen(client);
    await waitFor(() => expect(mockGetAccountInfo).toHaveBeenCalledTimes(1));

    // A read has no durable side effect, so it must not make Disconnect wait. The captured
    // generation and cache key are what make its eventual completion safe.
    await act(async () => {
      await pauseRealtimeDeliveries();
    });
    resumeRealtimeDeliveries();

    await act(async () => {
      oldResponse.resolve(ACCOUNT);
    });
    await waitFor(() => expect(client.getQueryCache().getAll()[0]?.state.status).toBe('success'));
    expect(screen.queryByText('user@icloud.com')).toBeNull();
    expect(
      client
        .getQueryCache()
        .getAll()
        .some((query) => query.state.data === ACCOUNT),
    ).toBe(false);

    await view.unmount();
    mockGetAccountInfo.mockResolvedValueOnce(OTHER_ACCOUNT);
    await renderScreen(client);

    expect(await screen.findByText('Next User')).toBeTruthy();
    expect(screen.getAllByText('next@icloud.com')).toHaveLength(2);
    expect(screen.queryByText('user@icloud.com')).toBeNull();
    const accountQueryKeys = client
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey);
    expect(accountQueryKeys).toHaveLength(2);
    expect(accountQueryKeys.map((key) => key.slice(0, 2))).toEqual([
      ['server', 'icloud-account'],
      ['server', 'icloud-account'],
    ]);
    expect(new Set(accountQueryKeys.map((key) => key[2])).size).toBe(2);
  });

  it('does not surface a delayed old-account GET error after reconnect', async () => {
    const oldResponse = deferred<typeof ACCOUNT>();
    mockGetAccountInfo.mockReset().mockReturnValueOnce(oldResponse.promise);
    const client = makeQueryClient();
    const { view } = await renderScreen(client);
    await waitFor(() => expect(mockGetAccountInfo).toHaveBeenCalledTimes(1));

    await act(async () => {
      await pauseRealtimeDeliveries();
    });
    resumeRealtimeDeliveries();
    await act(async () => {
      oldResponse.reject(new Error('old account helper failed'));
    });
    await waitFor(() => expect(client.getQueryCache().getAll()[0]?.state.status).toBe('success'));
    await view.unmount();

    mockGetAccountInfo.mockResolvedValueOnce(OTHER_ACCOUNT);
    await renderScreen(client);
    expect(await screen.findByText('Next User')).toBeTruthy();
    expect(screen.getAllByText('next@icloud.com')).toHaveLength(2);
    expect(screen.queryByText(/Couldn.t load your account/)).toBeNull();
    expect(screen.queryByText(/Private API helper on your Mac may be off/)).toBeNull();
    const accountQueryKeys = client
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey);
    expect(accountQueryKeys).toHaveLength(2);
    expect(accountQueryKeys.map((key) => key.slice(0, 2))).toEqual([
      ['server', 'icloud-account'],
      ['server', 'icloud-account'],
    ]);
    expect(new Set(accountQueryKeys.map((key) => key[2])).size).toBe(2);
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

  it('a failed alias change keeps the old selection and clears saving for a retry', async () => {
    mockSetActiveAlias.mockRejectedValueOnce(new Error('not enabled'));
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

    useDialogStore.setState({ current: null, queue: [] });
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /b@icloud\.com/ }).props.accessibilityState,
      ).toEqual(expect.objectContaining({ disabled: false })),
    );
    await act(async () => {
      fireEvent.press(screen.getByText('b@icloud.com'));
    });
    await waitFor(() => expect(mockSetActiveAlias).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        within(screen.getByRole('button', { name: /b@icloud\.com/ })).getByText('✓'),
      ).toBeTruthy(),
    );
    expect(useDialogStore.getState().current).toBeNull();
  });

  it('holds Disconnect for an accepted alias POST and disowns its late response', async () => {
    const response = deferred<{ activeAlias: string }>();
    mockSetActiveAlias.mockReturnValueOnce(response.promise);
    const { client, view } = await renderScreen();
    await screen.findByText('user@icloud.com');

    fireEvent.press(screen.getByText('b@icloud.com'));
    await waitFor(() => expect(mockSetActiveAlias).toHaveBeenCalledTimes(1));
    let drained = false;
    const drain = pauseRealtimeDeliveries().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    await act(async () => {
      response.resolve({ activeAlias: 'b@icloud.com' });
      await drain;
    });
    expect(useDialogStore.getState().current).toBeNull();
    expect(
      client
        .getQueryCache()
        .getAll()
        .map((query) => query.state.data)
        .filter(Boolean),
    ).toContainEqual(ACCOUNT);
    expect(
      client
        .getQueryCache()
        .getAll()
        .map((query) => query.state.data)
        .filter(Boolean),
    ).not.toContainEqual({ ...ACCOUNT, activeAlias: 'b@icloud.com' });

    resumeRealtimeDeliveries();
    await view.unmount();
    mockGetAccountInfo.mockResolvedValueOnce(OTHER_ACCOUNT);
    await renderScreen(client);
    expect(await screen.findByText('Next User')).toBeTruthy();
    expect(
      within(screen.getByRole('button', { name: /next@icloud\.com/ })).getByText('✓'),
    ).toBeTruthy();
  });

  it('does not POST when an old screen callback is pressed after reconnect', async () => {
    await renderScreen();
    await screen.findByText('user@icloud.com');
    const oldAliasRow = screen.getByRole('button', { name: /b@icloud\.com/ });

    await act(async () => {
      await pauseRealtimeDeliveries();
    });
    resumeRealtimeDeliveries();
    fireEvent.press(oldAliasRow);

    expect(mockSetActiveAlias).not.toHaveBeenCalled();
    expect(useDialogStore.getState().current).toBeNull();
  });

  it('suppresses an old alias error that arrives during Disconnect', async () => {
    const response = deferred<{ activeAlias: string }>();
    mockSetActiveAlias.mockReturnValueOnce(response.promise);
    await renderScreen();
    await screen.findByText('user@icloud.com');

    fireEvent.press(screen.getByText('b@icloud.com'));
    await waitFor(() => expect(mockSetActiveAlias).toHaveBeenCalledTimes(1));
    const drain = pauseRealtimeDeliveries();
    await act(async () => {
      response.reject(new Error('old account helper failed'));
      await drain;
    });
    resumeRealtimeDeliveries();

    expect(useDialogStore.getState().current).toBeNull();
  });
});
