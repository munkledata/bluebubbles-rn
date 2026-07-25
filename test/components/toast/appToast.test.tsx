/**
 * AppToast (src/ui/toast/AppToast.tsx): the app-wide ephemeral status pill. Locked in:
 *   - renders nothing when the store is empty;
 *   - shows an enqueued toast's message (via showToast);
 *   - auto-dismisses after its duration;
 *   - the overlay NEVER captures touches (pointerEvents="none" over the whole screen) — the one
 *     property that separates this from AppDialog's Modal, and the reason it can float over chat;
 *   - the FIFO queue actually PLAYS BACK: a second toast enqueued behind the first is promoted by
 *     the auto-dismiss instead of being dropped.
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
});
