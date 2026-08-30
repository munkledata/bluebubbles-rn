/* eslint-disable import/first -- native-module mocks must exist before the module under test loads. */

type NativeHandler = (message: { data?: Record<string, string> }) => void | Promise<void>;
type TokenRefreshHandler = (token: string) => void;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function settlementProbe(promise: Promise<unknown>): { isSettled: () => boolean } {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return { isSettled: () => settled };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

let mockTokenRefreshHandler: TokenRefreshHandler | undefined;
let mockBackgroundHandler: NativeHandler | undefined;
const mockGetToken = jest.fn(async (): Promise<string> => 'fresh-token');
const mockRegisterDevice = jest.fn(async (): Promise<{ id: string | null }> => ({
  id: 'device-1',
}));
const mockFlushPersistentLogs = jest.fn(async (): Promise<boolean> => true);

jest.mock('@react-native-firebase/messaging', () => ({
  getMessaging: jest.fn(() => ({ app: 'messaging' })),
  setBackgroundMessageHandler: jest.fn((_messaging: unknown, handler: NativeHandler) => {
    mockBackgroundHandler = handler;
  }),
  onMessage: jest.fn(() => jest.fn()),
  onTokenRefresh: jest.fn((_messaging: unknown, handler: TokenRefreshHandler) => {
    mockTokenRefreshHandler = handler;
    return jest.fn();
  }),
  getToken: mockGetToken,
}));
jest.mock('react-native', () => ({ Platform: { Version: 35 } }));
jest.mock('@core/api', () => ({ fcmApi: { registerDevice: mockRegisterDevice } }));
jest.mock('@/services/clients', () => ({
  http: { kind: 'shared-http-client' },
  vault: { get: jest.fn(async () => 'false') },
  accountRevocationMarker: { isRevoked: jest.fn(() => false) },
}));
jest.mock('@/services/realtimeControl', () => ({
  dispatchRealtimeEvent: jest.fn(async () => undefined),
}));
jest.mock('@/services/logging/fileLogSink', () => ({
  flushPersistentLogsForHeadlessCompletion: mockFlushPersistentLogs,
}));
jest.mock('@/services/notifications/fcmPayload', () => ({
  parseFcmData: jest.fn(() => ({
    eventName: 'new-message',
    body: {},
    encrypted: false,
    encryptionType: undefined,
  })),
}));
jest.mock('@/services/notifications/fcmDecrypt', () => ({
  FCM_ENCRYPTION_TYPE: 'aes-gcm',
  decryptFcmPayload: jest.fn(),
}));
jest.mock('@/services/notifications/fcmSessionGate', () => ({
  readFcmSessionState: jest.fn(async () => 'active'),
}));
jest.mock('@/services/notifications/lockGate', () => ({
  effectivelyLocked: jest.fn(() => false),
}));
jest.mock('@/services/notifications/notifeeService', () => ({
  postLockedNotification: jest.fn(async () => undefined),
}));

import { logger } from '@core/secure';
import { useSessionStore } from '@state/sessionStore';
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
import { registerFcmToken, startFcm } from '@/services/notifications/fcmMessaging';
import '@/services/notifications/registerFcmBackgroundHandler';

function setConnectedSession(origin: string, password: string, epoch: number): void {
  useSessionStore.setState({
    status: 'connected',
    origin,
    password,
    serverInfo: null,
    error: null,
    epoch,
  });
}

beforeEach(async () => {
  await pauseRealtimeDeliveries();
  resumeRealtimeDeliveries();
  setConnectedSession('https://account-a.test', 'password-a', 101);
  mockTokenRefreshHandler = undefined;
  mockFlushPersistentLogs.mockResolvedValue(true);
  mockGetToken.mockResolvedValue('fresh-token');
  mockRegisterDevice.mockResolvedValue({ id: 'device-1' });
});

afterEach(async () => {
  await pauseRealtimeDeliveries();
  resumeRealtimeDeliveries();
  jest.restoreAllMocks();
});

describe('FCM registration account ownership', () => {
  it('waits for the persistent-log barrier before a background native callback settles', async () => {
    const flushGate = deferred<boolean>();
    mockFlushPersistentLogs.mockReturnValueOnce(flushGate.promise);

    const handling = Promise.resolve(mockBackgroundHandler?.({ data: {} }));
    const handlingProbe = settlementProbe(handling);
    await settle();

    expect(mockFlushPersistentLogs).toHaveBeenCalledTimes(1);
    expect(handlingProbe.isSettled()).toBe(false);

    flushGate.resolve(true);
    await expect(handling).resolves.toBeUndefined();
  });

  it('drops account A token lookup when Disconnect pauses while getToken is suspended', async () => {
    const tokenGate = deferred<string>();
    mockGetToken.mockReturnValueOnce(tokenGate.promise);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const registration = registerFcmToken();
    expect(mockGetToken).toHaveBeenCalledTimes(1);

    const pause = pauseRealtimeDeliveries();
    const pauseProbe = settlementProbe(pause);
    await settle();
    expect(pauseProbe.isSettled()).toBe(false);

    tokenGate.resolve('account-a-token');
    await expect(registration).resolves.toBe('skipped');
    await expect(pause).resolves.toBeUndefined();
    expect(mockRegisterDevice).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalledWith(
      '[fcm] device token registration failed',
      expect.anything(),
    );

    setConnectedSession('https://account-b.test', 'password-b', 102);
    resumeRealtimeDeliveries();
    mockGetToken.mockResolvedValueOnce('account-b-token');
    await registerFcmToken();

    expect(mockRegisterDevice).toHaveBeenCalledTimes(1);
    expect(mockRegisterDevice).toHaveBeenCalledWith(
      { kind: 'shared-http-client' },
      'Gator (Android 35)',
      'account-b-token',
    );
  });

  it('drains an admitted server registration and suppresses its stale failure during pause', async () => {
    const responseGate = deferred<{ id: string | null }>();
    const staleFailure = new Error('account A server went away');
    mockGetToken.mockResolvedValueOnce('account-a-token');
    mockRegisterDevice.mockReturnValueOnce(responseGate.promise);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const registration = registerFcmToken();
    await settle();
    expect(mockRegisterDevice).toHaveBeenCalledWith(
      { kind: 'shared-http-client' },
      'Gator (Android 35)',
      'account-a-token',
    );

    const pause = pauseRealtimeDeliveries();
    const pauseProbe = settlementProbe(pause);
    await settle();
    expect(pauseProbe.isSettled()).toBe(false);

    responseGate.reject(staleFailure);
    await expect(registration).resolves.toBe('skipped');
    await expect(pause).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalledWith('[fcm] device token registration failed', staleFailure);
  });

  it('fails closed if the session identity changes without a coordinator pause', async () => {
    const tokenGate = deferred<string>();
    mockGetToken.mockReturnValueOnce(tokenGate.promise);

    const registration = registerFcmToken();
    expect(mockGetToken).toHaveBeenCalledTimes(1);

    setConnectedSession('https://account-b.test', 'password-b', 102);
    tokenGate.resolve('account-a-token');
    await registration;

    expect(mockRegisterDevice).not.toHaveBeenCalled();
  });

  it('reacquires the token for the current session instead of trusting a queued refresh value', async () => {
    await startFcm();
    expect(mockTokenRefreshHandler).toEqual(expect.any(Function));

    await pauseRealtimeDeliveries();
    mockTokenRefreshHandler!('unowned-native-token');
    await settle();
    expect(mockGetToken).not.toHaveBeenCalled();

    setConnectedSession('https://account-b.test', 'password-b', 102);
    resumeRealtimeDeliveries();
    mockGetToken.mockResolvedValueOnce('fresh-account-b-token');
    mockTokenRefreshHandler!('stale-callback-argument');
    await settle();

    expect(mockGetToken).toHaveBeenCalledTimes(1);
    expect(mockRegisterDevice).toHaveBeenCalledWith(
      { kind: 'shared-http-client' },
      'Gator (Android 35)',
      'fresh-account-b-token',
    );
    expect(mockRegisterDevice).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'stale-callback-argument',
    );
  });
});
