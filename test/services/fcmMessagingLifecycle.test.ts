/* eslint-disable import/first -- native-module mocks must exist before the module under test loads. */

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

interface MockV3Identity {
  version: 3;
  eventType: string;
  serverInstallationId: string;
  principalId: string;
  deviceId: string;
  occurrenceId: string;
  messageId?: string;
  issuedAt: number;
  expiresAt: number;
}

let mockBackgroundHandler: NativeHandler | undefined;
let mockForegroundHandler: NativeHandler | undefined;
const mockGetMessaging = jest.fn(() => ({ app: 'messaging' }));
const mockDispatchRealtimeEvent = jest.fn(async (..._args: unknown[]) => undefined);
const mockPersistAuthenticatedLockedFcmV3Event = jest.fn(
  async (..._args: unknown[]): Promise<'enqueued' | 'not-enqueued'> => 'enqueued',
);
const mockParseFcmData = jest.fn((): MockParsedFcm => ({
  eventName: 'new-message',
  body: { guid: 'm1' },
  envelopeChatGuid: undefined as string | undefined,
  encrypted: false,
  encryptionType: '',
}));
const mockDecryptFcmV2Payload = jest.fn(async () => '{"guid":"decrypted-v2-message"}');
const mockDecryptFcmV3Payload = jest.fn<
  Promise<{ plaintext: string; identity: MockV3Identity }>,
  [string, string, string]
>(async () => ({
  plaintext: '{"guid":"decrypted-v3-message"}',
  identity: {
    version: 3,
    eventType: 'new-message',
    serverInstallationId: '11111111-1111-4111-8111-111111111111',
    principalId: '22222222-2222-4222-8222-222222222222',
    deviceId: '33333333-3333-4333-8333-333333333333',
    occurrenceId: '44444444-4444-4444-8444-444444444444',
    messageId: 'decrypted-v3-message',
    issuedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_300_000,
  },
}));
const mockEffectivelyLocked = jest.fn(
  (_lockState: unknown, _storedAppLockEnabled: boolean): boolean => false,
);
const mockPostLockedNotification = jest.fn(async () => undefined);
const mockCloseHeadlessEffects = jest.fn<Promise<'completed' | 'deadline' | 'account-changed'>, []>(
  async () => 'completed',
);
const mockBeginHeadlessEffects = jest.fn(() => ({ close: mockCloseHeadlessEffects }));
const mockFlushPersistentLogs = jest.fn(async (): Promise<boolean> => true);
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
const mockGenerationInvalidationListeners = new Set<() => void>();
const mockSubscribeRealtimeGenerationInvalidation = jest.fn(
  (generation: number, listener: () => void): (() => void) => {
    if (!leaseCurrent || generation !== activeLease.generation) {
      listener();
      return () => undefined;
    }
    mockGenerationInvalidationListeners.add(listener);
    return () => mockGenerationInvalidationListeners.delete(listener);
  },
);
function invalidateActiveGeneration(): void {
  leaseCurrent = false;
  const listeners = [...mockGenerationInvalidationListeners];
  mockGenerationInvalidationListeners.clear();
  for (const listener of listeners) listener();
}
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
jest.mock('@/services/background/realtimeHeadlessEffects', () => ({
  REALTIME_HEADLESS_EFFECT_WINDOW_MS: 40_000,
  beginRealtimeHeadlessEffectCollection: mockBeginHeadlessEffects,
}));
jest.mock('@/services/logging/fileLogSink', () => ({
  flushPersistentLogsForHeadlessCompletion: mockFlushPersistentLogs,
}));
jest.mock('@/services/realtimeControl', () => ({
  dispatchRealtimeEvent: mockDispatchRealtimeEvent,
  persistAuthenticatedLockedFcmV3Event: mockPersistAuthenticatedLockedFcmV3Event,
}));
jest.mock('@/services/notifications/fcmPayload', () => ({
  parseFcmData: mockParseFcmData,
  rehydrateFcmEnvelopeChatGuid: jest.requireActual('@/services/notifications/fcmPayload')
    .rehydrateFcmEnvelopeChatGuid,
}));
jest.mock('@/services/notifications/fcmDecrypt', () => ({
  FCM_V2_ENCRYPTION_TYPE: 'AEAD_GCM_V2_DEVICE',
  FCM_V3_ENCRYPTION_TYPE: 'AEAD_GCM_V3_IDENTITY',
  decryptFcmV2Payload: mockDecryptFcmV2Payload,
  decryptFcmV3Payload: mockDecryptFcmV3Payload,
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
  subscribeRealtimeGenerationInvalidation: mockSubscribeRealtimeGenerationInvalidation,
}));

import { logger } from '@core/secure';
import {
  activeFcmPushKeyState,
  activeFcmDeviceEncryptionV3State,
  activeFcmDeviceEncryptionState,
  pendingFcmDeviceEncryptionV3State,
  pendingFcmDeviceEncryptionState,
  revokedFcmDeviceEncryptionState,
  serializeFcmDeviceEncryptionState,
} from '@core/realtime';
import {
  FCM_HEADLESS_DELIVERY_WINDOW_MS,
  FCM_V2_COMPATIBILITY_CUTOFF_MS,
  startFcm,
} from '@/services/notifications/fcmMessaging';
import '@/services/notifications/registerFcmBackgroundHandler';

const message = { messageId: 'provider-message-1', data: { type: 'new-message' } };
const V2_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const V3_NEXT_KEY = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc';
const V3_BINDING = {
  serverInstallationId: '11111111-1111-4111-8111-111111111111',
  principalId: '22222222-2222-4222-8222-222222222222',
  deviceId: '33333333-3333-4333-8333-333333333333',
} as const;
const V3_OCCURRENCE_ID = '44444444-4444-4444-8444-444444444444';
const V3_NOW = 1_700_000_000_000;
let diagnosticEvent: jest.SpyInstance;

function v3Identity(overrides: Partial<MockV3Identity> = {}): MockV3Identity {
  return {
    version: 3,
    eventType: 'new-message',
    ...V3_BINDING,
    occurrenceId: V3_OCCURRENCE_ID,
    messageId: 'v3-message',
    issuedAt: V3_NOW,
    expiresAt: V3_NOW + 300_000,
    ...overrides,
  };
}

function configureV3Delivery(options: {
  locked: boolean;
  eventName?: string;
  plaintext?: string;
  identity?: MockV3Identity;
}): void {
  const state = activeFcmDeviceEncryptionV3State(V2_KEY, V3_BINDING, 'https://gator.example');
  mockVaultGet.mockImplementation(async (key: string) => {
    if (key === 'appLockEnabled') return options.locked ? 'true' : 'false';
    if (key === 'fcmPushEncryptionV2') return serializeFcmDeviceEncryptionState(state);
    if (key === 'serverAddress') return 'https://gator.example';
    return null;
  });
  mockEffectivelyLocked.mockImplementation(
    (_lockState, storedAppLockEnabled) => storedAppLockEnabled,
  );
  mockParseFcmData.mockReturnValue({
    eventName: options.eventName ?? 'new-message',
    body: 'v3-frame',
    envelopeChatGuid: undefined,
    encrypted: true,
    encryptionType: 'AEAD_GCM_V3_IDENTITY',
  });
  mockDecryptFcmV3Payload.mockResolvedValue({
    plaintext: options.plaintext ?? '{"guid":"v3-message"}',
    identity: options.identity ?? v3Identity(),
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(FCM_V2_COMPATIBILITY_CUTOFF_MS - 1);
  diagnosticEvent = jest.spyOn(logger, 'event').mockImplementation(() => undefined);
  leaseCurrent = true;
  mockGenerationInvalidationListeners.clear();
  mockSubscribeRealtimeGenerationInvalidation.mockClear();
  mockGetMessaging.mockReturnValue({ app: 'messaging' });
  mockDispatchRealtimeEvent.mockResolvedValue(undefined);
  mockPersistAuthenticatedLockedFcmV3Event.mockResolvedValue('enqueued');
  mockParseFcmData.mockReturnValue({
    eventName: 'new-message',
    body: 'v2-frame',
    envelopeChatGuid: undefined,
    encrypted: true,
    encryptionType: 'AEAD_GCM_V2_DEVICE',
  });
  mockDecryptFcmV2Payload.mockResolvedValue('{"guid":"m1"}');
  mockDecryptFcmV3Payload.mockResolvedValue({
    plaintext: '{"guid":"v3-message"}',
    identity: v3Identity(),
  });
  mockEffectivelyLocked.mockReturnValue(false);
  mockVaultGet.mockImplementation(async (key: string) =>
    key === 'serverPassword'
      ? 'server-password'
      : key === 'serverAddress'
        ? 'https://gator.example'
        : key === 'appLockEnabled'
          ? 'false'
          : key === 'fcmPushEncryptionV2'
            ? serializeFcmDeviceEncryptionState(
                activeFcmDeviceEncryptionState(V2_KEY, 'device-v2', 'https://gator.example'),
              )
            : null,
  );
  mockReadFcmSessionState.mockReset().mockResolvedValue('active');
  mockRunTrackedRealtimeDelivery.mockImplementation(
    async (task: (lease: typeof activeLease) => Promise<void>) => {
      await task(activeLease);
      return 'delivered';
    },
  );
  mockCloseHeadlessEffects.mockReset().mockResolvedValue('completed');
  mockBeginHeadlessEffects.mockClear();
  mockFlushPersistentLogs.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('FCM native callback ownership', () => {
  it('registers the killed-app handler at explicit entry-module evaluation and tracks its whole delivery', async () => {
    expect(mockBackgroundHandler).toEqual(expect.any(Function));

    await expect(mockBackgroundHandler!(message)).resolves.toBeUndefined();

    expect(mockRunTrackedRealtimeDelivery).toHaveBeenCalledTimes(1);
    expect(mockBeginHeadlessEffects).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: activeLease.generation,
        signal: expect.any(AbortSignal),
        isCurrent: expect.any(Function),
      }),
      expect.objectContaining({ deadlineAt: expect.any(Number) }),
    );
    expect(mockCloseHeadlessEffects).toHaveBeenCalledTimes(1);
    expect(mockDispatchRealtimeEvent).toHaveBeenCalledWith(
      'new-message',
      '{"guid":"m1"}',
      'fcm',
      expect.objectContaining({
        generation: activeLease.generation,
        signal: expect.any(AbortSignal),
        isCurrent: expect.any(Function),
      }),
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

  it('keeps the background native callback open until bounded post-commit effects settle', async () => {
    const effects = deferred<'completed'>();
    mockCloseHeadlessEffects.mockReturnValueOnce(effects.promise);
    let settled = false;

    const handled = Promise.resolve(mockBackgroundHandler!(message)).then(() => {
      settled = true;
    });
    for (
      let index = 0;
      index < 20 && mockCloseHeadlessEffects.mock.calls.length === 0;
      index += 1
    ) {
      await Promise.resolve();
    }

    expect(mockDispatchRealtimeEvent).toHaveBeenCalledTimes(1);
    expect(mockCloseHeadlessEffects).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    effects.resolve('completed');
    await expect(handled).resolves.toBeUndefined();
  });

  it('persists an effect-deadline warning inside the separate callback-finalization window', async () => {
    const callbackStartedAt = 10_000;
    jest.spyOn(Date, 'now').mockReturnValue(callbackStartedAt);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    mockCloseHeadlessEffects.mockResolvedValueOnce('deadline');

    await expect(mockBackgroundHandler!(message)).resolves.toBeUndefined();

    expect(mockBeginHeadlessEffects).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: activeLease.generation,
        signal: expect.any(AbortSignal),
        isCurrent: expect.any(Function),
      }),
      { deadlineAt: callbackStartedAt + 40_000 },
    );
    expect(warn).toHaveBeenCalledWith(
      '[fcm] headless side effects reached their bounded effect deadline',
    );
    expect(mockFlushPersistentLogs).toHaveBeenCalledWith(callbackStartedAt + 55_000);
    expect(warn.mock.invocationCallOrder[0]).toBeLessThan(
      mockFlushPersistentLogs.mock.invocationCallOrder[0]!,
    );
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
      '{"guid":"m1"}',
      'fcm',
      expect.objectContaining({
        generation: activeLease.generation,
        signal: expect.any(AbortSignal),
        isCurrent: expect.any(Function),
      }),
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

  it('drops V2 content when the account lease expires during native decryption', async () => {
    const decryptGate = deferred<string>();
    mockParseFcmData.mockReturnValueOnce({
      eventName: 'new-message',
      body: 'encrypted-frame',
      envelopeChatGuid: 'encrypted-chat',
      encrypted: true,
      encryptionType: 'AEAD_GCM_V2_DEVICE',
    });
    mockDecryptFcmV2Payload.mockReturnValueOnce(decryptGate.promise);

    const handled = mockBackgroundHandler!(message);
    try {
      for (
        let attempt = 0;
        attempt < 50 && mockDecryptFcmV2Payload.mock.calls.length === 0;
        attempt += 1
      ) {
        await Promise.resolve();
      }
      expect(mockDecryptFcmV2Payload).toHaveBeenCalledTimes(1);
    } finally {
      leaseCurrent = false;
      decryptGate.resolve('{"guid":"stale-decrypted-message"}');
      await handled;
    }

    expect(mockDispatchRealtimeEvent).not.toHaveBeenCalled();
    expect(mockPostLockedNotification).not.toHaveBeenCalled();
  });

  it('keeps native receipt order when an earlier FCM gate settles later', async () => {
    let now = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const firstSessionGate = deferred<'active'>();
    mockReadFcmSessionState
      .mockReturnValueOnce(firstSessionGate.promise)
      .mockResolvedValueOnce('active');

    const first = mockBackgroundHandler!({
      messageId: 'native-first',
      data: { type: 'new-message' },
    });
    now = 2_000;
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

  it('bounds callbacks waiting in FIFO and never overlaps a late predecessor', async () => {
    jest.useFakeTimers();
    const firstSessionGate = deferred<'active'>();
    mockReadFcmSessionState.mockReturnValueOnce(firstSessionGate.promise);
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    let third: Promise<void> | undefined;
    try {
      first = Promise.resolve(
        mockBackgroundHandler!({
          messageId: 'deadline-first',
          data: { type: 'new-message' },
        }),
      );
      second = Promise.resolve(
        mockBackgroundHandler!({
          messageId: 'deadline-second',
          data: { type: 'new-message' },
        }),
      );
      await settle();

      expect(mockRunTrackedRealtimeDelivery).toHaveBeenCalledTimes(2);
      expect(mockReadFcmSessionState).toHaveBeenCalledTimes(1);
      expect(mockDispatchRealtimeEvent).not.toHaveBeenCalled();

      jest.advanceTimersByTime(FCM_HEADLESS_DELIVERY_WINDOW_MS);
      await settle();
      await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
      expect(mockDispatchRealtimeEvent).not.toHaveBeenCalled();

      third = Promise.resolve(
        mockBackgroundHandler!({
          messageId: 'fresh-after-deadline',
          data: { type: 'new-message' },
        }),
      );
      await settle();
      expect(mockRunTrackedRealtimeDelivery).toHaveBeenCalledTimes(3);
      expect(mockReadFcmSessionState).toHaveBeenCalledTimes(1);

      firstSessionGate.resolve('active');
      await expect(third).resolves.toBeUndefined();
      expect(mockReadFcmSessionState).toHaveBeenCalledTimes(2);
      expect(mockDispatchRealtimeEvent).toHaveBeenCalledTimes(1);
      expect(mockDispatchRealtimeEvent.mock.calls[0]?.[4]).toMatchObject({
        transportOccurrenceId: 'fresh-after-deadline',
      });
    } finally {
      firstSessionGate.resolve('active');
      jest.runOnlyPendingTimers();
      await settle();
      await Promise.allSettled(
        [first, second, third].filter((value): value is Promise<void> => !!value),
      );
      jest.useRealTimers();
    }
  });

  it('releases a foreground teardown wait without overtaking an expired predecessor', async () => {
    jest.useFakeTimers();
    const firstSessionGate = deferred<'active'>();
    mockReadFcmSessionState.mockReturnValueOnce(firstSessionGate.promise);
    await startFcm();
    let first: Promise<void> | undefined;
    let fresh: Promise<void> | undefined;
    try {
      first = Promise.resolve(
        mockBackgroundHandler!({
          messageId: 'expired-predecessor',
          data: { type: 'new-message' },
        }),
      );
      await settle();
      expect(mockReadFcmSessionState).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(FCM_HEADLESS_DELIVERY_WINDOW_MS);
      await settle();
      await expect(first).resolves.toBeUndefined();

      expect(
        mockForegroundHandler!({
          messageId: 'foreground-behind-expired',
          data: { type: 'new-message' },
        }),
      ).toBeUndefined();
      await settle();
      expect(mockRunTrackedRealtimeDelivery).toHaveBeenCalledTimes(2);
      expect(mockReadFcmSessionState).toHaveBeenCalledTimes(1);

      const foregroundTracked = mockRunTrackedRealtimeDelivery.mock.results[1]?.value as
        Promise<'delivered' | 'paused'> | undefined;
      expect(foregroundTracked).toBeDefined();
      let teardownWaitSettled = false;
      const teardownWait = foregroundTracked?.finally(() => {
        teardownWaitSettled = true;
      });
      await settle();
      expect(teardownWaitSettled).toBe(false);

      invalidateActiveGeneration();
      await expect(teardownWait).resolves.toBe('delivered');
      expect(mockDispatchRealtimeEvent).not.toHaveBeenCalled();

      firstSessionGate.resolve('active');
      await settle();
      expect(mockDispatchRealtimeEvent).not.toHaveBeenCalled();

      leaseCurrent = true;
      fresh = Promise.resolve(
        mockBackgroundHandler!({
          messageId: 'fresh-after-teardown',
          data: { type: 'new-message' },
        }),
      );
      await expect(fresh).resolves.toBeUndefined();
      expect(mockDispatchRealtimeEvent).toHaveBeenCalledTimes(1);
      expect(mockDispatchRealtimeEvent.mock.calls[0]?.[4]).toMatchObject({
        transportOccurrenceId: 'fresh-after-teardown',
      });
    } finally {
      firstSessionGate.resolve('active');
      leaseCurrent = true;
      await settle();
      await Promise.allSettled([first, fresh].filter((value): value is Promise<void> => !!value));
      jest.clearAllTimers();
      jest.useRealTimers();
    }
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

  it.each([
    {
      credential: 'server-password',
      label: 'shared-password plaintext',
      encrypted: false,
      encryptionType: '',
      body: '{"guid":"plaintext"}',
    },
    {
      credential: 'server-password',
      label: 'shared-password V1',
      encrypted: true,
      encryptionType: 'aes-gcm',
      body: 'legacy-frame',
    },
    {
      credential: `bbd_device_v1_${'W'.repeat(43)}`,
      label: 'scoped plaintext',
      encrypted: false,
      encryptionType: '',
      body: '{"guid":"plaintext"}',
    },
    {
      credential: `bbd_device_v1_${'W'.repeat(43)}`,
      label: 'scoped V1',
      encrypted: true,
      encryptionType: 'aes-gcm',
      body: 'legacy-frame',
    },
  ])('rejects absent-state $label delivery', async ({ credential, label: _label, ...shape }) => {
    mockVaultGet.mockImplementation(async (key: string) =>
      key === 'appLockEnabled'
        ? 'false'
        : key === 'serverPassword'
          ? credential
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

    expect(mockDispatchRealtimeEvent).not.toHaveBeenCalled();
    expect(mockPostLockedNotification).not.toHaveBeenCalled();
  });

  it.each(['pending', 'active'] as const)(
    'authenticates and dispatches a V2 payload from %s state',
    async (status) => {
      jest.spyOn(Date, 'now').mockReturnValue(FCM_V2_COMPATIBILITY_CUTOFF_MS - 1);
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
        expect.objectContaining({
          generation: activeLease.generation,
          signal: expect.any(AbortSignal),
          isCurrent: expect.any(Function),
        }),
        expect.anything(),
      );
      expect(mockDispatchRealtimeEvent.mock.calls[0]?.[1]).not.toContain(
        'unauthenticated-outer-chat',
      );
    },
  );

  it('rejects V2 at the exclusive 2027-02-01 compatibility cutoff', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(FCM_V2_COMPATIBILITY_CUTOFF_MS);
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
      body: 'v2-frame',
      envelopeChatGuid: undefined,
      encrypted: true,
      encryptionType: 'AEAD_GCM_V2_DEVICE',
    });

    await mockBackgroundHandler!(message);

    expect(mockDecryptFcmV2Payload).not.toHaveBeenCalled();
    expect(mockDispatchRealtimeEvent).not.toHaveBeenCalled();
    expect(mockPostLockedNotification).not.toHaveBeenCalled();
  });

  it('authenticates and durably dispatches one identity-bound V3 payload', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(V3_NOW);
    const state = activeFcmDeviceEncryptionV3State(V2_KEY, V3_BINDING, 'https://gator.example');
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
      body: 'v3-frame',
      envelopeChatGuid: 'unauthenticated-outer-chat',
      encrypted: true,
      encryptionType: 'AEAD_GCM_V3_IDENTITY',
    });

    await mockBackgroundHandler!(message);

    expect(mockDecryptFcmV3Payload).toHaveBeenCalledWith('v3-frame', V2_KEY, 'new-message');
    expect(mockDispatchRealtimeEvent).toHaveBeenCalledWith(
      'new-message',
      '{"guid":"v3-message"}',
      'fcm',
      expect.objectContaining({
        generation: activeLease.generation,
        signal: expect.any(AbortSignal),
        isCurrent: expect.any(Function),
      }),
      {
        transportOccurrenceId: 'provider-message-1',
        receivedAt: V3_NOW,
        serverEventId: `fcm3:${V3_BINDING.serverInstallationId}:${V3_BINDING.principalId}:${V3_BINDING.deviceId}:${V3_OCCURRENCE_ID}`,
        authenticatedExpiresAt: V3_NOW + 300_000,
      },
    );
  });

  it('tries the current V3 key first, then accepts the previous key inside its overlap', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(V3_NOW);
    const state = activeFcmPushKeyState(
      V3_NEXT_KEY,
      2,
      V3_BINDING,
      'https://gator.example',
      V3_NOW - 1_000,
      { key: V2_KEY, keyVersion: 1, expiresAt: V3_NOW + 1_000 },
    );
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
      body: 'v3-frame',
      envelopeChatGuid: undefined,
      encrypted: true,
      encryptionType: 'AEAD_GCM_V3_IDENTITY',
    });
    mockDecryptFcmV3Payload
      .mockRejectedValueOnce(new Error('not encrypted with current key'))
      .mockResolvedValueOnce({ plaintext: '{"guid":"v3-message"}', identity: v3Identity() });

    await mockBackgroundHandler!(message);

    expect(mockDecryptFcmV3Payload.mock.calls.map((call) => call[1])).toEqual([
      V3_NEXT_KEY,
      V2_KEY,
    ]);
    expect(mockDispatchRealtimeEvent).toHaveBeenCalledTimes(1);
  });

  it('does not try the previous V3 key at its exclusive overlap deadline', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(V3_NOW + 1_000);
    const state = activeFcmPushKeyState(
      V3_NEXT_KEY,
      2,
      V3_BINDING,
      'https://gator.example',
      V3_NOW - 1_000,
      { key: V2_KEY, keyVersion: 1, expiresAt: V3_NOW + 1_000 },
    );
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
      body: 'v3-frame',
      envelopeChatGuid: undefined,
      encrypted: true,
      encryptionType: 'AEAD_GCM_V3_IDENTITY',
    });
    mockDecryptFcmV3Payload.mockRejectedValueOnce(new Error('not encrypted with current key'));

    await mockBackgroundHandler!(message);

    expect(mockDecryptFcmV3Payload).toHaveBeenCalledTimes(1);
    expect(mockDecryptFcmV3Payload).toHaveBeenCalledWith('v3-frame', V3_NEXT_KEY, 'new-message');
    expect(mockDispatchRealtimeEvent).not.toHaveBeenCalled();
  });

  it('rejects a previous-key result when native decryption crosses the overlap deadline', async () => {
    let now = V3_NOW;
    const previousDeadline = V3_NOW + 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const state = activeFcmPushKeyState(
      V3_NEXT_KEY,
      2,
      V3_BINDING,
      'https://gator.example',
      V3_NOW - 1_000,
      { key: V2_KEY, keyVersion: 1, expiresAt: previousDeadline },
    );
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
      body: 'v3-frame',
      envelopeChatGuid: undefined,
      encrypted: true,
      encryptionType: 'AEAD_GCM_V3_IDENTITY',
    });
    mockDecryptFcmV3Payload
      .mockRejectedValueOnce(new Error('not encrypted with current key'))
      .mockImplementationOnce(async () => {
        now = previousDeadline;
        return { plaintext: '{"guid":"v3-message"}', identity: v3Identity() };
      });

    await mockBackgroundHandler!(message);

    expect(mockDecryptFcmV3Payload.mock.calls.map((call) => call[1])).toEqual([
      V3_NEXT_KEY,
      V2_KEY,
    ]);
    expect(mockDispatchRealtimeEvent).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'prior server installation after replacement',
      overrides: { serverInstallationId: '55555555-5555-4555-8555-555555555555' },
    },
    {
      label: 'prior account principal after account replacement',
      overrides: { principalId: '55555555-5555-4555-8555-555555555555' },
    },
    {
      label: 'wrong enrolled device',
      overrides: { deviceId: '55555555-5555-4555-8555-555555555555' },
    },
    { label: 'wrong message identity', overrides: { messageId: 'other-message' } },
    { label: 'expired identity', overrides: { issuedAt: V3_NOW - 1_000, expiresAt: V3_NOW } },
    {
      label: 'issue time beyond the accepted future-clock skew',
      overrides: { issuedAt: V3_NOW + 300_001, expiresAt: V3_NOW + 600_001 },
    },
  ])('rejects a V3 payload with $label', async ({ overrides }) => {
    jest.spyOn(Date, 'now').mockReturnValue(V3_NOW);
    const state = activeFcmDeviceEncryptionV3State(V2_KEY, V3_BINDING, 'https://gator.example');
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
      body: 'v3-frame',
      envelopeChatGuid: undefined,
      encrypted: true,
      encryptionType: 'AEAD_GCM_V3_IDENTITY',
    });
    mockDecryptFcmV3Payload.mockResolvedValueOnce({
      plaintext: '{"guid":"v3-message"}',
      identity: v3Identity(overrides),
    });

    await mockBackgroundHandler!(message);

    expect(mockDispatchRealtimeEvent).not.toHaveBeenCalled();
  });

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

  it('contains only V2 authentication failures and leaves durable dispatch untouched', async () => {
    const decryptFailure = new Error('authentication tag mismatch');
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    mockParseFcmData.mockReturnValueOnce({
      eventName: 'new-message',
      body: 'bad-frame',
      envelopeChatGuid: 'encrypted-chat',
      encrypted: true,
      encryptionType: 'AEAD_GCM_V2_DEVICE',
    });
    mockDecryptFcmV2Payload.mockRejectedValueOnce(decryptFailure);

    await mockBackgroundHandler!(message);

    expect(mockDispatchRealtimeEvent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[fcm] failed to authenticate encrypted push; sync may recover server state, but a one-time event may be lost',
      { errorName: 'Error' },
    );
  });

  it('does not mislabel or swallow a durable V2 dispatch failure as authentication failure', async () => {
    const dispatchFailure = new Error('durable enqueue failed');
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    mockParseFcmData.mockReturnValueOnce({
      eventName: 'new-message',
      body: 'valid-frame',
      envelopeChatGuid: undefined,
      encrypted: true,
      encryptionType: 'AEAD_GCM_V2_DEVICE',
    });
    mockDispatchRealtimeEvent.mockRejectedValueOnce(dispatchFailure);

    await mockBackgroundHandler!(message);

    expect(mockDecryptFcmV2Payload).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalledWith(
      '[fcm] failed to authenticate encrypted push; sync may recover server state, but a one-time event may be lost',
      expect.anything(),
    );
    expect(warn).toHaveBeenCalledWith(
      '[fcm] push delivery failed; sync may recover server state, but a one-time event may be lost',
      expect.objectContaining({ source: 'background', errorName: 'Error' }),
    );
  });

  it('authenticates and durably admits locked V3 content before posting one generic notice', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(V3_NOW);
    configureV3Delivery({ locked: true });

    await mockBackgroundHandler!(message);

    expect(mockDecryptFcmV3Payload).toHaveBeenCalledWith('v3-frame', V2_KEY, 'new-message');
    expect(mockPersistAuthenticatedLockedFcmV3Event).toHaveBeenCalledWith(
      'new-message',
      '{"guid":"v3-message"}',
      expect.objectContaining({ generation: 1, isCurrent: expect.any(Function) }),
      {
        transportOccurrenceId: 'provider-message-1',
        receivedAt: V3_NOW,
        serverEventId: `fcm3:${V3_BINDING.serverInstallationId}:${V3_BINDING.principalId}:${V3_BINDING.deviceId}:${V3_OCCURRENCE_ID}`,
        authenticatedExpiresAt: V3_NOW + 300_000,
      },
    );
    const lockedContext = mockPersistAuthenticatedLockedFcmV3Event.mock.calls[0]?.[2];
    expect(mockPostLockedNotification).toHaveBeenCalledTimes(1);
    expect(mockPostLockedNotification).toHaveBeenCalledWith(lockedContext);
    expect(mockPersistAuthenticatedLockedFcmV3Event.mock.invocationCallOrder[0]!).toBeLessThan(
      mockPostLockedNotification.mock.invocationCallOrder[0]!,
    );
    expect(mockDispatchRealtimeEvent).not.toHaveBeenCalled();
  });

  it('does not re-alert when durable locked V3 admission rejects a replay', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(V3_NOW);
    configureV3Delivery({ locked: true });
    mockPersistAuthenticatedLockedFcmV3Event
      .mockResolvedValueOnce('enqueued')
      .mockResolvedValueOnce('not-enqueued');

    await mockBackgroundHandler!(message);
    await mockBackgroundHandler!(message);

    expect(mockPersistAuthenticatedLockedFcmV3Event).toHaveBeenCalledTimes(2);
    expect(mockPostLockedNotification).toHaveBeenCalledTimes(1);
    expect(mockDispatchRealtimeEvent).not.toHaveBeenCalled();
  });

  it('does not notify when locked V3 durable admission fails', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(V3_NOW);
    configureV3Delivery({ locked: true });
    mockPersistAuthenticatedLockedFcmV3Event.mockRejectedValueOnce(new Error('database closed'));

    await mockBackgroundHandler!(message);

    expect(mockPostLockedNotification).not.toHaveBeenCalled();
    expect(mockDispatchRealtimeEvent).not.toHaveBeenCalled();
  });

  it('drops a locked V3 envelope with the wrong binding before persistence or notice', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(V3_NOW);
    configureV3Delivery({
      locked: true,
      identity: v3Identity({ deviceId: '55555555-5555-4555-8555-555555555555' }),
    });

    await mockBackgroundHandler!(message);

    expect(mockPersistAuthenticatedLockedFcmV3Event).not.toHaveBeenCalled();
    expect(mockPostLockedNotification).not.toHaveBeenCalled();
    expect(mockDispatchRealtimeEvent).not.toHaveBeenCalled();
  });

  it('drops locked V3 while enrollment is pending because no binding triple is acknowledged', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(V3_NOW);
    configureV3Delivery({ locked: true });
    mockVaultGet.mockImplementation(async (key: string) => {
      if (key === 'appLockEnabled') return 'true';
      if (key === 'fcmPushEncryptionV2') {
        return serializeFcmDeviceEncryptionState(
          pendingFcmDeviceEncryptionV3State(V2_KEY, 'https://gator.example'),
        );
      }
      return key === 'serverAddress' ? 'https://gator.example' : null;
    });

    await mockBackgroundHandler!(message);

    expect(mockDecryptFcmV3Payload).not.toHaveBeenCalled();
    expect(mockPersistAuthenticatedLockedFcmV3Event).not.toHaveBeenCalled();
    expect(mockPostLockedNotification).not.toHaveBeenCalled();
    expect(mockDispatchRealtimeEvent).not.toHaveBeenCalled();
  });

  it.each([
    { encrypted: false, encryptionType: '', body: '{"guid":"plaintext"}' },
    { encrypted: true, encryptionType: 'AEAD_GCM_V2_DEVICE', body: 'v2-frame' },
  ])('drops a locked downgrade after V3 migration before persistence or notice', async (shape) => {
    jest.spyOn(Date, 'now').mockReturnValue(V3_NOW);
    configureV3Delivery({ locked: true });
    mockParseFcmData.mockReturnValueOnce({
      eventName: 'new-message',
      envelopeChatGuid: undefined,
      ...shape,
    });

    await mockBackgroundHandler!(message);

    expect(mockDecryptFcmV2Payload).not.toHaveBeenCalled();
    expect(mockDecryptFcmV3Payload).not.toHaveBeenCalled();
    expect(mockPersistAuthenticatedLockedFcmV3Event).not.toHaveBeenCalled();
    expect(mockPostLockedNotification).not.toHaveBeenCalled();
  });

  it('drops locked delivery when migrated encryption state is unavailable', async () => {
    mockVaultGet.mockImplementation(async (key: string) => {
      if (key === 'appLockEnabled') return 'true';
      if (key === 'fcmPushEncryptionV2') throw new Error('vault unavailable');
      return null;
    });
    mockEffectivelyLocked.mockImplementation(
      (_lockState, storedAppLockEnabled) => storedAppLockEnabled,
    );

    await mockBackgroundHandler!(message);

    expect(mockPersistAuthenticatedLockedFcmV3Event).not.toHaveBeenCalled();
    expect(mockPostLockedNotification).not.toHaveBeenCalled();
    expect(mockDispatchRealtimeEvent).not.toHaveBeenCalled();
  });

  it('rejects V3 FCM server rotation on every replay without prompt, persistence, or notice', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(V3_NOW);
    configureV3Delivery({
      locked: false,
      eventName: 'new-server',
      plaintext: 'https://rotated.example',
      identity: v3Identity({ eventType: 'new-server', messageId: undefined }),
    });

    await mockBackgroundHandler!(message);
    await mockBackgroundHandler!(message);

    expect(mockDecryptFcmV3Payload).toHaveBeenCalledTimes(2);
    expect(mockPersistAuthenticatedLockedFcmV3Event).not.toHaveBeenCalled();
    expect(mockDispatchRealtimeEvent).not.toHaveBeenCalled();
    expect(mockPostLockedNotification).not.toHaveBeenCalled();
  });

  it('authenticates V2 before posting the generic locked notice without persisting content', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(FCM_V2_COMPATIBILITY_CUTOFF_MS - 1);
    const state = activeFcmDeviceEncryptionState(V2_KEY, 'device-v2', 'https://gator.example');
    mockVaultGet.mockImplementation(async (key: string) => {
      if (key === 'appLockEnabled') return 'true';
      if (key === 'fcmPushEncryptionV2') return serializeFcmDeviceEncryptionState(state);
      return key === 'serverAddress' ? 'https://gator.example' : null;
    });
    mockEffectivelyLocked.mockImplementation(
      (_lockState, storedAppLockEnabled) => storedAppLockEnabled,
    );
    mockParseFcmData.mockReturnValueOnce({
      eventName: 'new-message',
      body: 'v2-frame',
      envelopeChatGuid: undefined,
      encrypted: true,
      encryptionType: 'AEAD_GCM_V2_DEVICE',
    });

    await mockBackgroundHandler!(message);

    expect(mockPostLockedNotification).toHaveBeenCalledTimes(1);
    expect(mockDecryptFcmV2Payload).toHaveBeenCalledWith('v2-frame', V2_KEY, 'new-message');
    expect(mockPersistAuthenticatedLockedFcmV3Event).not.toHaveBeenCalled();
    expect(mockDispatchRealtimeEvent).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'plaintext envelope',
      shape: { encrypted: false, encryptionType: '', body: '{"guid":"plaintext"}' },
      decryptFails: false,
    },
    {
      label: 'unauthenticated ciphertext',
      shape: {
        encrypted: true,
        encryptionType: 'AEAD_GCM_V2_DEVICE',
        body: 'bad-v2-frame',
      },
      decryptFails: true,
    },
  ])('does not post a generic locked notice for a V2 $label', async ({ shape, decryptFails }) => {
    jest.spyOn(Date, 'now').mockReturnValue(FCM_V2_COMPATIBILITY_CUTOFF_MS - 1);
    const state = activeFcmDeviceEncryptionState(V2_KEY, 'device-v2', 'https://gator.example');
    mockVaultGet.mockImplementation(async (key: string) => {
      if (key === 'appLockEnabled') return 'true';
      if (key === 'fcmPushEncryptionV2') return serializeFcmDeviceEncryptionState(state);
      return key === 'serverAddress' ? 'https://gator.example' : null;
    });
    mockEffectivelyLocked.mockImplementation(
      (_lockState, storedAppLockEnabled) => storedAppLockEnabled,
    );
    mockParseFcmData.mockReturnValueOnce({
      eventName: 'new-message',
      envelopeChatGuid: undefined,
      ...shape,
    });
    if (decryptFails) {
      mockDecryptFcmV2Payload.mockRejectedValueOnce(new Error('authentication tag mismatch'));
    }

    await mockBackgroundHandler!(message);

    expect(mockPostLockedNotification).not.toHaveBeenCalled();
    expect(mockPersistAuthenticatedLockedFcmV3Event).not.toHaveBeenCalled();
    expect(mockDispatchRealtimeEvent).not.toHaveBeenCalled();
  });

  it('drops the retired absent-state legacy locked path without a notice or dispatch', async () => {
    mockVaultGet.mockImplementation(async (key: string) => {
      if (key === 'appLockEnabled') return 'true';
      if (key === 'serverPassword') return 'server-password';
      return null;
    });
    mockEffectivelyLocked.mockImplementation(
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
    expect(mockPostLockedNotification).not.toHaveBeenCalled();
    expect(mockDecryptFcmV2Payload).not.toHaveBeenCalled();
    expect(mockVaultGet).toHaveBeenCalledWith('fcmPushEncryptionV2');
    expect(mockPersistAuthenticatedLockedFcmV3Event).not.toHaveBeenCalled();
    expect(mockDispatchRealtimeEvent).not.toHaveBeenCalled();
  });

  it('fails closed when the persisted app-lock value is malformed', async () => {
    mockVaultGet.mockImplementation(async (key: string) => {
      if (key === 'appLockEnabled') return 'yes';
      if (key === 'serverPassword') return 'server-password';
      return null;
    });
    mockEffectivelyLocked.mockImplementation(
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
    expect(mockPostLockedNotification).not.toHaveBeenCalled();
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
      '[fcm] lock-state check failed — failing closed (assuming locked)',
      vaultFailure,
    );
    expect(mockPostLockedNotification).not.toHaveBeenCalled();
    expect(mockDecryptFcmV2Payload).not.toHaveBeenCalled();
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
