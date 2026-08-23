/**
 * PairingQr (src/ui/primitives/PairingQr.tsx) — the reveal gate over the pairing QR.
 * The payload contains the server PASSWORD, so the contracts locked in here are security
 * contracts:
 *   - the QR is HIDDEN by default; only the warning + "Reveal QR Code" button render;
 *   - tapping the button reveals the QR matrix (rendered by the pure-JS QrCode);
 *   - losing screen focus (useFocusEffect cleanup) hides the QR again;
 *   - with no payload (not connected) there is nothing to reveal at all.
 *
 * expo-router's useFocusEffect is mocked to capture the effect callback so the test can
 * drive the focus lifecycle (run effect → run its cleanup = blur) explicitly.
 */
import React from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { renderWithTheme, screen, fireEvent, act } from '../support/renderWithTheme';

interface QrCodeProbeProps {
  value: string;
  size?: number;
  testID?: string;
}

const mockQrCode = jest.fn<void, [QrCodeProbeProps]>();
jest.mock('@ui/primitives/QrCode', () => {
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    QrCode: (props: QrCodeProbeProps) => {
      mockQrCode(props);
      return ReactModule.createElement(RN.View, {
        testID: props.testID,
        accessible: true,
        accessibilityLabel: 'QR code',
      });
    },
  };
});

type FocusEffect = () => (() => void) | void;
let focusEffect: FocusEffect | null = null;
type AppStateHandler = (state: AppStateStatus) => void;
const appStateHandlers: AppStateHandler[] = [];
const mockRemoveAppStateListener = jest.fn();
jest.mock('expo-router', () => ({
  useFocusEffect: (cb: FocusEffect) => {
    focusEffect = cb;
  },
}));

// eslint-disable-next-line import/first
import { PairingQr } from '@ui/primitives/PairingQr';
// eslint-disable-next-line import/first
import { buildSetupQr } from '@features/setup/qr';

const PRIVATE_ORIGIN = 'https://pairing-origin-7f31.gator.example';
const PRIVATE_PASSWORD = 'pairing-password-d12a-4f98';
const PAYLOAD = buildSetupQr(PRIVATE_ORIGIN, PRIVATE_PASSWORD);
const NEXT_PRIVATE_ORIGIN = 'https://pairing-next-origin-83be.gator.example';
const NEXT_PRIVATE_PASSWORD = 'pairing-next-password-7a09-cc42';
const NEXT_PAYLOAD = buildSetupQr(NEXT_PRIVATE_ORIGIN, NEXT_PRIVATE_PASSWORD);

function serializedTree(view: { toJSON(): unknown }): string {
  return JSON.stringify(view.toJSON());
}

function expectCredentialsAbsent(tree: string, origin: string, password: string, payload: string) {
  expect(tree).not.toContain(origin);
  expect(tree).not.toContain(password);
  expect(tree).not.toContain(payload);
}

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
  jest.clearAllMocks();
  focusEffect = null;
  appStateHandlers.length = 0;
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _type: string,
    handler: AppStateHandler,
  ) => {
    appStateHandlers.push(handler);
    return { remove: mockRemoveAppStateListener };
  }) as unknown as typeof AppState.addEventListener);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('PairingQr — reveal gate', () => {
  it('hides the QR by default and shows the warning + reveal button', async () => {
    const view = await renderWithTheme(<PairingQr payload={PAYLOAD} />);
    expect(screen.getByText(/Anyone who scans this code gets full access/)).toBeTruthy();
    expect(screen.getByText('Reveal QR Code')).toBeTruthy();
    expect(screen.queryByTestId('pairing-qr-code')).toBeNull();
    expect(screen.queryByLabelText('QR code')).toBeNull();
    expect(mockQrCode).not.toHaveBeenCalled();
    expectCredentialsAbsent(serializedTree(view), PRIVATE_ORIGIN, PRIVATE_PASSWORD, PAYLOAD);
  });

  it('reveals the QR matrix after an explicit tap', async () => {
    await renderWithTheme(<PairingQr payload={PAYLOAD} />);
    await fireEvent.press(screen.getByText('Reveal QR Code'));
    expect(await screen.findByTestId('pairing-qr-code')).toBeTruthy();
    expect(screen.queryByText('Reveal QR Code')).toBeNull();
    expect(mockQrCode).toHaveBeenLastCalledWith({
      value: PAYLOAD,
      size: 260,
      testID: 'pairing-qr-code',
    });
  });

  it('hides the QR again when the screen loses focus', async () => {
    const view = await renderWithTheme(<PairingQr payload={PAYLOAD} />);
    const oldReveal = retainConfiguredPress(screen.getByRole('button', { name: 'Reveal QR Code' }));
    await invokeConfiguredPress(oldReveal);
    await screen.findByTestId('pairing-qr-code');

    // Simulate focus → blur: run the captured focus effect, then its cleanup.
    await act(async () => {
      const cleanup = focusEffect?.();
      if (typeof cleanup === 'function') cleanup();
    });

    expect(screen.queryByTestId('pairing-qr-code')).toBeNull();
    expect(await screen.findByText('Reveal QR Code')).toBeTruthy();
    expectCredentialsAbsent(serializedTree(view), PRIVATE_ORIGIN, PRIVATE_PASSWORD, PAYLOAD);
    const callsAfterBlur = mockQrCode.mock.calls.length;

    await invokeConfiguredPress(oldReveal);
    expect(screen.queryByTestId('pairing-qr-code')).toBeNull();
    expect(mockQrCode).toHaveBeenCalledTimes(callsAfterBlur);

    const freshReveal = retainConfiguredPress(
      screen.getByRole('button', { name: 'Reveal QR Code' }),
    );
    await invokeConfiguredPress(freshReveal);
    expect(await screen.findByTestId('pairing-qr-code')).toBeTruthy();
    expect(mockQrCode).toHaveBeenLastCalledWith(expect.objectContaining({ value: PAYLOAD }));
  });

  it('revokes a reveal when Android backgrounds the app without a route blur', async () => {
    const view = await renderWithTheme(<PairingQr payload={PAYLOAD} />);
    expect(appStateHandlers).toHaveLength(1);
    const oldReveal = retainConfiguredPress(screen.getByRole('button', { name: 'Reveal QR Code' }));
    await invokeConfiguredPress(oldReveal);
    await screen.findByTestId('pairing-qr-code');

    await act(async () => {
      appStateHandlers[0]?.('background');
    });

    expect(screen.queryByTestId('pairing-qr-code')).toBeNull();
    expect(await screen.findByText('Reveal QR Code')).toBeTruthy();
    expectCredentialsAbsent(serializedTree(view), PRIVATE_ORIGIN, PRIVATE_PASSWORD, PAYLOAD);
    const callsAfterBackground = mockQrCode.mock.calls.length;

    await invokeConfiguredPress(oldReveal);
    expect(screen.queryByTestId('pairing-qr-code')).toBeNull();
    expect(mockQrCode).toHaveBeenCalledTimes(callsAfterBackground);

    const freshReveal = retainConfiguredPress(
      screen.getByRole('button', { name: 'Reveal QR Code' }),
    );
    await invokeConfiguredPress(freshReveal);
    expect(await screen.findByTestId('pairing-qr-code')).toBeTruthy();
    expect(mockQrCode).toHaveBeenLastCalledWith(expect.objectContaining({ value: PAYLOAD }));
  });

  it('shows the connect-first copy (and no reveal button) without a payload', async () => {
    const view = await renderWithTheme(<PairingQr payload={null} />);
    expect(screen.getByText(/Connect to a server first/)).toBeTruthy();
    expect(screen.queryByText('Reveal QR Code')).toBeNull();
    expect(screen.queryByTestId('pairing-qr-code')).toBeNull();
    expect(mockQrCode).not.toHaveBeenCalled();
    expectCredentialsAbsent(serializedTree(view), PRIVATE_ORIGIN, PRIVATE_PASSWORD, PAYLOAD);
  });

  it('removes the Android lifecycle listener on awaited unmount', async () => {
    const view = await renderWithTheme(<PairingQr payload={PAYLOAD} />);
    expect(appStateHandlers).toHaveLength(1);
    expect(mockRemoveAppStateListener).not.toHaveBeenCalled();

    await view.unmount();

    expect(mockRemoveAppStateListener).toHaveBeenCalledTimes(1);
  });

  it('binds a reveal grant and retained Reveal callback to one exact payload revision', async () => {
    const view = await renderWithTheme(<PairingQr payload={PAYLOAD} />);
    const oldReveal = retainConfiguredPress(screen.getByRole('button', { name: 'Reveal QR Code' }));
    await invokeConfiguredPress(oldReveal);
    expect(await screen.findByTestId('pairing-qr-code')).toBeTruthy();
    expect(mockQrCode).toHaveBeenLastCalledWith(expect.objectContaining({ value: PAYLOAD }));
    const callsAfterFirstReveal = mockQrCode.mock.calls.length;

    await view.rerender(<PairingQr payload={NEXT_PAYLOAD} />);
    expect(screen.getByText('Reveal QR Code')).toBeTruthy();
    expect(screen.queryByTestId('pairing-qr-code')).toBeNull();
    expectCredentialsAbsent(
      serializedTree(view),
      NEXT_PRIVATE_ORIGIN,
      NEXT_PRIVATE_PASSWORD,
      NEXT_PAYLOAD,
    );

    await invokeConfiguredPress(oldReveal);
    expect(screen.queryByTestId('pairing-qr-code')).toBeNull();
    expect(mockQrCode).toHaveBeenCalledTimes(callsAfterFirstReveal);

    const freshReveal = retainConfiguredPress(
      screen.getByRole('button', { name: 'Reveal QR Code' }),
    );
    await invokeConfiguredPress(freshReveal);
    expect(await screen.findByTestId('pairing-qr-code')).toBeTruthy();
    expect(mockQrCode).toHaveBeenLastCalledWith({
      value: NEXT_PAYLOAD,
      size: 260,
      testID: 'pairing-qr-code',
    });
  });
});
