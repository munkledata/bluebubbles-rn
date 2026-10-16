/* eslint-disable import/first -- native-module mocks must exist before the module under test loads. */

interface NativeMessage {
  data?: Record<string, string>;
  messageId?: string;
}

type NativeHandler = (message: NativeMessage) => Promise<void> | void;

let backgroundHandler: NativeHandler | undefined;
const mockReadFcmSessionState = jest.fn<Promise<'active'>, []>();
const mockDispatchRealtimeEvent = jest.fn(async () => undefined);
const mockFlushHeadlessLogs = jest.fn(async () => undefined);

jest.mock('@react-native-firebase/messaging', () => ({
  getMessaging: jest.fn(() => ({ app: 'messaging' })),
  setBackgroundMessageHandler: jest.fn((_messaging: unknown, handler: NativeHandler) => {
    backgroundHandler = handler;
  }),
  onMessage: jest.fn(() => jest.fn()),
  onTokenRefresh: jest.fn(() => jest.fn()),
  getToken: jest.fn(async () => 'token'),
}));
jest.mock('react-native', () => ({ Platform: { Version: 35 } }));
jest.mock('@core/api', () => ({ fcmApi: { registerDevice: jest.fn(async () => undefined) } }));
jest.mock('@core/secure', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    event: jest.fn(),
    error: jest.fn(),
  },
}));
jest.mock('@state/lockStore', () => ({ useLockStore: { getState: () => ({}) } }));
jest.mock('@state/sessionStore', () => ({ useSessionStore: { getState: () => ({}) } }));
jest.mock('@/services/clients', () => ({
  http: {},
  vault: { get: jest.fn(async () => 'false') },
  accountRevocationMarker: { isRevoked: jest.fn(() => false) },
}));
jest.mock('@/services/logging/fileLogSink', () => ({
  flushPersistentLogsForHeadlessCompletion: mockFlushHeadlessLogs,
}));
jest.mock('@/services/realtimeControl', () => ({
  dispatchRealtimeEvent: mockDispatchRealtimeEvent,
}));
jest.mock('@/services/notifications/fcmPayload', () => ({
  parseFcmData: jest.fn(() => ({
    eventName: 'new-message',
    body: { guid: 'coordinator-integration' },
    encrypted: false,
    encryptionType: '',
  })),
}));
jest.mock('@/services/notifications/fcmDecrypt', () => ({
  FCM_V2_ENCRYPTION_TYPE: 'AEAD_GCM_V2_DEVICE',
  FCM_V3_ENCRYPTION_TYPE: 'AEAD_GCM_V3_IDENTITY',
  decryptFcmV2Payload: jest.fn(async () => '{}'),
  decryptFcmV3Payload: jest.fn(async () => ({ plaintext: '{}', identity: {} })),
}));
jest.mock('@/services/notifications/fcmSessionGate', () => ({
  readFcmSessionState: mockReadFcmSessionState,
}));
jest.mock('@/services/notifications/lockGate', () => ({
  effectivelyLocked: jest.fn(() => false),
}));
jest.mock('@/services/notifications/notifeeService', () => ({
  postLockedNotification: jest.fn(async () => undefined),
}));

import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
import '@/services/notifications/registerFcmBackgroundHandler';
import { flushMicrotasks } from '../support/async';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('FCM delivery coordinator integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resumeRealtimeDeliveries();
  });

  afterEach(() => {
    resumeRealtimeDeliveries();
  });

  it('releases tracked callback ownership on pause and refuses later callbacks', async () => {
    if (!backgroundHandler) throw new Error('background FCM handler was not registered');
    const sessionGate = deferred<'active'>();
    mockReadFcmSessionState.mockReturnValueOnce(sessionGate.promise);

    const admitted = backgroundHandler({
      messageId: 'admitted-before-pause',
      data: { type: 'new-message' },
    });
    await flushMicrotasks();

    let pauseSettled = false;
    const pause = pauseRealtimeDeliveries().then(() => {
      pauseSettled = true;
    });
    await flushMicrotasks();
    // Teardown retires the tracked wait immediately. The callback's real session-gate continuation
    // remains the private FIFO fence, so a later account can never overtake it.
    expect(pauseSettled).toBe(true);
    await expect(pause).resolves.toBeUndefined();
    await expect(admitted).resolves.toBeUndefined();

    await expect(
      backgroundHandler({
        messageId: 'rejected-after-pause',
        data: { type: 'new-message' },
      }),
    ).resolves.toBeUndefined();
    expect(mockReadFcmSessionState).toHaveBeenCalledTimes(1);

    sessionGate.resolve('active');
    await flushMicrotasks();
    expect(mockDispatchRealtimeEvent).not.toHaveBeenCalled();
    expect(mockFlushHeadlessLogs).toHaveBeenCalledTimes(2);
  });
});
