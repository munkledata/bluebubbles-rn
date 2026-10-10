/**
 * Manual setup accessibility contract: an explicit insecure HTTP URL reveals a named Switch that
 * can be found and operated through its accessibility role, without relying on adjacent text.
 */
import React from 'react';
import { renderWithTheme, screen, fireEvent, act } from '../support/renderWithTheme';

const mockReplace = jest.fn();
let mockKbVisible = false;
let mockKavProps: Record<string, unknown> = {};

jest.mock('@ui', () => ({
  ...jest.requireActual('@ui/theme'),
  ...jest.requireActual('@ui/primitives'),
}));
jest.mock('@ui/hooks/useKeyboardVisible', () => ({
  useKeyboardVisible: () => mockKbVisible,
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ replace: mockReplace }) }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@/services', () => ({
  connect: jest.fn(),
  disconnectFailureMessage: jest.fn(() => 'still blocked'),
  forgetOnThisPhoneOnly: jest.fn(async () => undefined),
  PREVIOUS_CREDENTIAL_UNREVOKED_MESSAGE: 'previous server never confirmed revoking this phone',
  previousUnrevokedServerOrigin: jest.fn(async () => 'https://gone.example'),
}));
// RNTL exposes only the host tree, so capture the composite KeyboardAvoidingView props through a
// small stand-in. Its native movement remains device-only evidence.
jest.mock('react-native/Libraries/Components/Keyboard/KeyboardAvoidingView', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react');
  return {
    __esModule: true,
    default: (props: Record<string, unknown>) => {
      mockKavProps = props;
      return R.createElement(R.Fragment, null, props.children as React.ReactNode);
    },
  };
});

// eslint-disable-next-line import/first
import ManualSetupScreen from '../../../app/(setup)/manual';
// eslint-disable-next-line import/first
import { useSessionStore } from '@state/sessionStore';

beforeEach(() => {
  jest.clearAllMocks();
  mockKbVisible = false;
  mockKavProps = {};
  useSessionStore.setState({
    status: 'unauthenticated',
    origin: null,
    password: null,
    serverInfo: null,
    error: null,
  });
});

describe('ManualSetupScreen', () => {
  it('offers "Forget on this phone only" only for an unconfirmed previous-credential revocation', async () => {
    useSessionStore.setState({ status: 'error', error: 'some other connection error' });
    await renderWithTheme(<ManualSetupScreen />);
    expect(screen.queryByRole('button', { name: 'Forget on this phone only' })).toBeNull();

    await act(async () => {
      useSessionStore.setState({
        status: 'error',
        error: 'previous server never confirmed revoking this phone',
      });
    });
    expect(screen.getByRole('button', { name: 'Forget on this phone only' })).toBeTruthy();
  });

  it('states the system-CA-only HTTPS policy', async () => {
    await renderWithTheme(<ManualSetupScreen />);

    expect(screen.getByText(/certificate from Android’s built-in system authorities/)).toBeTruthy();
    expect(
      screen.getByText(/authorities added in Android Settings are not supported/),
    ).toBeTruthy();
  });

  it('uses padding only while the keyboard is visible without an offset counterweight', async () => {
    const view = await renderWithTheme(<ManualSetupScreen />);

    expect(mockKavProps.behavior).toBe('padding');
    expect(mockKavProps.enabled).toBe(false);
    expect(mockKavProps.keyboardVerticalOffset ?? 0).toBe(0);

    mockKbVisible = true;
    await act(async () => {
      view.rerender(<ManualSetupScreen />);
    });

    expect(mockKavProps.behavior).toBe('padding');
    expect(mockKavProps.enabled).toBe(true);
    expect(mockKavProps.keyboardVerticalOffset ?? 0).toBe(0);
  });

  it('names and operates the insecure-HTTP switch by accessibility role', async () => {
    await renderWithTheme(<ManualSetupScreen />);

    await act(async () => {
      fireEvent.changeText(
        screen.getByPlaceholderText('https://your-server.ngrok.io'),
        'http://gator.test',
      );
    });

    const toggle = screen.getByRole('switch', { name: 'Allow insecure connection' });
    expect(toggle).toHaveAccessibleName('Allow insecure connection');
    expect(toggle.props.accessibilityLabel).toBe('Allow insecure connection');
    expect(toggle.props.value).toBe(false);

    await act(async () => {
      fireEvent(toggle, 'valueChange', true);
    });

    expect(screen.getByRole('switch', { name: 'Allow insecure connection' }).props.value).toBe(
      true,
    );
  });
});
