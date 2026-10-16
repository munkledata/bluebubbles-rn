const pauseRealtime = jest.fn();
const resumeRealtime = jest.fn<Promise<void>, []>(() => Promise.resolve());
const flushErrorReports = jest.fn<Promise<void>, []>(() => Promise.resolve());
const reconcileMessageNotificationGroup = jest.fn<Promise<void>, []>(() => Promise.resolve());
const clearLockedNotification = jest.fn<Promise<void>, []>(() => Promise.resolve());
const beginAppLockNotificationPrivacy = jest.fn<Promise<void>, []>(() => Promise.resolve());
const commitAppLockNotificationPrivacy = jest.fn();
const releaseAppLockNotificationPrivacyBarrier = jest.fn();
const recoverOutgoing = jest.fn<Promise<{ eligible: number; sent: number }>, []>(async () => ({
  eligible: 0,
  sent: 0,
}));
const isDevServer = jest.fn(() => false);
const vaultGet = jest.fn(async () => null as string | null);
const vaultSet = jest.fn<Promise<void>, [string, string]>(async () => undefined);
const setNativeAppLockEnabled = jest.fn(() => true);
const clearCurrentShareShortcuts = jest.fn(() => true);

jest.mock('@/services/realtimeControl', () => ({ pauseRealtime, resumeRealtime }));
jest.mock('@/services/errors', () => ({ flushErrorReports }));
jest.mock('@/services/notifications/notifeeService', () => ({
  reconcileMessageNotificationGroup,
  clearLockedNotification,
  beginAppLockNotificationPrivacy,
  commitAppLockNotificationPrivacy,
  releaseAppLockNotificationPrivacyBarrier,
}));
jest.mock('@/services/send', () => ({ recoverOutgoing }));
jest.mock('@utils/isDev', () => ({ isDevServer }));
jest.mock('@/services/clients', () => ({
  vault: { get: vaultGet, set: vaultSet },
}));
jest.mock('@native/screenSecurity', () => ({
  setNativeAppLockEnabled,
}));
jest.mock('@/services/shortcuts/shareShortcuts', () => ({
  clearCurrentShareShortcuts,
}));

// Mock registration must precede the service import so no native notification module is loaded.
// eslint-disable-next-line import/first
import { logger } from '@core/secure';
// eslint-disable-next-line import/first
import { useLockStore } from '@state/lockStore';
// eslint-disable-next-line import/first
import { useSessionStore } from '@state/sessionStore';
// eslint-disable-next-line import/first
import { completeUnlock, hydrateLock, setAppLockEnabled } from '@/services/lock';
// eslint-disable-next-line import/first
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

beforeEach(() => {
  resumeRealtimeDeliveries();
  pauseRealtime.mockReset();
  resumeRealtime.mockReset().mockResolvedValue(undefined);
  flushErrorReports.mockReset().mockResolvedValue(undefined);
  reconcileMessageNotificationGroup.mockReset().mockResolvedValue(undefined);
  clearLockedNotification.mockReset().mockResolvedValue(undefined);
  beginAppLockNotificationPrivacy.mockReset().mockResolvedValue(undefined);
  commitAppLockNotificationPrivacy.mockReset();
  releaseAppLockNotificationPrivacyBarrier.mockReset();
  recoverOutgoing.mockReset().mockResolvedValue({ eligible: 0, sent: 0 });
  isDevServer.mockReset().mockReturnValue(false);
  vaultSet.mockReset().mockResolvedValue(undefined);
  vaultGet.mockReset().mockResolvedValue(null);
  setNativeAppLockEnabled.mockReset().mockReturnValue(true);
  clearCurrentShareShortcuts.mockReset().mockReturnValue(true);
  useLockStore.setState({
    enabled: true,
    locked: true,
    hydrated: true,
    lastBackgrounded: 1,
    timeoutMs: 30_000,
  });
  useSessionStore.setState({ status: 'unauthenticated', origin: null, password: null });
});

describe('setAppLockEnabled', () => {
  it('drains a held scrub and drops its setting write after account retirement', async () => {
    useLockStore.setState({ enabled: false, locked: false });
    let finish!: () => void;
    beginAppLockNotificationPrivacy.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const enable = setAppLockEnabled(true);
    const rejection = expect(enable).rejects.toThrow('interrupted by Disconnect');
    let drained = false;
    const teardown = pauseRealtimeDeliveries().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    finish();
    await Promise.all([rejection, teardown]);
    resumeRealtimeDeliveries();
    expect(vaultSet).not.toHaveBeenCalled();
    expect(useLockStore.getState().enabled).toBe(false);
    expect(commitAppLockNotificationPrivacy).not.toHaveBeenCalled();
  });

  it('settles an admitted device-policy vault write before account teardown can finish', async () => {
    useLockStore.setState({ enabled: false, locked: false });
    let finish!: () => void;
    vaultSet.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const enable = setAppLockEnabled(true);
    await Promise.resolve();
    expect(finish).toBeDefined();
    let drained = false;
    const teardown = pauseRealtimeDeliveries().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    finish();
    await Promise.all([enable, teardown]);
    expect(drained).toBe(true);
    resumeRealtimeDeliveries();
    expect(useLockStore.getState()).toMatchObject({ enabled: true, locked: true });
    expect(commitAppLockNotificationPrivacy).toHaveBeenCalledTimes(1);
  });

  it('installs privacy synchronously and waits for the sweep before persisting or publishing', async () => {
    useLockStore.setState({ enabled: false, locked: false });
    let finish!: () => void;
    beginAppLockNotificationPrivacy.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const enable = setAppLockEnabled(true);
    expect(beginAppLockNotificationPrivacy).toHaveBeenCalledTimes(1);
    expect(vaultSet).not.toHaveBeenCalled();
    expect(useLockStore.getState().enabled).toBe(false);
    finish();
    await enable;
    expect(commitAppLockNotificationPrivacy).toHaveBeenCalledTimes(1);
    expect(useLockStore.getState().enabled).toBe(true);
  });

  it('rejects overlapping opposite toggles and hydration rather than reordering vault writes', async () => {
    let finish!: () => void;
    vaultSet.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const enable = setAppLockEnabled(true);
    await Promise.resolve();
    await expect(setAppLockEnabled(false)).rejects.toThrow('already in progress');
    await expect(hydrateLock()).rejects.toThrow('already in progress');
    finish();
    await enable;
    expect(vaultSet).toHaveBeenCalledTimes(1);
    await setAppLockEnabled(false);
    expect(useLockStore.getState().enabled).toBe(false);
  });

  it.each(['native cleanup', 'vault write'])(
    'keeps the privacy barrier on failed %s without claiming App Lock enabled',
    async (stage) => {
      useLockStore.setState({ enabled: false, locked: false });
      if (stage === 'native cleanup')
        beginAppLockNotificationPrivacy.mockRejectedValueOnce(new Error('native cleanup'));
      else vaultSet.mockRejectedValueOnce(new Error('vault write'));
      await expect(setAppLockEnabled(true)).rejects.toThrow(stage);
      expect(commitAppLockNotificationPrivacy).not.toHaveBeenCalled();
      expect(useLockStore.getState().enabled).toBe(false);
      expect(pauseRealtime).not.toHaveBeenCalled();
      await setAppLockEnabled(true);
      expect(useLockStore.getState().enabled).toBe(true);
    },
  );

  it('does not open a cold protected gate until the native sweep completes', async () => {
    useLockStore.setState({ enabled: false, locked: false, hydrated: false });
    vaultGet.mockResolvedValueOnce('true');
    let finish!: () => void;
    beginAppLockNotificationPrivacy.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const hydrate = hydrateLock();
    await Promise.resolve();
    expect(useLockStore.getState().hydrated).toBe(false);
    finish();
    await hydrate;
    expect(useLockStore.getState()).toMatchObject({ enabled: true, locked: true, hydrated: true });
  });

  it('does not publish a cold hydration retired during native cleanup', async () => {
    useLockStore.setState({ enabled: false, locked: false, hydrated: false });
    vaultGet.mockResolvedValueOnce('true');
    let finish!: () => void;
    let current = true;
    beginAppLockNotificationPrivacy.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const hydrate = hydrateLock({ shouldCommit: () => current });
    await Promise.resolve();
    current = false;
    finish();
    await hydrate;
    expect(useLockStore.getState().hydrated).toBe(false);
    expect(commitAppLockNotificationPrivacy).not.toHaveBeenCalled();
    expect(setNativeAppLockEnabled).not.toHaveBeenCalled();
  });

  it('starts locked after a failed cold cleanup, keeps the privacy barrier, and reports it', async () => {
    useLockStore.setState({ enabled: false, locked: false, hydrated: false });
    vaultGet.mockResolvedValueOnce('true');
    beginAppLockNotificationPrivacy.mockRejectedValueOnce(new Error('native cleanup'));

    await expect(hydrateLock()).resolves.toEqual({ notificationCleanupFailed: true });

    expect(useLockStore.getState()).toMatchObject({ enabled: true, locked: true, hydrated: true });
    expect(clearCurrentShareShortcuts).toHaveBeenCalledTimes(1);
    expect(setNativeAppLockEnabled).toHaveBeenCalledWith(true);
    // The barrier stays up until a later sweep is verified.
    expect(commitAppLockNotificationPrivacy).not.toHaveBeenCalled();
  });

  it.each([null, 'false'])(
    'hydrating App Lock off (%s) keeps notifications already being prepared (M106)',
    async (stored) => {
      // Startup reading "off" changes no policy: nothing prepared during startup can reveal more
      // than "off" allows, so only the barrier is lifted; a new privacy epoch would drop it.
      useLockStore.setState({ enabled: false, locked: false, hydrated: false });
      vaultGet.mockResolvedValueOnce(stored);

      await expect(hydrateLock()).resolves.toEqual({ notificationCleanupFailed: false });

      expect(useLockStore.getState()).toMatchObject({ enabled: false, hydrated: true });
      expect(beginAppLockNotificationPrivacy).not.toHaveBeenCalled();
      expect(commitAppLockNotificationPrivacy).not.toHaveBeenCalled();
      expect(releaseAppLockNotificationPrivacyBarrier).toHaveBeenCalledTimes(1);
    },
  );

  it('hydrating App Lock on still starts a new privacy epoch after the verified sweep', async () => {
    useLockStore.setState({ enabled: false, locked: false, hydrated: false });
    vaultGet.mockResolvedValueOnce('true');

    await hydrateLock();

    expect(commitAppLockNotificationPrivacy).toHaveBeenCalledTimes(1);
    expect(releaseAppLockNotificationPrivacyBarrier).not.toHaveBeenCalled();
  });

  it('hydrates the native Recents owner before publishing the persisted App Lock choice', async () => {
    vaultGet.mockResolvedValueOnce('true');

    await hydrateLock();

    expect(clearCurrentShareShortcuts).toHaveBeenCalledTimes(1);
    expect(setNativeAppLockEnabled).toHaveBeenCalledWith(true);
    expect(clearCurrentShareShortcuts.mock.invocationCallOrder[0]!).toBeLessThan(
      setNativeAppLockEnabled.mock.invocationCallOrder[0]!,
    );
    expect(useLockStore.getState()).toMatchObject({ enabled: true, locked: true, hydrated: true });
  });

  it('refuses to enable App Lock when native Recents protection is unavailable', async () => {
    useLockStore.setState({ enabled: false, locked: false });
    setNativeAppLockEnabled.mockReturnValueOnce(false);

    await expect(setAppLockEnabled(true)).rejects.toThrow(
      'App Lock requires the Android Recents protection module.',
    );

    expect(vaultSet).not.toHaveBeenCalled();
    expect(useLockStore.getState()).toMatchObject({ enabled: false, locked: false });
  });

  it('refuses to enable App Lock when personalized Direct Share rows cannot be cleared', async () => {
    useLockStore.setState({ enabled: false, locked: false });
    clearCurrentShareShortcuts.mockReturnValueOnce(false);

    await expect(setAppLockEnabled(true)).rejects.toThrow(
      'App Lock requires Direct Share privacy cleanup.',
    );

    expect(setNativeAppLockEnabled).not.toHaveBeenCalled();
    expect(vaultSet).not.toHaveBeenCalled();
    expect(useLockStore.getState()).toMatchObject({ enabled: false, locked: false });
  });

  it('locks the gate and stops an existing realtime connection when enabled', async () => {
    useLockStore.setState({ enabled: false, locked: false });

    await setAppLockEnabled(true);

    expect(vaultSet).toHaveBeenCalledWith('appLockEnabled', 'true');
    expect(clearCurrentShareShortcuts).toHaveBeenCalledTimes(1);
    expect(setNativeAppLockEnabled).toHaveBeenCalledWith(true);
    expect(clearCurrentShareShortcuts.mock.invocationCallOrder[0]!).toBeLessThan(
      setNativeAppLockEnabled.mock.invocationCallOrder[0]!,
    );
    expect(setNativeAppLockEnabled.mock.invocationCallOrder[0]!).toBeLessThan(
      vaultSet.mock.invocationCallOrder[0]!,
    );
    expect(useLockStore.getState()).toMatchObject({ enabled: true, locked: true });
    expect(pauseRealtime).toHaveBeenCalledTimes(1);
  });

  it('does not pause an already-unlocked connection when the setting is disabled', async () => {
    await setAppLockEnabled(false);

    expect(vaultSet).toHaveBeenCalledWith('appLockEnabled', 'false');
    expect(setNativeAppLockEnabled).toHaveBeenCalledWith(false);
    expect(useLockStore.getState()).toMatchObject({ enabled: false, locked: false });
    expect(pauseRealtime).not.toHaveBeenCalled();
  });

  it('retains the enabled gate and native privacy policy when disabling cannot persist', async () => {
    vaultSet.mockRejectedValueOnce(new Error('vault unavailable'));
    await expect(setAppLockEnabled(false)).rejects.toThrow('vault unavailable');
    expect(useLockStore.getState()).toMatchObject({ enabled: true, locked: true });
    expect(setNativeAppLockEnabled).not.toHaveBeenCalled();
    expect(commitAppLockNotificationPrivacy).not.toHaveBeenCalled();
  });
});

describe('completeUnlock', () => {
  it('keeps a cold boot locked when no coordinator run identity is supplied', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    useSessionStore.setState({ status: 'loading', origin: null, password: null });

    await completeUnlock();

    expect(useLockStore.getState().locked).toBe(true);
    expect(resumeRealtime).not.toHaveBeenCalled();
    expect(flushErrorReports).not.toHaveBeenCalled();
    expect(reconcileMessageNotificationGroup).not.toHaveBeenCalled();
    expect(clearLockedNotification).not.toHaveBeenCalled();
    expect(recoverOutgoing).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[lock] ignored cold unlock without foreground boot run ownership',
    );
    warn.mockRestore();
  });

  it('runs the foreground recovery sequence after a warm connected session is unlocked', async () => {
    useSessionStore.setState({
      status: 'connected',
      origin: 'https://gator.example',
      password: 'secret',
    });

    await completeUnlock();

    expect(useLockStore.getState().locked).toBe(false);
    expect(resumeRealtime).toHaveBeenCalledTimes(1);
    expect(flushErrorReports).toHaveBeenCalledTimes(1);
    expect(reconcileMessageNotificationGroup).toHaveBeenCalledTimes(1);
    // The user is now in the app: a stale "You have new messages" must not linger in the tray.
    expect(clearLockedNotification).toHaveBeenCalledTimes(1);
    expect(recoverOutgoing).toHaveBeenCalledTimes(1);
    expect(resumeRealtime.mock.invocationCallOrder[0]!).toBeLessThan(
      flushErrorReports.mock.invocationCallOrder[0]!,
    );
    expect(flushErrorReports.mock.invocationCallOrder[0]!).toBeLessThan(
      recoverOutgoing.mock.invocationCallOrder[0]!,
    );
  });

  it('keeps every recovery non-blocking after authentication succeeds', async () => {
    let finishRealtime!: () => void;
    let finishFlush!: () => void;
    let finishNotificationRepair!: () => void;
    let finishOutgoing!: (result: { eligible: number; sent: number }) => void;
    resumeRealtime.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishRealtime = resolve;
      }),
    );
    flushErrorReports.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishFlush = resolve;
      }),
    );
    reconcileMessageNotificationGroup.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishNotificationRepair = resolve;
      }),
    );
    recoverOutgoing.mockReturnValueOnce(
      new Promise<{ eligible: number; sent: number }>((resolve) => {
        finishOutgoing = resolve;
      }),
    );
    useSessionStore.setState({
      status: 'connected',
      origin: 'https://gator.example',
      password: 'secret',
    });

    await expect(completeUnlock()).resolves.toBeUndefined();

    expect(useLockStore.getState().locked).toBe(false);
    expect(resumeRealtime).toHaveBeenCalledTimes(1);
    expect(flushErrorReports).toHaveBeenCalledTimes(1);
    expect(reconcileMessageNotificationGroup).toHaveBeenCalledTimes(1);
    expect(recoverOutgoing).toHaveBeenCalledTimes(1);

    finishRealtime();
    finishFlush();
    finishNotificationRepair();
    finishOutgoing({ eligible: 0, sent: 0 });
  });

  it('does not run server send recovery for the fixture dev server', async () => {
    isDevServer.mockReturnValue(true);
    useSessionStore.setState({
      status: 'connected',
      origin: 'https://dev.local',
      password: 'secret',
    });

    await completeUnlock();

    expect(resumeRealtime).toHaveBeenCalledTimes(1);
    expect(flushErrorReports).toHaveBeenCalledTimes(1);
    expect(reconcileMessageNotificationGroup).toHaveBeenCalledTimes(1);
    expect(recoverOutgoing).not.toHaveBeenCalled();
  });

  it('does not start connected-session recovery for a warm disconnected session', async () => {
    await completeUnlock();

    expect(useLockStore.getState().locked).toBe(false);
    expect(resumeRealtime).not.toHaveBeenCalled();
    expect(flushErrorReports).not.toHaveBeenCalled();
    expect(reconcileMessageNotificationGroup).not.toHaveBeenCalled();
    expect(recoverOutgoing).not.toHaveBeenCalled();
  });

  it('does not re-lock or reject when any post-unlock recovery fails', async () => {
    const realtimeFailure = new Error('socket unavailable');
    const flushFailure = new Error('report queue unavailable');
    const notificationFailure = new Error('notification tray unavailable');
    const outgoingFailure = new Error('send queue unavailable');
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    useSessionStore.setState({
      status: 'connected',
      origin: 'https://gator.example',
      password: 'secret',
    });
    resumeRealtime.mockRejectedValueOnce(realtimeFailure);
    flushErrorReports.mockRejectedValueOnce(flushFailure);
    reconcileMessageNotificationGroup.mockRejectedValueOnce(notificationFailure);
    recoverOutgoing.mockRejectedValueOnce(outgoingFailure);

    await expect(completeUnlock()).resolves.toBeUndefined();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(useLockStore.getState().locked).toBe(false);
    expect(warn.mock.calls).toEqual([
      ['[realtime] post-unlock resume failed', realtimeFailure],
      ['[errors] post-unlock flush failed', flushFailure],
      ['[notif] post-unlock message-group repair failed', notificationFailure],
      ['[send] post-unlock recovery failed', outgoingFailure],
    ]);
    warn.mockRestore();
  });
});
