/**
 * AppToast (src/ui/toast/AppToast.tsx): the app-wide ephemeral status pill. Locked in:
 *   - renders nothing when the store is empty;
 *   - shows an enqueued toast's message (via showToast);
 *   - auto-dismisses after its duration.
 * Insets are mocked (the pill offsets by insets.bottom). Renders async under RNTL 14 → await.
 */
import React from 'react';
import { act } from '@testing-library/react-native';
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
});
