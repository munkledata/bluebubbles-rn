const mockBeginCredentialUpgradeRuntime = jest.fn();
const mockBeginCredentialReplacementRuntime = jest.fn();
const mockResumeCredentialUpgradeRuntime = jest.fn();
const mockDiscardCredentialUpgradeCandidateRuntime = jest.fn();
const mockRevokeReplacedCredentialRuntime = jest.fn();
const mockRunTrackedRealtimeWork = jest.fn();
const mockRunSerializedFcmRegistration = jest.fn();
const mockPauseRealtimeForCredentialUpgrade = jest.fn();
const mockResumeRealtimeAfterCredentialUpgrade = jest.fn(async () => undefined);
const mockRevokeSelf = jest.fn();
const mockRegisterDevice = jest.fn();
const mockRemoveDevice = jest.fn();
const mockFixedCredentialClient = jest.fn(() => ({ kind: 'fixed-candidate-client' }));
const mockLease = {
  generation: 47,
  isCurrent: jest.fn(() => true),
};
const mockSession = {
  status: 'connected',
  epoch: 11,
  transportRevision: 19,
  origin: 'https://single-flight.example.test',
  password: 'legacy-credential',
  replaceCredentialForTransport: jest.fn(() => true),
};
const mockVault = {
  get: jest.fn(),
  set: jest.fn(),
  delete: jest.fn(),
};

jest.mock('react-native', () => ({ Platform: { Version: 36 } }));
jest.mock('@core/api', () => ({
  deviceCredentialsApi: { revokeSelf: mockRevokeSelf },
  fcmApi: { registerDevice: mockRegisterDevice, removeDevice: mockRemoveDevice },
  serverApi: { serverInfo: jest.fn() },
}));
jest.mock('@state/sessionStore', () => ({
  useSessionStore: { getState: () => mockSession },
}));
jest.mock('@/services/clients', () => ({
  fixedCredentialClient: mockFixedCredentialClient,
  vault: mockVault,
}));
jest.mock('@/services/credentialUpgradeRuntime', () => ({
  beginCredentialUpgradeRuntime: mockBeginCredentialUpgradeRuntime,
  beginCredentialReplacementRuntime: mockBeginCredentialReplacementRuntime,
  resumeCredentialUpgradeRuntime: mockResumeCredentialUpgradeRuntime,
  discardCredentialUpgradeCandidateRuntime: mockDiscardCredentialUpgradeCandidateRuntime,
  revokeReplacedCredentialRuntime: mockRevokeReplacedCredentialRuntime,
}));
jest.mock('@/services/realtime/deliveryCoordinator', () => ({
  captureRealtimeDeliveryLease: () => mockLease,
  runTrackedRealtimeWork: mockRunTrackedRealtimeWork,
}));
jest.mock('@/services/realtimeControl', () => ({
  pauseRealtimeForCredentialUpgrade: mockPauseRealtimeForCredentialUpgrade,
  resumeRealtimeAfterCredentialUpgrade: mockResumeRealtimeAfterCredentialUpgrade,
}));
jest.mock('@/services/realtime/serverRotationCoordinator', () => ({
  serverRotationCoordinator: { hasInProgressTransition: () => false },
}));
jest.mock('@/services/notifications/fcmEncryptionState', () => ({
  readFcmDeviceEncryptionState: jest.fn(),
  writeFcmDeviceEncryptionState: jest.fn(),
}));
jest.mock('@react-native-firebase/messaging', () => ({
  getMessaging: () => ({}),
  getToken: async () => 'fcm-token',
}));
jest.mock('@/services/notifications/fcmRegistrationCoordinator', () => ({
  runSerializedFcmRegistration: mockRunSerializedFcmRegistration,
}));

// eslint-disable-next-line import/first
import { serverApi } from '@core/api';
// eslint-disable-next-line import/first
import { ApiError } from '@core/api/errors';
// eslint-disable-next-line import/first
import {
  activeFcmDeviceEncryptionV3State,
  FCM_PUSH_ENCRYPTION_TYPE_V3,
  revokedFcmDeviceEncryptionState,
} from '@core/realtime';
// eslint-disable-next-line import/first
import {
  readFcmDeviceEncryptionState,
  writeFcmDeviceEncryptionState,
} from '@/services/notifications/fcmEncryptionState';
// eslint-disable-next-line import/first
import {
  beginScopedCredentialReplacement,
  beginScopedCredentialUpgrade,
  discardScopedCredentialUpgradeCandidate,
  resumeScopedCredentialUpgrade,
} from '@/services/credentialUpgrade';
import { flushMicrotasks } from '../support/async';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  mockLease.isCurrent.mockReturnValue(true);
  mockRunTrackedRealtimeWork.mockImplementation(
    async (_lease: unknown, task: (lease: typeof mockLease) => Promise<unknown>) => {
      await task(mockLease);
      return 'delivered';
    },
  );
  mockRunSerializedFcmRegistration.mockImplementation(async (task: () => Promise<void>) => {
    await task();
  });
  mockBeginCredentialUpgradeRuntime.mockResolvedValue({ kind: 'adopted' });
  mockBeginCredentialReplacementRuntime.mockResolvedValue({ kind: 'adopted' });
  mockResumeCredentialUpgradeRuntime.mockResolvedValue({ kind: 'idle' });
  mockDiscardCredentialUpgradeCandidateRuntime.mockResolvedValue({ kind: 'discarded' });
  mockRevokeReplacedCredentialRuntime.mockReset().mockResolvedValue('none');
  mockRemoveDevice.mockReset().mockResolvedValue(undefined);
  mockResumeRealtimeAfterCredentialUpgrade.mockResolvedValue(undefined);
  mockRevokeSelf.mockReset();
  mockRegisterDevice.mockReset();
  mockFixedCredentialClient.mockClear();
});

it.each([
  ['an omitted key version', {}],
  [
    'unexpected rotation metadata',
    {
      pushEncryptionKeyVersion: 1,
      pushEncryptionRotationId: '44444444-4444-4444-8444-444444444444',
      pushEncryptionPreviousKeyExpiresAt: 1_700_086_700_000,
    },
  ],
])('rejects a live credential-adoption acknowledgement with %s', async (_label, extra) => {
  const candidate = `bbd_device_v1_${'Y'.repeat(43)}`;
  const identity = {
    serverInstallationId: '11111111-1111-4111-8111-111111111111',
    principalId: '22222222-2222-4222-8222-222222222222',
    deviceId: '33333333-3333-4333-8333-333333333333',
  } as const;
  mockRegisterDevice.mockResolvedValueOnce({
    id: identity.deviceId,
    pushEncryptionType: FCM_PUSH_ENCRYPTION_TYPE_V3,
    pushEncryptionIdentity: identity,
    ...extra,
  });
  mockBeginCredentialUpgradeRuntime.mockImplementationOnce(
    async (
      _candidate: string,
      dependencies: {
        registerV3(
          origin: string,
          credential: string,
          registration: {
            name: string;
            provider: 'fcm';
            token: string;
            pushEncryption: { type: typeof FCM_PUSH_ENCRYPTION_TYPE_V3; key: string };
          },
        ): Promise<unknown>;
      },
    ) => {
      await expect(
        dependencies.registerV3(mockSession.origin, candidate, {
          name: 'Gator (Android 36)',
          provider: 'fcm',
          token: 'fcm-token',
          pushEncryption: {
            type: FCM_PUSH_ENCRYPTION_TYPE_V3,
            key: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
          },
        }),
      ).rejects.toThrow('server did not acknowledge identity-bound FCM adoption');
      return { kind: 'retry' as const, stage: 'adoption' as const };
    },
  );

  await expect(beginScopedCredentialUpgrade(candidate)).resolves.toEqual({
    kind: 'retry',
    stage: 'adoption',
  });
});

it('joins an in-flight resume while begin and discard remain busy', async () => {
  const recovery = deferred<{ kind: 'idle' }>();
  mockResumeCredentialUpgradeRuntime.mockReturnValueOnce(recovery.promise);

  const first = resumeScopedCredentialUpgrade({ restartRealtime: false });
  await flushMicrotasks();
  const joined = resumeScopedCredentialUpgrade({ restartRealtime: false });

  expect(joined).toBe(first);
  await expect(beginScopedCredentialUpgrade('device-candidate')).resolves.toEqual({ kind: 'busy' });
  await expect(beginScopedCredentialReplacement('replacement-candidate')).resolves.toEqual({
    kind: 'busy',
  });
  await expect(discardScopedCredentialUpgradeCandidate()).resolves.toEqual({ kind: 'busy' });
  expect(mockResumeCredentialUpgradeRuntime).toHaveBeenCalledTimes(1);
  expect(mockBeginCredentialUpgradeRuntime).not.toHaveBeenCalled();
  expect(mockBeginCredentialReplacementRuntime).not.toHaveBeenCalled();
  expect(mockDiscardCredentialUpgradeCandidateRuntime).not.toHaveBeenCalled();

  recovery.resolve({ kind: 'idle' });
  await expect(Promise.all([first, joined])).resolves.toEqual([{ kind: 'idle' }, { kind: 'idle' }]);
  await flushMicrotasks();
});

it('routes a scoped replacement through the serialized transition; only the runtime revokes', async () => {
  const candidate = `bbd_device_v1_${'R'.repeat(43)}`;
  mockBeginCredentialReplacementRuntime.mockImplementationOnce(
    async (_candidate: string, dependencies: { beginExclusiveTransition(): boolean }) => {
      expect(dependencies.beginExclusiveTransition()).toBe(true);
      return { kind: 'adopted' };
    },
  );

  await expect(beginScopedCredentialReplacement(candidate)).resolves.toEqual({ kind: 'adopted' });
  expect(mockBeginCredentialReplacementRuntime).toHaveBeenCalledWith(candidate, expect.any(Object));
  expect(mockRevokeSelf).not.toHaveBeenCalled();
  expect(mockResumeRealtimeAfterCredentialUpgrade).toHaveBeenCalledTimes(1);
});

it('preserves begin and discard transitions plus their one post-settlement restart', async () => {
  mockBeginCredentialUpgradeRuntime.mockImplementationOnce(
    async (_candidate: string, dependencies: { beginExclusiveTransition(): boolean }) => {
      expect(dependencies.beginExclusiveTransition()).toBe(true);
      return { kind: 'adopted' };
    },
  );

  await expect(beginScopedCredentialUpgrade('device-candidate')).resolves.toEqual({
    kind: 'adopted',
  });
  expect(mockPauseRealtimeForCredentialUpgrade).toHaveBeenCalledTimes(1);
  expect(mockResumeRealtimeAfterCredentialUpgrade).toHaveBeenCalledTimes(1);
  await flushMicrotasks();

  mockDiscardCredentialUpgradeCandidateRuntime.mockImplementationOnce(
    async (dependencies: { beginExclusiveTransition(): boolean }) => {
      expect(dependencies.beginExclusiveTransition()).toBe(true);
      return { kind: 'discarded' };
    },
  );

  await expect(discardScopedCredentialUpgradeCandidate()).resolves.toEqual({ kind: 'discarded' });
  expect(mockPauseRealtimeForCredentialUpgrade).toHaveBeenCalledTimes(2);
  expect(mockResumeRealtimeAfterCredentialUpgrade).toHaveBeenCalledTimes(2);
});

it('retains candidate custody when self-revocation receives a generic 401', async () => {
  const scopedCredential = `bbd_device_v1_${'X'.repeat(43)}`;
  mockRevokeSelf.mockRejectedValueOnce(ApiError.fromStatus(401, 'proxy unauthorized'));
  mockDiscardCredentialUpgradeCandidateRuntime.mockImplementationOnce(
    async (dependencies: {
      revokeCandidate(origin: string, credential: string): Promise<void>;
    }) => {
      try {
        await dependencies.revokeCandidate(mockSession.origin, scopedCredential);
        return { kind: 'discarded' as const };
      } catch {
        return { kind: 'retry' as const, stage: 'candidate-revocation' as const };
      }
    },
  );

  await expect(discardScopedCredentialUpgradeCandidate()).resolves.toEqual({
    kind: 'retry',
    stage: 'candidate-revocation',
  });

  expect(mockFixedCredentialClient).toHaveBeenCalledWith(
    mockSession.origin,
    scopedCredential,
    expect.any(Function),
  );
  expect(mockRevokeSelf).toHaveBeenCalledTimes(1);
});

it('adopts a device credential after Disconnect left a revoked push-key marker', async () => {
  // Disconnect replaces a V3 key with a keyless marker; adoption is the documented way back.
  jest.mocked(readFcmDeviceEncryptionState).mockResolvedValue({
    kind: 'valid',
    state: revokedFcmDeviceEncryptionState(FCM_PUSH_ENCRYPTION_TYPE_V3),
  });
  jest.mocked(writeFcmDeviceEncryptionState).mockClear();
  mockBeginCredentialUpgradeRuntime.mockImplementationOnce(
    async (
      _candidate: string,
      dependencies: {
        prepareV3Registration(origin: string): Promise<{
          name: string;
          provider: 'fcm';
          token: string;
          pushEncryption: { type: typeof FCM_PUSH_ENCRYPTION_TYPE_V3; key: string };
        }>;
        persistPendingV3(
          origin: string,
          registration: Awaited<ReturnType<typeof dependencies.prepareV3Registration>>,
        ): Promise<void>;
      },
    ) => {
      const registration = await dependencies.prepareV3Registration(mockSession.origin);
      expect(registration.pushEncryption.type).toBe(FCM_PUSH_ENCRYPTION_TYPE_V3);
      await dependencies.persistPendingV3(mockSession.origin, registration);
      expect(writeFcmDeviceEncryptionState).toHaveBeenCalledWith(
        mockVault,
        expect.objectContaining({
          encryptionType: FCM_PUSH_ENCRYPTION_TYPE_V3,
          status: 'pending',
          key: registration.pushEncryption.key,
          origin: mockSession.origin,
        }),
      );
      return { kind: 'adopted' as const };
    },
  );

  await expect(beginScopedCredentialUpgrade(`bbd_device_v1_${'Z'.repeat(43)}`)).resolves.toEqual({
    kind: 'adopted',
  });
});

it('replays a saved adoption whose device name predates an Android update (M128)', async () => {
  // The journal keeps the exact request, including the name built from the Android version when it
  // was saved (Platform.Version is 36 here). A retry must send that saved request, not refuse it.
  const candidate = `bbd_device_v1_${'W'.repeat(43)}`;
  const identity = {
    serverInstallationId: '11111111-1111-4111-8111-111111111111',
    principalId: '22222222-2222-4222-8222-222222222222',
    deviceId: '33333333-3333-4333-8333-333333333333',
  } as const;
  const journaled = {
    name: 'Gator (Android 35)',
    provider: 'fcm' as const,
    token: 'fcm-token',
    pushEncryption: {
      type: FCM_PUSH_ENCRYPTION_TYPE_V3,
      key: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    },
  };
  jest.mocked(readFcmDeviceEncryptionState).mockResolvedValue({
    kind: 'valid',
    state: revokedFcmDeviceEncryptionState(FCM_PUSH_ENCRYPTION_TYPE_V3),
  });
  mockRegisterDevice.mockResolvedValueOnce({
    id: identity.deviceId,
    pushEncryptionType: FCM_PUSH_ENCRYPTION_TYPE_V3,
    pushEncryptionIdentity: identity,
    pushEncryptionKeyVersion: 1,
  });
  mockResumeCredentialUpgradeRuntime.mockImplementationOnce(
    async (dependencies: {
      persistPendingV3(origin: string, registration: typeof journaled): Promise<void>;
      registerV3(
        origin: string,
        credential: string,
        registration: typeof journaled,
      ): Promise<unknown>;
    }) => {
      await dependencies.persistPendingV3(mockSession.origin, journaled);
      await dependencies.registerV3(mockSession.origin, candidate, journaled);
      return { kind: 'adopted' as const };
    },
  );

  await expect(resumeScopedCredentialUpgrade({ restartRealtime: false })).resolves.toEqual({
    kind: 'adopted',
  });
  expect(mockRegisterDevice).toHaveBeenCalledWith(
    expect.anything(),
    'Gator (Android 35)',
    'fcm-token',
    journaled.pushEncryption,
  );
});

describe('replaced-credential wiring (M130)', () => {
  const OLD = `bbd_device_v1_${'O'.repeat(43)}`;
  const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
  const identity = {
    serverInstallationId: '11111111-1111-4111-8111-111111111111',
    principalId: '22222222-2222-4222-8222-222222222222',
    deviceId: '33333333-3333-4333-8333-333333333333',
  } as const;

  type ReplacementDeps = {
    releasePreviousPushTarget(origin: string, previous: string): Promise<'released' | 'refused'>;
    revokePreviousCredential(origin: string, previous: string): Promise<void>;
    checkBearerAccepted(origin: string, credential: string): Promise<void>;
  };

  /** Run one replacement whose runtime only hands its real dependencies to `use`. */
  async function withReplacementDeps(use: (deps: ReplacementDeps) => Promise<void>): Promise<void> {
    mockBeginCredentialReplacementRuntime.mockImplementationOnce(
      async (_candidate: string, deps: ReplacementDeps) => {
        await use(deps);
        return { kind: 'adopted' as const };
      },
    );
    await expect(
      beginScopedCredentialReplacement(`bbd_device_v1_${'N'.repeat(43)}`),
    ).resolves.toEqual({ kind: 'adopted' });
  }

  function storeActiveV3(origin = mockSession.origin): void {
    jest.mocked(readFcmDeviceEncryptionState).mockResolvedValue({
      kind: 'valid',
      state: activeFcmDeviceEncryptionV3State(KEY, identity, origin),
    });
  }

  it('frees only the replaced bearer’s own push row, through that bearer', async () => {
    storeActiveV3();
    await withReplacementDeps(async (deps) => {
      await expect(deps.releasePreviousPushTarget(mockSession.origin, OLD)).resolves.toBe(
        'released',
      );
    });
    expect(mockFixedCredentialClient).toHaveBeenCalledWith(
      mockSession.origin,
      OLD,
      expect.any(Function),
    );
    expect(mockRemoveDevice).toHaveBeenCalledWith(
      { kind: 'fixed-candidate-client' },
      identity.deviceId,
      expect.any(AbortSignal),
    );
  });

  it('maps the server’s answers: gone is freed, forbidden is refused, a network error retries', async () => {
    storeActiveV3();
    await withReplacementDeps(async (deps) => {
      mockRemoveDevice.mockRejectedValueOnce(ApiError.fromStatus(404, 'not found'));
      await expect(deps.releasePreviousPushTarget(mockSession.origin, OLD)).resolves.toBe(
        'released',
      );
      mockRemoveDevice.mockRejectedValueOnce(ApiError.fromStatus(403, 'self only'));
      await expect(deps.releasePreviousPushTarget(mockSession.origin, OLD)).resolves.toBe(
        'refused',
      );
      mockRemoveDevice.mockRejectedValueOnce(new Error('network down'));
      await expect(deps.releasePreviousPushTarget(mockSession.origin, OLD)).rejects.toThrow(
        'network down',
      );
    });
  });

  it('refuses without any server call when no active V3 row is stored for this server', async () => {
    jest.mocked(readFcmDeviceEncryptionState).mockResolvedValue({
      kind: 'valid',
      state: revokedFcmDeviceEncryptionState(FCM_PUSH_ENCRYPTION_TYPE_V3),
    });
    await withReplacementDeps(async (deps) => {
      await expect(deps.releasePreviousPushTarget(mockSession.origin, OLD)).resolves.toBe(
        'refused',
      );
    });
    storeActiveV3('https://other.example.test');
    await withReplacementDeps(async (deps) => {
      await expect(deps.releasePreviousPushTarget(mockSession.origin, OLD)).resolves.toBe(
        'refused',
      );
    });
    expect(mockRemoveDevice).not.toHaveBeenCalled();
  });

  it('revokes the replaced bearer through that bearer', async () => {
    mockRevokeSelf.mockResolvedValueOnce({
      revoked: true,
      deviceId: identity.deviceId,
      deviceRemoved: true,
    });
    await withReplacementDeps(async (deps) => {
      await deps.revokePreviousCredential(mockSession.origin, OLD);
    });
    expect(mockFixedCredentialClient).toHaveBeenCalledWith(
      mockSession.origin,
      OLD,
      expect.any(Function),
    );
    expect(mockRevokeSelf).toHaveBeenCalledWith(
      { kind: 'fixed-candidate-client' },
      expect.any(AbortSignal),
    );
  });

  it('checks a rejected bearer with its own time-limited request (M130 follow-up)', async () => {
    let captured!: ReplacementDeps;
    await withReplacementDeps(async (deps) => {
      captured = deps;
    });
    const serverInfo = jest.mocked(serverApi.serverInfo);
    // A server that never answers: only the request's own deadline can end the check.
    serverInfo.mockImplementationOnce(
      (_client: unknown, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('bearer check aborted')));
        }),
    );
    jest.useFakeTimers();
    try {
      const check = captured.checkBearerAccepted(mockSession.origin, OLD);
      const outcome = expect(check).rejects.toThrow('bearer check aborted');
      await jest.advanceTimersByTimeAsync(60_000);
      await outcome;
    } finally {
      jest.useRealTimers();
    }
    expect(mockFixedCredentialClient).toHaveBeenLastCalledWith(
      mockSession.origin,
      OLD,
      expect.any(Function),
    );
    expect(serverInfo).toHaveBeenCalledWith(
      { kind: 'fixed-candidate-client' },
      expect.any(AbortSignal),
    );
  });

  it('revokes the replaced bearer once the new credential is live, as pending when that fails', async () => {
    mockRevokeReplacedCredentialRuntime.mockResolvedValueOnce('pending');
    await expect(
      beginScopedCredentialReplacement(`bbd_device_v1_${'N'.repeat(43)}`),
    ).resolves.toEqual({ kind: 'adopted-revocation-pending' });
    expect(mockRevokeReplacedCredentialRuntime.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockBeginCredentialReplacementRuntime.mock.invocationCallOrder[0]!,
    );

    mockRevokeReplacedCredentialRuntime.mockResolvedValueOnce('revoked');
    await expect(
      beginScopedCredentialReplacement(`bbd_device_v1_${'M'.repeat(43)}`),
    ).resolves.toEqual({ kind: 'adopted' });
  });

  it('retries a pending revocation in the background only after an idle resume', async () => {
    await expect(resumeScopedCredentialUpgrade({ restartRealtime: false })).resolves.toEqual({
      kind: 'idle',
    });
    await flushMicrotasks();
    expect(mockRevokeReplacedCredentialRuntime).toHaveBeenCalledTimes(1);

    // A resume that finishes a promotion revokes inline once and schedules nothing more.
    mockResumeCredentialUpgradeRuntime.mockResolvedValueOnce({ kind: 'adopted' });
    await expect(resumeScopedCredentialUpgrade({ restartRealtime: false })).resolves.toEqual({
      kind: 'adopted',
    });
    await flushMicrotasks();
    expect(mockRevokeReplacedCredentialRuntime).toHaveBeenCalledTimes(2);
  });
});
