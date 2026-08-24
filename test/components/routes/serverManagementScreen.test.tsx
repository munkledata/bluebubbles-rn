/**
 * ServerManagementScreen route (app/(app)/server-management.tsx): the STATUS/STATISTICS
 * sections are now TanStack Query-backed with the captured account generation appended to every
 * key (ping → ['server','ping',generation], and likewise for stats/info).
 *
 * Locks in the query wiring:
 *   - a resolved ping renders "Reachable · N ms"; a rejected one renders "Unreachable";
 *   - stats numbers render from the stats query; total failure shows the INLINE error row,
 *     and "Refresh Statistics" refetches (clearing the error on success);
 *   - the server-info query populates the session store (version/macOS/private-API rows).
 *
 * ...and the DESTRUCTIVE ACTIONS section (restart iMessage / services / server, view logs):
 *   - each restart is confirm-gated (opening the confirm must not touch the server) and, on
 *     confirm, posts the RIGHT admin-command channel string;
 *   - Cancel is a no-op;
 *   - the `busy` in-flight guard disables the rows so a second tap can't fire a second restart.
 *
 * The ACTIONS tests deliberately let the REAL `restartImessage`/`softRestart`/`hardRestart`/
 * `serverLogs` + `adminCommand` run (only ping/stats/info are jest.fn'd) and assert on the
 * mocked `http.post` — that is the only way to pin the literal channel strings, which are the
 * whole payload of these calls.
 *
 * Each test gets a FRESH QueryClient (retry off; gcTime Infinity so no GC timers linger).
 */
import React from 'react';
import { AccessibilityInfo, Share } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithTheme, screen, fireEvent, waitFor, act } from '../support/renderWithTheme';

const mockPush = jest.fn();
const mockBack = jest.fn();
// `mock*` prefix so the jest.mock factory below may close over it (hoisting rule).
const mockHttpPost = jest.fn();
const mockQrCode = jest.fn();
const mockIsReduceMotionEnabled = AccessibilityInfo.isReduceMotionEnabled as jest.MockedFunction<
  typeof AccessibilityInfo.isReduceMotionEnabled
>;
const mockAddEventListener = AccessibilityInfo.addEventListener as jest.Mock;

let reduceMotionListeners: Array<(enabled: boolean) => void>;
let removeReduceMotionListeners: jest.Mock[];

// The full `@ui` barrel drags in the conversation/attachment tree (expo-video/expo-image/ky —
// native/ESM modules jest-expo can't load). The screen only needs `Screen` + `useTheme`.
jest.mock('@ui', () => ({
  ...jest.requireActual('@ui/theme'),
  ...jest.requireActual('@ui/primitives'),
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: mockBack }),
  useFocusEffect: jest.fn(),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@ui/primitives/QrCode', () => {
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    QrCode: (props: { value: string; size?: number; testID?: string }) => {
      mockQrCode(props);
      return ReactModule.createElement(RN.View, {
        testID: props.testID,
        accessible: true,
        accessibilityLabel: 'QR code',
      });
    },
  };
});
// `post` forwards LAZILY: the factory runs while the screen's (hoisted) import graph loads, which
// is before `const mockHttpPost` is initialised — capturing it directly yields `undefined`.
jest.mock('@/services', () => ({
  http: { post: (...args: unknown[]) => mockHttpPost(...args) },
  startSync: jest.fn(),
}));
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
import { ApiError, UnimplementedEndpointError } from '@core/api/errors';
// eslint-disable-next-line import/first
import { buildSetupQr } from '@features/setup/qr';
// eslint-disable-next-line import/first
import { useSessionStore } from '@state/sessionStore';
// eslint-disable-next-line import/first
import { useSyncStore } from '@state/syncStore';
// eslint-disable-next-line import/first
import { startSync } from '@/services';
// eslint-disable-next-line import/first
import { useDialogStore, type DialogRequest } from '@ui/dialog/dialogStore';
// eslint-disable-next-line import/first
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

const mockPing = serverApi.ping as jest.Mock;
const mockStats = serverApi.serverStatTotals as jest.Mock;
const mockInfo = serverApi.serverInfo as jest.Mock;
const mockStartSync = startSync as jest.MockedFunction<typeof startSync>;

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

const PRIVATE_ORIGIN = 'https://management-private-origin-73ad.example/tenant';
const PRIVATE_PASSWORD = 'management-private-password-1b8e';
const PRIVATE_INFO = {
  server_version: 'management-private-server-build-642f',
  os_version: 'management-private-macos-build-98c1',
  private_api: true,
  proxy_service: 'management-private-proxy-5d70',
};
const PRIVATE_TOTALS = {
  messages: 987_654_321,
  chats: 876_543_210,
  handles: 765_432_109,
  attachments: 654_321_098,
  images: 543_210_987,
  videos: 432_109_876,
  locations: 321_098_765,
};
const PRIVATE_LOG = 'management-private-log-canary-29bf';
const SECOND_ORIGIN = 'https://management-second-origin-2f91.example/tenant';
const SECOND_PASSWORD = 'management-second-password-83c4';
const SECOND_INFO = {
  server_version: 'management-second-server-build-9a32',
  os_version: 'management-second-macos-build-4e17',
  private_api: false,
  proxy_service: 'management-second-proxy-b604',
};
const SECOND_TOTALS = {
  messages: 246_813_579,
  chats: 135_792_468,
  handles: 112_358_132,
  attachments: 314_159_265,
  images: 271_828_182,
  videos: 161_803_398,
  locations: 141_421_356,
};
const SECOND_LOG = 'management-second-log-canary-7c15';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
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

async function invokeConfiguredPress(press: () => void): Promise<void> {
  await act(async () => {
    press();
    await Promise.resolve();
  });
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
      <ServerManagementScreen />
    </QueryClientProvider>,
  );
  return { client, view };
}

function arrangePrivateServer(): void {
  useSessionStore.setState({
    origin: PRIVATE_ORIGIN,
    password: PRIVATE_PASSWORD,
    serverInfo: null,
  });
  mockInfo.mockResolvedValue(PRIVATE_INFO);
  mockStats.mockResolvedValue(PRIVATE_TOTALS);
}

function arrangeSecondServer(): void {
  useSessionStore.setState({
    origin: SECOND_ORIGIN,
    password: SECOND_PASSWORD,
    serverInfo: null,
  });
  mockInfo.mockResolvedValue(SECOND_INFO);
  mockStats.mockResolvedValue(SECOND_TOTALS);
  mockPing.mockResolvedValue({ pong: true });
}

beforeEach(() => {
  resumeRealtimeDeliveries();
  jest.clearAllMocks();
  reduceMotionListeners = [];
  removeReduceMotionListeners = [];
  mockIsReduceMotionEnabled.mockReset().mockResolvedValue(false);
  mockAddEventListener.mockReset().mockImplementation((event, listener) => {
    expect(event).toBe('reduceMotionChanged');
    reduceMotionListeners.push(listener as (enabled: boolean) => void);
    const remove = jest.fn();
    removeReduceMotionListeners.push(remove);
    return { remove };
  });
  useSessionStore.setState({ origin: 'https://gator.example', serverInfo: null });
  useSyncStore.setState({ status: 'idle', chats: 0, messages: 0, error: null });
  useDialogStore.setState({ current: null, queue: [] });
  mockHttpPost.mockResolvedValue({});
  mockPing.mockResolvedValue({ pong: true });
  mockStats.mockResolvedValue(TOTALS);
  mockInfo.mockResolvedValue({
    server_version: '9.9.9',
    os_version: '26.0',
    private_api: true,
    proxy_service: 'zrok',
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  resumeRealtimeDeliveries();
});

describe('ServerManagementScreen — status queries', () => {
  it('shows Reachable + latency once the ping resolves', async () => {
    await renderScreen();
    expect(await screen.findByText(/Reachable · \d+ ms/)).toBeTruthy();
    await waitFor(() => {
      expect(mockPing).toHaveBeenCalledTimes(1);
      expect(mockStats).toHaveBeenCalledTimes(1);
      expect(mockInfo).toHaveBeenCalledTimes(1);
    });
    for (const endpoint of [mockPing, mockStats, mockInfo]) {
      expect(endpoint.mock.calls[0]?.[1]).toMatchObject({ aborted: false });
    }
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

  it.each(['success', 'rejection'] as const)(
    'isolates all three query keys and drops delayed old-account %s publication',
    async (outcome) => {
      const oldPing = deferred<{ pong: boolean }>();
      const oldStats = deferred<typeof PRIVATE_TOTALS>();
      const oldInfo = deferred<typeof PRIVATE_INFO>();
      arrangePrivateServer();
      mockPing.mockReset().mockReturnValueOnce(oldPing.promise);
      mockStats.mockReset().mockReturnValueOnce(oldStats.promise);
      mockInfo.mockReset().mockReturnValueOnce(oldInfo.promise);

      const client = makeQueryClient();
      const { view } = await renderScreen(client);
      await waitFor(() => {
        expect(mockPing).toHaveBeenCalledTimes(1);
        expect(mockStats).toHaveBeenCalledTimes(1);
        expect(mockInfo).toHaveBeenCalledTimes(1);
      });

      const firstGenerations = ['ping', 'stats', 'info'].map((kind) => {
        const query = client.getQueryCache().findAll({ queryKey: ['server', kind] })[0];
        expect(query?.queryKey).toEqual(['server', kind, expect.any(Number)]);
        return query?.queryKey[2];
      });
      expect(new Set(firstGenerations).size).toBe(1);
      const firstGeneration = firstGenerations[0];

      await act(async () => {
        await pauseRealtimeDeliveries();
      });

      const staleError = new Error(`management-old-query-${outcome}-error-70d4`);
      await act(async () => {
        if (outcome === 'success') {
          oldPing.resolve({ pong: true });
          oldStats.resolve(PRIVATE_TOTALS);
          oldInfo.resolve(PRIVATE_INFO);
        } else {
          oldPing.reject(staleError);
          oldStats.reject(staleError);
          oldInfo.reject(staleError);
        }
        await Promise.allSettled([oldPing.promise, oldStats.promise, oldInfo.promise]);
      });

      await waitFor(() => {
        for (const kind of ['ping', 'stats', 'info']) {
          const query = client
            .getQueryCache()
            .find({ queryKey: ['server', kind, firstGeneration], exact: true });
          expect(query?.state.status).toBe('success');
          expect(query?.state.data).toBeNull();
        }
      });
      const retiredTree = JSON.stringify(view.toJSON());
      expect(retiredTree).not.toContain(PRIVATE_INFO.server_version);
      expect(retiredTree).not.toContain(PRIVATE_TOTALS.messages.toLocaleString());
      expect(retiredTree).not.toContain(staleError.message);

      await view.unmount();
      resumeRealtimeDeliveries();
      arrangeSecondServer();
      await renderScreen(client);
      expect(await screen.findByText(SECOND_INFO.server_version)).toBeTruthy();
      expect(await screen.findByText(SECOND_TOTALS.messages.toLocaleString())).toBeTruthy();
      expect(await screen.findByText(/Reachable/)).toBeTruthy();

      for (const kind of ['ping', 'stats', 'info']) {
        const queries = client.getQueryCache().findAll({ queryKey: ['server', kind] });
        expect(queries).toHaveLength(2);
        const generations = queries.map((query) => query.queryKey[2]);
        expect(new Set(generations).size).toBe(2);
        expect(generations).toContain(firstGeneration);
      }
      expect(useSessionStore.getState().serverInfo?.server_version).toBe(
        SECOND_INFO.server_version,
      );
    },
  );
});

describe('ServerManagementScreen — ordinary sensitive presentation and account ownership', () => {
  it('renders exact sensitive host/a11y data and preserves Share, Health, Sync, and QR actions', async () => {
    arrangePrivateServer();
    useSyncStore.setState({ status: 'done', chats: 23, messages: 456, error: null });
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.sharedAction });
    const payload = buildSetupQr(PRIVATE_ORIGIN, PRIVATE_PASSWORD);
    const { view } = await renderScreen();

    expect(await screen.findByText(PRIVATE_INFO.server_version)).toBeTruthy();
    expect(await screen.findByText(PRIVATE_TOTALS.messages.toLocaleString())).toBeTruthy();
    expect(screen.getByText(PRIVATE_ORIGIN)).toBeTruthy();
    expect(screen.getByText(PRIVATE_INFO.os_version)).toBeTruthy();
    expect(screen.getByText(PRIVATE_INFO.proxy_service)).toBeTruthy();
    expect(screen.getByText('Up to date (456 msgs)')).toBeTruthy();
    const shareButton = screen.getByRole('button', {
      name: `Share server URL ${PRIVATE_ORIGIN}`,
    });
    expect(shareButton.props.accessibilityLabel).toBe(`Share server URL ${PRIVATE_ORIGIN}`);

    await invokeConfiguredPress(retainConfiguredPress(shareButton));
    expect(share).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledWith({ message: PRIVATE_ORIGIN });

    await invokeConfiguredPress(
      retainConfiguredPress(screen.getByRole('button', { name: 'Server Health' })),
    );
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/server-health');

    await invokeConfiguredPress(
      retainConfiguredPress(screen.getByRole('button', { name: 'Sync Now' })),
    );
    expect(mockStartSync).toHaveBeenCalledTimes(1);
    expect(mockStartSync).toHaveBeenCalledWith();

    await invokeConfiguredPress(
      retainConfiguredPress(screen.getByRole('button', { name: 'Show Pairing QR' })),
    );
    expect(await screen.findByRole('button', { name: 'Reveal QR Code' })).toBeTruthy();
    expect(screen.queryByTestId('pairing-qr-code')).toBeNull();
    expect(mockQrCode).not.toHaveBeenCalled();
    const preRevealTree = JSON.stringify(view.toJSON());
    expect(preRevealTree).not.toContain(PRIVATE_PASSWORD);
    expect(preRevealTree).not.toContain(payload);

    await fireEvent.press(screen.getByRole('button', { name: 'Reveal QR Code' }));
    expect(await screen.findByTestId('pairing-qr-code')).toBeTruthy();
    expect(mockQrCode).toHaveBeenLastCalledWith({
      value: payload,
      size: 260,
      testID: 'pairing-qr-code',
    });
  });

  it('automatically closes retired QR/log hosts, revokes retained A actions, and binds fresh B actions', async () => {
    arrangePrivateServer();
    const firstSyncCopy = 'Up to date (864209753 msgs)';
    useSyncStore.setState({
      status: 'done',
      chats: 753_190_246,
      messages: 864_209_753,
      error: null,
    });
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.sharedAction });
    mockHttpPost.mockResolvedValueOnce({ logs: PRIVATE_LOG });
    const { view } = await renderScreen();
    expect(await screen.findByText(PRIVATE_INFO.server_version)).toBeTruthy();
    expect(await screen.findByText(PRIVATE_TOTALS.messages.toLocaleString())).toBeTruthy();
    expect(screen.getByText(PRIVATE_ORIGIN)).toBeTruthy();
    expect(screen.getByText(PRIVATE_INFO.os_version)).toBeTruthy();
    expect(screen.getByText(PRIVATE_INFO.proxy_service)).toBeTruthy();
    expect(screen.getByText(firstSyncCopy)).toBeTruthy();

    const oldShare = retainConfiguredPress(
      screen.getByRole('button', { name: `Share server URL ${PRIVATE_ORIGIN}` }),
    );
    const oldSync = retainConfiguredPress(screen.getByRole('button', { name: 'Sync Now' }));
    const oldHealth = retainConfiguredPress(screen.getByRole('button', { name: 'Server Health' }));
    const oldPairing = retainConfiguredPress(
      screen.getByRole('button', { name: 'Show Pairing QR' }),
    );
    const oldLogs = retainConfiguredPress(screen.getByRole('button', { name: 'View Server Logs' }));

    await invokeConfiguredPress(oldPairing);
    await fireEvent.press(await screen.findByRole('button', { name: 'Reveal QR Code' }));
    expect(await screen.findByTestId('pairing-qr-code')).toBeTruthy();
    await invokeConfiguredPress(oldLogs);
    expect(await screen.findByText(PRIVATE_LOG)).toBeTruthy();

    await act(async () => {
      await pauseRealtimeDeliveries();
    });

    await waitFor(() => {
      expect(screen.queryByTestId('pairing-qr-code')).toBeNull();
      expect(screen.queryByLabelText('Close pairing QR')).toBeNull();
      expect(screen.queryByText(PRIVATE_LOG)).toBeNull();
      expect(screen.queryByLabelText('Close server logs')).toBeNull();
    });
    const retiredTree = JSON.stringify(view.toJSON());
    expect(retiredTree).not.toContain(PRIVATE_ORIGIN);
    expect(retiredTree).not.toContain(PRIVATE_INFO.server_version);
    expect(retiredTree).not.toContain(PRIVATE_INFO.os_version);
    expect(retiredTree).not.toContain(PRIVATE_INFO.proxy_service);
    expect(retiredTree).not.toContain(PRIVATE_TOTALS.messages.toLocaleString());
    expect(retiredTree).not.toContain(PRIVATE_TOTALS.chats.toLocaleString());
    expect(retiredTree).not.toContain(firstSyncCopy);
    expect(retiredTree).not.toContain(PRIVATE_PASSWORD);
    expect(retiredTree).not.toContain(buildSetupQr(PRIVATE_ORIGIN, PRIVATE_PASSWORD));
    expect(retiredTree).not.toContain(PRIVATE_LOG);
    expect(screen.getByRole('button', { name: 'Share server URL Unknown' })).toBeTruthy();
    expect(screen.getAllByText('Unknown').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText('Idle')).toBeTruthy();

    share.mockClear();
    mockStartSync.mockClear();
    mockPush.mockClear();
    mockHttpPost.mockClear();
    mockQrCode.mockClear();
    await invokeConfiguredPress(oldShare);
    await invokeConfiguredPress(oldSync);
    await invokeConfiguredPress(oldHealth);
    await invokeConfiguredPress(oldPairing);
    await invokeConfiguredPress(oldLogs);
    expect(share).not.toHaveBeenCalled();
    expect(mockStartSync).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockHttpPost).not.toHaveBeenCalled();
    expect(mockQrCode).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Close pairing QR')).toBeNull();
    expect(screen.queryByLabelText('Close server logs')).toBeNull();

    await view.unmount();
    resumeRealtimeDeliveries();
    arrangeSecondServer();
    useSyncStore.setState({
      status: 'done',
      chats: 147_258_369,
      messages: 258_369_147,
      error: null,
    });
    mockHttpPost.mockResolvedValueOnce({ logs: SECOND_LOG });
    const { view: secondView } = await renderScreen();
    expect(await screen.findByText(SECOND_INFO.server_version)).toBeTruthy();
    expect(await screen.findByText(SECOND_TOTALS.messages.toLocaleString())).toBeTruthy();
    expect(screen.getByText('Up to date (258369147 msgs)')).toBeTruthy();

    await invokeConfiguredPress(
      retainConfiguredPress(
        screen.getByRole('button', { name: `Share server URL ${SECOND_ORIGIN}` }),
      ),
    );
    expect(share).toHaveBeenCalledWith({ message: SECOND_ORIGIN });
    await invokeConfiguredPress(
      retainConfiguredPress(screen.getByRole('button', { name: 'Sync Now' })),
    );
    expect(mockStartSync).toHaveBeenCalledTimes(1);
    await invokeConfiguredPress(
      retainConfiguredPress(screen.getByRole('button', { name: 'Server Health' })),
    );
    expect(mockPush).toHaveBeenCalledWith('/server-health');

    await invokeConfiguredPress(
      retainConfiguredPress(screen.getByRole('button', { name: 'Show Pairing QR' })),
    );
    const secondPayload = buildSetupQr(SECOND_ORIGIN, SECOND_PASSWORD);
    const secondPreRevealTree = JSON.stringify(secondView.toJSON());
    expect(secondPreRevealTree).not.toContain(SECOND_PASSWORD);
    expect(secondPreRevealTree).not.toContain(secondPayload);
    await fireEvent.press(await screen.findByRole('button', { name: 'Reveal QR Code' }));
    expect(mockQrCode).toHaveBeenLastCalledWith({
      value: secondPayload,
      size: 260,
      testID: 'pairing-qr-code',
    });
    await fireEvent.press(screen.getByLabelText('Close pairing QR'));

    await invokeConfiguredPress(
      retainConfiguredPress(screen.getByRole('button', { name: 'View Server Logs' })),
    );
    expect(await screen.findByText(SECOND_LOG)).toBeTruthy();
    expect(mockHttpPost).toHaveBeenLastCalledWith('/admin/command', expect.anything(), {
      json: { channel: 'get-logs', data: { count: 500 } },
    });
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

  it('shows the "unsupported" copy (not connection-blaming) when the dispatcher 404s', async () => {
    // serverStatTotals re-throws Unimplemented when EVERY channel was a dispatcher 404 —
    // an old server or a reverse proxy blocking /api/v1/admin/*.
    mockStats.mockRejectedValueOnce(new UnimplementedEndpointError('/admin/command'));
    await renderScreen();
    expect(await screen.findByText(/doesn.t expose statistics/)).toBeTruthy();
    expect(screen.queryByText(/Check your connection/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Destructive ACTIONS: the restart trio + log fetch.
// ---------------------------------------------------------------------------

/**
 * Render, then wait for all three mount queries (info/stats/ping) to land. The ACTIONS tests
 * finish fast; without this they can unmount while a query is still in flight and its setState
 * lands outside act() (noisy, and it bleeds into the next test).
 */
async function renderSettledScreen(): Promise<void> {
  await renderScreen();
  await screen.findByText('9.9.9'); // server info
  await screen.findByText('42'); // statistics
  await screen.findByText(/Reachable/); // ping
}

async function settleInitialMotionPreference(): Promise<void> {
  await waitFor(() => expect(mockIsReduceMotionEnabled).toHaveBeenCalledTimes(1));
  await act(async () => {
    await Promise.resolve();
  });
}

async function emitReduceMotion(enabled: boolean): Promise<void> {
  expect(reduceMotionListeners).toHaveLength(1);
  await act(async () => {
    reduceMotionListeners[0]?.(enabled);
  });
}

async function openPairingQr(): Promise<ReturnType<typeof screen.getByTestId>> {
  await invokeConfiguredPress(
    retainConfiguredPress(screen.getByRole('button', { name: 'Show Pairing QR' })),
  );
  return screen.findByTestId('pairing-qr-modal');
}

async function closePairingQr(): Promise<void> {
  await fireEvent.press(screen.getByRole('button', { name: 'Close pairing QR' }));
  await waitFor(() => expect(screen.queryByTestId('pairing-qr-modal')).toBeNull());
}

async function openServerLogs(): Promise<ReturnType<typeof screen.getByTestId>> {
  await invokeConfiguredPress(
    retainConfiguredPress(screen.getByRole('button', { name: 'View Server Logs' })),
  );
  return screen.findByTestId('server-logs-modal');
}

async function closeServerLogs(): Promise<void> {
  await fireEvent.press(screen.getByRole('button', { name: 'Close server logs' }));
  await waitFor(() => expect(screen.queryByTestId('server-logs-modal')).toBeNull());
}

/** Press an ACTIONS row and return the confirm dialog it enqueued (AppDialog isn't mounted here,
 *  so the dialog only exists in the store — which is exactly where the button handlers live). */
async function pressRowAndGetConfirm(label: string): Promise<DialogRequest> {
  fireEvent.press(await screen.findByText(label));
  await waitFor(() => expect(useDialogStore.getState().current?.title).toBe(label));
  return useDialogStore.getState().current as DialogRequest;
}

/** Mimic AppDialog's button press exactly: dismiss the dialog FIRST, then run its handler. */
async function pressDialogButton(dlg: DialogRequest, text: string): Promise<void> {
  const btn = dlg.buttons.find((b) => b.text === text);
  expect(btn).toBeTruthy();
  await act(async () => {
    useDialogStore.getState().dismiss();
    btn?.onPress?.();
  });
}

const RESTARTS = [
  {
    label: 'Restart iMessage',
    channel: 'restart-imessage',
    style: 'default' as const,
    okMsg: 'Messages is restarting.',
  },
  {
    label: 'Restart Services',
    channel: 'soft-restart',
    style: 'default' as const,
    okMsg: 'Services are restarting.',
  },
  {
    label: 'Restart Server',
    channel: 'hard-restart',
    style: 'destructive' as const,
    okMsg: 'The server is restarting — reconnecting shortly.',
  },
];

describe('ServerManagementScreen — destructive restart actions', () => {
  it.each(RESTARTS)(
    '$label asks first, then posts the "$channel" admin channel',
    async ({ label, channel, style, okMsg }) => {
      await renderSettledScreen();
      const dlg = await pressRowAndGetConfirm(label);

      // Confirm shape: Cancel + the action, and the FULL restart is flagged destructive (red).
      expect(dlg.buttons.map((b) => ({ text: b.text, style: b.style }))).toEqual([
        { text: 'Cancel', style: 'cancel' },
        { text: label, style },
      ]);
      // `confirmThen` must NOT fire the action just for opening the sheet. `run` calls `fn()`
      // synchronously, so had it done so the post would already be recorded.
      expect(mockHttpPost).not.toHaveBeenCalled();

      await pressDialogButton(dlg, label);

      expect(mockHttpPost).toHaveBeenCalledTimes(1);
      expect(mockHttpPost).toHaveBeenCalledWith('/admin/command', expect.anything(), {
        json: { channel, data: undefined },
      });
      // …and the outcome is reported with this action's own success copy.
      await waitFor(() => expect(useDialogStore.getState().current?.title).toBe('Server'));
      expect(useDialogStore.getState().current?.message).toBe(okMsg);
    },
  );

  it('Cancel closes the confirm without restarting anything', async () => {
    await renderSettledScreen();
    const dlg = await pressRowAndGetConfirm('Restart Server');
    await pressDialogButton(dlg, 'Cancel');

    expect(mockHttpPost).not.toHaveBeenCalled();
    // No follow-up dialog either — cancelling is completely silent.
    expect(useDialogStore.getState().current).toBeNull();
    expect(useDialogStore.getState().queue).toHaveLength(0);
  });

  it('a second tap while a restart is in flight cannot fire it twice (busy guard)', async () => {
    let release: (v: unknown) => void = () => {};
    mockHttpPost.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await renderSettledScreen();
    const dlg = await pressRowAndGetConfirm('Restart Server');
    await pressDialogButton(dlg, 'Restart Server');
    expect(mockHttpPost).toHaveBeenCalledTimes(1);

    // Still in flight → `busy` disables the ACTIONS rows, so a second tap can't even re-open the
    // confirm (the dialog store was dismissed above, so a leaked dialog is visible as `current`).
    await act(async () => {
      fireEvent.press(screen.getByText('Restart Server'));
    });
    expect(useDialogStore.getState().current).toBeNull();
    expect(useDialogStore.getState().queue).toHaveLength(0);
    expect(mockHttpPost).toHaveBeenCalledTimes(1);
    // A sibling action is locked out too (one `busy` slot for the whole section).
    await act(async () => {
      fireEvent.press(screen.getByText('Restart iMessage'));
    });
    expect(useDialogStore.getState().current).toBeNull();
    expect(mockHttpPost).toHaveBeenCalledTimes(1);

    // Once it settles the guard releases — the row works again (i.e. it's a guard, not a deadlock).
    await act(async () => {
      release({});
    });
    await waitFor(() => expect(useDialogStore.getState().current?.title).toBe('Server'));
    await act(async () => {
      useDialogStore.getState().dismiss();
    });
    await pressRowAndGetConfirm('Restart Server');
  });

  it('reports an unsupported restart as such instead of blaming the connection', async () => {
    mockHttpPost.mockRejectedValue(new ApiError('bad_request', 'Not Found', 404));
    await renderSettledScreen();
    const dlg = await pressRowAndGetConfirm('Restart Services');
    await pressDialogButton(dlg, 'Restart Services');
    await waitFor(() => expect(useDialogStore.getState().current?.title).toBe('Server'));
    // adminCommand remaps a 404 → UnimplementedEndpointError; failCopy then says "isn't supported".
    expect(useDialogStore.getState().current?.message).toBe(
      'Restart Services isn’t supported on this server.',
    );
  });

  it('does not run a confirm callback retained from the previous account', async () => {
    await renderSettledScreen();
    const dlg = await pressRowAndGetConfirm('Restart Server');

    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    await pressDialogButton(dlg, 'Restart Server');

    expect(mockHttpPost).not.toHaveBeenCalled();
    expect(useDialogStore.getState().current).toBeNull();
  });

  it.each(['success', 'rejection'] as const)(
    'holds Disconnect for an admitted restart %s and suppresses its old-account dialog',
    async (outcome) => {
      const response = deferred<unknown>();
      const rawError = `management-old-restart-${outcome}-error-a7c2`;
      mockHttpPost.mockReturnValueOnce(response.promise);
      await renderSettledScreen();
      const dlg = await pressRowAndGetConfirm('Restart Server');
      await pressDialogButton(dlg, 'Restart Server');
      await waitFor(() => expect(mockHttpPost).toHaveBeenCalledTimes(1));

      let drained = false;
      let drain!: Promise<void>;
      await act(async () => {
        drain = pauseRealtimeDeliveries().then(() => {
          drained = true;
        });
        await Promise.resolve();
      });
      expect(drained).toBe(false);

      await act(async () => {
        if (outcome === 'success') response.resolve({});
        else response.reject(new Error(rawError));
        await response.promise.catch(() => undefined);
        await drain;
      });
      expect(useDialogStore.getState().current).toBeNull();
      expect(JSON.stringify(useDialogStore.getState())).not.toContain(rawError);
      resumeRealtimeDeliveries();
    },
  );
});

describe('ServerManagementScreen — View Server Logs', () => {
  it('fetches the "get-logs" channel (no confirm) and shows the tail in the modal', async () => {
    mockHttpPost.mockResolvedValue({ logs: 'boot: ok\nnext line' });
    await renderSettledScreen();
    const row = await screen.findByText('View Server Logs');
    // act-wrapped: the fetch settles in a microtask and flips `logs`/`busy` state.
    await act(async () => {
      fireEvent.press(row);
    });

    await waitFor(() =>
      expect(mockHttpPost).toHaveBeenCalledWith('/admin/command', expect.anything(), {
        json: { channel: 'get-logs', data: { count: 500 } },
      }),
    );
    expect(await screen.findByText('boot: ok\nnext line')).toBeTruthy();
    // Reading logs is non-destructive: it is the one ACTIONS row with no confirm gate.
    expect(useDialogStore.getState().current).toBeNull();
  });

  it('uses fixed log-rejection copy and releases busy so a current retry succeeds', async () => {
    const rawError = 'management-current-log-error-61f8';
    mockHttpPost
      .mockRejectedValueOnce(new Error(rawError))
      .mockResolvedValueOnce({ logs: SECOND_LOG });
    await renderSettledScreen();
    const row = await screen.findByText('View Server Logs');
    // act-wrapped: the fetch settles in a microtask and flips `logs`/`busy` state.
    await act(async () => {
      fireEvent.press(row);
    });

    await waitFor(() => expect(useDialogStore.getState().current?.title).toBe('Server'));
    expect(useDialogStore.getState().current?.message).toBe(
      'Couldn’t fetch logs. Check your connection.',
    );
    expect(JSON.stringify(useDialogStore.getState().current)).not.toContain(rawError);
    // The modal stays closed — its Done button is the only thing rendered exclusively inside it.
    await expect(
      screen.findByLabelText('Close server logs', {}, { timeout: 400 }),
    ).rejects.toBeTruthy();

    await act(async () => {
      useDialogStore.getState().dismiss();
    });
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'View Server Logs' }).props.accessibilityState?.disabled,
      ).not.toBe(true),
    );
    await fireEvent.press(screen.getByRole('button', { name: 'View Server Logs' }));
    expect(await screen.findByText(SECOND_LOG)).toBeTruthy();
    expect(mockHttpPost).toHaveBeenCalledTimes(2);
  });

  it.each(['success', 'rejection'] as const)(
    'drains an admitted old-account log %s without publishing its result',
    async (outcome) => {
      const response = deferred<{ logs: string }>();
      const rawError = `management-old-log-${outcome}-error-18d3`;
      mockHttpPost.mockReturnValueOnce(response.promise);
      await renderSettledScreen();
      fireEvent.press(await screen.findByText('View Server Logs'));
      await waitFor(() => expect(mockHttpPost).toHaveBeenCalledTimes(1));

      let drained = false;
      let drain!: Promise<void>;
      await act(async () => {
        drain = pauseRealtimeDeliveries().then(() => {
          drained = true;
        });
        await Promise.resolve();
      });
      expect(drained).toBe(false);

      await act(async () => {
        if (outcome === 'success') response.resolve({ logs: PRIVATE_LOG });
        else response.reject(new Error(rawError));
        await response.promise.catch(() => undefined);
        await drain;
      });
      expect(screen.queryByText(PRIVATE_LOG)).toBeNull();
      expect(screen.queryByText(rawError)).toBeNull();
      expect(screen.queryByLabelText('Close server logs')).toBeNull();
      expect(JSON.stringify(useDialogStore.getState().current)).not.toContain(rawError);
      expect(useDialogStore.getState().current).toBeNull();
      resumeRealtimeDeliveries();
    },
  );
});

describe('ServerManagementScreen — Reduce Motion modal openings', () => {
  it('opens safely while the preference is unresolved and only slides after a later false result', async () => {
    const preference = deferred<boolean>();
    mockIsReduceMotionEnabled.mockReturnValue(preference.promise);
    await renderSettledScreen();

    expect((await openPairingQr()).props.animationType).toBe('none');
    await act(async () => {
      preference.resolve(false);
      await preference.promise;
    });
    expect(screen.getByTestId('pairing-qr-modal').props.animationType).toBe('none');

    await closePairingQr();
    expect((await openPairingQr()).props.animationType).toBe('slide');
  });

  it('suppresses both modal slides when Reduce Motion is initially enabled', async () => {
    mockIsReduceMotionEnabled.mockResolvedValue(true);
    mockHttpPost.mockResolvedValueOnce({ logs: PRIVATE_LOG });
    await renderSettledScreen();
    await settleInitialMotionPreference();

    expect((await openPairingQr()).props.animationType).toBe('none');
    await closePairingQr();
    expect((await openServerLogs()).props.animationType).toBe('none');
    expect(await screen.findByText(PRIVATE_LOG)).toBeTruthy();
  });

  it('retains both existing modal slides when Reduce Motion is initially disabled', async () => {
    mockIsReduceMotionEnabled.mockResolvedValue(false);
    mockHttpPost.mockResolvedValueOnce({ logs: PRIVATE_LOG });
    await renderSettledScreen();
    await settleInitialMotionPreference();

    expect((await openPairingQr()).props.animationType).toBe('slide');
    await closePairingQr();
    expect((await openServerLogs()).props.animationType).toBe('slide');
    expect(await screen.findByText(PRIVATE_LOG)).toBeTruthy();
  });

  it('does not recreate an open modal when the native query rejects, then restores future slides', async () => {
    const preference = deferred<boolean>();
    mockIsReduceMotionEnabled.mockReturnValue(preference.promise);
    await renderSettledScreen();

    expect((await openPairingQr()).props.animationType).toBe('none');
    await act(async () => {
      preference.reject(new Error('motion preference unavailable'));
      await preference.promise.catch(() => undefined);
    });
    expect(screen.getByTestId('pairing-qr-modal').props.animationType).toBe('none');

    await closePairingQr();
    expect((await openPairingQr()).props.animationType).toBe('slide');
  });

  it('preserves an open revealed QR when motion becomes reduced and suppresses its next opening', async () => {
    await renderSettledScreen();
    await settleInitialMotionPreference();
    const retainedOpen = retainConfiguredPress(
      screen.getByRole('button', { name: 'Show Pairing QR' }),
    );

    await invokeConfiguredPress(retainedOpen);
    expect((await screen.findByTestId('pairing-qr-modal')).props.animationType).toBe('slide');
    await fireEvent.press(screen.getByRole('button', { name: 'Reveal QR Code' }));
    expect(await screen.findByTestId('pairing-qr-code')).toBeTruthy();

    await emitReduceMotion(true);
    await invokeConfiguredPress(retainedOpen);
    expect(screen.getByTestId('pairing-qr-modal').props.animationType).toBe('slide');
    expect(screen.getByTestId('pairing-qr-code')).toBeTruthy();

    await closePairingQr();
    expect((await openPairingQr()).props.animationType).toBe('none');
    expect(screen.queryByTestId('pairing-qr-code')).toBeNull();
  });

  it('preserves open logs and captures the preference when a later response is published', async () => {
    mockHttpPost.mockResolvedValueOnce({ logs: PRIVATE_LOG });
    await renderSettledScreen();
    await settleInitialMotionPreference();

    expect((await openServerLogs()).props.animationType).toBe('slide');
    expect(await screen.findByText(PRIVATE_LOG)).toBeTruthy();
    await emitReduceMotion(true);
    expect(screen.getByTestId('server-logs-modal').props.animationType).toBe('slide');
    expect(screen.getByText(PRIVATE_LOG)).toBeTruthy();

    await closeServerLogs();
    const response = deferred<{ logs: string }>();
    mockHttpPost.mockReturnValueOnce(response.promise);
    await invokeConfiguredPress(
      retainConfiguredPress(screen.getByRole('button', { name: 'View Server Logs' })),
    );
    await waitFor(() => expect(mockHttpPost).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('server-logs-modal')).toBeNull();

    await emitReduceMotion(false);
    await act(async () => {
      response.resolve({ logs: SECOND_LOG });
      await response.promise;
    });
    expect((await screen.findByTestId('server-logs-modal')).props.animationType).toBe('slide');
    expect(await screen.findByText(SECOND_LOG)).toBeTruthy();
  });

  it('keeps an open none modal intact when slides become allowed and slides on the next opening', async () => {
    mockIsReduceMotionEnabled.mockResolvedValue(true);
    await renderSettledScreen();
    await settleInitialMotionPreference();
    const retainedOpen = retainConfiguredPress(
      screen.getByRole('button', { name: 'Show Pairing QR' }),
    );

    await invokeConfiguredPress(retainedOpen);
    expect((await screen.findByTestId('pairing-qr-modal')).props.animationType).toBe('none');
    await emitReduceMotion(false);
    await invokeConfiguredPress(retainedOpen);
    expect(screen.getByTestId('pairing-qr-modal').props.animationType).toBe('none');

    await closePairingQr();
    expect((await openPairingQr()).props.animationType).toBe('slide');
  });

  it.each([
    ['false event over a stale true query', false, true, 'slide'],
    ['true event over a stale false query', true, false, 'none'],
  ] as const)('keeps the %s', async (_label, eventValue, staleQueryValue, expectedAnimation) => {
    const preference = deferred<boolean>();
    mockIsReduceMotionEnabled.mockReturnValue(preference.promise);
    await renderSettledScreen();
    await waitFor(() => expect(mockIsReduceMotionEnabled).toHaveBeenCalledTimes(1));

    await emitReduceMotion(eventValue);
    await act(async () => {
      preference.resolve(staleQueryValue);
      await preference.promise;
    });

    expect((await openPairingQr()).props.animationType).toBe(expectedAnimation);
  });

  it('removes its listener and ignores late native callbacks and query rejection after unmount', async () => {
    const preference = deferred<boolean>();
    mockIsReduceMotionEnabled.mockReturnValue(preference.promise);
    const { view } = await renderScreen();
    await screen.findByText('9.9.9');
    await screen.findByText('42');
    await screen.findByText(/Reachable/);
    await waitFor(() => expect(reduceMotionListeners).toHaveLength(1));
    const lateListener = reduceMotionListeners[0];

    await view.unmount();
    expect(removeReduceMotionListeners).toHaveLength(1);
    expect(removeReduceMotionListeners[0]).toHaveBeenCalledTimes(1);

    await act(async () => {
      lateListener?.(true);
      preference.reject(new Error('late native preference failure'));
      await preference.promise.catch(() => undefined);
    });
    expect(mockAddEventListener).toHaveBeenCalledTimes(1);
    expect(removeReduceMotionListeners[0]).toHaveBeenCalledTimes(1);
  });
});
