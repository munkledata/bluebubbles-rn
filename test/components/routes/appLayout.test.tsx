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
jest.mock('expo-router', () => ({
  Stack: () => null,
  Redirect: (props: { href: string }) => {
    mockRedirect(props);
    return null;
  },
}));
jest.mock('@/services', () => ({
  flushErrorReports: jest.fn(() => Promise.resolve()),
  pauseRealtime: jest.fn(),
  resumeRealtime: jest.fn(() => Promise.resolve()),
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
jest.mock('@ui/server-rotation', () => ({
  ServerRotationApprovalHost: () => mockServerRotationApprovalHost(),
}));
jest.mock('@ui/useChatNavigator', () => ({ useChatNavigator: () => jest.fn() }));

// Mock registration has to precede the route import so its service barrels never load native code.
// eslint-disable-next-line import/first
import { AppState, type AppStateStatus } from 'react-native';
// eslint-disable-next-line import/first
import AppLayout from '../../../app/(app)/_layout';
// eslint-disable-next-line import/first
import { useLockStore } from '@state/lockStore';
// eslint-disable-next-line import/first
import { useSessionStore } from '@state/sessionStore';
// eslint-disable-next-line import/first
import { act, renderWithTheme } from '../support/renderWithTheme';
// eslint-disable-next-line import/first
import { flushErrorReports, pauseRealtime, resumeRealtime } from '@/services';
// eslint-disable-next-line import/first
import { recoverOutgoing } from '@/services/send';

const mockPauseRealtime = pauseRealtime as jest.MockedFunction<typeof pauseRealtime>;
const mockResumeRealtime = resumeRealtime as jest.MockedFunction<typeof resumeRealtime>;
const mockFlushErrorReports = flushErrorReports as jest.MockedFunction<typeof flushErrorReports>;
const mockRecoverOutgoing = recoverOutgoing as jest.MockedFunction<typeof recoverOutgoing>;

type AppStateHandler = (state: AppStateStatus) => void;
const appStateHandlers: AppStateHandler[] = [];
const mockLock = jest.fn(() => useLockStore.setState({ locked: true }));
const mockNoteBackgrounded = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  appStateHandlers.length = 0;
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

async function mountLayout(): Promise<void> {
  await renderWithTheme(<AppLayout />);
  expect(mockServerRotationApprovalHost).toHaveBeenCalledTimes(1);
  // One callback owns lock/realtime coordination; the other drains notification taps on resume.
  expect(appStateHandlers).toHaveLength(2);

  // Ignore the layout's intentional mount-time report flush. Assertions below describe only the
  // AppState transition being driven by the test.
  mockLock.mockClear();
  mockPauseRealtime.mockClear();
  mockResumeRealtime.mockClear();
  mockFlushErrorReports.mockClear();
  mockRecoverOutgoing.mockClear();
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
});
