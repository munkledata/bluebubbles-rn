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
    envelopeChatGuid: undefined,
    encrypted: false,
    encryptionType: '',
  })),
  rehydrateFcmEnvelopeChatGuid: jest.fn((value: string) => value),
}));
jest.mock('@/services/notifications/fcmDecrypt', () => ({
  FCM_ENCRYPTION_TYPE: 'aes-gcm',
  decryptFcmPayload: jest.fn(async () => '{}'),
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe('FCM delivery coordinator integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resumeRealtimeDeliveries();
  });

  afterEach(() => {
    resumeRealtimeDeliveries();
  });

  it('drains an admitted native callback and refuses callbacks arriving after pause', async () => {
    if (!backgroundHandler) throw new Error('background FCM handler was not registered');
    const sessionGate = deferred<'active'>();
    mockReadFcmSessionState.mockReturnValueOnce(sessionGate.promise);

    const admitted = backgroundHandler({
      messageId: 'admitted-before-pause',
      data: { type: 'new-message' },
    });
    await settle();

    let pauseSettled = false;
    const pause = pauseRealtimeDeliveries().then(() => {
      pauseSettled = true;
    });
    await settle();
    expect(pauseSettled).toBe(false);

    await expect(
      backgroundHandler({
        messageId: 'rejected-after-pause',
        data: { type: 'new-message' },
      }),
    ).resolves.toBeUndefined();
    expect(mockReadFcmSessionState).toHaveBeenCalledTimes(1);

    sessionGate.resolve('active');
    await expect(admitted).resolves.toBeUndefined();
    await expect(pause).resolves.toBeUndefined();
    expect(mockDispatchRealtimeEvent).not.toHaveBeenCalled();
    expect(mockFlushHeadlessLogs).toHaveBeenCalledTimes(2);
  });
});
