/**
 * IncomingFaceTimeOverlay (src/ui/facetime/IncomingFaceTimeOverlay.tsx): the full-screen in-app
 * ring for an INCOMING FaceTime call. This suite locks in the USER-OBSERVABLE behavior derived
 * from the source:
 *   - visibility gating off the REAL faceTimeStore: nothing renders when there is no `incoming`,
 *     and nothing renders while a call is already active (`call` set) — the WebView overlay owns
 *     the screen then;
 *   - the caller NAME + subtitle copy (video vs audio) from the ringing `incoming`;
 *   - REDACTED mode (useRedactedModeStore) masks the caller to a generic "FaceTime" label and the
 *     real caller name is absent from the tree (glanceable-privacy contract);
 *   - the Answer / Decline affordances fire the useIncomingFaceTime handlers with the right args
 *     (answer ← the whole incoming call, decline ← its uuid).
 *
 * In-file mocks:
 *   - `@features/facetime/useIncomingFaceTime`: the real hook pulls the services/api graph (native
 *     crypto / cert-pinning) at import and would hit the network on Answer. Its logic is covered by
 *     the node tests (test/features/incomingFaceTime.test.ts); here we only assert the overlay wires
 *     the buttons to it, so a jest.fn pair is sufficient.
 *   - `react-native-safe-area-context`: the overlay calls useSafeAreaInsets (needs a provider) —
 *     return zero insets so it resolves without one.
 */
import React from 'react';
import { renderWithTheme, screen, fireEvent } from '../support/renderWithTheme';
import { IncomingFaceTimeOverlay } from '@ui/facetime/IncomingFaceTimeOverlay';
import { useFaceTimeStore, type IncomingFaceTimeCall } from '@state/faceTimeStore';
import { useRedactedModeStore } from '@state/redactedModeStore';

const mockAnswer = jest.fn();
const mockDecline = jest.fn();
jest.mock('@features/facetime/useIncomingFaceTime', () => ({
  useIncomingFaceTime: () => ({ answer: mockAnswer, decline: mockDecline }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const INCOMING: IncomingFaceTimeCall = {
  uuid: 'call-uuid-123',
  callerName: 'Jane Appleseed',
  isAudio: false,
};

beforeEach(() => {
  // setup.ts resets only the theme store; these two are this suite's to control.
  useFaceTimeStore.setState({ call: null, incoming: null });
  useRedactedModeStore.setState({ enabled: false });
});

describe('IncomingFaceTimeOverlay — visibility gating', () => {
  it('renders nothing when no call is ringing', async () => {
    await renderWithTheme(<IncomingFaceTimeOverlay />);
    expect(screen.queryByLabelText('Answer FaceTime call')).toBeNull();
    expect(screen.queryByLabelText('Decline FaceTime call')).toBeNull();
  });

  it('renders nothing while a call is already active (the WebView overlay owns the screen)', async () => {
    useFaceTimeStore.setState({
      incoming: INCOMING,
      call: { link: 'facetime:x', chatGuid: '', video: true },
    });
    await renderWithTheme(<IncomingFaceTimeOverlay />);
    expect(screen.queryByLabelText('Answer FaceTime call')).toBeNull();
    expect(screen.queryByText('Jane Appleseed')).toBeNull();
  });
});

describe('IncomingFaceTimeOverlay — ring content', () => {
  it('shows the caller name and the video subtitle for a video call', async () => {
    useFaceTimeStore.setState({ incoming: INCOMING });
    await renderWithTheme(<IncomingFaceTimeOverlay />);
    expect(screen.getByText('Jane Appleseed')).toBeTruthy();
    expect(screen.getByText('FaceTime Video…')).toBeTruthy();
    expect(screen.queryByText('FaceTime Audio…')).toBeNull();
  });

  it('shows the audio subtitle for an audio-only call', async () => {
    useFaceTimeStore.setState({ incoming: { ...INCOMING, isAudio: true } });
    await renderWithTheme(<IncomingFaceTimeOverlay />);
    expect(screen.getByText('FaceTime Audio…')).toBeTruthy();
  });

  it('masks the caller name to "FaceTime" in redacted mode (real name absent)', async () => {
    useFaceTimeStore.setState({ incoming: INCOMING });
    useRedactedModeStore.setState({ enabled: true });
    await renderWithTheme(<IncomingFaceTimeOverlay />);
    expect(screen.getByText('FaceTime')).toBeTruthy();
    expect(screen.queryByText('Jane Appleseed')).toBeNull();
  });
});

describe('IncomingFaceTimeOverlay — answer / decline', () => {
  it('Decline fires the handler with the call uuid', async () => {
    useFaceTimeStore.setState({ incoming: INCOMING });
    await renderWithTheme(<IncomingFaceTimeOverlay />);
    fireEvent.press(screen.getByLabelText('Decline FaceTime call'));
    expect(mockDecline).toHaveBeenCalledTimes(1);
    expect(mockDecline).toHaveBeenCalledWith('call-uuid-123');
    expect(mockAnswer).not.toHaveBeenCalled();
  });

  it('Answer fires the handler with the whole incoming call', async () => {
    useFaceTimeStore.setState({ incoming: INCOMING });
    await renderWithTheme(<IncomingFaceTimeOverlay />);
    fireEvent.press(screen.getByLabelText('Answer FaceTime call'));
    expect(mockAnswer).toHaveBeenCalledTimes(1);
    expect(mockAnswer).toHaveBeenCalledWith(INCOMING);
    expect(mockDecline).not.toHaveBeenCalled();
  });
});
