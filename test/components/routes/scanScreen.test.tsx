import React from 'react';
import { Linking } from 'react-native';
import { act, fireEvent, renderWithTheme, screen } from '../support/renderWithTheme';

const mockReplace = jest.fn();
const mockRequestPermission = jest.fn();
interface MockCameraViewProps {
  readonly onBarcodeScanned?: (event: { readonly data: string }) => void;
}

let mockCameraViewProps: MockCameraViewProps = {};
let mockPermission: { readonly granted: boolean; readonly canAskAgain?: boolean } | null = {
  granted: false,
};
let mockSessionState: { readonly status: string; readonly error: string | null } = {
  status: 'unauthenticated',
  error: null,
};

jest.mock('@ui', () => ({
  ...jest.requireActual('@ui/theme'),
  ...jest.requireActual('@ui/primitives'),
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ replace: mockReplace }) }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('expo-camera', () => ({
  CameraView: (props: MockCameraViewProps) => {
    mockCameraViewProps = props;
    return null;
  },
  useCameraPermissions: () => [mockPermission, mockRequestPermission],
}));
jest.mock('@/services', () => ({
  connect: jest.fn(),
  disconnectFailureMessage: jest.fn(() => 'still blocked'),
  forgetOnThisPhoneOnly: jest.fn(async () => undefined),
  PREVIOUS_CREDENTIAL_UNREVOKED_MESSAGE: 'previous server never confirmed revoking this phone',
  previousUnrevokedServerOrigin: jest.fn(async () => 'https://gone.example'),
}));
jest.mock('@state/sessionStore', () => ({
  useSessionStore: (
    selector: (state: { readonly status: string; readonly error: string | null }) => unknown,
  ) => selector(mockSessionState),
}));

// eslint-disable-next-line import/first
import ScanScreen from '../../../app/(setup)/scan';
// eslint-disable-next-line import/first
import { connect } from '@/services';

const mockConnect = connect as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockCameraViewProps = {};
  mockPermission = { granted: false };
  mockSessionState = { status: 'unauthenticated', error: null };
});

describe('ScanScreen', () => {
  it('renders catalogued permission recovery and preserves both actions', async () => {
    await renderWithTheme(<ScanScreen />);

    expect(screen.getByText('Camera access needed')).toBeTruthy();
    expect(screen.getByText(/scan your server’s setup QR code/)).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Grant Camera Access' }));
    });
    expect(mockRequestPermission).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Enter Manually' }));
    });
    expect(mockReplace).toHaveBeenCalledWith('/manual');
  });

  it('catalogues scanner status while preserving connection errors exactly', async () => {
    mockPermission = { granted: true };
    mockSessionState = { status: 'unauthenticated', error: 'SERVER_CANARY_42' };
    const view = await renderWithTheme(<ScanScreen />);

    expect(screen.getByText('Point your camera at the server QR code')).toBeTruthy();
    expect(screen.getByText('SERVER_CANARY_42')).toBeTruthy();

    mockSessionState = { status: 'connecting', error: 'SERVER_CANARY_42' };
    await act(async () => {
      view.rerender(<ScanScreen />);
    });
    expect(screen.getByText('Connecting…')).toBeTruthy();
    expect(screen.getByText('SERVER_CANARY_42')).toBeTruthy();
  });

  it('explains an http:// setup code instead of connecting, and keeps scanning open', async () => {
    mockPermission = { granted: true };
    await renderWithTheme(<ScanScreen />);
    const scan = mockCameraViewProps.onBarcodeScanned;

    // The camera reports the same code repeatedly while it stays in view.
    for (let index = 0; index < 2; index += 1) {
      await act(async () => {
        scan?.({ data: JSON.stringify(['secret', 'http://gator.local:1234']) });
      });
    }

    expect(mockConnect).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        'This code uses an insecure http:// address. Choose Enter Manually and turn on Allow insecure connection to use it.',
      ),
    ).toBeTruthy();
    await fireEvent.press(screen.getByText('Enter Manually'));
    expect(mockReplace).toHaveBeenCalledWith('/manual');

    // Scanning is not locked: a secure code still connects.
    await act(async () => {
      scan?.({ data: JSON.stringify(['secret', 'https://gator.example']) });
    });
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockConnect).toHaveBeenCalledWith('https://gator.example', 'secret');
  });

  it('maps every parser code to safe copy and remains ready to rescan', async () => {
    mockPermission = { granted: true };
    await renderWithTheme(<ScanScreen />);

    const scan = mockCameraViewProps.onBarcodeScanned;
    expect(scan).toBeDefined();
    const malformedCases = [
      ['', 'No data was scanned. Please try again.'],
      ['not-json', 'That code is not a valid Gator setup QR code.'],
      [JSON.stringify(['only-password']), 'That Gator QR code has an invalid format.'],
      [
        JSON.stringify(['', 'https://gator.example']),
        'This QR code is missing the server address or password.',
      ],
    ] as const;

    for (const [data, message] of malformedCases) {
      await act(async () => {
        scan?.({ data });
      });
      expect(screen.getByText(message)).toBeTruthy();
    }
    expect(mockConnect).not.toHaveBeenCalled();
  });
  it('offers Open Settings once Android stops asking for the camera', async () => {
    mockPermission = { granted: false, canAskAgain: false };
    const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    await renderWithTheme(<ScanScreen />);

    expect(
      screen.getByText(/Turn it on in Settings, or enter your server details manually/),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Grant Camera Access' })).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Open Settings' }));
    });
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(mockRequestPermission).not.toHaveBeenCalled();
    // Manual entry stays available.
    expect(screen.getByRole('button', { name: 'Enter Manually' })).toBeTruthy();
    openSettings.mockRestore();
  });

  it('waits for Scan Again after a failed connection instead of retrying the code in view', async () => {
    mockPermission = { granted: true };
    const view = await renderWithTheme(<ScanScreen />);
    const code = { data: JSON.stringify(['secret', 'https://gator.example']) };
    await act(async () => {
      mockCameraViewProps.onBarcodeScanned?.(code);
    });
    expect(mockConnect).toHaveBeenCalledTimes(1);

    mockSessionState = { status: 'error', error: 'SERVER_CANARY_42' };
    await act(async () => {
      view.rerender(<ScanScreen />);
    });
    // The camera keeps reporting the same code while it stays in view: no silent retry.
    for (let index = 0; index < 3; index += 1) {
      await act(async () => {
        mockCameraViewProps.onBarcodeScanned?.(code);
      });
    }
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(screen.getByText('SERVER_CANARY_42')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Scan Again' }));
    });
    await act(async () => {
      mockCameraViewProps.onBarcodeScanned?.(code);
    });
    expect(mockConnect).toHaveBeenCalledTimes(2);
  });
});
