/**
 * LockScreen: the full-screen biometric gate. It auto-prompts on mount, routes a successful auth
 * to `onUnlock` (cold-boot path) or the store's `unlock` (default), and flips the button to "Try
 * again" on failure. The biometrics native wrapper is mocked in-file; the REAL `useLockStore`
 * drives the default unlock path.
 *
 * The last two tests pin what happens when a promise REJECTS rather than resolving false. That is
 * a real gap in the source (`tryUnlock` has no try/catch) — see the comments on those tests.
 */
import React from 'react';
import { runInThisContext } from 'node:vm';
import { renderWithTheme, fireEvent, waitFor, screen } from './support/renderWithTheme';
import { LockScreen } from '@features/lock/LockScreen';
import { useLockStore } from '@state/lockStore';
import { authenticate } from '@native/biometrics';

jest.mock('@native/biometrics', () => ({ authenticate: jest.fn() }));
const mockAuthenticate = authenticate as jest.Mock;

// LockScreen only needs `useTheme`, but it imports it from the big `@ui` barrel, which
// re-exports the whole UI tree (ConversationTile, VideoPlayer, …) and so drags in `ky` (ESM)
// and native modules (expo-video) that don't load under jest. Collapse `@ui` to the real theme
// module — same ThemeProvider context `renderWithTheme` uses, so the provider still drives useTheme.
jest.mock('@ui', () => jest.requireActual('@ui/theme'));

// No SafeAreaProvider is mounted by renderWithTheme, so stub the inset hook.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

beforeEach(() => {
  mockAuthenticate.mockReset();
  useLockStore.setState({
    enabled: true,
    locked: true,
    hydrated: true,
    lastBackgrounded: null,
    timeoutMs: 30_000,
  });
});

/**
 * Run `body` while OWNING Node's `unhandledRejection` event, and hand back everything that
 * escaped during it.
 *
 * Why this is needed: the two SOURCE BUG tests below drive `LockScreen` into a rejection, and
 * because the source has no try/catch that rejection escapes from the `void tryUnlock()` call.
 * Jest turns an escaped rejection into a test failure — which would make the bug untestable and
 * hide the interesting question (what is the USER left looking at?). So we borrow the event,
 * collect instead, and restore Jest's listener afterwards.
 *
 * Why the `vm` hop: the `process` global visible inside a test is a sandboxed deep copy with its
 * own event emitter (jest-util's `createProcessObject`), so `process.on('unhandledRejection')`
 * here would never fire — verified. `vm.runInThisContext` compiles in the OUTER realm, which
 * yields the real process object Jest actually listens on.
 */
function realProcess(): NodeJS.Process {
  const proc = runInThisContext('process') as NodeJS.Process | undefined;
  if (!proc?.on) throw new Error('could not reach the real process object');
  return proc;
}

async function collectingUnhandledRejections(body: () => Promise<void>): Promise<unknown[]> {
  const proc = realProcess();
  const saved = proc.listeners('unhandledRejection');
  const escaped: unknown[] = [];
  const collect = (reason: unknown): void => {
    escaped.push(reason);
  };
  proc.removeAllListeners('unhandledRejection');
  proc.on('unhandledRejection', collect);
  try {
    await body();
    // One more macrotask so a rejection settled at the very end still reaches the collector.
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    proc.off('unhandledRejection', collect);
    for (const listener of saved) {
      proc.on('unhandledRejection', listener as (reason: unknown) => void);
    }
  }
  return escaped;
}

describe('LockScreen', () => {
  it('renders the locked prompt and auto-prompts biometrics on mount', async () => {
    mockAuthenticate.mockReturnValue(new Promise(() => {})); // pending → no state change
    const { getByText } = await renderWithTheme(<LockScreen />);
    expect(getByText('Gator is locked')).toBeTruthy();
    expect(getByText('Authenticate to continue')).toBeTruthy();
    expect(getByText('Unlock')).toBeTruthy();
    await waitFor(() => expect(mockAuthenticate).toHaveBeenCalledWith('Unlock Gator'));
    expect(mockAuthenticate).toHaveBeenCalledTimes(1);
  });

  it('routes a successful auth to the onUnlock prop (cold-boot path)', async () => {
    mockAuthenticate.mockResolvedValue(true);
    const onUnlock = jest.fn();
    await renderWithTheme(<LockScreen onUnlock={onUnlock} />);
    await waitFor(() => expect(onUnlock).toHaveBeenCalledTimes(1));
    // The store's own unlock isn't used when onUnlock is provided.
    expect(useLockStore.getState().locked).toBe(true);
  });

  it('falls back to the store unlock when no onUnlock is given', async () => {
    mockAuthenticate.mockResolvedValue(true);
    await renderWithTheme(<LockScreen />);
    await waitFor(() => expect(useLockStore.getState().locked).toBe(false));
  });

  it('shows "Try again" after a failed auth', async () => {
    mockAuthenticate.mockResolvedValue(false);
    const { findByText } = await renderWithTheme(<LockScreen />);
    expect(await findByText('Try again')).toBeTruthy();
    expect(useLockStore.getState().locked).toBe(true);
  });

  it('re-prompts biometrics when the button is pressed (and unlocks on the retry)', async () => {
    mockAuthenticate.mockResolvedValueOnce(false); // auto-prompt fails → "Try again"
    mockAuthenticate.mockResolvedValueOnce(true); // the manual retry succeeds
    const { findByText } = await renderWithTheme(<LockScreen />);
    const btn = await findByText('Try again');
    expect(mockAuthenticate).toHaveBeenCalledTimes(1);
    fireEvent.press(btn);
    // The success path unlocks via the store (LockScreen subscribes only to the stable
    // `unlock`, so no component re-render/act churn to await here).
    await waitFor(() => expect(useLockStore.getState().locked).toBe(false));
    expect(mockAuthenticate).toHaveBeenCalledTimes(2);
  });

  /**
   * FIXED (was a source bug): `tryUnlock` awaited `authenticate(...)` bare, so a REJECTION (the
   * native biometric bridge throwing — expo-local-authentication erroring after an enrolment
   * change, or the module missing on a stale bundle) was NOT treated like a declined prompt:
   * `setFailed(true)` never ran, the button still read "Unlock", and the rejection escaped as an
   * unhandled promise rejection from the `void tryUnlock()` in the mount effect. The user was left
   * staring at an unchanged screen with no indication anything had happened.
   *
   * A thrown prompt is now treated as a failed prompt (retrying is reasonable).
   */
  it('a REJECTING authenticate() shows "Try again" and does not escape as an unhandled rejection', async () => {
    mockAuthenticate.mockRejectedValue(new Error('biometric bridge unavailable'));

    const escaped = await collectingUnhandledRejections(async () => {
      await renderWithTheme(<LockScreen />);
      await waitFor(() => expect(mockAuthenticate).toHaveBeenCalledTimes(1));

      // The user gets a real affordance now.
      expect(await screen.findByText('Try again')).toBeTruthy();
      expect(screen.getByText('Gator is locked')).toBeTruthy();
      expect(useLockStore.getState().locked).toBe(true); // a throw must never unlock
    });

    // The catch swallowed it — nothing escapes to the process any more.
    expect(escaped).toEqual([]);
  });

  /**
   * FIXED (was a source bug): same missing try/catch on `await (onUnlock ?? storeUnlock)()`.
   *
   * The cold-boot path passes `completeUnlock`, which OPENS THE SQLCIPHER DB. If that open throws
   * (corrupt DB, Keystore key-unwrap failure, migration error) the biometric prompt has ALREADY
   * succeeded, so the `else setFailed(true)` branch is unreachable — the user was stranded on the
   * lock screen forever, and pressing the button just re-prompted and failed the same silent way.
   *
   * This case deliberately does NOT say "Try again": retrying cannot fix a corrupt database, so it
   * gets its own message. That distinction is the point of the test.
   */
  it('a REJECTING onUnlock (cold-boot DB open) shows a distinct error, not "Try again"', async () => {
    mockAuthenticate.mockResolvedValue(true);
    const onUnlock = jest.fn().mockRejectedValue(new Error('Database not initialized'));

    const escaped = await collectingUnhandledRejections(async () => {
      await renderWithTheme(<LockScreen onUnlock={onUnlock} />);
      await waitFor(() => expect(onUnlock).toHaveBeenCalledTimes(1));

      expect(await screen.findByText(/Couldn.t open your messages/)).toBeTruthy();
      // "Try again" would be misleading here — assert it is NOT offered. findBy runs to timeout,
      // so this fails if it ever appears (a queryBy-null would pass on the first tick).
      await expect(screen.findByText('Try again', {}, { timeout: 600 })).rejects.toBeTruthy();
      expect(useLockStore.getState().locked).toBe(true);
    });

    expect(escaped).toEqual([]);
  });
});
