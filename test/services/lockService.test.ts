const hydrateSession = jest.fn<Promise<void>, []>(() => Promise.resolve());
const pauseRealtime = jest.fn();
const resumeRealtime = jest.fn<Promise<void>, []>(() => Promise.resolve());
const flushErrorReports = jest.fn<Promise<void>, []>(() => Promise.resolve());
const recoverOutgoing = jest.fn<Promise<{ eligible: number; sent: number }>, []>(async () => ({
  eligible: 0,
  sent: 0,
}));
const isDevServer = jest.fn(() => false);
const vaultGet = jest.fn(async () => null as string | null);
const vaultSet = jest.fn(async () => undefined);
const setNativeAppLockEnabled = jest.fn(() => true);

jest.mock('@/services/bootstrap', () => ({ hydrateSession }));
jest.mock('@/services/realtimeControl', () => ({ pauseRealtime, resumeRealtime }));
jest.mock('@/services/errors', () => ({ flushErrorReports }));
jest.mock('@/services/send', () => ({ recoverOutgoing }));
jest.mock('@utils/isDev', () => ({ isDevServer }));
jest.mock('@/services/clients', () => ({
  vault: { get: vaultGet, set: vaultSet },
}));
jest.mock('@native/screenSecurity', () => ({
  setNativeAppLockEnabled,
}));

import { logger } from '@core/secure';
import { useLockStore } from '@state/lockStore';
import { useSessionStore } from '@state/sessionStore';
import { completeUnlock, hydrateLock, setAppLockEnabled } from '@/services/lock';

beforeEach(() => {
  hydrateSession.mockReset().mockResolvedValue(undefined);
  pauseRealtime.mockReset();
  resumeRealtime.mockReset().mockResolvedValue(undefined);
  flushErrorReports.mockReset().mockResolvedValue(undefined);
  recoverOutgoing.mockReset().mockResolvedValue({ eligible: 0, sent: 0 });
  isDevServer.mockReset().mockReturnValue(false);
  vaultSet.mockReset().mockResolvedValue(undefined);
  vaultGet.mockReset().mockResolvedValue(null);
  setNativeAppLockEnabled.mockReset().mockReturnValue(true);
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
  it('hydrates the native Recents owner before publishing the persisted App Lock choice', async () => {
    vaultGet.mockResolvedValueOnce('true');

    await hydrateLock();

    expect(setNativeAppLockEnabled).toHaveBeenCalledWith(true);
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

  it('locks the gate and stops an existing realtime connection when enabled', async () => {
    useLockStore.setState({ enabled: false, locked: false });

    await setAppLockEnabled(true);

    expect(vaultSet).toHaveBeenCalledWith('appLockEnabled', 'true');
    expect(setNativeAppLockEnabled).toHaveBeenCalledWith(true);
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
});

describe('completeUnlock', () => {
  it('keeps a cold boot locked when no coordinator run identity is supplied', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    useSessionStore.setState({ status: 'loading', origin: null, password: null });

    await completeUnlock();

    expect(hydrateSession).not.toHaveBeenCalled();
    expect(useLockStore.getState().locked).toBe(true);
    expect(resumeRealtime).not.toHaveBeenCalled();
    expect(flushErrorReports).not.toHaveBeenCalled();
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

    expect(hydrateSession).not.toHaveBeenCalled();
    expect(useLockStore.getState().locked).toBe(false);
    expect(resumeRealtime).toHaveBeenCalledTimes(1);
    expect(flushErrorReports).toHaveBeenCalledTimes(1);
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
    expect(recoverOutgoing).toHaveBeenCalledTimes(1);

    finishRealtime();
    finishFlush();
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
    expect(recoverOutgoing).not.toHaveBeenCalled();
  });

  it('does not start connected-session recovery for a warm disconnected session', async () => {
    await completeUnlock();

    expect(useLockStore.getState().locked).toBe(false);
    expect(resumeRealtime).not.toHaveBeenCalled();
    expect(flushErrorReports).not.toHaveBeenCalled();
    expect(recoverOutgoing).not.toHaveBeenCalled();
  });

  it('does not re-lock or reject when any post-unlock recovery fails', async () => {
    const realtimeFailure = new Error('socket unavailable');
    const flushFailure = new Error('report queue unavailable');
    const outgoingFailure = new Error('send queue unavailable');
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    useSessionStore.setState({
      status: 'connected',
      origin: 'https://gator.example',
      password: 'secret',
    });
    resumeRealtime.mockRejectedValueOnce(realtimeFailure);
    flushErrorReports.mockRejectedValueOnce(flushFailure);
    recoverOutgoing.mockRejectedValueOnce(outgoingFailure);

    await expect(completeUnlock()).resolves.toBeUndefined();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(useLockStore.getState().locked).toBe(false);
    expect(warn.mock.calls).toEqual([
      ['[realtime] post-unlock resume failed', realtimeFailure],
      ['[errors] post-unlock flush failed', flushFailure],
      ['[send] post-unlock recovery failed', outgoingFailure],
    ]);
    warn.mockRestore();
  });
});
