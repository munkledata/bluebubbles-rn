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
type RegisterAck = {
  id: string | null;
  pushEncryptionType: string | null;
  pushEncryptionIdentity?: {
    serverInstallationId: string;
    principalId: string;
    deviceId: string;
  } | null;
  pushEncryptionKeyVersion?: number;
  pushEncryptionRotationId?: string;
  pushEncryptionPreviousKeyExpiresAt?: number;
};
type PushEncryptionExtension = {
  type: string;
  key: string;
  rotation?: { id: string; previousKeyVersion: number };
};
const mockRegisterDevice = jest.fn<
  Promise<RegisterAck>,
  [unknown, string, string, PushEncryptionExtension?]
>(async (): Promise<{ id: string | null; pushEncryptionType: string | null }> => ({
  id: 'device-1',
  pushEncryptionType: null,
}));
type MockServerInfo = {
  server_version: string;
  supports_fcm_device_encryption: boolean;
  supports_fcm_push_encryption_v3?: boolean;
  supports_fcm_push_key_rotation?: boolean;
};
const mockServerInfo = jest.fn<Promise<MockServerInfo>, []>(async () => ({
  server_version: '2.0.15',
  supports_fcm_device_encryption: false,
}));
const vaultValues = new Map<string, string>();
const mockVaultGet = jest.fn(
  async (key: string): Promise<string | null> => vaultValues.get(key) ?? null,
);
const mockVaultSet = jest.fn(async (key: string, value: string): Promise<void> => {
  vaultValues.set(key, value);
});
const mockVaultDelete = jest.fn(async (key: string): Promise<void> => {
  vaultValues.delete(key);
});
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
jest.mock('@core/api', () => ({
  fcmApi: { registerDevice: mockRegisterDevice },
  serverApi: { serverInfo: mockServerInfo },
}));
// Registration must use the Disconnect-cancellable client (review item 1073), never the shared one.
jest.mock('@/services/clients', () => ({
  http: { kind: 'shared-http-client' },
  accountHttp: () => ({ kind: 'account-http-client' }),
  vault: { get: mockVaultGet, set: mockVaultSet, delete: mockVaultDelete },
  accountRevocationMarker: { isRevoked: jest.fn(() => false) },
}));
jest.mock('@/services/realtimeControl', () => ({
  dispatchRealtimeEvent: jest.fn(async () => undefined),
  persistAuthenticatedLockedFcmV3Event: jest.fn(async () => 'not-enqueued'),
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
  FCM_V2_ENCRYPTION_TYPE: 'AEAD_GCM_V2_DEVICE',
  FCM_V3_ENCRYPTION_TYPE: 'AEAD_GCM_V3_IDENTITY',
  decryptFcmV2Payload: jest.fn(),
  decryptFcmV3Payload: jest.fn(),
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

import {
  createCredentialUpgradeCandidate,
  logger,
  revokedCredentialUpgradeJournal,
  serializeCredentialUpgradeJournal,
} from '@core/secure';
import type { SecureVault } from '@core/secure';
import {
  activeFcmDeviceEncryptionV3State,
  activeFcmPushKeyState,
  activeFcmDeviceEncryptionState,
  FCM_PUSH_KEY_ROTATION_INTERVAL_MS,
  FCM_PUSH_KEY_ROTATION_LOCAL_MAX_MS,
  FCM_DEVICE_ENCRYPTION_TYPE,
  FCM_PUSH_ENCRYPTION_TYPE_V3,
  inspectFcmDeviceEncryptionState,
  revokedFcmDeviceEncryptionState,
  rotatingFcmPushKeyState,
  serializeFcmDeviceEncryptionState,
} from '@core/realtime';
import { useSessionStore } from '@state/sessionStore';
import * as Crypto from 'expo-crypto';
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
import {
  FCM_V2_COMPATIBILITY_CUTOFF_MS,
  registerFcmToken,
  startFcm,
} from '@/services/notifications/fcmMessaging';
import {
  moveFcmPushKeyStateToOrigin,
  retireFcmDeviceEncryptionState,
} from '@/services/notifications/fcmEncryptionState';
import '@/services/notifications/registerFcmBackgroundHandler';

function setConnectedSession(
  origin: string,
  password: string,
  epoch: number,
  supportsFcmDeviceEncryption = false,
  supportsFcmPushEncryptionV3 = false,
  supportsFcmPushKeyRotation = false,
): void {
  useSessionStore.setState({
    status: 'connected',
    origin,
    password,
    serverInfo: {
      server_version: '2.0.15',
      supports_fcm_device_encryption: supportsFcmDeviceEncryption,
      supports_fcm_push_encryption_v3: supportsFcmPushEncryptionV3,
      supports_fcm_push_key_rotation: supportsFcmPushKeyRotation,
    },
    error: null,
    epoch,
  });
}

/** A server that cannot encrypt push payloads, both in the cached session and when asked live. */
function useNonEncryptingServer(): void {
  setConnectedSession('https://account-a.test', 'password-a', 101, false);
  mockServerInfo.mockResolvedValue({
    server_version: '2.0.15',
    supports_fcm_device_encryption: false,
  });
}

beforeEach(async () => {
  jest.spyOn(Date, 'now').mockReturnValue(FCM_V2_COMPATIBILITY_CUTOFF_MS - 1);
  await pauseRealtimeDeliveries();
  resumeRealtimeDeliveries();
  // Plaintext push registration is retired, so the ordinary server here can encrypt pushes.
  setConnectedSession('https://account-a.test', 'password-a', 101, true);
  mockTokenRefreshHandler = undefined;
  mockFlushPersistentLogs.mockResolvedValue(true);
  mockGetToken.mockResolvedValue('fresh-token');
  mockRegisterDevice.mockResolvedValue({
    id: 'device-1',
    pushEncryptionType: FCM_DEVICE_ENCRYPTION_TYPE,
  });
  mockServerInfo.mockReset().mockResolvedValue({
    server_version: '2.0.15',
    supports_fcm_device_encryption: true,
  });
  vaultValues.clear();
  mockVaultGet.mockImplementation(async (key: string) => vaultValues.get(key) ?? null);
  mockVaultSet.mockImplementation(async (key: string, value: string) => {
    vaultValues.set(key, value);
  });
  mockVaultDelete.mockImplementation(async (key: string) => {
    vaultValues.delete(key);
  });
});

afterEach(async () => {
  await pauseRealtimeDeliveries();
  resumeRealtimeDeliveries();
  jest.restoreAllMocks();
});

describe('FCM registration account ownership', () => {
  it('passes the callback deadline to logging and waits without turning flush failure into delivery failure', async () => {
    const callbackStartedAt = 10_000;
    jest.spyOn(Date, 'now').mockReturnValue(callbackStartedAt);
    const flushGate = deferred<boolean>();
    mockFlushPersistentLogs.mockReturnValueOnce(flushGate.promise);

    const handling = Promise.resolve(mockBackgroundHandler?.({ data: {} }));
    const handlingProbe = settlementProbe(handling);
    for (let index = 0; index < 50 && mockFlushPersistentLogs.mock.calls.length === 0; index += 1) {
      await Promise.resolve();
    }

    const flushCallsWhileBlocked = mockFlushPersistentLogs.mock.calls.length;
    const settledWhileFlushBlocked = handlingProbe.isSettled();

    // Effect work stops at 40 seconds; final persistence retains a separate 15-second window and
    // still returns five seconds before RNFB's 60-second native callback ceiling.
    expect(mockFlushPersistentLogs).toHaveBeenCalledWith(callbackStartedAt + 55_000);
    flushGate.resolve(false);
    expect(flushCallsWhileBlocked).toBe(1);
    expect(settledWhileFlushBlocked).toBe(false);
    await expect(handling).resolves.toBeUndefined();
  });

  it('drops account A token lookup when Disconnect pauses while getToken is suspended', async () => {
    const tokenGate = deferred<string>();
    mockGetToken.mockReturnValueOnce(tokenGate.promise);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const registration = registerFcmToken();
    await settle();
    const tokenLookupsBeforePause = mockGetToken.mock.calls.length;

    const pause = pauseRealtimeDeliveries();
    const pauseProbe = settlementProbe(pause);
    await settle();
    expect(pauseProbe.isSettled()).toBe(false);

    tokenGate.resolve('account-a-token');
    await expect(registration).resolves.toBe('skipped');
    await expect(pause).resolves.toBeUndefined();
    expect(tokenLookupsBeforePause).toBe(1);
    expect(mockRegisterDevice).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalledWith(
      '[fcm] device token registration failed',
      expect.anything(),
    );

    setConnectedSession('https://account-b.test', 'password-b', 102, true);
    resumeRealtimeDeliveries();
    mockGetToken.mockResolvedValueOnce('account-b-token');
    await registerFcmToken();

    expect(mockRegisterDevice).toHaveBeenCalledTimes(1);
    expect(mockRegisterDevice).toHaveBeenCalledWith(
      { kind: 'account-http-client' },
      'Gator (Android 35)',
      'account-b-token',
      expect.objectContaining({ type: FCM_DEVICE_ENCRYPTION_TYPE }),
    );
  });

  it('drains an admitted server registration and suppresses its stale failure during pause', async () => {
    const responseGate = deferred<RegisterAck>();
    const staleFailure = new Error('account A server went away');
    mockGetToken.mockResolvedValueOnce('account-a-token');
    mockRegisterDevice.mockReturnValueOnce(responseGate.promise);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    // Prevent a test-regression path where an early assertion leaves an unconsumed rejection.
    void responseGate.promise.catch(() => undefined);

    const registration = registerFcmToken();
    await settle();
    const registrationCall = mockRegisterDevice.mock.calls[0];

    const pause = pauseRealtimeDeliveries();
    const pauseProbe = settlementProbe(pause);
    await settle();
    expect(pauseProbe.isSettled()).toBe(false);

    responseGate.reject(staleFailure);
    await expect(registration).resolves.toBe('skipped');
    await expect(pause).resolves.toBeUndefined();
    expect(registrationCall).toEqual([
      { kind: 'account-http-client' },
      'Gator (Android 35)',
      'account-a-token',
      expect.objectContaining({ type: FCM_DEVICE_ENCRYPTION_TYPE }),
    ]);
    expect(warn).not.toHaveBeenCalledWith('[fcm] device token registration failed', staleFailure);
  });

  it('fails closed if the session identity changes without a coordinator pause', async () => {
    const tokenGate = deferred<string>();
    mockGetToken.mockReturnValueOnce(tokenGate.promise);

    const registration = registerFcmToken();
    await settle();
    const tokenLookupsBeforeIdentityChange = mockGetToken.mock.calls.length;

    setConnectedSession('https://account-b.test', 'password-b', 102);
    tokenGate.resolve('account-a-token');
    await registration;

    expect(tokenLookupsBeforeIdentityChange).toBe(1);
    expect(mockRegisterDevice).not.toHaveBeenCalled();
  });

  it('reacquires the token for the current session instead of trusting a queued refresh value', async () => {
    await startFcm();
    expect(mockTokenRefreshHandler).toEqual(expect.any(Function));

    await pauseRealtimeDeliveries();
    mockTokenRefreshHandler!('unowned-native-token');
    await settle();
    expect(mockGetToken).not.toHaveBeenCalled();

    setConnectedSession('https://account-b.test', 'password-b', 102, true);
    resumeRealtimeDeliveries();
    mockGetToken.mockResolvedValueOnce('fresh-account-b-token');
    mockTokenRefreshHandler!('stale-callback-argument');
    for (let index = 0; index < 50 && mockRegisterDevice.mock.calls.length === 0; index += 1) {
      await Promise.resolve();
    }

    expect(mockGetToken).toHaveBeenCalledTimes(1);
    expect(mockRegisterDevice).toHaveBeenCalledWith(
      { kind: 'account-http-client' },
      'Gator (Android 35)',
      'fresh-account-b-token',
      expect.objectContaining({ type: FCM_DEVICE_ENCRYPTION_TYPE }),
    );
    expect(mockRegisterDevice).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'stale-callback-argument',
    );
  });

  it('persists pending before V2 registration and activates only after the exact acknowledgement', async () => {
    setConnectedSession('https://account-a.test', 'password-a', 101, true);
    const keyBytes = Uint8Array.from({ length: 32 }, (_, index) => index);
    const random = jest.spyOn(Crypto, 'getRandomBytesAsync').mockResolvedValueOnce(keyBytes);
    mockRegisterDevice.mockImplementationOnce(async () => {
      const pending = inspectFcmDeviceEncryptionState(
        vaultValues.get('fcmPushEncryptionV2') ?? null,
      );
      expect(pending).toMatchObject({
        kind: 'valid',
        state: { status: 'pending', origin: 'https://account-a.test' },
      });
      return { id: 'device-v2', pushEncryptionType: FCM_DEVICE_ENCRYPTION_TYPE };
    });

    await expect(registerFcmToken()).resolves.toBe('registered');

    const saved = inspectFcmDeviceEncryptionState(vaultValues.get('fcmPushEncryptionV2') ?? null);
    expect(saved).toMatchObject({
      kind: 'valid',
      state: {
        status: 'active',
        origin: 'https://account-a.test',
        deviceId: 'device-v2',
      },
    });
    expect(mockRegisterDevice).toHaveBeenCalledWith(
      { kind: 'account-http-client' },
      'Gator (Android 35)',
      'fresh-token',
      {
        type: FCM_DEVICE_ENCRYPTION_TYPE,
        key: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
      },
    );
    expect(random).toHaveBeenCalledWith(32);
  });

  it('enrolls V3 only for a scoped credential and pins the exact acknowledged identity', async () => {
    const scopedCredential = `bbd_device_v1_${'A'.repeat(43)}`;
    const binding = {
      serverInstallationId: '11111111-1111-4111-8111-111111111111',
      principalId: '22222222-2222-4222-8222-222222222222',
      deviceId: '33333333-3333-4333-8333-333333333333',
    } as const;
    setConnectedSession('https://account-a.test', scopedCredential, 101, true, true);
    mockServerInfo.mockResolvedValueOnce({
      server_version: '2.0.16',
      supports_fcm_device_encryption: true,
      supports_fcm_push_encryption_v3: true,
      supports_fcm_push_key_rotation: false,
    });
    jest
      .spyOn(Crypto, 'getRandomBytesAsync')
      .mockResolvedValueOnce(Uint8Array.from({ length: 32 }, (_, index) => index));
    mockRegisterDevice.mockResolvedValueOnce({
      id: binding.deviceId,
      pushEncryptionType: FCM_PUSH_ENCRYPTION_TYPE_V3,
      pushEncryptionIdentity: binding,
    });

    await expect(registerFcmToken()).resolves.toBe('registered');

    expect(mockRegisterDevice.mock.calls[0]?.[3]).toEqual({
      type: FCM_PUSH_ENCRYPTION_TYPE_V3,
      key: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    });
    expect(inspectFcmDeviceEncryptionState(vaultValues.get('fcmPushEncryptionV2') ?? null)).toEqual(
      {
        kind: 'valid',
        state: activeFcmDeviceEncryptionV3State(
          'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
          binding,
          'https://account-a.test',
        ),
      },
    );
  });

  it('persists a versioned V3 candidate before initial registration and requires generation one', async () => {
    const requestedAt = 1_700_000_000_000;
    const scopedCredential = `bbd_device_v1_${'G'.repeat(43)}`;
    const binding = {
      serverInstallationId: '11111111-1111-4111-8111-111111111111',
      principalId: '22222222-2222-4222-8222-222222222222',
      deviceId: '33333333-3333-4333-8333-333333333333',
    } as const;
    jest.spyOn(Date, 'now').mockReturnValue(requestedAt);
    setConnectedSession('https://account-a.test', scopedCredential, 101, true, true, true);
    jest
      .spyOn(Crypto, 'getRandomBytesAsync')
      .mockResolvedValueOnce(Uint8Array.from({ length: 32 }, (_, index) => index));
    mockRegisterDevice.mockImplementationOnce(async () => {
      expect(
        inspectFcmDeviceEncryptionState(vaultValues.get('fcmPushEncryptionV2') ?? null),
      ).toMatchObject({
        kind: 'valid',
        state: { version: 3, status: 'pending', requestedAt },
      });
      return {
        id: binding.deviceId,
        pushEncryptionType: FCM_PUSH_ENCRYPTION_TYPE_V3,
        pushEncryptionIdentity: binding,
        pushEncryptionKeyVersion: 1,
      };
    });

    await expect(registerFcmToken()).resolves.toBe('registered');

    expect(inspectFcmDeviceEncryptionState(vaultValues.get('fcmPushEncryptionV2') ?? null)).toEqual(
      {
        kind: 'valid',
        state: activeFcmPushKeyState(
          'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
          1,
          binding,
          'https://account-a.test',
          requestedAt,
        ),
      },
    );
  });

  it('persists one exact legacy-V3 rotation and reuses it after a lost acknowledgement', async () => {
    const requestedAt = 1_700_000_000_000;
    const scopedCredential = `bbd_device_v1_${'H'.repeat(43)}`;
    const binding = {
      serverInstallationId: '11111111-1111-4111-8111-111111111111',
      principalId: '22222222-2222-4222-8222-222222222222',
      deviceId: '33333333-3333-4333-8333-333333333333',
    } as const;
    const previousKey = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
    const candidateKey = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc';
    const rotationId = '44444444-4444-4444-8444-444444444444';
    const serverPreviousExpiry = requestedAt + FCM_PUSH_KEY_ROTATION_LOCAL_MAX_MS - 5 * 60_000;
    jest.spyOn(Date, 'now').mockReturnValue(requestedAt);
    jest
      .spyOn(Crypto, 'getRandomBytesAsync')
      .mockResolvedValueOnce(Uint8Array.from({ length: 32 }, () => 7));
    jest.spyOn(Crypto, 'randomUUID').mockReturnValue(rotationId);
    setConnectedSession('https://account-a.test', scopedCredential, 101, true, true, true);
    vaultValues.set(
      'fcmPushEncryptionV2',
      serializeFcmDeviceEncryptionState(
        activeFcmDeviceEncryptionV3State(previousKey, binding, 'https://account-a.test'),
      ),
    );
    mockRegisterDevice.mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce({
      id: binding.deviceId,
      pushEncryptionType: FCM_PUSH_ENCRYPTION_TYPE_V3,
      pushEncryptionIdentity: binding,
      pushEncryptionKeyVersion: 2,
      pushEncryptionRotationId: rotationId,
      pushEncryptionPreviousKeyExpiresAt: serverPreviousExpiry,
    });

    await expect(registerFcmToken()).resolves.toBe('failed');
    expect(useSessionStore.getState().serverInfo?.supports_fcm_push_key_rotation).toBe(true);
    expect(mockServerInfo).not.toHaveBeenCalled();
    expect(Crypto.getRandomBytesAsync).toHaveBeenCalledTimes(1);
    expect(Crypto.randomUUID).toHaveBeenCalledTimes(1);
    expect(mockRegisterDevice.mock.calls[0]?.[3]).toMatchObject({
      type: FCM_PUSH_ENCRYPTION_TYPE_V3,
      rotation: { id: rotationId, previousKeyVersion: 1 },
    });
    expect(inspectFcmDeviceEncryptionState(vaultValues.get('fcmPushEncryptionV2') ?? null)).toEqual(
      {
        kind: 'valid',
        state: rotatingFcmPushKeyState(
          candidateKey,
          previousKey,
          1,
          binding,
          'https://account-a.test',
          rotationId,
          requestedAt,
        ),
      },
    );

    await expect(registerFcmToken()).resolves.toBe('registered');

    const exactRegistration = {
      type: FCM_PUSH_ENCRYPTION_TYPE_V3,
      key: candidateKey,
      rotation: { id: rotationId, previousKeyVersion: 1 },
    };
    expect(mockRegisterDevice.mock.calls[0]?.[3]).toEqual(exactRegistration);
    expect(mockRegisterDevice.mock.calls[1]?.[3]).toEqual(exactRegistration);
    expect(Crypto.getRandomBytesAsync).toHaveBeenCalledTimes(1);
    expect(Crypto.randomUUID).toHaveBeenCalledTimes(1);
    expect(inspectFcmDeviceEncryptionState(vaultValues.get('fcmPushEncryptionV2') ?? null)).toEqual(
      {
        kind: 'valid',
        state: activeFcmPushKeyState(
          candidateKey,
          2,
          binding,
          'https://account-a.test',
          requestedAt,
          { key: previousKey, keyVersion: 1, expiresAt: serverPreviousExpiry },
        ),
      },
    );
  });

  it('refreshes only an aged rotation request anchor before a first late server commit', async () => {
    const now = 1_700_100_000_000;
    const oldRequestedAt = now - FCM_PUSH_KEY_ROTATION_LOCAL_MAX_MS;
    const scopedCredential = `bbd_device_v1_${'I'.repeat(43)}`;
    const binding = {
      serverInstallationId: '11111111-1111-4111-8111-111111111111',
      principalId: '22222222-2222-4222-8222-222222222222',
      deviceId: '33333333-3333-4333-8333-333333333333',
    } as const;
    const previousKey = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
    const candidateKey = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc';
    const rotationId = '44444444-4444-4444-8444-444444444444';
    const serverPreviousExpiry = now + FCM_PUSH_KEY_ROTATION_LOCAL_MAX_MS - 5 * 60_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const random = jest.spyOn(Crypto, 'getRandomBytesAsync');
    const uuid = jest.spyOn(Crypto, 'randomUUID');
    setConnectedSession('https://account-a.test', scopedCredential, 101, true, true, true);
    vaultValues.set(
      'fcmPushEncryptionV2',
      serializeFcmDeviceEncryptionState(
        rotatingFcmPushKeyState(
          candidateKey,
          previousKey,
          1,
          binding,
          'https://account-a.test',
          rotationId,
          oldRequestedAt,
        ),
      ),
    );
    mockRegisterDevice.mockImplementationOnce(async () => {
      expect(
        inspectFcmDeviceEncryptionState(vaultValues.get('fcmPushEncryptionV2') ?? null),
      ).toEqual({
        kind: 'valid',
        state: rotatingFcmPushKeyState(
          candidateKey,
          previousKey,
          1,
          binding,
          'https://account-a.test',
          rotationId,
          now,
          oldRequestedAt,
        ),
      });
      return {
        id: binding.deviceId,
        pushEncryptionType: FCM_PUSH_ENCRYPTION_TYPE_V3,
        pushEncryptionIdentity: binding,
        pushEncryptionKeyVersion: 2,
        pushEncryptionRotationId: rotationId,
        pushEncryptionPreviousKeyExpiresAt: serverPreviousExpiry,
      };
    });

    await expect(registerFcmToken()).resolves.toBe('registered');

    expect(random).not.toHaveBeenCalled();
    expect(uuid).not.toHaveBeenCalled();
    expect(inspectFcmDeviceEncryptionState(vaultValues.get('fcmPushEncryptionV2') ?? null)).toEqual(
      {
        kind: 'valid',
        state: activeFcmPushKeyState(candidateKey, 2, binding, 'https://account-a.test', now, {
          key: previousKey,
          keyVersion: 1,
          expiresAt: serverPreviousExpiry,
        }),
      },
    );
  });

  it('promotes an aged idempotent rotation acknowledgement without reviving the expired key', async () => {
    const now = 1_700_100_000_000;
    const rotationStartedAt = now - FCM_PUSH_KEY_ROTATION_LOCAL_MAX_MS;
    const scopedCredential = `bbd_device_v1_${'K'.repeat(43)}`;
    const binding = {
      serverInstallationId: '11111111-1111-4111-8111-111111111111',
      principalId: '22222222-2222-4222-8222-222222222222',
      deviceId: '33333333-3333-4333-8333-333333333333',
    } as const;
    const previousKey = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
    const candidateKey = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc';
    const rotationId = '44444444-4444-4444-8444-444444444444';
    const expiredServerDeadline = rotationStartedAt + 24 * 60 * 60 * 1_000 + 5 * 60_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);
    setConnectedSession('https://account-a.test', scopedCredential, 101, true, true, true);
    vaultValues.set(
      'fcmPushEncryptionV2',
      serializeFcmDeviceEncryptionState(
        rotatingFcmPushKeyState(
          candidateKey,
          previousKey,
          1,
          binding,
          'https://account-a.test',
          rotationId,
          rotationStartedAt,
        ),
      ),
    );
    mockRegisterDevice.mockResolvedValueOnce({
      id: binding.deviceId,
      pushEncryptionType: FCM_PUSH_ENCRYPTION_TYPE_V3,
      pushEncryptionIdentity: binding,
      pushEncryptionKeyVersion: 2,
      pushEncryptionRotationId: rotationId,
      pushEncryptionPreviousKeyExpiresAt: expiredServerDeadline,
    });

    await expect(registerFcmToken()).resolves.toBe('registered');

    expect(inspectFcmDeviceEncryptionState(vaultValues.get('fcmPushEncryptionV2') ?? null)).toEqual(
      {
        kind: 'valid',
        state: activeFcmPushKeyState(
          candidateKey,
          2,
          binding,
          'https://account-a.test',
          rotationStartedAt,
        ),
      },
    );
  });

  it('uses a bounded timer to rotate a continuously connected scoped session at its deadline', async () => {
    const now = 1_700_000_000_000;
    let currentTime = now;
    const activatedAt = now - FCM_PUSH_KEY_ROTATION_INTERVAL_MS + 24 * 60 * 60 * 1_000;
    const rotationDeadline = activatedAt + FCM_PUSH_KEY_ROTATION_INTERVAL_MS;
    const scopedCredential = `bbd_device_v1_${'J'.repeat(43)}`;
    const binding = {
      serverInstallationId: '11111111-1111-4111-8111-111111111111',
      principalId: '22222222-2222-4222-8222-222222222222',
      deviceId: '33333333-3333-4333-8333-333333333333',
    } as const;
    const currentKey = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
    const candidateKey = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc';
    const rotationId = '44444444-4444-4444-8444-444444444444';
    const scheduled: { callback: () => void; delay: number }[] = [];
    jest.spyOn(Date, 'now').mockImplementation(() => currentTime);
    jest.spyOn(global, 'clearTimeout').mockImplementation(() => undefined);
    jest.spyOn(global, 'setTimeout').mockImplementation(((callback: () => void, delay = 0) => {
      scheduled.push({ callback, delay });
      return { unref: jest.fn() };
    }) as unknown as typeof setTimeout);
    jest
      .spyOn(Crypto, 'getRandomBytesAsync')
      .mockResolvedValueOnce(Uint8Array.from({ length: 32 }, () => 7));
    jest.spyOn(Crypto, 'randomUUID').mockReturnValue(rotationId);
    setConnectedSession('https://account-a.test', scopedCredential, 101, true, true, true);
    vaultValues.set(
      'fcmPushEncryptionV2',
      serializeFcmDeviceEncryptionState(
        activeFcmPushKeyState(currentKey, 1, binding, 'https://account-a.test', activatedAt),
      ),
    );
    mockRegisterDevice.mockResolvedValueOnce({
      id: binding.deviceId,
      pushEncryptionType: FCM_PUSH_ENCRYPTION_TYPE_V3,
      pushEncryptionIdentity: binding,
      pushEncryptionKeyVersion: 1,
    });

    await expect(registerFcmToken()).resolves.toBe('registered');
    expect(scheduled.at(-1)?.delay).toBe(24 * 60 * 60 * 1_000);

    currentTime = rotationDeadline;
    const serverPreviousExpiry = currentTime + FCM_PUSH_KEY_ROTATION_LOCAL_MAX_MS - 5 * 60_000;
    mockRegisterDevice.mockResolvedValueOnce({
      id: binding.deviceId,
      pushEncryptionType: FCM_PUSH_ENCRYPTION_TYPE_V3,
      pushEncryptionIdentity: binding,
      pushEncryptionKeyVersion: 2,
      pushEncryptionRotationId: rotationId,
      pushEncryptionPreviousKeyExpiresAt: serverPreviousExpiry,
    });
    scheduled.at(-1)?.callback();
    for (let index = 0; index < 50 && mockRegisterDevice.mock.calls.length < 2; index += 1) {
      await Promise.resolve();
    }
    await settle();

    expect(mockRegisterDevice.mock.calls[1]?.[3]).toEqual({
      type: FCM_PUSH_ENCRYPTION_TYPE_V3,
      key: candidateKey,
      rotation: { id: rotationId, previousKeyVersion: 1 },
    });
    expect(inspectFcmDeviceEncryptionState(vaultValues.get('fcmPushEncryptionV2') ?? null)).toEqual(
      {
        kind: 'valid',
        state: activeFcmPushKeyState(
          candidateKey,
          2,
          binding,
          'https://account-a.test',
          rotationDeadline,
          { key: currentKey, keyVersion: 1, expiresAt: serverPreviousExpiry },
        ),
      },
    );
  });

  it('fails closed before V2 or plaintext registration when a scoped credential lacks V3 support', async () => {
    const scopedCredential = `bbd_device_v1_${'C'.repeat(43)}`;
    setConnectedSession('https://account-a.test', scopedCredential, 101, true, false);
    mockServerInfo.mockResolvedValueOnce({
      server_version: '2.0.16',
      supports_fcm_device_encryption: true,
      supports_fcm_push_encryption_v3: false,
    });
    const random = jest.spyOn(Crypto, 'getRandomBytesAsync');

    await expect(registerFcmToken()).resolves.toBe('failed');

    expect(mockRegisterDevice).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
    expect(vaultValues.has('fcmPushEncryptionV2')).toBe(false);
  });

  it('keeps an active V3 binding active throughout a same-binding token refresh', async () => {
    const scopedCredential = `bbd_device_v1_${'D'.repeat(43)}`;
    const binding = {
      serverInstallationId: '11111111-1111-4111-8111-111111111111',
      principalId: '22222222-2222-4222-8222-222222222222',
      deviceId: '33333333-3333-4333-8333-333333333333',
    } as const;
    const active = activeFcmDeviceEncryptionV3State(
      'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
      binding,
      'https://account-a.test',
    );
    const serializedActive = serializeFcmDeviceEncryptionState(active);
    setConnectedSession('https://account-a.test', scopedCredential, 101, true, true);
    mockServerInfo.mockResolvedValueOnce({
      server_version: '2.0.16',
      supports_fcm_device_encryption: true,
      supports_fcm_push_encryption_v3: true,
      supports_fcm_push_key_rotation: false,
    });
    vaultValues.set('fcmPushEncryptionV2', serializedActive);
    const random = jest.spyOn(Crypto, 'getRandomBytesAsync');
    mockRegisterDevice.mockImplementationOnce(async () => {
      expect(vaultValues.get('fcmPushEncryptionV2')).toBe(serializedActive);
      return {
        id: binding.deviceId,
        pushEncryptionType: FCM_PUSH_ENCRYPTION_TYPE_V3,
        pushEncryptionIdentity: binding,
      };
    });

    await expect(registerFcmToken()).resolves.toBe('registered');

    expect(random).not.toHaveBeenCalled();
    expect(vaultValues.get('fcmPushEncryptionV2')).toBe(serializedActive);
  });

  it('retains the active V3 binding when a token-refresh acknowledgement changes identity', async () => {
    const scopedCredential = `bbd_device_v1_${'E'.repeat(43)}`;
    const binding = {
      serverInstallationId: '11111111-1111-4111-8111-111111111111',
      principalId: '22222222-2222-4222-8222-222222222222',
      deviceId: '33333333-3333-4333-8333-333333333333',
    } as const;
    const changedBinding = {
      ...binding,
      deviceId: '55555555-5555-4555-8555-555555555555',
    } as const;
    const serializedActive = serializeFcmDeviceEncryptionState(
      activeFcmDeviceEncryptionV3State(
        'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
        binding,
        'https://account-a.test',
      ),
    );
    setConnectedSession('https://account-a.test', scopedCredential, 101, true, true);
    mockServerInfo.mockResolvedValueOnce({
      server_version: '2.0.16',
      supports_fcm_device_encryption: true,
      supports_fcm_push_encryption_v3: true,
      supports_fcm_push_key_rotation: false,
    });
    vaultValues.set('fcmPushEncryptionV2', serializedActive);
    mockRegisterDevice.mockResolvedValueOnce({
      id: changedBinding.deviceId,
      pushEncryptionType: FCM_PUSH_ENCRYPTION_TYPE_V3,
      pushEncryptionIdentity: changedBinding,
    });

    await expect(registerFcmToken()).resolves.toBe('failed');

    expect(vaultValues.get('fcmPushEncryptionV2')).toBe(serializedActive);
  });

  it.each([
    [
      'candidate',
      serializeCredentialUpgradeJournal(
        createCredentialUpgradeCandidate(
          'https://account-a.test',
          'password-a',
          `bbd_device_v1_${'F'.repeat(43)}`,
        ),
      ),
    ],
    ['revoked', serializeCredentialUpgradeJournal(revokedCredentialUpgradeJournal())],
  ])(
    'leaves a valid %s credential-upgrade journal in sole control of SEC-04 recovery',
    async (_phase, journal) => {
      vaultValues.set('serverCredentialUpgrade', journal);

      await expect(registerFcmToken()).resolves.toBe('skipped');

      expect(mockGetToken).not.toHaveBeenCalled();
      expect(mockRegisterDevice).not.toHaveBeenCalled();
      expect(vaultValues.get('serverCredentialUpgrade')).toBe(journal);
    },
  );

  it('reports current-session failure without mutation for an invalid upgrade journal', async () => {
    vaultValues.set('serverCredentialUpgrade', '{"version":1,"phase":"candidate"}');

    await expect(registerFcmToken()).resolves.toBe('failed');

    expect(mockGetToken).not.toHaveBeenCalled();
    expect(mockRegisterDevice).not.toHaveBeenCalled();
    expect(vaultValues.get('serverCredentialUpgrade')).toBe('{"version":1,"phase":"candidate"}');
  });

  it('reports current-session failure when the upgrade journal cannot be read', async () => {
    mockVaultGet.mockImplementation(async (key: string) => {
      if (key === 'serverCredentialUpgrade') throw new Error('vault unavailable');
      return vaultValues.get(key) ?? null;
    });

    await expect(registerFcmToken()).resolves.toBe('failed');

    expect(mockGetToken).not.toHaveBeenCalled();
    expect(mockRegisterDevice).not.toHaveBeenCalled();
  });

  it('never falls back to V2 after a V3 enrollment record exists', async () => {
    const scopedCredential = `bbd_device_v1_${'B'.repeat(43)}`;
    const binding = {
      serverInstallationId: '11111111-1111-4111-8111-111111111111',
      principalId: '22222222-2222-4222-8222-222222222222',
      deviceId: '33333333-3333-4333-8333-333333333333',
    } as const;
    setConnectedSession('https://account-a.test', scopedCredential, 101, true, false);
    mockServerInfo.mockResolvedValueOnce({
      server_version: '2.0.16',
      supports_fcm_device_encryption: true,
      supports_fcm_push_encryption_v3: false,
    });
    vaultValues.set(
      'fcmPushEncryptionV2',
      serializeFcmDeviceEncryptionState(
        activeFcmDeviceEncryptionV3State(
          'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
          binding,
          'https://account-a.test',
        ),
      ),
    );

    await expect(registerFcmToken()).resolves.toBe('failed');
    expect(mockRegisterDevice).not.toHaveBeenCalled();
  });

  it('retains and reuses one pending key after a lost registration response', async () => {
    setConnectedSession('https://account-a.test', 'password-a', 101, true);
    const random = jest
      .spyOn(Crypto, 'getRandomBytesAsync')
      .mockResolvedValue(Uint8Array.from({ length: 32 }, () => 7));
    mockRegisterDevice.mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce({
      id: 'device-v2',
      pushEncryptionType: FCM_DEVICE_ENCRYPTION_TYPE,
    });

    await expect(registerFcmToken()).resolves.toBe('failed');
    const firstKey = (
      inspectFcmDeviceEncryptionState(vaultValues.get('fcmPushEncryptionV2') ?? null) as {
        kind: 'valid';
        state: { key: string };
      }
    ).state.key;
    await expect(registerFcmToken()).resolves.toBe('registered');

    expect(random).toHaveBeenCalledTimes(1);
    expect(mockRegisterDevice.mock.calls[0]?.[3]).toEqual({
      type: FCM_DEVICE_ENCRYPTION_TYPE,
      key: firstKey,
    });
    expect(mockRegisterDevice.mock.calls[1]?.[3]).toEqual({
      type: FCM_DEVICE_ENCRYPTION_TYPE,
      key: firstKey,
    });
  });

  it('does not register shared-password FCM at the exclusive V2 compatibility cutoff', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(FCM_V2_COMPATIBILITY_CUTOFF_MS);
    setConnectedSession('https://account-a.test', 'password-a', 101, true);
    const random = jest.spyOn(Crypto, 'getRandomBytesAsync');

    await expect(registerFcmToken()).resolves.toBe('failed');

    expect(random).not.toHaveBeenCalled();
    expect(mockRegisterDevice).not.toHaveBeenCalled();
    expect(vaultValues.has('fcmPushEncryptionV2')).toBe(false);
  });

  it('serializes simultaneous registration calls and leaves server/local key agreement', async () => {
    setConnectedSession('https://account-a.test', 'password-a', 101, true);
    const responseGate = deferred<{ id: string; pushEncryptionType: string }>();
    const random = jest
      .spyOn(Crypto, 'getRandomBytesAsync')
      .mockResolvedValue(Uint8Array.from({ length: 32 }, () => 11));
    mockRegisterDevice.mockReturnValueOnce(responseGate.promise).mockResolvedValueOnce({
      id: 'device-v2',
      pushEncryptionType: FCM_DEVICE_ENCRYPTION_TYPE,
    });

    const first = registerFcmToken();
    const second = registerFcmToken();
    for (let index = 0; index < 100 && mockRegisterDevice.mock.calls.length === 0; index += 1) {
      await Promise.resolve();
    }
    const registrationsWhileFirstResponseBlocked = mockRegisterDevice.mock.calls.length;

    responseGate.resolve({
      id: 'device-v2',
      pushEncryptionType: FCM_DEVICE_ENCRYPTION_TYPE,
    });
    await expect(Promise.all([first, second])).resolves.toEqual(['registered', 'registered']);

    expect(registrationsWhileFirstResponseBlocked).toBe(1);
    expect(mockRegisterDevice).toHaveBeenCalledTimes(2);
    expect(random).toHaveBeenCalledTimes(1);
    const firstKey = (mockRegisterDevice.mock.calls[0]?.[3] as { key: string }).key;
    const secondKey = (mockRegisterDevice.mock.calls[1]?.[3] as { key: string }).key;
    expect(secondKey).toBe(firstKey);
    expect(vaultValues.get('fcmPushEncryptionV2')).toContain(firstKey);
  });

  it('keeps pending and reports failure when the server omits the exact V2 acknowledgement', async () => {
    setConnectedSession('https://account-a.test', 'password-a', 101, true);
    jest
      .spyOn(Crypto, 'getRandomBytesAsync')
      .mockResolvedValueOnce(Uint8Array.from({ length: 32 }, () => 13));
    mockRegisterDevice.mockResolvedValueOnce({ id: 'device-v2', pushEncryptionType: null });

    await expect(registerFcmToken()).resolves.toBe('failed');

    expect(
      inspectFcmDeviceEncryptionState(vaultValues.get('fcmPushEncryptionV2') ?? null),
    ).toMatchObject({ kind: 'valid', state: { status: 'pending' } });
  });

  it('fetches missing cold-boot capability instead of silently selecting legacy registration', async () => {
    setConnectedSession('https://account-a.test', 'password-a', 101);
    useSessionStore.setState({ serverInfo: null });
    mockServerInfo.mockResolvedValueOnce({
      server_version: '2.0.15',
      supports_fcm_device_encryption: true,
    });
    jest
      .spyOn(Crypto, 'getRandomBytesAsync')
      .mockResolvedValueOnce(Uint8Array.from({ length: 32 }, () => 17));
    mockRegisterDevice.mockResolvedValueOnce({
      id: 'device-v2',
      pushEncryptionType: FCM_DEVICE_ENCRYPTION_TYPE,
    });

    await expect(registerFcmToken()).resolves.toBe('registered');

    expect(mockServerInfo).toHaveBeenCalledWith({ kind: 'account-http-client' });
    expect(mockRegisterDevice.mock.calls[0]).toHaveLength(4);
    expect(useSessionStore.getState().serverInfo?.supports_fcm_device_encryption).toBe(true);
  });

  it('refreshes cached false capability so a server upgrade can enroll V2', async () => {
    setConnectedSession('https://account-a.test', 'password-a', 101, false);
    mockServerInfo.mockResolvedValueOnce({
      server_version: '2.0.16',
      supports_fcm_device_encryption: true,
    });
    jest
      .spyOn(Crypto, 'getRandomBytesAsync')
      .mockResolvedValueOnce(Uint8Array.from({ length: 32 }, () => 19));
    mockRegisterDevice.mockResolvedValueOnce({
      id: 'device-v2',
      pushEncryptionType: FCM_DEVICE_ENCRYPTION_TYPE,
    });

    await expect(registerFcmToken()).resolves.toBe('registered');

    expect(mockServerInfo).toHaveBeenCalledWith({ kind: 'account-http-client' });
    expect(mockRegisterDevice.mock.calls[0]).toHaveLength(4);
    expect(useSessionStore.getState().serverInfo?.supports_fcm_device_encryption).toBe(true);
  });

  it('fails without registration when cold-boot capability lookup is unavailable', async () => {
    setConnectedSession('https://account-a.test', 'password-a', 101);
    useSessionStore.setState({ serverInfo: null });
    mockServerInfo.mockRejectedValueOnce(new Error('server unavailable'));

    await expect(registerFcmToken()).resolves.toBe('failed');

    expect(mockRegisterDevice).not.toHaveBeenCalled();
  });

  it('never registers plaintext push with a server that cannot encrypt, and reports it unavailable', async () => {
    // Every unencrypted push would be dropped on arrival, so registering could only make the
    // server send message content through FCM unencrypted.
    useNonEncryptingServer();

    await expect(registerFcmToken()).resolves.toBe('failed');

    expect(mockRegisterDevice).not.toHaveBeenCalled();
    expect(vaultValues.has('fcmPushEncryptionV2')).toBe(false);
  });

  it('rejects a legacy downgrade when any migration record is already present', async () => {
    useNonEncryptingServer();
    const existing = activeFcmDeviceEncryptionState(
      'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
      'device-v2',
      'https://account-a.test',
    );
    vaultValues.set('fcmPushEncryptionV2', serializeFcmDeviceEncryptionState(existing));

    await expect(registerFcmToken()).resolves.toBe('failed');

    expect(mockRegisterDevice).not.toHaveBeenCalled();
  });

  it('rejects a same-origin legacy reconnect after Disconnect retained a revoked tombstone', async () => {
    useNonEncryptingServer();
    vaultValues.set(
      'fcmPushEncryptionV2',
      serializeFcmDeviceEncryptionState(revokedFcmDeviceEncryptionState()),
    );

    await expect(registerFcmToken()).resolves.toBe('failed');

    expect(mockRegisterDevice).not.toHaveBeenCalled();
  });

  it('generates a fresh key for a capable same-origin account after Disconnect retires A', async () => {
    const oldKey = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
    vaultValues.set(
      'fcmPushEncryptionV2',
      serializeFcmDeviceEncryptionState(
        activeFcmDeviceEncryptionState(oldKey, 'device-a', 'https://account-a.test'),
      ),
    );
    await retireFcmDeviceEncryptionState({
      get: mockVaultGet,
      set: mockVaultSet,
      delete: mockVaultDelete,
    } as SecureVault);
    setConnectedSession('https://account-a.test', 'password-b', 102, true);
    jest
      .spyOn(Crypto, 'getRandomBytesAsync')
      .mockResolvedValueOnce(Uint8Array.from({ length: 32 }, () => 29));
    mockRegisterDevice.mockResolvedValueOnce({
      id: 'device-b',
      pushEncryptionType: FCM_DEVICE_ENCRYPTION_TYPE,
    });

    await expect(registerFcmToken()).resolves.toBe('registered');

    const extension = mockRegisterDevice.mock.calls[0]?.[3] as { key: string };
    expect(extension.key).not.toBe(oldKey);
    expect(vaultValues.get('fcmPushEncryptionV2')).toContain(extension.key);
    expect(vaultValues.get('fcmPushEncryptionV2')).not.toContain(oldKey);
  });

  it('rotates to a fresh key when an approved server origin changes', async () => {
    const oldKey = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
    vaultValues.set(
      'fcmPushEncryptionV2',
      serializeFcmDeviceEncryptionState(
        activeFcmDeviceEncryptionState(oldKey, 'device-old', 'https://old.test'),
      ),
    );
    setConnectedSession('https://new.test', 'password-a', 101, true);
    jest
      .spyOn(Crypto, 'getRandomBytesAsync')
      .mockResolvedValueOnce(Uint8Array.from({ length: 32 }, () => 23));
    mockRegisterDevice.mockResolvedValueOnce({
      id: 'device-new',
      pushEncryptionType: FCM_DEVICE_ENCRYPTION_TYPE,
    });

    await expect(registerFcmToken()).resolves.toBe('registered');

    const extension = mockRegisterDevice.mock.calls[0]?.[3] as { key: string };
    expect(extension.key).not.toBe(oldKey);
    expect(vaultValues.get('fcmPushEncryptionV2')).toContain('https://new.test');
    expect(vaultValues.get('fcmPushEncryptionV2')).not.toContain(oldKey);
  });

  it('keeps the same V3 key after an approved server origin change carries the record', async () => {
    const rotatedAt = 1_700_000_000_000;
    const scopedCredential = `bbd_device_v1_${'R'.repeat(43)}`;
    const binding = {
      serverInstallationId: '11111111-1111-4111-8111-111111111111',
      principalId: '22222222-2222-4222-8222-222222222222',
      deviceId: '33333333-3333-4333-8333-333333333333',
    } as const;
    const key = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
    jest.spyOn(Date, 'now').mockReturnValue(rotatedAt);
    vaultValues.set(
      'fcmPushEncryptionV2',
      serializeFcmDeviceEncryptionState(
        activeFcmPushKeyState(key, 1, binding, 'https://old.test', rotatedAt),
      ),
    );
    // The approved rotation (serverRotationExecutor) carries the record to the new origin.
    await moveFcmPushKeyStateToOrigin(
      { get: mockVaultGet, set: mockVaultSet, delete: mockVaultDelete } as unknown as SecureVault,
      'https://old.test',
      'https://new.test',
    );
    setConnectedSession('https://new.test', scopedCredential, 101, true, true, true);
    mockRegisterDevice.mockResolvedValueOnce({
      id: binding.deviceId,
      pushEncryptionType: FCM_PUSH_ENCRYPTION_TYPE_V3,
      pushEncryptionIdentity: binding,
      pushEncryptionKeyVersion: 1,
    });

    await expect(registerFcmToken()).resolves.toBe('registered');

    // Same server installation, credential and key: no re-enrollment, only the URL moved.
    expect(mockRegisterDevice.mock.calls[0]?.[3]).toMatchObject({
      type: FCM_PUSH_ENCRYPTION_TYPE_V3,
      key,
    });
    expect(inspectFcmDeviceEncryptionState(vaultValues.get('fcmPushEncryptionV2') ?? null)).toEqual(
      {
        kind: 'valid',
        state: activeFcmPushKeyState(key, 1, binding, 'https://new.test', rotatedAt),
      },
    );
  });
});
