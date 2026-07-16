/**
 * ServerHealthScreen route (app/(app)/server-health.tsx): the read-only diagnostics screen,
 * now backed by TanStack Query (`useQueries` — one query per health channel under the
 * ['server','health',…] key namespace).
 *
 * Locks in the query wiring, not the copy:
 *   - each resolved channel fills its card; a rejected one degrades to "—" without
 *     blocking the rest;
 *   - EVERY channel failing shows the "server isn't responding" banner;
 *   - the header Refresh invalidates the ['server','health'] prefix → every channel refetches;
 *   - Clear Alerts calls the endpoint and empties the alerts card via the query cache.
 *
 * Each test gets a FRESH QueryClient (retry off so errors surface immediately; gcTime
 * Infinity so no GC timers linger past the test).
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
jest.mock('@/services', () => ({ http: {} }));
// The screen imports `serverApi` from the `@core/api` barrel, whose HttpClient re-export pulls
// in `ky` (ESM-only — jest-expo doesn't transform it). Never called here (`http` is mocked).
jest.mock('ky', () => ({ __esModule: true, default: jest.fn() }));
// Keep the real module shape (schemas/constants); replace only the health-channel calls.
jest.mock('@core/api/endpoints/server', () => ({
  ...jest.requireActual('@core/api/endpoints/server'),
  privateApiStatus: jest.fn(),
  serverEnv: jest.fn(),
  findMyKeysStatus: jest.fn(),
  fcmStatus: jest.fn(),
  zrokStatus: jest.fn(),
  publicIp: jest.fn(),
  tlsStatus: jest.fn(),
  adminStatus: jest.fn(),
  serverAlerts: jest.fn(),
  rcsStatus: jest.fn(),
  clearServerAlerts: jest.fn(),
}));

// eslint-disable-next-line import/first
import ServerHealthScreen from '../../../app/(app)/server-health';
// eslint-disable-next-line import/first
import { serverApi } from '@core/api';
// eslint-disable-next-line import/first
import { useSessionStore } from '@state/sessionStore';
// eslint-disable-next-line import/first
import { useRcsHealthStore } from '@state/rcsHealthStore';

const mocks = {
  privateApiStatus: serverApi.privateApiStatus as jest.Mock,
  serverEnv: serverApi.serverEnv as jest.Mock,
  findMyKeysStatus: serverApi.findMyKeysStatus as jest.Mock,
  fcmStatus: serverApi.fcmStatus as jest.Mock,
  zrokStatus: serverApi.zrokStatus as jest.Mock,
  publicIp: serverApi.publicIp as jest.Mock,
  tlsStatus: serverApi.tlsStatus as jest.Mock,
  adminStatus: serverApi.adminStatus as jest.Mock,
  serverAlerts: serverApi.serverAlerts as jest.Mock,
  rcsStatus: serverApi.rcsStatus as jest.Mock,
  clearServerAlerts: serverApi.clearServerAlerts as jest.Mock,
};

function resolveAllChannels(): void {
  mocks.privateApiStatus.mockResolvedValue({
    connected: true,
    enabled: true,
    ft_connected: false,
    ft_enabled: true,
  });
  mocks.serverEnv.mockResolvedValue({ version: '1.9.9', node: 'v20.1.0' });
  mocks.findMyKeysStatus.mockResolvedValue({ LocalStorage: { present: true, valid: true } });
  mocks.fcmStatus.mockResolvedValue({ configured: true, projectId: 'proj-x' });
  mocks.zrokStatus.mockResolvedValue({ running: true, url: 'https://tunnel.example' });
  mocks.publicIp.mockResolvedValue('203.0.113.9');
  mocks.tlsStatus.mockResolvedValue({ mode: 'auto', domain: 'gator.example' });
  mocks.adminStatus.mockResolvedValue({ uptimeMs: 90_061_000 }); // 1d 1h 1m
  mocks.serverAlerts.mockResolvedValue([]);
  mocks.rcsStatus.mockResolvedValue(null);
  mocks.clearServerAlerts.mockResolvedValue(undefined);
}

async function renderScreen(): Promise<void> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  await renderWithTheme(
    <QueryClientProvider client={client}>
      <ServerHealthScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  useSessionStore.setState({ serverInfo: null });
  useRcsHealthStore.setState({ lastAlertType: null, lastAlertAt: null });
  resolveAllChannels();
});

describe('ServerHealthScreen — query-backed cards', () => {
  it('fills each card as its channel resolves', async () => {
    await renderScreen();
    expect(await screen.findByText('proj-x')).toBeTruthy();
    expect(screen.getByText('Connected')).toBeTruthy(); // Messages helper
    expect(screen.getByText('Not connected')).toBeTruthy(); // FaceTime helper
    expect(screen.getByText('1.9.9')).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.getByText('https://tunnel.example')).toBeTruthy();
    expect(screen.getByText('203.0.113.9')).toBeTruthy();
    expect(screen.getByText('1d 1h')).toBeTruthy();
    expect(screen.getByText('Imported ✓')).toBeTruthy();
    expect(screen.queryByText(/isn.t responding to health checks/)).toBeNull();
  });

  it('degrades one failed channel to "—" without hiding the rest', async () => {
    mocks.publicIp.mockRejectedValue(new Error('nope'));
    await renderScreen();
    expect(await screen.findByText('proj-x')).toBeTruthy();
    // Public IP row falls back to the em-dash; no all-failed banner.
    await waitFor(() => expect(screen.getAllByText('—').length).toBeGreaterThan(0));
    expect(screen.queryByText(/isn.t responding to health checks/)).toBeNull();
  });

  it('shows the unreachable banner only when EVERY channel fails', async () => {
    for (const m of Object.values(mocks)) m.mockRejectedValue(new Error('down'));
    await renderScreen();
    expect(await screen.findByText(/isn.t responding to health checks/)).toBeTruthy();
  });

  it('Refresh invalidates the ["server","health"] prefix so every channel refetches', async () => {
    await renderScreen();
    await screen.findByText('proj-x');
    expect(mocks.fcmStatus).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.press(screen.getByText('Refresh'));
    });
    await waitFor(() => expect(mocks.fcmStatus).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mocks.publicIp).toHaveBeenCalledTimes(2));
  });

  it('Clear Alerts calls the endpoint and empties the alerts card', async () => {
    mocks.serverAlerts.mockResolvedValue([{ id: 'a1', type: 'warn', value: 'Helper crashed' }]);
    await renderScreen();
    expect(await screen.findByText('Helper crashed')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByText('Clear Alerts'));
    });
    await waitFor(() => expect(mocks.clearServerAlerts).toHaveBeenCalled());
    expect(await screen.findByText('None')).toBeTruthy();
    expect(screen.queryByText('Helper crashed')).toBeNull();
  });
});
