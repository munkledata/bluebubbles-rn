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
});
