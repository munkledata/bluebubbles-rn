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
import { renderWithTheme, screen, fireEvent, act } from '../support/renderWithTheme';

type FocusEffect = () => (() => void) | void;
let focusEffect: FocusEffect | null = null;
jest.mock('expo-router', () => ({
  useFocusEffect: (cb: FocusEffect) => {
    focusEffect = cb;
  },
}));

// eslint-disable-next-line import/first
import { PairingQr } from '@ui/primitives/PairingQr';
// eslint-disable-next-line import/first
import { buildSetupQr } from '@features/setup/qr';

const PAYLOAD = buildSetupQr('https://gator.example', 'secret-pw');

beforeEach(() => {
  focusEffect = null;
});

describe('PairingQr — reveal gate', () => {
  it('hides the QR by default and shows the warning + reveal button', async () => {
    await renderWithTheme(<PairingQr payload={PAYLOAD} />);
    expect(screen.getByText(/Anyone who scans this code gets full access/)).toBeTruthy();
    expect(screen.getByText('Reveal QR Code')).toBeTruthy();
    expect(screen.queryByTestId('pairing-qr-code')).toBeNull();
  });

  it('reveals the QR matrix after an explicit tap', async () => {
    await renderWithTheme(<PairingQr payload={PAYLOAD} />);
    fireEvent.press(screen.getByText('Reveal QR Code'));
    expect(await screen.findByTestId('pairing-qr-code')).toBeTruthy();
    expect(screen.queryByText('Reveal QR Code')).toBeNull();
  });

  it('hides the QR again when the screen loses focus', async () => {
    await renderWithTheme(<PairingQr payload={PAYLOAD} />);
    fireEvent.press(screen.getByText('Reveal QR Code'));
    await screen.findByTestId('pairing-qr-code');

    // Simulate focus → blur: run the captured focus effect, then its cleanup.
    await act(async () => {
      const cleanup = focusEffect?.();
      if (typeof cleanup === 'function') cleanup();
    });

    expect(screen.queryByTestId('pairing-qr-code')).toBeNull();
    expect(await screen.findByText('Reveal QR Code')).toBeTruthy();
  });

  it('shows the connect-first copy (and no reveal button) without a payload', async () => {
    await renderWithTheme(<PairingQr payload={null} />);
    expect(screen.getByText(/Connect to a server first/)).toBeTruthy();
    expect(screen.queryByText('Reveal QR Code')).toBeNull();
  });
});
