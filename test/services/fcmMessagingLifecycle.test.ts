interface NativeMessage {
  data?: Record<string, string>;
  messageId?: string;
}

type NativeHandler = (message: NativeMessage) => void | Promise<void>;

interface MockParsedFcm {
  eventName: string;
  body: unknown;
  envelopeChatGuid: string | undefined;
  encrypted: boolean;
  encryptionType: string;
}

let mockBackgroundHandler: NativeHandler | undefined;
let mockForegroundHandler: NativeHandler | undefined;
const mockGetMessaging = jest.fn(() => ({ app: 'messaging' }));
const mockDispatchRealtimeEvent = jest.fn(async (..._args: unknown[]) => undefined);
const mockParseFcmData = jest.fn((): MockParsedFcm => ({
  eventName: 'new-message',
  body: { guid: 'm1' },
  envelopeChatGuid: undefined as string | undefined,
  encrypted: false,
  encryptionType: '',
}));
const mockDecryptFcmPayload = jest.fn(async () => '{"guid":"decrypted-message"}');
const mockDecryptFcmV2Payload = jest.fn(async () => '{"guid":"decrypted-v2-message"}');
const mockEffectivelyLocked = jest.fn(
  (_lockState: unknown, _storedAppLockEnabled: boolean): boolean => false,
);
const mockPostLockedNotification = jest.fn(async () => undefined);
const mockVaultGet = jest.fn<Promise<string | null>, [string]>(async (key) =>
  key === 'serverPassword'
    ? 'server-password'
    : key === 'serverAddress'
      ? 'https://gator.example'
      : key === 'appLockEnabled'
        ? 'false'
        : null,
);
const mockReadFcmSessionState = jest.fn(
  async (): Promise<'active' | 'forgotten' | 'unavailable'> => 'active',
);
let leaseCurrent = true;
const activeLease = { generation: 1, isCurrent: () => leaseCurrent };
const mockRunTrackedRealtimeDelivery = jest.fn(
  async (task: (lease: typeof activeLease) => Promise<void>): Promise<'delivered' | 'paused'> => {
    await task(activeLease);
    return 'delivered';
  },
);

jest.mock('@react-native-firebase/messaging', () => ({
  getMessaging: mockGetMessaging,
  setBackgroundMessageHandler: jest.fn((_messaging: unknown, handler: NativeHandler) => {
    mockBackgroundHandler = handler;
  }),
  onMessage: jest.fn((_messaging: unknown, handler: NativeHandler) => {
    mockForegroundHandler = handler;
    return jest.fn();
  }),
  onTokenRefresh: jest.fn(() => jest.fn()),
  getToken: jest.fn(async () => 'token'),
}));
jest.mock('react-native', () => ({ Platform: { Version: 35 } }));
jest.mock('@core/api', () => ({ fcmApi: { registerDevice: jest.fn(async () => undefined) } }));
jest.mock('@/services/clients', () => ({
  http: {},
  vault: { get: mockVaultGet },
  accountRevocationMarker: { isRevoked: jest.fn(() => false) },
}));
jest.mock('@/services/realtimeControl', () => ({
  dispatchRealtimeEvent: mockDispatchRealtimeEvent,
}));
jest.mock('@/services/notifications/fcmPayload', () => ({
  parseFcmData: mockParseFcmData,
  rehydrateFcmEnvelopeChatGuid: jest.requireActual('@/services/notifications/fcmPayload')
    .rehydrateFcmEnvelopeChatGuid,
}));
jest.mock('@/services/notifications/fcmDecrypt', () => ({
  FCM_ENCRYPTION_TYPE: 'aes-gcm',
  FCM_V2_ENCRYPTION_TYPE: 'AEAD_GCM_V2_DEVICE',
  decryptFcmPayload: mockDecryptFcmPayload,
  decryptFcmV2Payload: mockDecryptFcmV2Payload,
}));
jest.mock('@/services/notifications/fcmSessionGate', () => ({
  readFcmSessionState: mockReadFcmSessionState,
}));
jest.mock('@/services/notifications/lockGate', () => ({
  effectivelyLocked: mockEffectivelyLocked,
}));
jest.mock('@/services/notifications/notifeeService', () => ({
  postLockedNotification: mockPostLockedNotification,
}));
jest.mock('@/services/realtime/deliveryCoordinator', () => ({
  runTrackedRealtimeDelivery: mockRunTrackedRealtimeDelivery,
}));

import { logger } from '@core/secure';
import {
  activeFcmDeviceEncryptionState,
  pendingFcmDeviceEncryptionState,
  revokedFcmDeviceEncryptionState,
  serializeFcmDeviceEncryptionState,
} from '@core/realtime';
import { startFcm } from '@/services/notifications/fcmMessaging';
import '@/services/notifications/registerFcmBackgroundHandler';

const message = { messageId: 'provider-message-1', data: { type: 'new-message' } };
const V2_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
let diagnosticEvent: jest.SpyInstance;

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  diagnosticEvent = jest.spyOn(logger, 'event').mockImplementation(() => undefined);
  leaseCurrent = true;
  mockGetMessaging.mockReturnValue({ app: 'messaging' });
  mockDispatchRealtimeEvent.mockResolvedValue(undefined);
  mockParseFcmData.mockReturnValue({
    eventName: 'new-message',
    body: { guid: 'm1' },
    envelopeChatGuid: undefined,
    encrypted: false,
    encryptionType: '',
  });
  mockDecryptFcmPayload.mockResolvedValue('{"guid":"decrypted-message"}');
  mockDecryptFcmV2Payload.mockResolvedValue('{"guid":"decrypted-v2-message"}');
  mockEffectivelyLocked.mockReturnValue(false);
  mockVaultGet.mockImplementation(async (key: string) =>
    key === 'serverPassword'
      ? 'server-password'
      : key === 'serverAddress'
        ? 'https://gator.example'
        : key === 'appLockEnabled'
          ? 'false'
          : null,
  );
  mockReadFcmSessionState.mockReset().mockResolvedValue('active');
  mockRunTrackedRealtimeDelivery.mockImplementation(
    async (task: (lease: typeof activeLease) => Promise<void>) => {
      await task(activeLease);
      return 'delivered';
    },
  );
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('FCM native callback ownership', () => {
  it('registers the killed-app handler at explicit entry-module evaluation and tracks its whole delivery', async () => {
    expect(mockBackgroundHandler).toEqual(expect.any(Function));

    await expect(mockBackgroundHandler!(message)).resolves.toBeUndefined();

    expect(mockRunTrackedRealtimeDelivery).toHaveBeenCalledTimes(1);
    expect(mockDispatchRealtimeEvent).toHaveBeenCalledWith(
      'new-message',
      { guid: 'm1' },
      'fcm',
      activeLease,
      expect.objectContaining({
        transportOccurrenceId: 'provider-message-1',
        receivedAt: expect.any(Number),
      }),
    );
    expect(diagnosticEvent).toHaveBeenCalledWith('fcm.push_received', {
      eventName: 'new-message',
      source: 'background',
    });
  });

  it('captures the provider occurrence id before the first asynchronous gate', async () => {
    const mutableMessage: NativeMessage = {
      messageId: 'captured-before-await',
      data: { type: 'new-message' },
    };

    const handled = mockBackgroundHandler!(mutableMessage);
    mutableMessage.messageId = 'mutated-after-callback';
    await handled;

    expect(mockDispatchRealtimeEvent).toHaveBeenCalledWith(
      'new-message',
      { guid: 'm1' },
      'fcm',
      activeLease,
      expect.objectContaining({
        transportOccurrenceId: 'captured-before-await',
        receivedAt: expect.any(Number),
      }),
    );
  });

  it('drops a delivery whose account lease expires while the session gate is pending', async () => {
    const sessionGate = deferred<'active'>();
    mockReadFcmSessionState.mockReturnValueOnce(sessionGate.promise);

    const handled = mockBackgroundHandler!(message);
    await settle();
    leaseCurrent = false;
    sessionGate.resolve('active');
    await handled;

    expect(mockDispatchRealtimeEvent).not.toHaveBeenCalled();
    expect(mockPostLockedNotification).not.toHaveBeenCalled();
    expect(mockVaultGet).not.toHaveBeenCalledWith('appLockEnabled');
  });

  it.each(['forgotten', 'unavailable'] as const)(
    'drops a %s session before reading lock state or dispatching',
    async (sessionState) => {
      mockReadFcmSessionState.mockResolvedValueOnce(sessionState);

      await mockBackgroundHandler!(message);

      expect(mockVaultGet).not.toHaveBeenCalledWith('appLockEnabled');
      expect(mockPostLockedNotification).not.toHaveBeenCalled();
      expect(mockDispatchRealtimeEvent).not.toHaveBeenCalled();
    },
  );

  it('does not publish after the account lease expires during the app-lock vault read', async () => {
    const lockGate = deferred<string | null>();
    mockVaultGet.mockImplementation((key: string) =>
      key === 'appLockEnabled' ? lockGate.promise : Promise.resolve('server-password'),
    );

    const handled = mockBackgroundHandler!(message);
    await settle();
    expect(mockVaultGet).toHaveBeenCalledWith('appLockEnabled');

    leaseCurrent = false;
    lockGate.resolve('false');
    await handled;

    expect(mockPostLockedNotification).not.toHaveBeenCalled();
    expect(mockDispatchRealtimeEvent).not.toHaveBeenCalled();
  });

  it('drops decrypted content when the account lease expires during native decryption', async () => {
    const decryptGate = deferred<string>();
    mockParseFcmData.mockReturnValueOnce({
      eventName: 'new-message',
      body: 'encrypted-frame',
      envelopeChatGuid: 'encrypted-chat',
      encrypted: true,
      encryptionType: 'aes-gcm',
    });
    mockDecryptFcmPayload.mockReturnValueOnce(decryptGate.promise);

    const handled = mockBackgroundHandler!(message);
    await settle();
    expect(mockDecryptFcmPayload).toHaveBeenCalledTimes(1);
    leaseCurrent = false;
    decryptGate.resolve('{"guid":"stale-decrypted-message"}');
    await handled;

    expect(mockDispatchRealtimeEvent).not.toHaveBeenCalled();
    expect(mockPostLockedNotification).not.toHaveBeenCalled();
  });

  it('keeps native receipt order when an earlier FCM gate settles later', async () => {
    jest.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(2_000);
    const firstSessionGate = deferred<'active'>();
    mockReadFcmSessionState
      .mockReturnValueOnce(firstSessionGate.promise)
      .mockResolvedValueOnce('active');

    const first = mockBackgroundHandler!({
      messageId: 'native-first',
      data: { type: 'new-message' },
    });
    const second = mockBackgroundHandler!({
      messageId: 'native-second',
      data: { type: 'new-message' },
    });
    await settle();

    // Both callbacks are already registered with teardown, but the later one cannot pass its
    // session gate or dispatch until the earlier callback completes admission.
    expect(mockRunTrackedRealtimeDelivery).toHaveBeenCalledTimes(2);
    expect(mockReadFcmSessionState).toHaveBeenCalledTimes(1);
    expect(mockDispatchRealtimeEvent).not.toHaveBeenCalled();

    firstSessionGate.resolve('active');
    await Promise.all([first, second]);

    const occurrences = mockDispatchRealtimeEvent.mock.calls.map(
      (call) => call[4] as { transportOccurrenceId: string; receivedAt: number },
    );
    expect(occurrences).toEqual([
      { transportOccurrenceId: 'native-first', receivedAt: 1_000 },
      { transportOccurrenceId: 'native-second', receivedAt: 2_000 },
    ]);
  });

  it('uses distinct bounded process-local occurrence ids when Firebase omits messageId', async () => {
    await mockBackgroundHandler!({ data: { type: 'new-message' } });
    await mockBackgroundHandler!({ data: { type: 'new-message' } });

    const occurrenceIds = mockDispatchRealtimeEvent.mock.calls.map(
      (call) => (call[4] as { transportOccurrenceId: string }).transportOccurrenceId,
    );
    expect(occurrenceIds).toHaveLength(2);
    expect(occurrenceIds[0]).toMatch(/^fcm-local:[a-z0-9]+-[a-z0-9]*:\d+$/);
    expect(occurrenceIds[1]).toMatch(/^fcm-local:[a-z0-9]+-[a-z0-9]*:\d+$/);
    expect(occurrenceIds[0]).not.toBe(occurrenceIds[1]);
    expect(occurrenceIds.every((id) => new TextEncoder().encode(id).byteLength <= 512)).toBe(true);
  });

  it('rehydrates an encrypted lean body before durable dispatch', async () => {
    mockParseFcmData.mockReturnValueOnce({
      eventName: 'new-message',
      body: 'encrypted-frame',
      envelopeChatGuid: 'encrypted-chat',
      encrypted: true,
      encryptionType: 'aes-gcm',
    });
    mockDecryptFcmPayload.mockResolvedValueOnce(
      JSON.stringify({ guid: 'decrypted-message', text: 'hello' }),
    );

    await mockBackgroundHandler!({
      messageId: 'encrypted-provider-id',
      data: { type: 'new-message' },
    });

    expect(mockDecryptFcmPayload).toHaveBeenCalledWith('encrypted-frame', 'server-password');
    expect(mockDispatchRealtimeEvent).toHaveBeenCalledWith(
      'new-message',
      JSON.stringify({
        guid: 'decrypted-message',
        text: 'hello',
        chatGuid: 'encrypted-chat',
      }),
      'fcm',
      activeLease,
      expect.objectContaining({
        transportOccurrenceId: 'encrypted-provider-id',
        receivedAt: expect.any(Number),
      }),
    );
  });

  it.each(['pending', 'active'] as const)(
    'authenticates and dispatches a V2 payload from %s state',
    async (status) => {
      const state =
        status === 'pending'
          ? pendingFcmDeviceEncryptionState(V2_KEY, 'https://gator.example')
          : activeFcmDeviceEncryptionState(V2_KEY, 'device-v2', 'https://gator.example');
      mockVaultGet.mockImplementation(async (key: string) =>
        key === 'appLockEnabled'
          ? 'false'
          : key === 'fcmPushEncryptionV2'
            ? serializeFcmDeviceEncryptionState(state)
            : key === 'serverAddress'
              ? 'https://gator.example'
              : key === 'serverPassword'
                ? 'server-password'
                : null,
      );
      mockParseFcmData.mockReturnValueOnce({
        eventName: 'message-send-error',
        body: 'v2-frame',
        // Current V2 does not authenticate this sibling, so it must not be merged into plaintext.
        envelopeChatGuid: 'unauthenticated-outer-chat',
        encrypted: true,
        encryptionType: 'AEAD_GCM_V2_DEVICE',
      });
      mockDecryptFcmV2Payload.mockResolvedValueOnce('{"guid":"v2-message"}');

      await mockBackgroundHandler!(message);

      expect(mockDecryptFcmV2Payload).toHaveBeenCalledWith(
        'v2-frame',
        V2_KEY,
        'message-send-error',
      );
      expect(mockDispatchRealtimeEvent).toHaveBeenCalledWith(
        'message-send-error',
        '{"guid":"v2-message"}',
        'fcm',
        activeLease,
        expect.anything(),
      );
      expect(mockDispatchRealtimeEvent.mock.calls[0]?.[1]).not.toContain(
        'unauthenticated-outer-chat',
      );
    },
  );

  it.each([
    { encrypted: false, encryptionType: '', body: '{"guid":"plaintext"}' },
    { encrypted: true, encryptionType: 'aes-gcm', body: 'legacy-frame' },
    { encrypted: true, encryptionType: 'unknown-scheme', body: 'unknown-frame' },
  ])('rejects legacy/unsupported delivery after V2 migration: $encryptionType', async (shape) => {
    const state = activeFcmDeviceEncryptionState(V2_KEY, 'device-v2', 'https://gator.example');
    mockVaultGet.mockImplementation(async (key: string) =>
      key === 'appLockEnabled'
        ? 'false'
        : key === 'fcmPushEncryptionV2'
          ? serializeFcmDeviceEncryptionState(state)
          : key === 'serverAddress'
            ? 'https://gator.example'
            : null,
    );
    mockParseFcmData.mockReturnValueOnce({
      eventName: 'new-message',
      envelopeChatGuid: undefined,
      ...shape,
    });

    await mockBackgroundHandler!(message);

    expect(mockDecryptFcmPayload).not.toHaveBeenCalled();
    expect(mockDecryptFcmV2Payload).not.toHaveBeenCalled();
    expect(mockDispatchRealtimeEvent).not.toHaveBeenCalled();
  });

  it.each([
    ['corrupt', 'not-json', 'https://gator.example'],
    [
      'revoked',
      serializeFcmDeviceEncryptionState(revokedFcmDeviceEncryptionState()),
      'https://gator.example',
    ],
    [
      'wrong origin',
      serializeFcmDeviceEncryptionState(
        activeFcmDeviceEncryptionState(V2_KEY, 'device-v2', 'https://old.example'),
      ),
      'https://gator.example',
    ],
  ])('fails closed for %s V2 state', async (_label, storedState, currentOrigin) => {
    mockVaultGet.mockImplementation(async (key: string) =>
      key === 'appLockEnabled'
        ? 'false'
        : key === 'fcmPushEncryptionV2'
          ? storedState
          : key === 'serverAddress'
            ? currentOrigin
            : null,
    );
    mockParseFcmData.mockReturnValueOnce({
      eventName: 'new-message',
      body: 'v2-frame',
      envelopeChatGuid: undefined,
      encrypted: true,
      encryptionType: 'AEAD_GCM_V2_DEVICE',
    });

    await mockBackgroundHandler!(message);

    expect(mockDecryptFcmV2Payload).not.toHaveBeenCalled();
    expect(mockDispatchRealtimeEvent).not.toHaveBeenCalled();
  });

  it('fails closed when the V2 state SecureStore read is unavailable', async () => {
    mockVaultGet.mockImplementation(async (key: string) => {
      if (key === 'appLockEnabled') return 'false';
      if (key === 'fcmPushEncryptionV2') throw new Error('SecureStore unavailable');
      return key === 'serverAddress' ? 'https://gator.example' : null;
    });

    await mockBackgroundHandler!(message);

    expect(mockDispatchRealtimeEvent).not.toHaveBeenCalled();
  });

  it('contains only decryption failures and leaves durable dispatch untouched', async () => {
    const decryptFailure = new Error('authentication tag mismatch');
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    mockParseFcmData.mockReturnValueOnce({
      eventName: 'new-message',
      body: 'bad-frame',
      envelopeChatGuid: 'encrypted-chat',
      encrypted: true,
      encryptionType: 'aes-gcm',
    });
    mockDecryptFcmPayload.mockRejectedValueOnce(decryptFailure);

    await mockBackgroundHandler!(message);

    expect(mockDispatchRealtimeEvent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[fcm] failed to decrypt push; sync may recover server state, but a one-time event may be lost',
      decryptFailure,
    );
  });

  it('does not mislabel or swallow a durable dispatch failure as decryption failure', async () => {
    const dispatchFailure = new Error('durable enqueue failed');
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    mockParseFcmData.mockReturnValueOnce({
      eventName: 'new-message',
      body: 'valid-frame',
      envelopeChatGuid: undefined,
      encrypted: true,
      encryptionType: 'aes-gcm',
    });
    mockDispatchRealtimeEvent.mockRejectedValueOnce(dispatchFailure);

    await mockBackgroundHandler!(message);

    expect(mockDecryptFcmPayload).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalledWith(
      '[fcm] failed to decrypt push; sync may recover server state, but a one-time event may be lost',
      expect.anything(),
    );
    expect(warn).toHaveBeenCalledWith(
      '[fcm] push delivery failed; sync may recover server state, but a one-time event may be lost',
      expect.objectContaining({ source: 'background', errorName: 'Error' }),
    );
  });

  it('keeps the locked path generic and never decrypts or durably dispatches content', async () => {
    mockVaultGet.mockImplementation(async (key: string) =>
      key === 'appLockEnabled' ? 'true' : 'server-password',
    );
    mockEffectivelyLocked.mockImplementationOnce(
      (_lockState, storedAppLockEnabled) => storedAppLockEnabled,
    );
    mockParseFcmData.mockReturnValueOnce({
      eventName: 'new-message',
      body: 'encrypted-private-frame',
      envelopeChatGuid: 'private-chat',
      encrypted: true,
      encryptionType: 'aes-gcm',
    });

    await mockBackgroundHandler!(message);

    expect(mockEffectivelyLocked).toHaveBeenCalledWith(expect.anything(), true);
    expect(mockPostLockedNotification).toHaveBeenCalledWith(activeLease);
    expect(mockDecryptFcmPayload).not.toHaveBeenCalled();
    expect(mockDecryptFcmV2Payload).not.toHaveBeenCalled();
    expect(mockVaultGet).not.toHaveBeenCalledWith('fcmPushEncryptionV2');
    expect(mockDispatchRealtimeEvent).not.toHaveBeenCalled();
  });

  it('fails closed when the persisted app-lock value is malformed', async () => {
    mockVaultGet.mockImplementation(async (key: string) =>
      key === 'appLockEnabled' ? 'yes' : 'server-password',
    );
    mockEffectivelyLocked.mockImplementationOnce(
      (_lockState, storedAppLockEnabled) => storedAppLockEnabled,
    );
    mockParseFcmData.mockReturnValueOnce({
      eventName: 'new-message',
      body: 'encrypted-private-frame',
      envelopeChatGuid: 'private-chat',
      encrypted: true,
      encryptionType: 'aes-gcm',
    });

    await mockBackgroundHandler!(message);

    expect(mockEffectivelyLocked).toHaveBeenCalledWith(expect.anything(), true);
    expect(mockPostLockedNotification).toHaveBeenCalledWith(activeLease);
    expect(mockDecryptFcmPayload).not.toHaveBeenCalled();
    expect(mockDispatchRealtimeEvent).not.toHaveBeenCalled();
  });

  it('fails closed when the app-lock vault value is unavailable', async () => {
    const vaultFailure = new Error('secure vault unavailable');
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    mockVaultGet.mockRejectedValueOnce(vaultFailure);
    mockParseFcmData.mockReturnValueOnce({
      eventName: 'new-message',
      body: 'encrypted-private-frame',
      envelopeChatGuid: 'private-chat',
      encrypted: true,
      encryptionType: 'aes-gcm',
    });

    await mockBackgroundHandler!(message);

    expect(mockEffectivelyLocked).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[fcm] lock-state check failed — failing closed (content-less notice)',
      vaultFailure,
    );
    expect(mockPostLockedNotification).toHaveBeenCalledWith(activeLease);
    expect(mockDecryptFcmPayload).not.toHaveBeenCalled();
    expect(mockDispatchRealtimeEvent).not.toHaveBeenCalled();
  });

  it('makes the foreground EventEmitter callback return void while delivery continues', async () => {
    await expect(startFcm()).resolves.toBe('ready');
    expect(mockForegroundHandler).toEqual(expect.any(Function));

    const returned = mockForegroundHandler!(message);
    expect(returned).toBeUndefined();
    await settle();

    expect(mockRunTrackedRealtimeDelivery).toHaveBeenCalledTimes(1);
    expect(mockDispatchRealtimeEvent).toHaveBeenCalledTimes(1);
    expect(diagnosticEvent).toHaveBeenCalledWith('fcm.push_received', {
      eventName: 'new-message',
      source: 'foreground',
    });
  });

  it('returns a failed status when foreground native listener setup is unavailable', async () => {
    mockGetMessaging.mockImplementationOnce(() => {
      throw new Error('Firebase unavailable');
    });

    await expect(startFcm()).resolves.toBe('failed');
  });

  it('contains an async foreground failure instead of creating an unhandled rejection', async () => {
    const failure = new Error('database write failed');
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    mockRunTrackedRealtimeDelivery.mockRejectedValueOnce(failure);
    await startFcm();

    expect(mockForegroundHandler!(message)).toBeUndefined();
    await settle();

    expect(warn).toHaveBeenCalledWith(
      '[fcm] push delivery failed; sync may recover server state, but a one-time event may be lost',
      expect.objectContaining({ source: 'foreground', errorName: 'Error' }),
    );
  });
});
