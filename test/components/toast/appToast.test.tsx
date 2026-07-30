/**
 * AppToast (src/ui/toast/AppToast.tsx): the app-wide ephemeral status pill. Locked in:
 *   - renders nothing when the store is empty;
 *   - shows an enqueued toast's message (via showToast);
 *   - auto-dismisses after its duration;
 *   - the overlay NEVER captures touches (pointerEvents="none" over the whole screen) — the one
 *     property that separates this from AppDialog's Modal, and the reason it can float over chat;
 *   - the FIFO queue actually PLAYS BACK: a second toast enqueued behind the first is promoted by
 *     the auto-dismiss instead of being dropped;
 *   - a STALE toast (enqueued by a headless FCM wake in a previous, hostless life of the JS
 *     context) is dropped on sight instead of replaying as a ghost pill.
 * Insets are mocked (the pill offsets by insets.bottom). Renders async under RNTL 14 → await.
 */
import React from 'react';
import { act } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { renderWithTheme, screen, waitFor } from '../support/renderWithTheme';
import { AppToast } from '@ui/toast/AppToast';
import { showToast, useToastStore } from '@ui/toast/toastStore';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

describe('AppToast', () => {
  beforeEach(() => {
    useToastStore.setState({ current: null, queue: [] });
  });

  it('renders nothing when there is no toast', async () => {
    await renderWithTheme(<AppToast />);
    expect(screen.toJSON()).toBeNull();
  });

  it('shows an enqueued toast message', async () => {
    await renderWithTheme(<AppToast />);
    await act(async () => {
      showToast('Downloaded 3 images to Gator album');
    });
    expect(await screen.findByText('Downloaded 3 images to Gator album')).toBeTruthy();
  });

  it('auto-dismisses after its duration', async () => {
    await renderWithTheme(<AppToast />);
    await act(async () => {
      showToast('bye', { durationMs: 50 });
    });
    expect(await screen.findByText('bye')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('bye')).toBeNull(), { timeout: 1500 });
  });

  it('is non-interactive: the full-screen overlay sets pointerEvents="none"', async () => {
    await renderWithTheme(<AppToast />);
    await act(async () => {
      showToast('heads up');
    });
    await screen.findByText('heads up');

    // The wrap View is AppToast's rendered root and stretches over the WHOLE screen
    // (top/left/right/bottom 0). Without pointerEvents="none" it would swallow every touch in
    // the app for the toast's lifetime — AppToast is deliberately NOT a Modal for this reason.
    const overlay = screen.root;
    if (!overlay) throw new Error('AppToast rendered nothing while a toast is active');
    expect(overlay.props.pointerEvents).toBe('none');
    expect(StyleSheet.flatten(overlay.props.style)).toMatchObject({
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
    });
  });

  it('promotes the SECOND queued toast after the first auto-dismisses (FIFO)', async () => {
    await renderWithTheme(<AppToast />);
    await act(async () => {
      showToast('first', { durationMs: 40 });
      showToast('second', { durationMs: 2000 });
    });

    // Only one at a time: "second" is parked in the queue while "first" is on screen.
    expect(await screen.findByText('first')).toBeTruthy();
    expect(screen.queryByText('second')).toBeNull();
    expect(useToastStore.getState().queue).toHaveLength(1);

    // The first toast's own timer calls dismiss(), which promotes the queued one — this is the
    // whole point of the queue (a burst of toasts plays back instead of clobbering each other).
    expect(await screen.findByText('second', {}, { timeout: 1500 })).toBeTruthy();
    expect(screen.queryByText('first')).toBeNull();
    expect(useToastStore.getState().queue).toHaveLength(0);
  });

  it('stamps createdAt at enqueue time', async () => {
    const before = Date.now();
    showToast('stamped');
    const current = useToastStore.getState().current;
    expect(current?.createdAt).toBeGreaterThanOrEqual(before);
    expect(current?.createdAt).toBeLessThanOrEqual(Date.now());
  });

  it('drops a stale toast instead of showing it, and drains a whole stale backlog', async () => {
    // Auto-download calls showToast from a killed-app FCM wake, where there is no React host to
    // dismiss anything. If Android later reuses that JS context for a real launch, this is the
    // backlog the host inherits — pills describing downloads that happened hours ago.
    const old = Date.now() - 60_000;
    useToastStore.setState({
      current: { id: 901, message: 'ghost one', durationMs: 2500, createdAt: old },
      queue: [
        { id: 902, message: 'ghost two', durationMs: 2500, createdAt: old },
        { id: 903, message: 'live', durationMs: 2000, createdAt: Date.now() },
      ],
    });

    await renderWithTheme(<AppToast />);

    // Both stale pills are dropped without ever animating in; the fresh one behind them still
    // shows — this is why the fix is per-toast staleness and NOT a mount-time store reset.
    expect(await screen.findByText('live')).toBeTruthy();
    expect(screen.queryByText('ghost one')).toBeNull();
    expect(screen.queryByText('ghost two')).toBeNull();
    expect(useToastStore.getState().queue).toHaveLength(0);
  });

  /**
   * F7 (device-found): the toast was invisible in practice. AppToast is deliberately NOT a Modal
   * (a Modal would swallow touches), so unlike AppDialog it gets NO free native window to sit in —
   * it is an ordinary sibling View. Only the inner pill declared `elevation`, and on Android
   * elevation, not JSX sibling order, decides what draws on top: the toast lost to elevated
   * surfaces above it and never appeared (0 sightings across 3 attempts on device, while dialogs
   * showed 3/3). The HOST must declare its own stacking — elevation for Android, zIndex for Yoga.
   */
  it('the host declares its own stacking so it cannot be drawn under other surfaces', async () => {
    await renderWithTheme(<AppToast />);
    await act(async () => {
      showToast('heads up');
    });
    await screen.findByText('heads up');

    const overlay = screen.root;
    if (!overlay) throw new Error('AppToast rendered nothing while a toast is active');
    const style = StyleSheet.flatten(overlay.props.style) as {
      elevation?: number;
      zIndex?: number;
    };
    expect(style.elevation).toBeGreaterThan(0);
    expect(style.zIndex).toBeGreaterThan(0);
  });
});
