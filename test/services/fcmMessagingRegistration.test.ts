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
type RegisterAck = { id: string | null; pushEncryptionType: string | null };
type PushEncryptionExtension = { type: string; key: string };
const mockRegisterDevice = jest.fn<
  Promise<RegisterAck>,
  [unknown, string, string, PushEncryptionExtension?]
>(async (): Promise<{ id: string | null; pushEncryptionType: string | null }> => ({
  id: 'device-1',
  pushEncryptionType: null,
}));
const mockServerInfo = jest.fn(async () => ({
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
jest.mock('@/services/clients', () => ({
  http: { kind: 'shared-http-client' },
  vault: { get: mockVaultGet, set: mockVaultSet, delete: mockVaultDelete },
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
  FCM_V2_ENCRYPTION_TYPE: 'AEAD_GCM_V2_DEVICE',
  decryptFcmPayload: jest.fn(),
  decryptFcmV2Payload: jest.fn(),
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
import type { SecureVault } from '@core/secure';
import {
  activeFcmDeviceEncryptionState,
  FCM_DEVICE_ENCRYPTION_TYPE,
  inspectFcmDeviceEncryptionState,
  revokedFcmDeviceEncryptionState,
  serializeFcmDeviceEncryptionState,
} from '@core/realtime';
import { useSessionStore } from '@state/sessionStore';
import * as Crypto from 'expo-crypto';
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
import { registerFcmToken, startFcm } from '@/services/notifications/fcmMessaging';
import { retireFcmDeviceEncryptionState } from '@/services/notifications/fcmEncryptionState';
import '@/services/notifications/registerFcmBackgroundHandler';

function setConnectedSession(
  origin: string,
  password: string,
  epoch: number,
  supportsFcmDeviceEncryption = false,
): void {
  useSessionStore.setState({
    status: 'connected',
    origin,
    password,
    serverInfo: {
      server_version: '2.0.15',
      supports_fcm_device_encryption: supportsFcmDeviceEncryption,
    },
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
  mockRegisterDevice.mockResolvedValue({ id: 'device-1', pushEncryptionType: null });
  mockServerInfo.mockReset().mockResolvedValue({
    server_version: '2.0.15',
    supports_fcm_device_encryption: false,
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
  it('waits for the persistent-log barrier before a background native callback settles', async () => {
    const flushGate = deferred<boolean>();
    mockFlushPersistentLogs.mockReturnValueOnce(flushGate.promise);

    const handling = Promise.resolve(mockBackgroundHandler?.({ data: {} }));
    const handlingProbe = settlementProbe(handling);
    for (let index = 0; index < 50 && mockFlushPersistentLogs.mock.calls.length === 0; index += 1) {
      await Promise.resolve();
    }

    const flushCallsWhileBlocked = mockFlushPersistentLogs.mock.calls.length;
    const settledWhileFlushBlocked = handlingProbe.isSettled();

    flushGate.resolve(true);
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
      { kind: 'shared-http-client' },
      'Gator (Android 35)',
      'account-a-token',
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

    setConnectedSession('https://account-b.test', 'password-b', 102);
    resumeRealtimeDeliveries();
    mockGetToken.mockResolvedValueOnce('fresh-account-b-token');
    mockTokenRefreshHandler!('stale-callback-argument');
    for (let index = 0; index < 50 && mockRegisterDevice.mock.calls.length === 0; index += 1) {
      await Promise.resolve();
    }

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
      { kind: 'shared-http-client' },
      'Gator (Android 35)',
      'fresh-token',
      {
        type: FCM_DEVICE_ENCRYPTION_TYPE,
        key: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
      },
    );
    expect(random).toHaveBeenCalledWith(32);
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

    expect(mockServerInfo).toHaveBeenCalledWith({ kind: 'shared-http-client' });
    expect(mockRegisterDevice.mock.calls[0]).toHaveLength(4);
    expect(useSessionStore.getState().serverInfo?.supports_fcm_device_encryption).toBe(true);
  });

  it('refreshes cached false capability so a server upgrade can enroll V2', async () => {
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

    expect(mockServerInfo).toHaveBeenCalledWith({ kind: 'shared-http-client' });
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

  it('rejects a legacy downgrade when any migration record is already present', async () => {
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
});
