import React from 'react';
import { act, fireEvent, renderWithTheme, screen, waitFor } from '../support/renderWithTheme';

const mockPush = jest.fn();
const mockReplace = jest.fn();

jest.mock('@ui', () => ({
  ...jest.requireActual('@ui/theme'),
  ...jest.requireActual('@ui/primitives'),
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@features/conversations/devFixtureSession', () => ({
  startDevFixtureSession: jest.fn(),
}));
jest.mock('@ui/dialog/dialogStore', () => ({ showDialog: jest.fn() }));
const mockRevocationPending = jest.fn<Promise<boolean>, []>();
const mockForgetOnThisPhoneOnly = jest.fn<Promise<void>, []>();
jest.mock('@/services', () => ({
  PREVIOUS_CREDENTIAL_UNREVOKED_MESSAGE: 'Previous server has not removed this phone yet.',
  previousServerRevocationPending: () => mockRevocationPending(),
  previousUnrevokedServerOrigin: jest.fn(async () => 'https://gone.example'),
  forgetOnThisPhoneOnly: () => mockForgetOnThisPhoneOnly(),
  disconnectFailureMessage: jest.fn(() => 'Could not finish.'),
}));

// eslint-disable-next-line import/first
import WelcomeScreen from '../../../app/(setup)/welcome';
// eslint-disable-next-line import/first
import { startDevFixtureSession } from '@features/conversations/devFixtureSession';
// eslint-disable-next-line import/first
import { showDialog } from '@ui/dialog/dialogStore';
// eslint-disable-next-line import/first
import { createI18n } from '@utils/i18n';

const mockStartDevFixtureSession = startDevFixtureSession as jest.Mock;
const mockShowDialog = showDialog as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockStartDevFixtureSession.mockResolvedValue(undefined);
  mockRevocationPending.mockResolvedValue(false);
  mockForgetOnThisPhoneOnly.mockResolvedValue(undefined);
});

describe('WelcomeScreen', () => {
  it('renders the catalog copy and preserves the primary setup route', async () => {
    const pseudo = createI18n('en-XA');
    await renderWithTheme(<WelcomeScreen />);

    expect(screen.getByText('Gator')).toBeTruthy();
    expect(screen.getByText('Your Mac’s messages, on Android.')).toBeTruthy();
    expect(pseudo.text('welcome.brand')).toBe('Gator');
    expect(pseudo.text('welcome.dev.dialog.messageSuffix')).not.toBe(
      ' could not prepare the local fixture session.',
    );

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Get Started' }));
    });
    expect(mockPush).toHaveBeenCalledWith('/connect');
  });

  it('shows catalogued developer recovery copy without navigating after a fixture failure', async () => {
    mockStartDevFixtureSession.mockRejectedValue(new Error('fixture failed'));
    await renderWithTheme(<WelcomeScreen />);

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Dev: seed & open inbox' }));
    });

    await waitFor(() =>
      expect(mockShowDialog).toHaveBeenCalledWith(
        'Developer fixtures',
        'Gator could not prepare the local fixture session.',
      ),
    );
    expect(mockReplace).not.toHaveBeenCalled();
  });

  // An unreachable previous server used to surface only after the user scanned a new code.
  it('offers Forget on this phone only up front while a previous server revocation is pending', async () => {
    mockRevocationPending.mockResolvedValue(true);
    await renderWithTheme(<WelcomeScreen />);

    await waitFor(() =>
      expect(screen.getByText('Previous server has not removed this phone yet.')).toBeTruthy(),
    );
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Forget on this phone only' }));
    });
    expect(mockShowDialog).toHaveBeenCalledWith(
      'Forget on this phone only?',
      expect.stringContaining('https://gone.example'),
      expect.any(Array),
    );

    const actions = mockShowDialog.mock.calls[0]![2] as { text: string; onPress?: () => void }[];
    await act(async () => {
      actions.find((action) => action.text === 'Forget on this phone')!.onPress!();
    });
    expect(mockForgetOnThisPhoneOnly).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.queryByText('Previous server has not removed this phone yet.')).toBeNull(),
    );
  });

  it('shows no previous-server notice when nothing is pending', async () => {
    await renderWithTheme(<WelcomeScreen />);
    await act(async () => undefined);

    expect(mockRevocationPending).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Previous server has not removed this phone yet.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Forget on this phone only' })).toBeNull();
  });
});
