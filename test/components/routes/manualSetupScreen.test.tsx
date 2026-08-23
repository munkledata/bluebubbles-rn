/**
 * Manual setup accessibility contract: an explicit insecure HTTP URL reveals a named Switch that
 * can be found and operated through its accessibility role, without relying on adjacent text.
 */
import React from 'react';
import { renderWithTheme, screen, fireEvent, act } from '../support/renderWithTheme';

const mockReplace = jest.fn();

jest.mock('@ui', () => ({
  ...jest.requireActual('@ui/theme'),
  ...jest.requireActual('@ui/primitives'),
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ replace: mockReplace }) }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@/services', () => ({ connect: jest.fn() }));

// eslint-disable-next-line import/first
import ManualSetupScreen from '../../../app/(setup)/manual';
// eslint-disable-next-line import/first
import { useSessionStore } from '@state/sessionStore';

beforeEach(() => {
  jest.clearAllMocks();
  useSessionStore.setState({
    status: 'unauthenticated',
    origin: null,
    password: null,
    serverInfo: null,
    error: null,
  });
});

describe('ManualSetupScreen', () => {
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
    expect(toggle.props.value).toBe(false);

    await act(async () => {
      fireEvent(toggle, 'valueChange', true);
    });

    expect(screen.getByRole('switch', { name: 'Allow insecure connection' }).props.value).toBe(
      true,
    );
  });
});
