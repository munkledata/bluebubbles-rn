/**
 * IncomingFaceTimeOverlay (src/ui/facetime/IncomingFaceTimeOverlay.tsx): the full-screen in-app
 * ring for an INCOMING FaceTime call. This suite locks in the USER-OBSERVABLE behavior derived
 * from the source:
 *   - visibility gating off the REAL faceTimeStore: nothing renders when there is no `incoming`,
 *     and nothing renders while a call is already active (`call` set) — the active-call handoff
 *     overlay owns the screen then;
 *   - the caller NAME + subtitle copy (video vs audio) from the ringing `incoming`;
 *   - the Answer / Decline affordances fire the useIncomingFaceTime handlers with the right args
 *     (answer ← the whole incoming call, decline ← its uuid).
 *
 * In-file mocks:
 *   - `@features/facetime/useIncomingFaceTime`: the real hook pulls the service/API composition graph
 *     and would hit the network on Answer. Its logic is covered by
 *     the node tests (test/features/incomingFaceTime.test.ts); here we only assert the overlay wires
 *     the buttons to it, so a jest.fn pair is sufficient.
 *   - `react-native-safe-area-context`: the overlay calls useSafeAreaInsets (needs a provider) —
 *     return zero insets so it resolves without one.
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { act, fireEvent, renderWithTheme, screen } from '../support/renderWithTheme';
import { IncomingFaceTimeOverlay } from '@ui/facetime/IncomingFaceTimeOverlay';
import { useFaceTimeStore, type IncomingFaceTimeCall } from '@state/faceTimeStore';

const mockAnswer = jest.fn();
const mockDecline = jest.fn();
jest.mock('@features/facetime/useIncomingFaceTime', () => ({
  useIncomingFaceTime: () => ({ answer: mockAnswer, decline: mockDecline }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const PRIVATE_CALLER = 'incoming-facetime-private-caller-7c91@example.test';
const INCOMING: IncomingFaceTimeCall = {
  uuid: 'call-uuid-123',
  callerName: PRIVATE_CALLER,
  isAudio: false,
};
const REPLACEMENT: IncomingFaceTimeCall = {
  uuid: 'call-uuid-replacement-8d42',
  callerName: 'incoming-facetime-replacement-caller-4ea2@example.test',
  isAudio: true,
};
const SAME_UUID_UPDATE: IncomingFaceTimeCall = {
  ...INCOMING,
  callerName: 'incoming-facetime-updated-caller-a49e@example.test',
  isAudio: true,
  avatarUri: 'file:///incoming-facetime-updated-avatar-b821.jpg',
};
const POST_RESET_SAME_UUID: IncomingFaceTimeCall = {
  ...INCOMING,
  callerName: 'incoming-facetime-post-reset-caller-f30d@example.test',
  isAudio: true,
  avatarUri: 'file:///incoming-facetime-post-reset-avatar-2bd8.jpg',
};

function retainConfiguredPress(node: { props: Record<string, unknown> }): () => void {
  const responder = node.props.onStartShouldSetResponder;
  if (typeof responder !== 'function') {
    throw new Error('Expected an accessible Pressable responder callback');
  }
  const readConfig = (
    responder as typeof responder & {
      testOnly_pressabilityConfig?: () => { onPress?: (event: object) => void };
    }
  ).testOnly_pressabilityConfig;
  if (typeof readConfig !== 'function') {
    throw new Error('Expected React Native test-only Pressability configuration');
  }
  const onPress = readConfig().onPress;
  if (typeof onPress !== 'function') throw new Error('Expected configured Pressable onPress');
  return () => onPress({ nativeEvent: {} });
}

async function invokeConfiguredPress(press: () => void): Promise<void> {
  await act(async () => {
    press();
    await Promise.resolve();
  });
}

beforeEach(() => {
  // setup.ts resets only the theme store; these two are this suite's to control.
  jest.clearAllMocks();
  useFaceTimeStore.setState({ generation: 0, call: null, incoming: null });
});

describe('IncomingFaceTimeOverlay — visibility gating', () => {
  it('renders nothing when no call is ringing', async () => {
    await renderWithTheme(<IncomingFaceTimeOverlay />);
    expect(screen.queryByLabelText('Answer FaceTime call')).toBeNull();
    expect(screen.queryByLabelText('Decline FaceTime call')).toBeNull();
  });

  it('renders nothing while the active-call handoff overlay owns the screen', async () => {
    useFaceTimeStore.setState({
      incoming: INCOMING,
      call: { link: 'facetime:x', chatGuid: '', video: true },
    });
    await renderWithTheme(<IncomingFaceTimeOverlay />);
    expect(screen.queryByLabelText('Answer FaceTime call')).toBeNull();
    expect(screen.queryByText(PRIVATE_CALLER)).toBeNull();
  });
});

describe('IncomingFaceTimeOverlay — ring content', () => {
  it('owns a higher Android layer than the global connection banner', async () => {
    useFaceTimeStore.setState({ incoming: INCOMING });
    await renderWithTheme(<IncomingFaceTimeOverlay />);

    const root = screen.root;
    if (!root) throw new Error('IncomingFaceTimeOverlay rendered nothing for a ringing call');
    expect(StyleSheet.flatten(root.props.style)).toMatchObject({
      elevation: 16,
      zIndex: 110,
    });
  });

  it('shows the caller name and the video subtitle for a video call', async () => {
    useFaceTimeStore.setState({ incoming: INCOMING });
    const view = await renderWithTheme(<IncomingFaceTimeOverlay />);
    expect(screen.getByText(PRIVATE_CALLER)).toBeTruthy();
    expect(JSON.stringify(view.toJSON())).toContain(PRIVATE_CALLER);
    expect(screen.getByText('FaceTime Video…')).toBeTruthy();
    expect(screen.queryByText('FaceTime Audio…')).toBeNull();
  });

  it('shows the audio subtitle for an audio-only call', async () => {
    useFaceTimeStore.setState({ incoming: { ...INCOMING, isAudio: true } });
    await renderWithTheme(<IncomingFaceTimeOverlay />);
    expect(screen.getByText('FaceTime Audio…')).toBeTruthy();
  });
});

describe('IncomingFaceTimeOverlay — answer / decline', () => {
  it('Decline fires the handler with the call uuid', async () => {
    useFaceTimeStore.setState({ incoming: INCOMING });
    await renderWithTheme(<IncomingFaceTimeOverlay />);
    await fireEvent.press(screen.getByLabelText('Decline FaceTime call'));
    expect(mockDecline).toHaveBeenCalledTimes(1);
    expect(mockDecline).toHaveBeenCalledWith('call-uuid-123');
    expect(mockAnswer).not.toHaveBeenCalled();
  });

  it('Answer fires the handler with the whole incoming call', async () => {
    useFaceTimeStore.setState({ incoming: INCOMING });
    await renderWithTheme(<IncomingFaceTimeOverlay />);
    await fireEvent.press(screen.getByLabelText('Answer FaceTime call'));
    expect(mockAnswer).toHaveBeenCalledTimes(1);
    expect(mockAnswer).toHaveBeenCalledWith(INCOMING);
    expect(mockDecline).not.toHaveBeenCalled();
  });

  it('blocks retained callbacks after an active call takes over', async () => {
    useFaceTimeStore.setState({ incoming: INCOMING });
    await renderWithTheme(<IncomingFaceTimeOverlay />);
    const oldDecline = retainConfiguredPress(
      screen.getByRole('button', { name: 'Decline FaceTime call' }),
    );
    const oldAnswer = retainConfiguredPress(
      screen.getByRole('button', { name: 'Answer FaceTime call' }),
    );

    await act(async () => {
      useFaceTimeStore.setState({
        call: { link: 'facetime:active-takeover', chatGuid: '', video: true },
      });
    });
    await invokeConfiguredPress(oldDecline);
    await invokeConfiguredPress(oldAnswer);

    expect(mockDecline).not.toHaveBeenCalled();
    expect(mockAnswer).not.toHaveBeenCalled();
  });

  it('uses the live call object when a retained Answer sees the same UUID updated in place', async () => {
    useFaceTimeStore.setState({ incoming: INCOMING });
    await renderWithTheme(<IncomingFaceTimeOverlay />);
    const retainedDecline = retainConfiguredPress(
      screen.getByRole('button', { name: 'Decline FaceTime call' }),
    );
    const retainedAnswer = retainConfiguredPress(
      screen.getByRole('button', { name: 'Answer FaceTime call' }),
    );

    await act(async () => {
      useFaceTimeStore.getState().ring(SAME_UUID_UPDATE);
    });
    await invokeConfiguredPress(retainedDecline);
    await invokeConfiguredPress(retainedAnswer);

    expect(mockDecline).toHaveBeenCalledWith(SAME_UUID_UPDATE.uuid);
    expect(mockAnswer).toHaveBeenCalledWith(SAME_UUID_UPDATE);
  });

  it.each([
    {
      label: 'a different-UUID replacement ring',
      resetFirst: false,
      currentIncoming: REPLACEMENT,
    },
    {
      label: 'an account reset followed by a same-UUID replacement ring',
      resetFirst: true,
      currentIncoming: POST_RESET_SAME_UUID,
    },
  ])(
    'blocks retained callbacks after $label while fresh-current controls remain usable',
    async ({ resetFirst, currentIncoming }) => {
      useFaceTimeStore.setState({ incoming: INCOMING });
      await renderWithTheme(<IncomingFaceTimeOverlay />);
      const oldDecline = retainConfiguredPress(
        screen.getByRole('button', { name: 'Decline FaceTime call' }),
      );
      const oldAnswer = retainConfiguredPress(
        screen.getByRole('button', { name: 'Answer FaceTime call' }),
      );

      await act(async () => {
        if (resetFirst) useFaceTimeStore.getState().reset();
        useFaceTimeStore.getState().ring(currentIncoming);
      });

      await invokeConfiguredPress(oldDecline);
      await invokeConfiguredPress(oldAnswer);
      expect(mockDecline).not.toHaveBeenCalled();
      expect(mockAnswer).not.toHaveBeenCalled();

      const currentDecline = retainConfiguredPress(
        screen.getByRole('button', { name: 'Decline FaceTime call' }),
      );
      const currentAnswer = retainConfiguredPress(
        screen.getByRole('button', { name: 'Answer FaceTime call' }),
      );
      await invokeConfiguredPress(currentDecline);
      await invokeConfiguredPress(currentAnswer);

      expect(mockDecline).toHaveBeenCalledWith(currentIncoming.uuid);
      expect(mockAnswer).toHaveBeenCalledWith(currentIncoming);
    },
  );
});
