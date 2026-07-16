/**
 * FaceTimeCallOverlay (src/ui/facetime/FaceTimeCallOverlay.tsx): the full-screen in-app overlay
 * for an ACTIVE FaceTime call. This suite locks in the USER-OBSERVABLE behavior derived from the
 * source:
 *   - visibility off the REAL faceTimeStore: nothing renders without an active `call`;
 *   - when a call is active it shows the "FaceTime" title bar + an "End FaceTime call" affordance
 *     (both siblings of the WebView, always present);
 *   - pressing End calls the store's `close`, clearing the call so the overlay disappears;
 *   - the LoadErrorBoundary fallback renders an "Open in browser" action that opens the call's
 *     validated link via Linking.
 *
 * jest limitation (documented, not worked around): the overlay hosts the WebView via
 * `React.lazy(() => import('./FaceTimeWebView'))`. A real dynamic `import()` REJECTS inside the jest
 * VM ("A dynamic import callback was invoked without --experimental-vm-modules"), which the
 * LoadErrorBoundary catches — so the overlay always shows the browser fallback here. That's exactly
 * the fallback contract we assert; the WebView SUCCESS/props path is covered directly in
 * faceTimeWebView.test.tsx. The `<FaceTimeWebView uri={call.link} />` element is still constructed
 * (so its line runs) before the lazy load fails.
 *
 * In-file mock: `react-native-safe-area-context` — the overlay calls useSafeAreaInsets; zero insets.
 */
import React from 'react';
import { Linking } from 'react-native';
import { renderWithTheme, screen, fireEvent, waitFor, act } from '../support/renderWithTheme';
import { FaceTimeCallOverlay } from '@ui/facetime/FaceTimeCallOverlay';
import { useFaceTimeStore } from '@state/faceTimeStore';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const CALL = {
  link: 'https://facetime.apple.com/join#abc',
  chatGuid: 'iMessage;-;+1',
  video: true,
};

beforeEach(() => {
  useFaceTimeStore.setState({ call: null, incoming: null });
});

describe('FaceTimeCallOverlay — visibility', () => {
  it('renders nothing when no call is active', async () => {
    await renderWithTheme(<FaceTimeCallOverlay />);
    expect(screen.queryByLabelText('End FaceTime call')).toBeNull();
    expect(screen.queryByText('FaceTime')).toBeNull();
  });
});

describe('FaceTimeCallOverlay — active call chrome', () => {
  it('shows the FaceTime title bar and the End affordance', async () => {
    useFaceTimeStore.setState({ call: CALL });
    await renderWithTheme(<FaceTimeCallOverlay />);
    expect(screen.getByText('FaceTime')).toBeTruthy();
    expect(screen.getByLabelText('End FaceTime call')).toBeTruthy();
  });

  it('End calls the store close, clearing the active call and hiding the overlay', async () => {
    useFaceTimeStore.setState({ call: CALL });
    await renderWithTheme(<FaceTimeCallOverlay />);
    await act(async () => {
      fireEvent.press(screen.getByLabelText('End FaceTime call'));
    });
    expect(useFaceTimeStore.getState().call).toBeNull();
    await waitFor(() => expect(screen.queryByLabelText('End FaceTime call')).toBeNull());
  });
});

describe('FaceTimeCallOverlay — WebView-unavailable fallback', () => {
  it('offers "Open in browser" and opens the validated call link via Linking', async () => {
    const openSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);
    useFaceTimeStore.setState({ call: CALL });
    await renderWithTheme(<FaceTimeCallOverlay />);
    const openBtn = await screen.findByLabelText('Open FaceTime call in browser');
    expect(screen.getByText('Open this FaceTime call in your browser to continue.')).toBeTruthy();
    fireEvent.press(openBtn);
    expect(openSpy).toHaveBeenCalledWith(CALL.link);
    openSpy.mockRestore();
  });
});
