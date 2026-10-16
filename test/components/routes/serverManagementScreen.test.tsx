/**
 * ServerManagementScreen route (app/(app)/server-management.tsx): the STATUS/STATISTICS
 * sections are now TanStack Query-backed with the captured account generation and current
 * transport revision appended to every key.
 *
 * Locks in the query wiring:
 *   - a resolved ping renders "Reachable · N ms"; a rejected one renders "Unreachable";
 *   - stats numbers render from the stats query; total failure shows the INLINE error row,
 *     and "Refresh Statistics" refetches (clearing the error on success);
 *   - the server-info query populates the session store (version/macOS/private-API rows).
 *
 * It also locks in the supported local/read-only actions and the absence of retired remote
 * restart and server-log controls.
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
const mockQrCode = jest.fn();
const mockBeginScopedCredentialReplacement = jest.fn();
const mockBeginScopedCredentialUpgrade = jest.fn();
const mockDiscardScopedCredentialUpgradeCandidate = jest.fn();
const mockInspectScopedCredentialUpgradeStatus = jest.fn();
const mockIsReduceMotionEnabled = AccessibilityInfo.isReduceMotionEnabled as jest.MockedFunction<
  typeof AccessibilityInfo.isReduceMotionEnabled
>;
const mockAddEventListener = AccessibilityInfo.addEventListener as jest.Mock;

let reduceMotionListeners: ((enabled: boolean) => void)[];
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
jest.mock('@/services', () => ({
  beginScopedCredentialReplacement: (...args: unknown[]) =>
    mockBeginScopedCredentialReplacement(...args),
  beginScopedCredentialUpgrade: (...args: unknown[]) => mockBeginScopedCredentialUpgrade(...args),
  discardScopedCredentialUpgradeCandidate: (...args: unknown[]) =>
    mockDiscardScopedCredentialUpgradeCandidate(...args),
  http: {},
  inspectScopedCredentialUpgradeStatus: (...args: unknown[]) =>
    mockInspectScopedCredentialUpgradeStatus(...args),
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
import { UnimplementedEndpointError } from '@core/api/errors';
// eslint-disable-next-line import/first
import { buildSetupQr } from '@features/setup/qr';
// eslint-disable-next-line import/first
import { useSessionStore } from '@state/sessionStore';
// eslint-disable-next-line import/first
import { useSyncStore } from '@state/syncStore';
// eslint-disable-next-line import/first
import { startSync } from '@/services';
// eslint-disable-next-line import/first
import { useDialogStore } from '@ui/dialog/dialogStore';

/** Answer the current app dialog the way AppDialog does: close it, then run the chosen button. */
async function answerDialog(buttonText: string): Promise<void> {
  const dialog = useDialogStore.getState().current;
  const button = dialog?.buttons.find((candidate) => candidate.text === buttonText);
  if (!dialog || !button) throw new Error(`Expected a dialog with a ${buttonText} button`);
  await act(async () => {
    useDialogStore.getState().dismissById(dialog.id);
    button.onPress?.();
  });
}
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
const PRIVATE_SCOPED_CREDENTIAL = `bbd_device_v1_${'s'.repeat(43)}`;
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
  useSessionStore.setState({
    origin: 'https://gator.example',
    password: 'management-default-password',
    serverInfo: null,
  });
  useSyncStore.setState({ status: 'idle', chats: 0, messages: 0, error: null });
  useDialogStore.setState({ current: null, queue: [] });
  mockBeginScopedCredentialUpgrade.mockResolvedValue({ kind: 'adopted' });
  mockBeginScopedCredentialReplacement.mockResolvedValue({ kind: 'adopted' });
  mockDiscardScopedCredentialUpgradeCandidate.mockResolvedValue({ kind: 'discarded' });
  mockInspectScopedCredentialUpgradeStatus.mockResolvedValue({ kind: 'none' });
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
    expect(screen.getByText('Retired in this release')).toBeTruthy();
    await waitFor(() =>
      expect(useSessionStore.getState().serverInfo?.server_version).toBe('9.9.9'),
    );
  });

  it.each([
    [true, 'Read-only lookup available'],
    [false, 'Not available'],
    [undefined, 'Unknown'],
  ] as const)(
    'reports iMessage availability capability %s without enabling broad Private API access',
    async (supported, expected) => {
      mockInfo.mockResolvedValue({
        server_version: '9.9.9',
        os_version: '26.0',
        private_api: true,
        proxy_service: 'zrok',
        supports_imessage_availability: supported,
      });

      await renderScreen();
      expect(await screen.findByText('9.9.9')).toBeTruthy();
      expect(screen.getByText('iMessage availability')).toBeTruthy();
      expect(screen.getByText(expected)).toBeTruthy();
      expect(screen.getByText('Retired in this release')).toBeTruthy();
    },
  );

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

      const firstQueries = ['ping', 'stats', 'info'].map((kind) => {
        const query = client.getQueryCache().findAll({ queryKey: ['server', kind] })[0];
        expect(query?.queryKey.slice(0, 3)).toEqual(['server', kind, expect.any(Number)]);
        expect(query?.queryKey[3]).toEqual(expect.any(Number));
        return query;
      });
      const firstGenerations = firstQueries.map((query) => query?.queryKey[2]);
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
        for (const query of firstQueries) {
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

  it('starts fresh queries after a same-account origin rotation and suppresses old-origin results', async () => {
    const oldPing = deferred<{ pong: boolean }>();
    const oldStats = deferred<typeof PRIVATE_TOTALS>();
    const oldInfo = deferred<typeof PRIVATE_INFO>();
    arrangePrivateServer();
    mockPing.mockReset().mockReturnValueOnce(oldPing.promise).mockResolvedValue({ pong: true });
    mockStats.mockReset().mockReturnValueOnce(oldStats.promise).mockResolvedValue(SECOND_TOTALS);
    mockInfo.mockReset().mockReturnValueOnce(oldInfo.promise).mockResolvedValue(SECOND_INFO);

    const client = makeQueryClient();
    const { view } = await renderScreen(client);
    await waitFor(() => {
      expect(mockPing).toHaveBeenCalledTimes(1);
      expect(mockStats).toHaveBeenCalledTimes(1);
      expect(mockInfo).toHaveBeenCalledTimes(1);
    });
    const firstQuery = client.getQueryCache().findAll({ queryKey: ['server', 'ping'] })[0];
    const generation = firstQuery?.queryKey[2] as number;
    const oldRevision = firstQuery?.queryKey[3] as number;

    await act(async () => {
      useSessionStore.getState().rotateOrigin(SECOND_ORIGIN, SECOND_INFO);
    });
    const currentRevision = useSessionStore.getState().transportRevision;
    expect(currentRevision).not.toBe(oldRevision);
    expect(await screen.findByText(SECOND_INFO.server_version)).toBeTruthy();
    expect(await screen.findByText(SECOND_TOTALS.messages.toLocaleString())).toBeTruthy();
    await waitFor(() => {
      expect(mockPing).toHaveBeenCalledTimes(2);
      expect(mockStats).toHaveBeenCalledTimes(2);
      expect(mockInfo).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      oldPing.resolve({ pong: true });
      oldStats.resolve(PRIVATE_TOTALS);
      oldInfo.resolve(PRIVATE_INFO);
      await Promise.all([oldPing.promise, oldStats.promise, oldInfo.promise]);
    });

    for (const kind of ['ping', 'stats', 'info']) {
      const queries = client.getQueryCache().findAll({ queryKey: ['server', kind] });
      expect(queries).toHaveLength(2);
      expect(queries.map((query) => query.queryKey[2])).toEqual([generation, generation]);
      expect(new Set(queries.map((query) => query.queryKey[3]))).toEqual(
        new Set([oldRevision, currentRevision]),
      );
    }
    const oldCache = ['ping', 'stats', 'info'].map((kind) =>
      client
        .getQueryCache()
        .find({ queryKey: ['server', kind, generation, oldRevision], exact: true }),
    );
    expect(JSON.stringify(oldCache.map((query) => query?.state))).not.toContain(
      PRIVATE_INFO.server_version,
    );
    expect(JSON.stringify(oldCache.map((query) => query?.state))).not.toContain(
      String(PRIVATE_TOTALS.messages),
    );
    const currentTree = JSON.stringify(view.toJSON());
    expect(currentTree).not.toContain(PRIVATE_INFO.server_version);
    expect(currentTree).not.toContain(PRIVATE_TOTALS.messages.toLocaleString());
    expect(useSessionStore.getState().serverInfo?.server_version).toBe(SECOND_INFO.server_version);
  });
});

describe('ServerManagementScreen — ordinary sensitive presentation and account ownership', () => {
  it('never offers or renders a reusable pairing QR for a scoped device credential', async () => {
    useSessionStore.setState({
      origin: PRIVATE_ORIGIN,
      password: PRIVATE_SCOPED_CREDENTIAL,
      serverInfo: null,
    });
    mockInfo.mockResolvedValue({ ...PRIVATE_INFO, supports_scoped_device_credentials: true });
    mockStats.mockResolvedValue(PRIVATE_TOTALS);
    const { view } = await renderScreen();

    expect(await screen.findByText(PRIVATE_INFO.server_version)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show Pairing QR' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pair This Device' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Replace Device Credential' })).toBeTruthy();
    expect(screen.getByText('Device credential')).toBeTruthy();
    expect(screen.getByText('Saved on phone')).toBeTruthy();
    expect(screen.getByText('Mac dashboard only')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Refresh Statistics' })).toBeNull();
    expect(mockStats).not.toHaveBeenCalled();
    expect(screen.queryByTestId('pairing-qr-modal')).toBeNull();
    expect(JSON.stringify(view.toJSON())).not.toContain(PRIVATE_SCOPED_CREDENTIAL);
    expect(mockQrCode).not.toHaveBeenCalled();
  });

  it('replaces a scoped credential without a QR and says the old one was revoked (M130)', async () => {
    useSessionStore.setState({
      origin: PRIVATE_ORIGIN,
      password: PRIVATE_SCOPED_CREDENTIAL,
      serverInfo: null,
    });
    mockInfo.mockResolvedValue({ ...PRIVATE_INFO, supports_scoped_device_credentials: true });
    await renderScreen();

    await fireEvent.press(screen.getByRole('button', { name: 'Replace Device Credential' }));
    expect(screen.getByText(/Devices → Paired Client Credentials/)).toBeTruthy();
    expect(screen.queryByTestId('pairing-qr-modal')).toBeNull();
    const newCredential = `bbd_device_v1_${'n'.repeat(43)}`;
    await fireEvent.changeText(screen.getByLabelText('Paired-client credential'), newCredential);
    await fireEvent.press(screen.getByRole('button', { name: 'Use New Credential' }));

    await waitFor(() =>
      expect(mockBeginScopedCredentialReplacement).toHaveBeenCalledWith(newCredential),
    );
    expect(mockBeginScopedCredentialUpgrade).not.toHaveBeenCalled();
    expect(screen.queryByTestId('device-credential-modal')).toBeNull();
    expect(useDialogStore.getState().current).toMatchObject({
      title: 'Credential replaced',
      message: expect.stringContaining('the old credential has been revoked'),
    });
  });

  async function replaceWith(outcome: object): Promise<string> {
    useSessionStore.setState({
      origin: PRIVATE_ORIGIN,
      password: PRIVATE_SCOPED_CREDENTIAL,
      serverInfo: null,
    });
    mockInfo.mockResolvedValue({ ...PRIVATE_INFO, supports_scoped_device_credentials: true });
    mockBeginScopedCredentialReplacement.mockResolvedValue(outcome);
    await renderScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Replace Device Credential' }));
    const newCredential = `bbd_device_v1_${'n'.repeat(43)}`;
    await fireEvent.changeText(screen.getByLabelText('Paired-client credential'), newCredential);
    await fireEvent.press(screen.getByRole('button', { name: 'Use New Credential' }));
    return newCredential;
  }

  it('says when the old credential will be revoked once the Mac is reachable (M130)', async () => {
    await replaceWith({ kind: 'adopted-revocation-pending' });
    await waitFor(() =>
      expect(useDialogStore.getState().current).toMatchObject({
        title: 'Credential replaced',
        message: expect.stringContaining('revoke the old credential automatically'),
      }),
    );
  });

  it('keeps the entry while an earlier replacement still revokes its old credential (M130)', async () => {
    const newCredential = await replaceWith({ kind: 'retry', stage: 'previous-revocation' });
    expect(await screen.findByText(/previous replacement is still revoking/)).toBeTruthy();
    expect(screen.getByLabelText('Paired-client credential').props.value).toBe(newCredential);
    expect(screen.getByLabelText('Paired-client credential').props.editable).toBe(true);
  });

  it('keeps an unconfirmed replacement entry available to retry', async () => {
    useSessionStore.setState({
      origin: PRIVATE_ORIGIN,
      password: PRIVATE_SCOPED_CREDENTIAL,
      serverInfo: null,
    });
    mockInfo.mockResolvedValue({ ...PRIVATE_INFO, supports_scoped_device_credentials: true });
    mockBeginScopedCredentialReplacement.mockResolvedValue({ kind: 'retry', stage: 'storage' });
    await renderScreen();

    await fireEvent.press(screen.getByRole('button', { name: 'Replace Device Credential' }));
    const newCredential = `bbd_device_v1_${'n'.repeat(43)}`;
    await fireEvent.changeText(screen.getByLabelText('Paired-client credential'), newCredential);
    await fireEvent.press(screen.getByRole('button', { name: 'Use New Credential' }));

    expect(
      await screen.findByText(/could not confirm that the replacement was saved/),
    ).toBeTruthy();
    expect(screen.getByLabelText('Paired-client credential').props.value).toBe(newCredential);
    expect(screen.getByLabelText('Paired-client credential').props.editable).toBe(true);
    expect(screen.getByRole('button', { name: 'Use New Credential' })).toBeTruthy();
  });

  it('lets a scoped session remove a candidate the server could not verify', async () => {
    useSessionStore.setState({
      origin: PRIVATE_ORIGIN,
      password: PRIVATE_SCOPED_CREDENTIAL,
      serverInfo: null,
    });
    mockInfo.mockResolvedValue({ ...PRIVATE_INFO, supports_scoped_device_credentials: true });
    mockBeginScopedCredentialReplacement.mockResolvedValue({
      kind: 'retry',
      stage: 'candidate-validation',
    });
    mockInspectScopedCredentialUpgradeStatus
      .mockResolvedValueOnce({ kind: 'none' })
      .mockResolvedValue({ kind: 'candidate' });
    await renderScreen();

    await fireEvent.press(screen.getByRole('button', { name: 'Replace Device Credential' }));
    await fireEvent.changeText(
      screen.getByLabelText('Paired-client credential'),
      `bbd_device_v1_${'n'.repeat(43)}`,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Use New Credential' }));

    expect(await screen.findByText(/server could not verify it/)).toBeTruthy();
    expect(screen.getByLabelText('Paired-client credential').props.value).toBe('');
    await fireEvent.press(screen.getByRole('button', { name: 'Revoke and Remove Replacement' }));
    expect(useDialogStore.getState().current).toMatchObject({
      title: 'Revoke the replacement credential?',
    });
    expect(mockDiscardScopedCredentialUpgradeCandidate).not.toHaveBeenCalled();
    await answerDialog('Revoke and Remove');
    expect(mockDiscardScopedCredentialUpgradeCandidate).toHaveBeenCalledTimes(1);
    expect(useDialogStore.getState().current).toMatchObject({
      title: 'Credential removed',
      message: expect.stringContaining('previous paired-client credential'),
    });
  });

  it('shows a push-owner conflict with a saved retry and no revocation action', async () => {
    useSessionStore.setState({
      origin: PRIVATE_ORIGIN,
      password: PRIVATE_SCOPED_CREDENTIAL,
      serverInfo: null,
    });
    mockInfo.mockResolvedValue({ ...PRIVATE_INFO, supports_scoped_device_credentials: true });
    mockBeginScopedCredentialReplacement.mockResolvedValue({
      kind: 'blocked',
      reason: 'push-target-owned',
    });
    mockInspectScopedCredentialUpgradeStatus
      .mockResolvedValueOnce({ kind: 'none' })
      .mockResolvedValue({ kind: 'in-progress' });
    await renderScreen();

    await fireEvent.press(screen.getByRole('button', { name: 'Replace Device Credential' }));
    await fireEvent.changeText(
      screen.getByLabelText('Paired-client credential'),
      `bbd_device_v1_${'n'.repeat(43)}`,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Use New Credential' }));
    expect(await screen.findByText(/could not move this phone’s notifications/)).toBeTruthy();
    expect(await screen.findByText(/remove only the old notification registration/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Revoke and Remove Credential' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Revoke and Remove Replacement' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Use New Credential' })).toBeNull();
  });

  it('restores a scoped candidate discard action after process restart', async () => {
    useSessionStore.setState({
      origin: PRIVATE_ORIGIN,
      password: PRIVATE_SCOPED_CREDENTIAL,
      serverInfo: null,
    });
    mockInfo.mockResolvedValue({ ...PRIVATE_INFO, supports_scoped_device_credentials: true });
    mockInspectScopedCredentialUpgradeStatus.mockResolvedValue({ kind: 'candidate' });
    await renderScreen();

    await fireEvent.press(screen.getByRole('button', { name: 'Finish Credential Replacement' }));
    expect(screen.getByRole('button', { name: 'Revoke and Remove Replacement' })).toBeTruthy();
    expect(screen.getByLabelText('Paired-client credential').props.editable).toBe(false);
  });

  it('validates and securely submits the device credential created on the Mac', async () => {
    arrangePrivateServer();
    const { view } = await renderScreen();
    expect(await screen.findByText(PRIVATE_INFO.server_version)).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Pair This Device' }));
    const input = await screen.findByLabelText('Paired-client credential');
    expect(input.props.secureTextEntry).toBe(true);
    expect(input.props.autoCapitalize).toBe('none');
    expect(input.props.autoCorrect).toBe(false);

    await fireEvent.changeText(input, 'not-a-device-credential');
    await fireEvent.press(screen.getByRole('button', { name: 'Use Credential' }));
    expect(await screen.findByText(/doesn’t look like a complete/)).toBeTruthy();
    expect(mockBeginScopedCredentialUpgrade).not.toHaveBeenCalled();

    await fireEvent.changeText(input, `  ${PRIVATE_SCOPED_CREDENTIAL}  `);
    await fireEvent.press(screen.getByRole('button', { name: 'Use Credential' }));
    await waitFor(() => {
      expect(mockBeginScopedCredentialUpgrade).toHaveBeenCalledTimes(1);
      expect(mockBeginScopedCredentialUpgrade).toHaveBeenCalledWith(PRIVATE_SCOPED_CREDENTIAL);
    });
    expect(screen.queryByTestId('device-credential-modal')).toBeNull();
    expect(JSON.stringify(view.toJSON())).not.toContain(PRIVATE_SCOPED_CREDENTIAL);
    expect(useDialogStore.getState().current).toMatchObject({
      title: 'Device paired',
      message: 'This phone now uses its own paired-client credential.',
    });
  });

  it('keeps a first-time credential in the form until it is safely stored', async () => {
    arrangePrivateServer();
    await renderScreen();
    expect(await screen.findByText(PRIVATE_INFO.server_version)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Pair This Device' }));
    await fireEvent.changeText(
      await screen.findByLabelText('Paired-client credential'),
      PRIVATE_SCOPED_CREDENTIAL,
    );
    const entry = () => screen.getByLabelText('Paired-client credential').props.value;

    // Nothing was stored, so the Mac's one-time credential must still be here to retry.
    mockBeginScopedCredentialUpgrade.mockResolvedValueOnce({ kind: 'busy' });
    await fireEvent.press(screen.getByRole('button', { name: 'Use Credential' }));
    expect(await screen.findByText(/Another secure connection change is in progress/)).toBeTruthy();
    expect(entry()).toBe(PRIVATE_SCOPED_CREDENTIAL);

    mockBeginScopedCredentialUpgrade.mockResolvedValueOnce({ kind: 'retry', stage: 'storage' });
    await fireEvent.press(screen.getByRole('button', { name: 'Use Credential' }));
    expect(await screen.findByText(/could not confirm that the credential was saved/)).toBeTruthy();
    expect(entry()).toBe(PRIVATE_SCOPED_CREDENTIAL);

    // Once it is stored securely, the form lets go of it.
    mockBeginScopedCredentialUpgrade.mockResolvedValueOnce({
      kind: 'retry',
      stage: 'candidate-validation',
    });
    await fireEvent.press(screen.getByRole('button', { name: 'Use Credential' }));
    expect(
      await screen.findByText(/saved securely, but the server could not verify it/),
    ).toBeTruthy();
    expect(entry()).toBe('');
    expect(mockBeginScopedCredentialUpgrade).toHaveBeenCalledTimes(3);
    expect(mockBeginScopedCredentialUpgrade).toHaveBeenLastCalledWith(PRIVATE_SCOPED_CREDENTIAL);
  });

  it('keeps a first-time entry an older saved attempt blocked, for use once that one is revoked', async () => {
    arrangePrivateServer();
    await renderScreen();
    expect(await screen.findByText(PRIVATE_INFO.server_version)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Pair This Device' }));
    await fireEvent.changeText(
      await screen.findByLabelText('Paired-client credential'),
      PRIVATE_SCOPED_CREDENTIAL,
    );
    const entry = () => screen.getByLabelText('Paired-client credential').props.value;

    // The status read when the screen opened missed an older saved attempt. A conflict is decided
    // before anything is stored, so this entry was never saved and must stay.
    mockBeginScopedCredentialUpgrade.mockResolvedValueOnce({
      kind: 'conflict',
      sameCandidate: false,
    });
    mockInspectScopedCredentialUpgradeStatus.mockResolvedValueOnce({ kind: 'candidate' });
    await fireEvent.press(screen.getByRole('button', { name: 'Use Credential' }));
    expect(await screen.findByText(/Another credential is already saved/)).toBeTruthy();
    expect(entry()).toBe(PRIVATE_SCOPED_CREDENTIAL);

    await fireEvent.press(screen.getByRole('button', { name: 'Revoke and Remove Credential' }));
    await answerDialog('Revoke and Remove');
    await waitFor(() => {
      expect(mockDiscardScopedCredentialUpgradeCandidate).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId('device-credential-modal')).toBeNull();

    // Reopening the form still holds the new entry, ready to use.
    await fireEvent.press(screen.getByRole('button', { name: 'Pair This Device' }));
    expect(entry()).toBe(PRIVATE_SCOPED_CREDENTIAL);
    mockBeginScopedCredentialUpgrade.mockResolvedValueOnce({ kind: 'adopted' });
    await fireEvent.press(screen.getByRole('button', { name: 'Use Credential' }));
    await waitFor(() => {
      expect(mockBeginScopedCredentialUpgrade).toHaveBeenLastCalledWith(PRIVATE_SCOPED_CREDENTIAL);
    });
    expect(mockBeginScopedCredentialUpgrade).toHaveBeenCalledTimes(2);
  });

  it('clears an entry an earlier try already saved when that save is what blocks it', async () => {
    arrangePrivateServer();
    await renderScreen();
    expect(await screen.findByText(PRIVATE_INFO.server_version)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Pair This Device' }));
    await fireEvent.changeText(
      await screen.findByLabelText('Paired-client credential'),
      PRIVATE_SCOPED_CREDENTIAL,
    );

    // An earlier try stored this credential but its confirmation was lost, so it is in custody.
    mockBeginScopedCredentialUpgrade.mockResolvedValueOnce({
      kind: 'conflict',
      sameCandidate: true,
    });
    mockInspectScopedCredentialUpgradeStatus.mockResolvedValueOnce({ kind: 'candidate' });
    await fireEvent.press(screen.getByRole('button', { name: 'Use Credential' }));

    expect(await screen.findByText(/This credential is already saved securely/)).toBeTruthy();
    expect(screen.getByLabelText('Paired-client credential').props.value).toBe('');
    expect(screen.getByRole('button', { name: 'Revoke and Remove Credential' })).toBeTruthy();
  });

  it('restores a persisted candidate after process death and can revoke it without another paste', async () => {
    arrangePrivateServer();
    mockInspectScopedCredentialUpgradeStatus.mockResolvedValue({ kind: 'candidate' });
    await renderScreen();
    expect(await screen.findByRole('button', { name: 'Finish Device Pairing' })).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Finish Device Pairing' }));
    expect(await screen.findByText(/credential is saved securely/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Revoke and Remove Credential' })).toBeTruthy();
    expect(screen.queryByLabelText('Paired-client credential')?.props.editable).toBe(false);

    await fireEvent.press(screen.getByRole('button', { name: 'Revoke and Remove Credential' }));
    expect(useDialogStore.getState().current).toMatchObject({ title: 'Revoke this credential?' });
    await answerDialog('Cancel');
    expect(mockDiscardScopedCredentialUpgradeCandidate).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByRole('button', { name: 'Revoke and Remove Credential' }));
    await answerDialog('Revoke and Remove');
    await waitFor(() => {
      expect(mockDiscardScopedCredentialUpgradeCandidate).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId('device-credential-modal')).toBeNull();
    expect(useDialogStore.getState().current).toMatchObject({
      title: 'Credential removed',
    });
  });

  it('renders exact sensitive host/a11y data and preserves Share, Health, Deleted, Sync, and QR actions', async () => {
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
    expect(
      ['Restart iMessage', 'Restart Services', 'Restart Server', 'View Server Logs'].map((name) =>
        screen.queryByRole('button', { name }),
      ),
    ).toEqual([null, null, null, null]);

    await invokeConfiguredPress(retainConfiguredPress(shareButton));
    expect(share).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledWith({ message: PRIVATE_ORIGIN });

    await invokeConfiguredPress(
      retainConfiguredPress(screen.getByRole('button', { name: 'Server Health' })),
    );
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/server-health');

    await invokeConfiguredPress(
      retainConfiguredPress(screen.getByRole('button', { name: 'Restore Deleted Conversations' })),
    );
    expect(mockPush).toHaveBeenCalledTimes(2);
    expect(mockPush).toHaveBeenLastCalledWith('/deleted-chats');

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

  it('automatically closes a retired QR, revokes retained A actions, and binds fresh B actions', async () => {
    arrangePrivateServer();
    const firstSyncCopy = 'Up to date (864209753 msgs)';
    useSyncStore.setState({
      status: 'done',
      chats: 753_190_246,
      messages: 864_209_753,
      error: null,
    });
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.sharedAction });
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
    const oldDeletedChats = retainConfiguredPress(
      screen.getByRole('button', { name: 'Restore Deleted Conversations' }),
    );
    const oldPairing = retainConfiguredPress(
      screen.getByRole('button', { name: 'Show Pairing QR' }),
    );
    await invokeConfiguredPress(oldPairing);
    await fireEvent.press(await screen.findByRole('button', { name: 'Reveal QR Code' }));
    expect(await screen.findByTestId('pairing-qr-code')).toBeTruthy();

    await act(async () => {
      await pauseRealtimeDeliveries();
    });

    await waitFor(() => {
      expect(screen.queryByTestId('pairing-qr-code')).toBeNull();
      expect(screen.queryByLabelText('Close pairing QR')).toBeNull();
    });
    const retiredTree = JSON.stringify(view.toJSON());
    expect(retiredTree).not.toContain(PRIVATE_ORIGIN);
    expect(retiredTree).not.toContain(PRIVATE_INFO.server_version);
    expect(retiredTree).not.toContain(PRIVATE_INFO.os_version);
    expect(retiredTree).not.toContain(PRIVATE_INFO.proxy_service);
    expect(retiredTree).not.toContain(PRIVATE_TOTALS.messages.toLocaleString());
    expect(retiredTree).not.toContain(firstSyncCopy);
    expect(retiredTree).not.toContain(PRIVATE_PASSWORD);
    expect(retiredTree).not.toContain(buildSetupQr(PRIVATE_ORIGIN, PRIVATE_PASSWORD));
    expect(screen.getByRole('button', { name: 'Share server URL Unknown' })).toBeTruthy();
    expect(screen.getAllByText('Unknown').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText('Idle')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Restore Deleted Conversations' })).toBeDisabled();

    share.mockClear();
    mockStartSync.mockClear();
    mockPush.mockClear();
    mockQrCode.mockClear();
    await invokeConfiguredPress(oldShare);
    await invokeConfiguredPress(oldSync);
    await invokeConfiguredPress(oldHealth);
    await invokeConfiguredPress(oldDeletedChats);
    await invokeConfiguredPress(oldPairing);
    expect(share).not.toHaveBeenCalled();
    expect(mockStartSync).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockQrCode).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Close pairing QR')).toBeNull();

    await view.unmount();
    resumeRealtimeDeliveries();
    arrangeSecondServer();
    useSyncStore.setState({
      status: 'done',
      chats: 147_258_369,
      messages: 258_369_147,
      error: null,
    });
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
      retainConfiguredPress(screen.getByRole('button', { name: 'Restore Deleted Conversations' })),
    );
    expect(mockPush).toHaveBeenLastCalledWith('/deleted-chats');

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
  });
});

describe('ServerManagementScreen — statistics query', () => {
  it('renders the stat totals', async () => {
    await renderScreen();
    expect(await screen.findByText('42')).toBeTruthy(); // messages
    expect(screen.getByText('6')).toBeTruthy(); // photos
    expect(screen.getByText('2')).toBeTruthy(); // videos
    for (const retiredLabel of ['Chats', 'iMessage Numbers', 'Attachments', 'Locations']) {
      expect(screen.queryByText(retiredLabel)).toBeNull();
    }
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

  it('shows the "unsupported" copy (not connection-blaming) when the typed route is absent', async () => {
    mockStats.mockRejectedValueOnce(new UnimplementedEndpointError('/statistics/snapshot'));
    await renderScreen();
    expect(await screen.findByText(/doesn.t expose statistics/)).toBeTruthy();
    expect(screen.queryByText(/Check your connection/)).toBeNull();
  });
});

/**
 * Render, then wait for all three mount queries (info/stats/ping) to land. The modal tests
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

  it('suppresses the QR modal slide when Reduce Motion is initially enabled', async () => {
    mockIsReduceMotionEnabled.mockResolvedValue(true);
    await renderSettledScreen();
    await settleInitialMotionPreference();

    expect((await openPairingQr()).props.animationType).toBe('none');
  });

  it('retains the QR modal slide when Reduce Motion is initially disabled', async () => {
    mockIsReduceMotionEnabled.mockResolvedValue(false);
    await renderSettledScreen();
    await settleInitialMotionPreference();

    expect((await openPairingQr()).props.animationType).toBe('slide');
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
