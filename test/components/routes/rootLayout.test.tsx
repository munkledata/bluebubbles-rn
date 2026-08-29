/**
 * Root foreground-boot integration.
 *
 * The production coordinator is replaced with stable public snapshots so this suite exercises the
 * real root presentation gate without opening SecureStore, SQLCipher, FCM, or background tasks.
 * Mocks must be registered before importing app/_layout.tsx because that route has module-level
 * notification registration imports.
 */
import type { BootState } from '@/services/boot/bootStateMachine';

let mockBootState: BootState;

const mockStartForegroundBoot = jest.fn<Promise<BootState>, []>();
const mockRetryForegroundBoot = jest.fn<Promise<BootState>, [number]>();
const mockUnlockForegroundBoot = jest.fn<Promise<BootState>, [number]>();
const mockGetForegroundBootSnapshot = jest.fn<BootState, []>();
const mockInvalidateForegroundBootRun = jest.fn<BootState, [number]>();
const mockCompleteUnlock = jest.fn<Promise<void>, []>();
const mockAuthenticate = jest.fn<Promise<boolean>, [string]>();
const mockPrepareNotificationPresentationState = jest.fn<Promise<void>, []>();
const mockLoggerWarn = jest.fn();

jest.mock('@/services/boot/foregroundBoot', () => ({
  getForegroundBootSnapshot: () => mockGetForegroundBootSnapshot(),
  invalidateForegroundBootRun: (runId: number) => mockInvalidateForegroundBootRun(runId),
  startForegroundBoot: () => mockStartForegroundBoot(),
  retryForegroundBoot: (runId: number) => mockRetryForegroundBoot(runId),
  unlockForegroundBoot: (runId: number) => mockUnlockForegroundBoot(runId),
}));

jest.mock('@features/boot/useForegroundBootState', () => ({
  useForegroundBootState: () => mockBootState,
}));

jest.mock('@/services/lock', () => ({
  completeUnlock: () => mockCompleteUnlock(),
}));

jest.mock('@/services/notifications/backgroundEvents', () => ({}));
jest.mock('@/services/notifications/notifeeService', () => ({
  prepareNotificationPresentationState: () => mockPrepareNotificationPresentationState(),
}));

jest.mock('@native/biometrics', () => ({
  authenticate: (reason: string) => mockAuthenticate(reason),
}));

jest.mock('@core/secure', () => ({
  logger: {
    error: jest.fn(),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  },
}));

jest.mock('@tanstack/react-query', () => ({
  QueryClientProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@state/queryClient', () => ({ queryClient: {} }));

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

jest.mock('expo-status-bar', () => ({ StatusBar: () => null }));
jest.mock('expo-router', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Stack: () => React.createElement(Text, null, 'Protected navigation stack'),
    ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
  };
});

jest.mock('@ui/theme/dark-navigation-theme', () => ({
  DARK_STATUS_BAR_STYLE: 'light',
  buildDarkNavigationTheme: () => ({ dark: true, colors: {} }),
}));

// Keep the real ThemeProvider so the test proves the root's fallback-theme option releases the
// boot shell even when the persisted theme is deliberately unhydrated. The remaining app-wide
// hosts are irrelevant here and would otherwise pull in their timers/native dependencies.
jest.mock('@ui', () => ({
  ...jest.requireActual('@ui/theme/ThemeProvider'),
  ...jest.requireActual('@ui/ErrorBoundary'),
  AppDialog: () => null,
  AppToast: () => null,
}));

// Mock registration must precede the route import.
// eslint-disable-next-line import/first
import React from 'react';
// eslint-disable-next-line import/first
import { AppState, type AppStateStatus } from 'react-native';
// eslint-disable-next-line import/first
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import RootLayout from '../../../app/_layout';
// eslint-disable-next-line import/first
import { useLockStore } from '@state/lockStore';
// eslint-disable-next-line import/first
import { useThemeStore } from '@state/themeStore';
// eslint-disable-next-line import/first
import { useToastStore } from '@ui/toast/toastStore';

const loadingState = (runId = 1): BootState => ({
  status: 'loading',
  stage: 'lock',
  runId,
  issues: [],
});

const idleState = (runId = 0): BootState => ({ status: 'idle', runId, issues: [] });

const lockedState = (runId: number): BootState => ({ status: 'locked', runId, issues: [] });

const readyState = (runId: number, issues: BootState['issues'] = []): BootState => ({
  status: 'ready',
  mode: 'connected',
  runId,
  issues,
});

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type AppStateHandler = (state: AppStateStatus) => void;
const appStateHandlers = new Set<AppStateHandler>();
let currentAppState: AppStateStatus | null = 'active';

async function emitAppState(state: AppStateStatus): Promise<void> {
  currentAppState = state;
  await act(async () => {
    for (const handler of [...appStateHandlers]) handler(state);
  });
}

describe('RootLayout — foreground boot presentation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBootState = loadingState();
    mockStartForegroundBoot.mockResolvedValue(readyState(1));
    mockRetryForegroundBoot.mockResolvedValue(readyState(2));
    mockUnlockForegroundBoot.mockResolvedValue(readyState(1));
    mockGetForegroundBootSnapshot.mockImplementation(() => mockBootState);
    mockInvalidateForegroundBootRun.mockImplementation((runId) => {
      if (mockBootState.status !== 'idle' && mockBootState.runId === runId) {
        mockBootState = idleState(runId);
      }
      return mockBootState;
    });
    mockCompleteUnlock.mockResolvedValue(undefined);
    mockAuthenticate.mockResolvedValue(true);
    mockPrepareNotificationPresentationState.mockResolvedValue(undefined);
    currentAppState = 'active';
    appStateHandlers.clear();
    Object.defineProperty(AppState, 'currentState', {
      configurable: true,
      get: () => currentAppState,
    });
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((_type, handler) => {
      appStateHandlers.add(handler);
      return { remove: () => appStateHandlers.delete(handler) };
    }) as typeof AppState.addEventListener);

    useLockStore.setState({
      enabled: false,
      locked: false,
      hydrated: false,
      lastBackgrounded: null,
      timeoutMs: 30_000,
    });
    useThemeStore.setState({
      customThemeId: null,
      customTokens: null,
      hydrated: false,
    });
    useToastStore.getState().reset();
  });

  it('starts once and renders a fail-closed loading shell with an unhydrated theme', async () => {
    const view = await render(<RootLayout />);

    expect(screen.getByRole('progressbar', { name: 'Loading Gator' })).toBeTruthy();
    expect(screen.queryByText('Protected navigation stack')).toBeNull();
    expect(useThemeStore.getState().hydrated).toBe(false);
    expect(mockStartForegroundBoot).toHaveBeenCalledTimes(1);

    await view.rerender(<RootLayout />);
    expect(mockStartForegroundBoot).toHaveBeenCalledTimes(1);
  });

  it('does not start while mounted in the background and starts once on activation', async () => {
    currentAppState = 'background';
    mockBootState = idleState();
    await render(<RootLayout />);

    expect(mockStartForegroundBoot).not.toHaveBeenCalled();
    await emitAppState('active');
    await emitAppState('active');
    expect(mockStartForegroundBoot).toHaveBeenCalledTimes(1);
  });

  it.each([null, 'unknown'] as const)(
    'waits for explicit active authority when initial AppState is %p',
    async (initialState) => {
      currentAppState = initialState;
      mockBootState = idleState();
      await render(<RootLayout />);

      expect(mockStartForegroundBoot).not.toHaveBeenCalled();
      await emitAppState('active');
      expect(mockStartForegroundBoot).toHaveBeenCalledTimes(1);
    },
  );

  it('retires a loading boot in the background and starts one successor on activation', async () => {
    mockBootState = { status: 'loading', stage: 'database', runId: 5, issues: [] };
    await render(<RootLayout />);
    expect(mockStartForegroundBoot).toHaveBeenCalledTimes(1);

    await emitAppState('background');
    expect(mockInvalidateForegroundBootRun).toHaveBeenCalledTimes(1);
    expect(mockInvalidateForegroundBootRun).toHaveBeenCalledWith(5);

    await emitAppState('active');
    await emitAppState('active');
    expect(mockStartForegroundBoot).toHaveBeenCalledTimes(2);
  });

  it('revokes an exact cold-unlock run that reaches ready while the app backgrounds', async () => {
    const runId = 7;
    const unlock = deferred<BootState>();
    mockBootState = lockedState(runId);
    useLockStore.setState({ enabled: true, hydrated: true, locked: true });
    mockUnlockForegroundBoot.mockReturnValue(unlock.promise);
    await render(<RootLayout />);
    await waitFor(() => expect(mockUnlockForegroundBoot).toHaveBeenCalledWith(runId));

    mockBootState = readyState(runId);
    await emitAppState('background');
    expect(mockInvalidateForegroundBootRun).toHaveBeenCalledWith(runId);

    await act(async () => {
      unlock.resolve(readyState(runId));
      await unlock.promise;
    });
    expect(useLockStore.getState().locked).toBe(true);

    await emitAppState('active');
    expect(mockStartForegroundBoot).toHaveBeenCalledTimes(2);
  });

  it('does not retire or restart an ordinary ready run across background', async () => {
    mockBootState = readyState(9);
    useLockStore.setState({ hydrated: true, locked: false });
    await render(<RootLayout />);

    await emitAppState('background');
    await emitAppState('active');

    expect(mockInvalidateForegroundBootRun).not.toHaveBeenCalled();
    expect(mockStartForegroundBoot).toHaveBeenCalledTimes(1);
  });

  it('retires a loading run when the root unmounts', async () => {
    mockBootState = { status: 'loading', stage: 'settings', runId: 12, issues: [] };
    const view = await render(<RootLayout />);

    await view.unmount();

    expect(mockInvalidateForegroundBootRun).toHaveBeenCalledTimes(1);
    expect(mockInvalidateForegroundBootRun).toHaveBeenCalledWith(12);
  });

  it('mounts the protected stack only after a ready snapshot', async () => {
    const view = await render(<RootLayout />);
    expect(screen.queryByText('Protected navigation stack')).toBeNull();

    mockBootState = readyState(1);
    await act(async () => {
      useLockStore.setState({ hydrated: true, locked: false });
    });
    await view.rerender(<RootLayout />);

    expect(screen.getByText('Protected navigation stack')).toBeTruthy();
    expect(screen.queryByRole('progressbar', { name: 'Loading Gator' })).toBeNull();
  });

  it.each([
    ['loading', loadingState(20)],
    ['locked', lockedState(20)],
    ['setup-ready', { status: 'ready', mode: 'setup', runId: 20, issues: [] } satisfies BootState],
    [
      'failed',
      {
        status: 'failed',
        runId: 20,
        issues: [],
        failure: {
          stage: 'database',
          kind: 'retryable',
          failClosed: true,
          code: 'database-open-failed',
          userMessage: 'Gator could not open your encrypted messages. Try again.',
        },
      } satisfies BootState,
    ],
  ] as const)('does not run notification maintenance for a %s boot', async (_label, state) => {
    mockBootState = state;

    await render(<RootLayout />);
    await act(async () => Promise.resolve());

    expect(mockPrepareNotificationPresentationState).not.toHaveBeenCalled();
  });

  it('runs notification maintenance once per connected ready run, including a degraded ready run', async () => {
    useLockStore.setState({ hydrated: true, locked: false });
    mockBootState = readyState(31, [
      {
        stage: 'fcm',
        level: 'degraded',
        code: 'foreground-fcm-start-failed',
        userMessage: 'Push updates are unavailable; live socket updates still work.',
      },
    ]);
    const view = await render(<RootLayout />);

    await waitFor(() => expect(mockPrepareNotificationPresentationState).toHaveBeenCalledTimes(1));
    mockBootState = readyState(31);
    await view.rerender(<RootLayout />);
    expect(mockPrepareNotificationPresentationState).toHaveBeenCalledTimes(1);

    mockBootState = readyState(32);
    await view.rerender(<RootLayout />);
    await waitFor(() => expect(mockPrepareNotificationPresentationState).toHaveBeenCalledTimes(2));
  });

  it('contains a maintenance rejection and retries only after a new admitted run', async () => {
    const failure = new Error('raw native maintenance failure');
    mockPrepareNotificationPresentationState
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);
    useLockStore.setState({ hydrated: true, locked: false });
    mockBootState = readyState(40);
    const view = await render(<RootLayout />);

    await waitFor(() =>
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        '[notif] notification presentation maintenance failed',
        failure,
      ),
    );
    expect(screen.getByText('Protected navigation stack')).toBeTruthy();
    expect(useToastStore.getState().current).toBeNull();

    mockBootState = readyState(40);
    await view.rerender(<RootLayout />);
    expect(mockPrepareNotificationPresentationState).toHaveBeenCalledTimes(1);

    mockBootState = readyState(41);
    await view.rerender(<RootLayout />);
    await waitFor(() => expect(mockPrepareNotificationPresentationState).toHaveBeenCalledTimes(2));
  });

  it('clears the cold lock only when unlock returns ready for the rendered run', async () => {
    const runId = 7;
    mockBootState = lockedState(runId);
    useLockStore.setState({ enabled: true, hydrated: true, locked: true });
    mockUnlockForegroundBoot.mockResolvedValue(readyState(runId));

    await render(<RootLayout />);

    await waitFor(() => expect(mockUnlockForegroundBoot).toHaveBeenCalledWith(runId));
    await waitFor(() => expect(useLockStore.getState().locked).toBe(false));
  });

  it('routes a ready-run warm unlock through completeUnlock', async () => {
    mockBootState = readyState(8);
    useLockStore.setState({ enabled: true, hydrated: true, locked: true });

    await render(<RootLayout />);

    await waitFor(() => expect(mockCompleteUnlock).toHaveBeenCalledTimes(1));
    expect(mockUnlockForegroundBoot).not.toHaveBeenCalled();
  });

  it('keeps the cold lock closed when unlock settles for a stale run', async () => {
    const renderedRunId = 7;
    const unlock = deferred<BootState>();
    mockBootState = lockedState(renderedRunId);
    useLockStore.setState({ enabled: true, hydrated: true, locked: true });
    mockUnlockForegroundBoot.mockReturnValue(unlock.promise);

    await render(<RootLayout />);

    await waitFor(() => expect(mockUnlockForegroundBoot).toHaveBeenCalledWith(renderedRunId));
    await act(async () => {
      unlock.resolve(readyState(renderedRunId + 1));
      await unlock.promise;
    });
    expect(useLockStore.getState().locked).toBe(true);
  });

  it('retries the exact failed run rendered by the root gate', async () => {
    mockBootState = {
      status: 'failed',
      runId: 42,
      issues: [],
      failure: {
        stage: 'database',
        kind: 'retryable',
        failClosed: true,
        code: 'database-open-failed',
        userMessage: 'Gator could not open your encrypted messages. Try again.',
      },
    };

    await render(<RootLayout />);
    expect(screen.queryByText('Protected navigation stack')).toBeNull();

    fireEvent.press(screen.getByRole('button', { name: 'Try Again' }));

    expect(mockRetryForegroundBoot).toHaveBeenCalledTimes(1);
    expect(mockRetryForegroundBoot).toHaveBeenCalledWith(42);
  });

  it('publishes each ready degraded issue to the toast store once', async () => {
    useLockStore.setState({ hydrated: true, locked: false });
    mockBootState = readyState(3, [
      {
        stage: 'fcm',
        level: 'degraded',
        code: 'foreground-fcm-start-failed',
        userMessage: 'Push updates are unavailable; live socket updates still work.',
      },
    ]);

    const view = await render(<RootLayout />);

    await waitFor(() =>
      expect(useToastStore.getState().current).toEqual(
        expect.objectContaining({
          message: 'Push updates are unavailable; live socket updates still work.',
          durationMs: 6_000,
        }),
      ),
    );
    expect(useToastStore.getState().queue).toHaveLength(0);

    await view.rerender(<RootLayout />);
    expect(useToastStore.getState().queue).toHaveLength(0);
  });
});
