/**
 * LockScreen: the full-screen biometric gate. It auto-prompts on mount, routes a successful auth
 * to `onUnlock` (cold-boot path) or the store's `unlock` (default), and flips the button to "Try
 * again" on failure. The biometrics native wrapper is mocked in-file; the REAL `useLockStore`
 * drives the default unlock path.
 */
import React from 'react';
import { renderWithTheme, fireEvent, waitFor } from './support/renderWithTheme';
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
});
