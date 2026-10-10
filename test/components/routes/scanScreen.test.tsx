import React from 'react';
import { act, fireEvent, renderWithTheme, screen } from '../support/renderWithTheme';

const mockReplace = jest.fn();
const mockRequestPermission = jest.fn();
interface MockCameraViewProps {
  readonly onBarcodeScanned?: (event: { readonly data: string }) => void;
}

let mockCameraViewProps: MockCameraViewProps = {};
let mockPermission: { readonly granted: boolean } | null = { granted: false };
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
        'The QR code does not contain a valid server URL and password or paired-client credential.',
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
});
