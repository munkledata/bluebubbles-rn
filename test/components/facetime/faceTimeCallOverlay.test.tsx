/**
 * FaceTimeCallOverlay (src/ui/facetime/FaceTimeCallOverlay.tsx): the full-screen in-app overlay
 * for an ACTIVE FaceTime call. This suite locks in the USER-OBSERVABLE behavior derived from the
 * source:
 *   - visibility off the REAL faceTimeStore: nothing renders without an active `call`;
 *   - when a call is active it shows the "FaceTime" title bar + an "End FaceTime call" affordance
 *     (always present);
 *   - pressing End calls the store's `close`, clearing the call so the overlay disappears;
 *   - the release-safe external-browser action opens the call's validated link via safeOpenUrl;
 *   - no embedded WebView path is mounted while FACE-01 is open.
 *
 * In-file mock: `react-native-safe-area-context` — the overlay calls useSafeAreaInsets; zero insets.
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { renderWithTheme, screen, fireEvent, waitFor, act } from '../support/renderWithTheme';

const mockWarn = jest.fn();

jest.mock('@utils', () => ({ ...jest.requireActual('@utils'), safeOpenUrl: jest.fn() }));
jest.mock('@core/secure', () => ({ logger: { warn: (...args: unknown[]) => mockWarn(...args) } }));

// eslint-disable-next-line import/first
import { FaceTimeCallOverlay } from '@ui/facetime/FaceTimeCallOverlay';
// eslint-disable-next-line import/first
import { useFaceTimeStore } from '@state/faceTimeStore';
// eslint-disable-next-line import/first
import { safeOpenUrl } from '@utils';
// eslint-disable-next-line import/first
import { useToastStore } from '@ui/toast/toastStore';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const CALL = {
  link: 'https://facetime.apple.com/join#abc',
  chatGuid: 'iMessage;-;+1',
  video: true,
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  useFaceTimeStore.setState({ generation: 0, call: null, incoming: null });
  (safeOpenUrl as jest.Mock).mockReset().mockResolvedValue(true);
  mockWarn.mockClear();
  useToastStore.setState({ current: null, queue: [] });
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

  it('owns a higher Android layer than the global connection banner', async () => {
    useFaceTimeStore.setState({ call: CALL });
    await renderWithTheme(<FaceTimeCallOverlay />);

    const root = screen.root;
    if (!root) throw new Error('FaceTimeCallOverlay rendered nothing for an active call');
    expect(StyleSheet.flatten(root.props.style)).toMatchObject({
      elevation: 16,
      zIndex: 100,
    });
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

describe('FaceTimeCallOverlay — external browser handoff', () => {
  it('offers "Open in browser" and opens the validated call link through the safe opener', async () => {
    useFaceTimeStore.setState({ call: CALL });
    await renderWithTheme(<FaceTimeCallOverlay />);
    const openBtn = await screen.findByLabelText('Open FaceTime call in browser');
    expect(screen.getByText('Open this FaceTime call in your browser to continue.')).toBeTruthy();
    await fireEvent.press(openBtn);
    await waitFor(() => expect(safeOpenUrl).toHaveBeenCalledWith(CALL.link));
    expect(useToastStore.getState().current).toBeNull();
  });

  it('shows one generic toast when the current call cannot be opened', async () => {
    (safeOpenUrl as jest.Mock).mockResolvedValue(false);
    useFaceTimeStore.setState({ call: CALL });
    await renderWithTheme(<FaceTimeCallOverlay />);

    await fireEvent.press(screen.getByLabelText('Open FaceTime call in browser'));
    await waitFor(() =>
      expect(useToastStore.getState().current?.message).toBe('Couldn’t open this outside Gator.'),
    );
    expect(useToastStore.getState().queue).toHaveLength(0);
  });

  it('drops a delayed failure after the call switches away and back to the same object', async () => {
    const open = deferred<boolean>();
    (safeOpenUrl as jest.Mock).mockReturnValue(open.promise);
    useFaceTimeStore.setState({ call: CALL });
    await renderWithTheme(<FaceTimeCallOverlay />);
    await fireEvent.press(screen.getByLabelText('Open FaceTime call in browser'));
    await waitFor(() => expect(safeOpenUrl).toHaveBeenCalledTimes(1));

    await act(async () => {
      useFaceTimeStore.setState({
        call: { ...CALL, chatGuid: 'iMessage;-;replacement-call' },
      });
      await Promise.resolve();
    });
    await act(async () => {
      useFaceTimeStore.setState({ call: CALL });
      await Promise.resolve();
    });
    expect(useFaceTimeStore.getState().call).toBe(CALL);

    await act(async () => {
      open.resolve(false);
      await open.promise;
    });

    expect(useToastStore.getState().current).toBeNull();
  });

  it('rejects an invalid retained link with generic feedback and no native handoff', async () => {
    useFaceTimeStore.setState({ call: { ...CALL, link: 'intent://private.invalid' } });
    await renderWithTheme(<FaceTimeCallOverlay />);

    await fireEvent.press(screen.getByLabelText('Open FaceTime call in browser'));
    expect(safeOpenUrl).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith('[facetime] refused non-FaceTime browser handoff');
    expect(useToastStore.getState().current?.message).toBe('Couldn’t open this outside Gator.');
  });
});
