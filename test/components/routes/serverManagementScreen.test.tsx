/**
 * ServerManagementScreen route (app/(app)/server-management.tsx): the STATUS/STATISTICS
 * sections are now TanStack Query-backed (ping → ['server','ping'], stats → ['server','stats'],
 * server info → ['server','info']).
 *
 * Locks in the query wiring:
 *   - a resolved ping renders "Reachable · N ms"; a rejected one renders "Unreachable";
 *   - stats numbers render from the stats query; total failure shows the INLINE error row,
 *     and "Refresh Statistics" refetches (clearing the error on success);
 *   - the server-info query populates the session store (version/macOS/private-API rows).
 *
 * Each test gets a FRESH QueryClient (retry off; gcTime Infinity so no GC timers linger).
 */
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithTheme, screen, fireEvent, waitFor, act } from '../support/renderWithTheme';

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
jest.mock('@/services', () => ({ http: {}, startSync: jest.fn() }));
// The screen imports `serverApi` from the `@core/api` barrel, whose HttpClient re-export pulls
// in `ky` (ESM-only — jest-expo doesn't transform it). Never called here (`http` is mocked).
jest.mock('ky', () => ({ __esModule: true, default: jest.fn() }));
// Keep the real module shape (schemas/constants); replace only the calls the screen makes.
jest.mock('@core/api/endpoints/server', () => ({
  ...jest.requireActual('@core/api/endpoints/server'),
  ping: jest.fn(),
  serverStatTotals: jest.fn(),
  serverInfo: jest.fn(),
}));

// eslint-disable-next-line import/first
import ServerManagementScreen from '../../../app/(app)/server-management';
// eslint-disable-next-line import/first
import { serverApi } from '@core/api';
// eslint-disable-next-line import/first
import { useSessionStore } from '@state/sessionStore';
// eslint-disable-next-line import/first
import { useSyncStore } from '@state/syncStore';
// eslint-disable-next-line import/first
import { useDialogStore } from '@ui/dialog/dialogStore';

const mockPing = serverApi.ping as jest.Mock;
const mockStats = serverApi.serverStatTotals as jest.Mock;
const mockInfo = serverApi.serverInfo as jest.Mock;

// All below 1,000 so `toLocaleString()` output is locale-proof.
const TOTALS = {
  messages: 42,
  chats: 7,
  handles: 3,
  attachments: 5,
  images: 6,
  videos: 2,
  locations: 1,
};

async function renderScreen(): Promise<void> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  await renderWithTheme(
    <QueryClientProvider client={client}>
      <ServerManagementScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  useSessionStore.setState({ origin: 'https://gator.example', serverInfo: null });
  useSyncStore.setState({ status: 'idle', chats: 0, messages: 0, error: null });
  useDialogStore.setState({ current: null, queue: [] });
  mockPing.mockResolvedValue({ pong: true });
  mockStats.mockResolvedValue(TOTALS);
  mockInfo.mockResolvedValue({
    server_version: '9.9.9',
    os_version: '26.0',
    private_api: true,
    proxy_service: 'zrok',
  });
});

describe('ServerManagementScreen — status queries', () => {
  it('shows Reachable + latency once the ping resolves', async () => {
    await renderScreen();
    expect(await screen.findByText(/Reachable · \d+ ms/)).toBeTruthy();
  });

  it('shows Unreachable when the ping fails', async () => {
    mockPing.mockRejectedValue(new Error('down'));
    await renderScreen();
    expect(await screen.findByText('Unreachable')).toBeTruthy();
  });

  it('populates the session store (and STATUS rows) from the server-info query', async () => {
    await renderScreen();
    expect(await screen.findByText('9.9.9')).toBeTruthy();
    expect(screen.getByText('26.0')).toBeTruthy();
    expect(screen.getByText('Enabled')).toBeTruthy();
    await waitFor(() =>
      expect(useSessionStore.getState().serverInfo?.server_version).toBe('9.9.9'),
    );
  });
});

describe('ServerManagementScreen — statistics query', () => {
  it('renders the stat totals', async () => {
    await renderScreen();
    expect(await screen.findByText('42')).toBeTruthy(); // messages
    expect(screen.getByText('7')).toBeTruthy(); // chats
  });

  it('shows the inline error on total failure and recovers via Refresh Statistics', async () => {
    mockStats.mockRejectedValueOnce(new Error('Server statistics unavailable'));
    await renderScreen();
    expect(await screen.findByText(/Couldn.t load statistics/)).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByText('Refresh Statistics'));
    });
    expect(await screen.findByText('42')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/Couldn.t load statistics/)).toBeNull());
    expect(mockStats).toHaveBeenCalledTimes(2);
  });
});
