/**
 * ServerHealthScreen route (app/(app)/server-health.tsx): the read-only diagnostics screen,
 * now backed by TanStack Query (`useQueries` — one query per health channel under the
 * ['server','health',generation,…] key namespace).
 *
 * Locks in the query wiring, not the copy:
 *   - each resolved channel fills its card; a rejected one degrades to "—" without
 *     blocking the rest;
 *   - EVERY channel failing shows the "server isn't responding" banner;
 *   - the header Refresh invalidates the ['server','health'] prefix → every channel refetches;
 *   - Clear Alerts calls the endpoint and empties the alerts card via the query cache.
 *
 * Each test gets a FRESH QueryClient (retry off so errors surface immediately; gcTime
 * Infinity so no GC timers linger past the test). Account-generation tests also prove that
 * every query and action remains owned by the screen's originally captured server account.
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
  rcsReauthNow: jest.fn(),
}));

// eslint-disable-next-line import/first
import ServerHealthScreen from '../../../app/(app)/server-health';
// eslint-disable-next-line import/first
import { serverApi } from '@core/api';
// eslint-disable-next-line import/first
import { UnimplementedEndpointError } from '@core/api/errors';
// eslint-disable-next-line import/first
import { RCS_ALERT_TYPES } from '@core/realtime';
// eslint-disable-next-line import/first
import { useSessionStore } from '@state/sessionStore';
// eslint-disable-next-line import/first
import { useRcsHealthStore } from '@state/rcsHealthStore';
// eslint-disable-next-line import/first
import { useToastStore } from '@ui/toast/toastStore';
// eslint-disable-next-line import/first
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

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
  rcsReauthNow: serverApi.rcsReauthNow as jest.Mock,
};

const healthReadMocks = [
  mocks.privateApiStatus,
  mocks.serverEnv,
  mocks.findMyKeysStatus,
  mocks.fcmStatus,
  mocks.zrokStatus,
  mocks.publicIp,
  mocks.tlsStatus,
  mocks.adminStatus,
  mocks.serverAlerts,
  mocks.rcsStatus,
] as const;

const PRIVATE_SESSION_VERSION = 'health-private-session-version-68bf';
const PRIVATE_ENV_VERSION = 'health-private-env-version-234c';
const PRIVATE_MACOS = 'health-private-macos-version-bd71';
const PRIVATE_NODE = 'health-private-node-version-7aa4';
const PRIVATE_FCM_PROJECT = 'health-private-fcm-project-91ef';
const PRIVATE_TUNNEL_URL = 'https://health-private-tunnel-3fc2.example/secret';
const PRIVATE_PUBLIC_IP = '198.51.100.47';
const PRIVATE_TLS_MODE = 'health-private-tls-mode-85da';
const PRIVATE_TLS_DOMAIN = 'health-private-tls-domain-d10e.example';
const PRIVATE_ALERT_VALUE = 'health-private-alert-value-d32b';
const PRIVATE_ALERT_TYPE = 'health-private-alert-type-703a';
const PRIVATE_RCS_PHONE = 'health-private-rcs-phone-19ce';
const PRIVATE_RCS_ERROR = 'health-private-rcs-startup-error-a8d4';
const PRIVATE_RECONNECT_ERROR = 'health-private-reconnect-error-4f61';
const PRIVATE_OLD_QUERY_ERROR = 'health-private-old-query-error-96ac';
const ACCOUNT_CHANGED_COPY = 'Server account changed. Go back and reopen Server Health.';
const HEALTH_QUERY_SUFFIXES = [
  'private-api',
  'env',
  'findmy-keys',
  'fcm',
  'zrok',
  'public-ip',
  'tls',
  'admin',
  'alerts',
  'rcs',
] as const;
const PRIVATE_HEALTH_CANARIES = [
  PRIVATE_SESSION_VERSION,
  PRIVATE_ENV_VERSION,
  PRIVATE_MACOS,
  PRIVATE_NODE,
  PRIVATE_FCM_PROJECT,
  PRIVATE_TUNNEL_URL,
  PRIVATE_PUBLIC_IP,
  PRIVATE_TLS_MODE,
  PRIVATE_TLS_DOMAIN,
  PRIVATE_ALERT_VALUE,
  PRIVATE_ALERT_TYPE,
  PRIVATE_RCS_PHONE,
  PRIVATE_RCS_ERROR,
];

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
  return () => {
    onPress({ nativeEvent: {} });
  };
}

function arrangePrivateHealth(envVersion: string | null = PRIVATE_ENV_VERSION): void {
  useSessionStore.setState({
    serverInfo: {
      server_version: PRIVATE_SESSION_VERSION,
      os_version: PRIVATE_MACOS,
      rcs: true,
    },
  });
  mocks.serverEnv.mockResolvedValue({ version: envVersion, node: PRIVATE_NODE });
  mocks.fcmStatus.mockResolvedValue({ configured: true, projectId: PRIVATE_FCM_PROJECT });
  mocks.zrokStatus.mockResolvedValue({ running: true, url: PRIVATE_TUNNEL_URL });
  mocks.publicIp.mockResolvedValue(PRIVATE_PUBLIC_IP);
  mocks.tlsStatus.mockResolvedValue({ mode: PRIVATE_TLS_MODE, domain: PRIVATE_TLS_DOMAIN });
  mocks.serverAlerts.mockResolvedValue([
    { id: 'health-private-alert-value', type: 'warn', value: PRIVATE_ALERT_VALUE },
    { id: 'health-private-alert-type', type: PRIVATE_ALERT_TYPE, value: null },
  ]);
  mocks.rcsStatus.mockResolvedValue({
    enabled: true,
    running: false,
    paired: true,
    connected: false,
    phoneResponding: false,
    state: 'failed',
    phoneID: PRIVATE_RCS_PHONE,
    error: PRIVATE_RCS_ERROR,
  });
}

async function waitForHealthQueries(client: QueryClient, generation?: number): Promise<void> {
  await waitFor(() => {
    const queries = client
      .getQueryCache()
      .findAll({ queryKey: ['server', 'health'] })
      .filter((query) => generation == null || query.queryKey[2] === generation);
    expect(queries).toHaveLength(10);
    expect(queries.every((query) => query.state.status === 'success')).toBe(true);
  });
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

function expectExactHealthQueryKeys(client: QueryClient, generation: number): void {
  const suffixes = client
    .getQueryCache()
    .findAll({ queryKey: ['server', 'health', generation] })
    .map((query) => query.queryKey[3])
    .sort();
  expect(suffixes).toEqual([...HEALTH_QUERY_SUFFIXES].sort());
}

function regexFor(value: string): RegExp {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

function expectNoPrivateHealthCanaries(): void {
  for (const canary of PRIVATE_HEALTH_CANARIES) {
    expect(screen.queryByText(regexFor(canary))).toBeNull();
    expect(screen.queryByRole('text', { name: regexFor(canary) })).toBeNull();
  }
}

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
  mocks.rcsReauthNow.mockResolvedValue({ reauthed: true, connected: true });
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
}

type RenderedScreen = {
  client: QueryClient;
  view: Awaited<ReturnType<typeof renderWithTheme>>;
};

const renderedScreens: RenderedScreen[] = [];

async function renderScreen(client = makeQueryClient()) {
  const view = await renderWithTheme(
    <QueryClientProvider client={client}>
      <ServerHealthScreen />
    </QueryClientProvider>,
  );
  const rendered = { client, view };
  renderedScreens.push(rendered);
  return rendered;
}

async function drainHealthObservers(client: QueryClient): Promise<void> {
  await waitFor(() => {
    expect(client.isFetching({ queryKey: ['server', 'health'] })).toBe(0);
  });
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

async function unmountScreen(rendered: RenderedScreen): Promise<void> {
  await drainHealthObservers(rendered.client);
  await rendered.view.unmount();
  const index = renderedScreens.indexOf(rendered);
  if (index >= 0) renderedScreens.splice(index, 1);
}

beforeEach(() => {
  resumeRealtimeDeliveries();
  jest.clearAllMocks();
  useSessionStore.setState({ serverInfo: null });
  useRcsHealthStore.setState({ lastAlertType: null, lastAlertAt: null });
  useToastStore.setState({ current: null, queue: [] });
  resolveAllChannels();
});

afterEach(async () => {
  resumeRealtimeDeliveries();
  try {
    for (const rendered of [...renderedScreens].reverse()) {
      await unmountScreen(rendered);
    }
  } finally {
    renderedScreens.length = 0;
    resumeRealtimeDeliveries();
  }
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

  it.each(['success', 'rejection'] as const)(
    'isolates all ten generation-keyed reads and drops a delayed old-account %s',
    async (outcome) => {
      const oldFcm = deferred<{ configured: boolean; projectId: string }>();
      mocks.fcmStatus.mockReset().mockReturnValueOnce(oldFcm.promise);
      const client = makeQueryClient();
      const renderedA = await renderScreen(client);
      await waitFor(() => expect(mocks.fcmStatus).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(client.getQueryCache().findAll({ queryKey: ['server', 'health'] })).toHaveLength(10),
      );
      const generationA = client.getQueryCache().findAll({ queryKey: ['server', 'health'] })[0]
        ?.queryKey[2] as number;
      expectExactHealthQueryKeys(client, generationA);

      await act(async () => {
        await pauseRealtimeDeliveries();
      });
      expect(screen.getByRole('text', { name: ACCOUNT_CHANGED_COPY })).toBeTruthy();

      await act(async () => {
        if (outcome === 'success') {
          oldFcm.resolve({ configured: true, projectId: 'project-A-late' });
        } else {
          oldFcm.reject(new Error(PRIVATE_OLD_QUERY_ERROR));
        }
        await oldFcm.promise.catch(() => undefined);
      });
      await waitForHealthQueries(client, generationA);
      const staleFcm = client
        .getQueryCache()
        .find({ queryKey: ['server', 'health', generationA, 'fcm'], exact: true });
      expect(staleFcm?.state.data).toBeNull();
      expect(JSON.stringify(staleFcm?.state)).not.toContain('project-A-late');
      expect(JSON.stringify(staleFcm?.state)).not.toContain(PRIVATE_OLD_QUERY_ERROR);
      expect(screen.queryByText('project-A-late')).toBeNull();
      expect(screen.queryByText(PRIVATE_OLD_QUERY_ERROR)).toBeNull();

      await unmountScreen(renderedA);
      resumeRealtimeDeliveries();
      mocks.fcmStatus.mockResolvedValueOnce({ configured: true, projectId: 'project-B' });
      await renderScreen(client);
      expect(await screen.findByText('project-B')).toBeTruthy();
      const generationB = client
        .getQueryCache()
        .findAll({ queryKey: ['server', 'health'] })
        .map((query) => query.queryKey[2])
        .find((generation) => generation !== generationA) as number;
      await waitForHealthQueries(client, generationB);
      expectExactHealthQueryKeys(client, generationB);
      expect(generationB).not.toBe(generationA);
      expect(screen.queryByText(PRIVATE_OLD_QUERY_ERROR)).toBeNull();
      expect(screen.queryByText('project-A-late')).toBeNull();
    },
  );

  it('shows the unreachable banner only when EVERY channel fails', async () => {
    for (const m of Object.values(mocks)) m.mockRejectedValue(new Error('down'));
    await renderScreen();
    expect(await screen.findByText(/isn.t responding to health checks/)).toBeTruthy();
  });

  it('shows the "unsupported" banner when every channel is a dispatcher 404 (Unimplemented)', async () => {
    // An old server without the admin dispatcher, or a reverse proxy blocking /api/v1/admin/* —
    // the copy must point at server/proxy config, not connectivity.
    for (const m of Object.values(mocks))
      m.mockRejectedValue(new UnimplementedEndpointError('/admin/command'));
    await renderScreen();
    expect(await screen.findByText(/doesn.t expose health reporting/)).toBeTruthy();
    expect(screen.queryByText(/isn.t responding to health checks/)).toBeNull();
  });

  it('Refresh invalidates the ["server","health"] prefix so every channel refetches', async () => {
    const { client } = await renderScreen();
    await screen.findByText('proj-x');
    expect(mocks.fcmStatus).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByText('Refresh'));
    await drainHealthObservers(client);
    expect(mocks.fcmStatus).toHaveBeenCalledTimes(2);
    expect(mocks.publicIp).toHaveBeenCalledTimes(2);
  });

  it('Clear Alerts calls the endpoint and empties the alerts card', async () => {
    mocks.serverAlerts.mockResolvedValue([{ id: 'a1', type: 'warn', value: 'Helper crashed' }]);
    await renderScreen();
    expect(await screen.findByText('Helper crashed')).toBeTruthy();
    await fireEvent.press(screen.getByText('Clear Alerts'));
    await waitFor(() => expect(mocks.clearServerAlerts).toHaveBeenCalled());
    expect(await screen.findByText('None')).toBeTruthy();
    expect(screen.queryByText('Helper crashed')).toBeNull();
  });

  it('keeps alerts on failure, uses fixed copy, and releases busy for a successful retry', async () => {
    const rawError = 'health-current-clear-error-6c2e';
    mocks.serverAlerts.mockResolvedValue([{ id: 'a1', type: 'warn', value: 'Helper crashed' }]);
    mocks.clearServerAlerts
      .mockRejectedValueOnce(new Error(rawError))
      .mockResolvedValueOnce(undefined);
    await renderScreen();
    expect(await screen.findByText('Helper crashed')).toBeTruthy();

    await fireEvent.press(screen.getByText('Clear Alerts'));
    expect(mocks.clearServerAlerts).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(useToastStore.getState().current?.message).toBe('Could not clear server alerts.'),
    );
    expect(JSON.stringify(useToastStore.getState().current)).not.toContain(rawError);
    expect(screen.getByText('Helper crashed')).toBeTruthy();
    expect(screen.queryByText('None')).toBeNull();

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Clear Alerts' }).props.accessibilityState?.disabled,
      ).not.toBe(true),
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Clear Alerts' }));
    await waitFor(() => expect(mocks.clearServerAlerts).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('None')).toBeTruthy();
    expect(screen.queryByText('Helper crashed')).toBeNull();
  });

  it('does not run a Clear Alerts callback retained from the previous account', async () => {
    mocks.serverAlerts.mockResolvedValue([{ id: 'a1', type: 'warn', value: 'Helper crashed' }]);
    await renderScreen();
    const oldPress = retainConfiguredPress(
      await screen.findByRole('button', { name: 'Clear Alerts' }),
    );

    await act(async () => {
      await pauseRealtimeDeliveries();
    });
    oldPress();

    expect(mocks.clearServerAlerts).not.toHaveBeenCalled();
    expect(useToastStore.getState().current).toBeNull();
    expect(screen.getByRole('text', { name: ACCOUNT_CHANGED_COPY })).toBeTruthy();
    resumeRealtimeDeliveries();
  });

  it.each(['success', 'rejection'] as const)(
    'holds Disconnect for an admitted alert-clear %s and disowns its cache/toast result',
    async (outcome) => {
      const response = deferred<void>();
      const alert = { id: 'a1', type: 'warn', value: 'Helper crashed' };
      mocks.serverAlerts.mockResolvedValue([alert]);
      mocks.clearServerAlerts.mockReturnValueOnce(response.promise);
      const { client } = await renderScreen();
      expect(await screen.findByText(alert.value)).toBeTruthy();
      await fireEvent.press(screen.getByText('Clear Alerts'));
      await waitFor(() => expect(mocks.clearServerAlerts).toHaveBeenCalledTimes(1));

      let drained = false;
      let drain!: Promise<void>;
      await act(async () => {
        drain = pauseRealtimeDeliveries().then(() => {
          drained = true;
        });
        await Promise.resolve();
      });
      expect(drained).toBe(false);
      expect(screen.getByRole('text', { name: ACCOUNT_CHANGED_COPY })).toBeTruthy();
      expect(screen.queryByText(alert.value)).toBeNull();

      await act(async () => {
        if (outcome === 'success') response.resolve(undefined);
        else response.reject(new Error(`old-clear-${PRIVATE_OLD_QUERY_ERROR}`));
        await response.promise.catch(() => undefined);
        await drain;
      });

      const alertsQuery = client
        .getQueryCache()
        .findAll({ queryKey: ['server', 'health'] })
        .find((query) => query.queryKey[3] === 'alerts');
      expect(alertsQuery?.state.data).toEqual([alert]);
      expect(useToastStore.getState().current).toBeNull();
      expect(JSON.stringify(useToastStore.getState())).not.toContain(PRIVATE_OLD_QUERY_ERROR);
      resumeRealtimeDeliveries();
    },
  );

  it.each(['success', 'rejection'] as const)(
    'drains an admitted RCS reconnect %s but suppresses its old-account toast and refresh',
    async (outcome) => {
      const response = deferred<{ staged: boolean; connected: boolean }>();
      useSessionStore.setState({ serverInfo: { server_version: '1.9.9', rcs: true } });
      mocks.rcsReauthNow.mockReturnValueOnce(response.promise);
      const { client } = await renderScreen();
      await waitForHealthQueries(client);
      const button = await screen.findByRole('button', { name: /Re-authenticate/ });
      const startReconnect = retainConfiguredPress(button);
      const fcmCallsBefore = mocks.fcmStatus.mock.calls.length;
      await act(async () => {
        startReconnect();
        await Promise.resolve();
      });
      expect(mocks.rcsReauthNow).toHaveBeenCalledTimes(1);

      let drained = false;
      let drain!: Promise<void>;
      await act(async () => {
        drain = pauseRealtimeDeliveries().then(() => {
          drained = true;
        });
        await Promise.resolve();
      });
      expect(drained).toBe(false);
      expect(screen.getByRole('text', { name: ACCOUNT_CHANGED_COPY })).toBeTruthy();
      await act(async () => {
        if (outcome === 'success') response.resolve({ staged: false, connected: true });
        else response.reject(new Error(`old-rcs-${PRIVATE_RECONNECT_ERROR}`));
        await response.promise.catch(() => undefined);
        await drain;
      });

      expect(useToastStore.getState().current).toBeNull();
      expect(JSON.stringify(useToastStore.getState())).not.toContain(PRIVATE_RECONNECT_ERROR);
      expect(mocks.fcmStatus).toHaveBeenCalledTimes(fcmCallsBefore);
      resumeRealtimeDeliveries();
    },
  );
});

describe('ServerHealthScreen — ordinary presentation and account ownership', () => {
  it('renders exact diagnostics and accessibility, keeps Back, and runs every current action', async () => {
    arrangePrivateHealth();
    const { client } = await renderScreen();
    await waitForHealthQueries(client);

    for (const canary of PRIVATE_HEALTH_CANARIES.filter(
      (value) => value !== PRIVATE_SESSION_VERSION,
    )) {
      expect(screen.getByText(regexFor(canary))).toBeTruthy();
    }
    expect(screen.getByRole('text', { name: PRIVATE_ENV_VERSION })).toBeTruthy();
    expect(screen.getByRole('text', { name: PRIVATE_FCM_PROJECT })).toBeTruthy();
    expect(screen.getByRole('text', { name: PRIVATE_RCS_PHONE })).toBeTruthy();
    expect(screen.getByRole('text', { name: regexFor(PRIVATE_RCS_ERROR) })).toBeTruthy();
    expect(screen.getByRole('text', { name: 'RCS bridge Not running' })).toBeTruthy();

    const generation = client.getQueryCache().findAll({ queryKey: ['server', 'health'] })[0]
      ?.queryKey[2] as number;
    expectExactHealthQueryKeys(client, generation);

    await fireEvent.press(screen.getByRole('button', { name: '‹ Back' }));
    expect(mockBack).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByRole('button', { name: 'Refresh' }));
    await drainHealthObservers(client);
    for (const readMock of healthReadMocks) expect(readMock).toHaveBeenCalledTimes(2);

    await fireEvent.press(screen.getByRole('button', { name: 'Clear Alerts' }));
    await waitFor(() => expect(mocks.clearServerAlerts).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('None')).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: /Re-authenticate/ }));
    await waitFor(() => expect(mocks.rcsReauthNow).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(useToastStore.getState().current?.message).toBe('RCS bridge reconnected.'),
    );
    await drainHealthObservers(client);
    for (const readMock of healthReadMocks) expect(readMock).toHaveBeenCalledTimes(3);
  });

  it('admits no endpoint reads for an initially stale account and leaves only Back plus fixed copy', async () => {
    arrangePrivateHealth();
    await act(async () => {
      await pauseRealtimeDeliveries();
    });

    const { client } = await renderScreen();
    await waitForHealthQueries(client);

    for (const readMock of healthReadMocks) expect(readMock).not.toHaveBeenCalled();
    expect(mocks.clearServerAlerts).not.toHaveBeenCalled();
    expect(mocks.rcsReauthNow).not.toHaveBeenCalled();
    expect(screen.getByRole('text', { name: ACCOUNT_CHANGED_COPY })).toBeTruthy();
    expect(screen.getByRole('button', { name: '‹ Back' })).toBeTruthy();
    expectNoPrivateHealthCanaries();
    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear Alerts' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Re-authenticate/ })).toBeNull();
    expect(screen.queryByText('PRIVATE API')).toBeNull();
    expect(screen.queryByText('ALERTS')).toBeNull();

    await fireEvent.press(screen.getByRole('button', { name: '‹ Back' }));
    expect(mockBack).toHaveBeenCalledTimes(1);
    resumeRealtimeDeliveries();
  });

  it('automatically retires a mounted account, revokes retained actions, and admits fresh B actions', async () => {
    arrangePrivateHealth(null);
    mocks.rcsStatus.mockResolvedValue({
      enabled: true,
      running: true,
      paired: true,
      connected: true,
      phoneResponding: true,
      state: 'connected',
      phoneID: PRIVATE_RCS_PHONE,
      error: null,
    });
    useRcsHealthStore.setState({
      lastAlertType: RCS_ALERT_TYPES.gaiaLoggedOut,
      lastAlertAt: Number.MAX_SAFE_INTEGER,
    });
    const renderedA = await renderScreen();
    await waitForHealthQueries(renderedA.client);
    expect(screen.getByRole('text', { name: PRIVATE_SESSION_VERSION })).toBeTruthy();
    expect(
      screen.getByText('RCS bridge disconnected — re-authenticate on the server dashboard.'),
    ).toBeTruthy();

    const oldRefresh = retainConfiguredPress(screen.getByRole('button', { name: 'Refresh' }));
    const oldClear = retainConfiguredPress(screen.getByRole('button', { name: 'Clear Alerts' }));
    const oldRcs = retainConfiguredPress(screen.getByRole('button', { name: /Re-authenticate/ }));
    const readCounts = healthReadMocks.map((readMock) => readMock.mock.calls.length);

    await act(async () => {
      await pauseRealtimeDeliveries();
    });

    expect(screen.getByRole('text', { name: ACCOUNT_CHANGED_COPY })).toBeTruthy();
    expectNoPrivateHealthCanaries();
    expect(screen.queryByText(PRIVATE_SESSION_VERSION)).toBeNull();
    expect(
      screen.queryByText('RCS bridge disconnected — re-authenticate on the server dashboard.'),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear Alerts' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Re-authenticate/ })).toBeNull();

    await act(async () => {
      oldRefresh();
      oldClear();
      oldRcs();
      await Promise.resolve();
    });
    healthReadMocks.forEach((readMock, index) => {
      expect(readMock).toHaveBeenCalledTimes(readCounts[index] ?? 0);
    });
    expect(mocks.clearServerAlerts).not.toHaveBeenCalled();
    expect(mocks.rcsReauthNow).not.toHaveBeenCalled();
    expect(useToastStore.getState().current).toBeNull();

    await unmountScreen(renderedA);
    resumeRealtimeDeliveries();
    for (const mock of Object.values(mocks)) mock.mockClear();
    useRcsHealthStore.setState({ lastAlertType: null, lastAlertAt: null });
    arrangePrivateHealth();
    mocks.fcmStatus.mockResolvedValue({
      configured: true,
      projectId: 'health-fresh-B-project-b73a',
    });
    const renderedB = await renderScreen();
    await waitForHealthQueries(renderedB.client);
    expect(screen.getByRole('text', { name: 'health-fresh-B-project-b73a' })).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Refresh' }));
    await drainHealthObservers(renderedB.client);
    for (const readMock of healthReadMocks) expect(readMock).toHaveBeenCalledTimes(2);
    await fireEvent.press(screen.getByRole('button', { name: 'Clear Alerts' }));
    await waitFor(() => expect(mocks.clearServerAlerts).toHaveBeenCalledTimes(1));
    await fireEvent.press(screen.getByRole('button', { name: /Re-authenticate/ }));
    await waitFor(() => expect(mocks.rcsReauthNow).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(useToastStore.getState().current?.message).toBe('RCS bridge reconnected.'),
    );
    await drainHealthObservers(renderedB.client);
    for (const readMock of healthReadMocks) expect(readMock).toHaveBeenCalledTimes(3);
  });

  it('uses fixed reconnect failure copy and releases busy so a current retry succeeds', async () => {
    arrangePrivateHealth();
    mocks.rcsReauthNow
      .mockRejectedValueOnce(new Error(PRIVATE_RECONNECT_ERROR))
      .mockResolvedValueOnce({ reauthed: true, connected: true });
    const { client } = await renderScreen();
    await waitForHealthQueries(client);

    await fireEvent.press(screen.getByRole('button', { name: /Re-authenticate/ }));
    await waitFor(() =>
      expect(useToastStore.getState().current?.message).toBe('Could not reconnect the RCS bridge.'),
    );
    expect(useToastStore.getState().current?.message).not.toContain(PRIVATE_RECONNECT_ERROR);

    useToastStore.getState().reset();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Re-authenticate/ }).props.accessibilityState?.disabled,
      ).not.toBe(true),
    );
    await fireEvent.press(screen.getByRole('button', { name: /Re-authenticate/ }));
    await waitFor(() => expect(mocks.rcsReauthNow).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(useToastStore.getState().current?.message).toBe('RCS bridge reconnected.'),
    );
    await drainHealthObservers(client);
    for (const readMock of healthReadMocks) expect(readMock).toHaveBeenCalledTimes(2);
  });
});
