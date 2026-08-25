/**
 * Regression guard for the connected layout's AppState lock/recovery ordering.
 *
 * When an enabled lock expires in the background, the first `active` callback must close the UI
 * gate and keep realtime paused. Starting any foreground catch-up underneath that overlay can post
 * full-content notifications before biometric authentication succeeds. A non-expired resume is the
 * control: it still starts the ordinary realtime, error-report, and outgoing-send recovery work.
 */
import React from 'react';

const mockRedirect = jest.fn((_props: { href: string }) => null);
const mockServerRotationApprovalHost = jest.fn(() => null);
const mockConnectionBanner = jest.fn((_props: { onRetry: () => unknown }) => null);
const mockOpenChat = jest.fn();
const mockLoggerWarn = jest.fn();
const mockForegroundHandlers: Array<
  (event: { type: number; detail: Record<string, unknown> }) => void
> = [];
jest.mock('react-native-notify-kit', () => ({
  __esModule: true,
  default: {
    getInitialNotification: jest.fn(async () => null),
    onForegroundEvent: jest.fn(
      (handler: (event: { type: number; detail: Record<string, unknown> }) => void) => {
        mockForegroundHandlers.push(handler);
        return jest.fn();
      },
    ),
  },
  EventType: { ACTION_PRESS: 1, PRESS: 2 },
}));
jest.mock('expo-router', () => ({
  Stack: () => null,
  Redirect: (props: { href: string }) => {
    mockRedirect(props);
    return null;
  },
}));
jest.mock('@core/secure', () => ({ logger: { warn: mockLoggerWarn } }));
jest.mock('@/services', () => ({
  flushErrorReports: jest.fn(() => Promise.resolve()),
  pauseRealtime: jest.fn(),
  resumeRealtime: jest.fn(() => Promise.resolve()),
  retryRealtimeConnection: jest.fn(() => true),
}));
jest.mock('@/services/send', () => ({
  recoverOutgoing: jest.fn(() => Promise.resolve({ eligible: 0, sent: 0 })),
}));
jest.mock('@utils/isDev', () => ({ isDevServer: () => false }));
jest.mock('@/services/notifications/actions', () => ({
  handleNotificationAction: jest.fn(() => Promise.resolve()),
  handleNotificationPress: jest.fn(() => Promise.resolve()),
}));
jest.mock('@/services/notifications/notificationOpen', () => ({
  drainNotificationTap: jest.fn(() => Promise.resolve()),
  openFromNotification: jest.fn(() => Promise.resolve()),
}));
jest.mock('@/services/notifications/pendingNav', () => ({
  takePendingNotification: jest.fn(() => null),
}));
jest.mock('@ui/facetime', () => ({
  FaceTimeCallOverlay: () => null,
  IncomingFaceTimeOverlay: () => null,
}));
jest.mock('@ui/connection', () => ({
  ConnectionBanner: (props: { onRetry: () => unknown }) => mockConnectionBanner(props),
}));
jest.mock('@ui/server-rotation', () => ({
  ServerRotationApprovalHost: () => mockServerRotationApprovalHost(),
}));
jest.mock('@ui/useChatNavigator', () => ({ useChatNavigator: () => mockOpenChat }));

// Mock registration has to precede the route import so its service barrels never load native code.
// eslint-disable-next-line import/first
import { AppState, type AppStateStatus } from 'react-native';
// eslint-disable-next-line import/first
import { EventType } from 'react-native-notify-kit';
// eslint-disable-next-line import/first
import AppLayout from '../../../app/(app)/_layout';
// eslint-disable-next-line import/first
import { useLockStore } from '@state/lockStore';
// eslint-disable-next-line import/first
import { useSessionStore } from '@state/sessionStore';
// eslint-disable-next-line import/first
import { act, renderWithTheme, waitFor } from '../support/renderWithTheme';
// eslint-disable-next-line import/first
import {
  flushErrorReports,
  pauseRealtime,
  resumeRealtime,
  retryRealtimeConnection,
} from '@/services';
// eslint-disable-next-line import/first
import { recoverOutgoing } from '@/services/send';
// eslint-disable-next-line import/first
import {
  handleNotificationAction,
  handleNotificationPress,
} from '@/services/notifications/actions';
// eslint-disable-next-line import/first
import {
  drainNotificationTap,
  openFromNotification,
} from '@/services/notifications/notificationOpen';
// eslint-disable-next-line import/first
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

const mockPauseRealtime = pauseRealtime as jest.MockedFunction<typeof pauseRealtime>;
const mockResumeRealtime = resumeRealtime as jest.MockedFunction<typeof resumeRealtime>;
const mockRetryRealtime = retryRealtimeConnection as jest.MockedFunction<
  typeof retryRealtimeConnection
>;
const mockFlushErrorReports = flushErrorReports as jest.MockedFunction<typeof flushErrorReports>;
const mockRecoverOutgoing = recoverOutgoing as jest.MockedFunction<typeof recoverOutgoing>;
const mockHandleNotificationAction = handleNotificationAction as jest.Mock;
const mockHandleNotificationPress = handleNotificationPress as jest.Mock;
const mockDrainNotificationTap = drainNotificationTap as jest.Mock;
const mockOpenFromNotification = openFromNotification as jest.Mock;

type AppStateHandler = (state: AppStateStatus) => void;
const appStateHandlers: AppStateHandler[] = [];
const mockLock = jest.fn(() => useLockStore.setState({ locked: true }));
const mockNoteBackgrounded = jest.fn();

beforeEach(() => {
  resumeRealtimeDeliveries();
  jest.clearAllMocks();
  appStateHandlers.length = 0;
  mockForegroundHandlers.length = 0;
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _type: string,
    handler: AppStateHandler,
  ) => {
    appStateHandlers.push(handler);
    return { remove: jest.fn() };
  }) as unknown as typeof AppState.addEventListener);
  useLockStore.setState({
    enabled: true,
    locked: false,
    hydrated: true,
    lastBackgrounded: 0,
    timeoutMs: 1,
    lock: mockLock,
    noteBackgrounded: mockNoteBackgrounded,
  });
  useSessionStore.setState({
    status: 'connected',
    origin: 'https://server.example',
    password: 'secret',
    error: null,
  });
});

afterEach(() => {
  resumeRealtimeDeliveries();
});

async function mountLayout(): Promise<void> {
  await renderWithTheme(<AppLayout />);
  expect(mockServerRotationApprovalHost).toHaveBeenCalledTimes(1);
  // One callback owns lock/realtime coordination; the other drains notification taps on resume.
  expect(appStateHandlers).toHaveLength(2);
  expect(mockForegroundHandlers).toHaveLength(1);

  // Ignore the layout's intentional mount-time report flush. Assertions below describe only the
  // AppState transition being driven by the test.
  mockLock.mockClear();
  mockPauseRealtime.mockClear();
  mockResumeRealtime.mockClear();
  mockFlushErrorReports.mockClear();
  mockRecoverOutgoing.mockClear();
  mockHandleNotificationAction.mockClear();
  mockHandleNotificationPress.mockClear();
  mockDrainNotificationTap.mockClear();
  mockOpenFromNotification.mockClear();
}

async function emitAppState(state: AppStateStatus): Promise<void> {
  await act(async () => {
    for (const handler of [...appStateHandlers]) handler(state);
  });
}

describe('AppLayout — active AppState lock gate', () => {
  it('waits for cold-start credential hydration instead of redirecting a valid deep link', async () => {
    useSessionStore.setState({ status: 'loading', origin: null, password: null });

    await renderWithTheme(<AppLayout />);

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(appStateHandlers).toHaveLength(0);
    expect(mockFlushErrorReports).not.toHaveBeenCalled();
  });

  it('immediately leaves connected routes after the session is reset', async () => {
    useSessionStore.getState().reset();

    await renderWithTheme(<AppLayout />);

    expect(mockRedirect.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ href: '/welcome' }));
    expect(appStateHandlers).toHaveLength(0);
    expect(mockFlushErrorReports).not.toHaveBeenCalled();
    expect(mockRecoverOutgoing).not.toHaveBeenCalled();
  });

  it('locks and pauses an expired session without starting foreground recovery', async () => {
    await mountLayout();

    await emitAppState('active');

    expect(mockLock).toHaveBeenCalledTimes(1);
    expect(useLockStore.getState().locked).toBe(true);
    expect(mockPauseRealtime).toHaveBeenCalledTimes(1);
    expect(mockLock.mock.invocationCallOrder[0]!).toBeLessThan(
      mockPauseRealtime.mock.invocationCallOrder[0]!,
    );
    expect(mockResumeRealtime).not.toHaveBeenCalled();
    expect(mockFlushErrorReports).not.toHaveBeenCalled();
    expect(mockRecoverOutgoing).not.toHaveBeenCalled();
  });

  it('starts the normal foreground recovery when the enabled lock has not expired', async () => {
    useLockStore.setState({ lastBackgrounded: null });
    await mountLayout();

    await emitAppState('active');

    expect(mockLock).not.toHaveBeenCalled();
    expect(mockPauseRealtime).not.toHaveBeenCalled();
    expect(mockResumeRealtime).toHaveBeenCalledTimes(1);
    expect(mockFlushErrorReports).toHaveBeenCalledTimes(1);
    expect(mockRecoverOutgoing).toHaveBeenCalledTimes(1);
  });

  it('mounts the shared connection banner with the service-owned Retry action', async () => {
    await mountLayout();

    expect(mockConnectionBanner).toHaveBeenCalledTimes(1);
    expect(mockConnectionBanner.mock.calls[0]?.[0].onRetry).toBe(mockRetryRealtime);
  });

  it('keeps in-flight account-A recovery rejections silent after account B connects', async () => {
    let rejectResume!: (error: unknown) => void;
    let rejectRecovery!: (error: unknown) => void;
    const resumePending = new Promise<never>((_resolve, reject) => {
      rejectResume = reject;
    });
    const recoveryPending = new Promise<never>((_resolve, reject) => {
      rejectRecovery = reject;
    });
    mockResumeRealtime.mockReturnValueOnce(resumePending);
    mockRecoverOutgoing.mockReturnValueOnce(recoveryPending);
    useLockStore.setState({ lastBackgrounded: null });
    await mountLayout();
    const oldRecovery = appStateHandlers[0]!;

    await act(async () => {
      oldRecovery('active');
      await Promise.resolve();
    });
    expect(mockResumeRealtime).toHaveBeenCalledTimes(1);
    expect(mockRecoverOutgoing).toHaveBeenCalledTimes(1);

    await act(async () => {
      await pauseRealtimeDeliveries();
      useSessionStore.getState().reset();
      resumeRealtimeDeliveries();
      useSessionStore.setState({
        status: 'connected',
        origin: 'https://server.example',
        password: 'secret-b',
        error: null,
      });
    });
    await act(async () => {
      rejectResume(new Error('stale account-A resume failure'));
      rejectRecovery(new Error('stale account-A recovery failure'));
      await Promise.allSettled([resumePending, recoveryPending]);
    });

    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('rejects retained account-A listeners while fresh account-B listeners still work', async () => {
    useLockStore.setState({ lastBackgrounded: null });
    await mountLayout();
    const oldForeground = mockForegroundHandlers[0]!;
    const oldRecovery = appStateHandlers[0]!;
    const oldTapDrain = appStateHandlers[1]!;

    await act(async () => {
      await pauseRealtimeDeliveries();
      useSessionStore.getState().reset();
    });
    await act(async () => {
      resumeRealtimeDeliveries();
      useSessionStore.setState({
        status: 'connected',
        origin: 'https://server.example',
        password: 'secret-b',
        error: null,
      });
    });
    await waitFor(() => {
      expect(mockForegroundHandlers).toHaveLength(2);
      expect(appStateHandlers).toHaveLength(4);
    });

    mockHandleNotificationAction.mockClear();
    mockHandleNotificationPress.mockClear();
    mockDrainNotificationTap.mockClear();
    mockOpenFromNotification.mockClear();
    mockResumeRealtime.mockClear();
    mockFlushErrorReports.mockClear();
    mockRecoverOutgoing.mockClear();

    await act(async () => {
      oldForeground({ type: EventType.ACTION_PRESS, detail: {} });
      oldForeground({ type: EventType.PRESS, detail: {} });
      oldRecovery('active');
      oldTapDrain('active');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockHandleNotificationAction).not.toHaveBeenCalled();
    expect(mockHandleNotificationPress).not.toHaveBeenCalled();
    expect(mockOpenFromNotification).not.toHaveBeenCalled();
    expect(mockDrainNotificationTap).not.toHaveBeenCalled();
    expect(mockResumeRealtime).not.toHaveBeenCalled();
    expect(mockFlushErrorReports).not.toHaveBeenCalled();
    expect(mockRecoverOutgoing).not.toHaveBeenCalled();

    const freshForeground = mockForegroundHandlers[1]!;
    const freshTapDrain = appStateHandlers[3]!;
    await act(async () => {
      freshForeground({ type: EventType.ACTION_PRESS, detail: {} });
      freshForeground({ type: EventType.PRESS, detail: {} });
      freshTapDrain('active');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockHandleNotificationAction).toHaveBeenCalledTimes(1);
    expect(mockHandleNotificationPress).toHaveBeenCalledTimes(1);
    expect(mockOpenFromNotification).toHaveBeenCalledTimes(1);
    expect(mockDrainNotificationTap).toHaveBeenCalledTimes(1);
  });
});
