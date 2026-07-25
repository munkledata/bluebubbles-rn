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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithTheme, screen, fireEvent, waitFor, act } from '../support/renderWithTheme';

const mockPush = jest.fn();
const mockBack = jest.fn();
// `mock*` prefix so the jest.mock factory below may close over it (hoisting rule).
const mockHttpPost = jest.fn();

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
import { useSessionStore } from '@state/sessionStore';
// eslint-disable-next-line import/first
import { useSyncStore } from '@state/syncStore';
// eslint-disable-next-line import/first
import { useDialogStore, type DialogRequest } from '@ui/dialog/dialogStore';

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

  it('surfaces a log-fetch failure as a dialog and opens no modal', async () => {
    mockHttpPost.mockRejectedValue(new Error('boom'));
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
    // The modal stays closed — its Done button is the only thing rendered exclusively inside it.
    await expect(
      screen.findByLabelText('Close server logs', {}, { timeout: 400 }),
    ).rejects.toBeTruthy();
  });
});
