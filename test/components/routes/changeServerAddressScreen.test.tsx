import React from 'react';
import { act, fireEvent, renderWithTheme, screen } from '../support/renderWithTheme';

const mockBack = jest.fn();
const mockRequestServerAddressChange = jest.fn();
// The full `@ui` barrel drags in the conversation/attachment tree (native/ESM modules jest-expo
// can't load). The screen only needs the theme and primitives.
jest.mock('@ui', () => ({
  ...jest.requireActual('@ui/theme'),
  ...jest.requireActual('@ui/primitives'),
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn(), back: mockBack }) }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@/services', () => ({
  requestServerAddressChange: (address: string) => mockRequestServerAddressChange(address),
}));
// The session store's import graph reaches the `@core/api` barrel, whose HttpClient pulls in `ky`
// (ESM-only, not transformed under jest-expo). Never called here.
jest.mock('ky', () => ({ __esModule: true, default: jest.fn() }));

// Jest mocks must be registered before the route imports its service boundary.
/* eslint-disable import/first */
import ChangeServerAddressScreen from '../../../app/(app)/change-server-address';
import { useSessionStore } from '@state/sessionStore';
/* eslint-enable import/first */

// Review item 800: the non-destructive way to follow a server that moved.
describe('ChangeServerAddressScreen', () => {
  const previous = useSessionStore.getState();

  beforeEach(() => {
    jest.clearAllMocks();
    useSessionStore.setState({ origin: 'https://old.example' });
  });

  afterEach(() => {
    useSessionStore.setState(previous);
  });

  async function submit(address: string): Promise<void> {
    await fireEvent.changeText(screen.getByPlaceholderText('https://example.com'), address);
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    });
  }

  it('shows the current address and hands an offered change to the approval prompt', async () => {
    mockRequestServerAddressChange.mockResolvedValue('offered');
    await renderWithTheme(<ChangeServerAddressScreen />);

    expect(screen.getByText('https://old.example')).toBeTruthy();
    await submit('new.example');

    expect(mockRequestServerAddressChange).toHaveBeenCalledWith('new.example');
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['invalid', 'Enter a server address like https://example.com.'],
    ['same-address', 'That is already your server address.'],
    ['insecure-downgrade', 'won’t switch from a secure https address'],
    ['unavailable', 'can’t change the address right now'],
  ])('explains a %s result and stays open', async (result, text) => {
    mockRequestServerAddressChange.mockResolvedValue(result);
    await renderWithTheme(<ChangeServerAddressScreen />);

    await submit('whatever.example');

    expect(screen.getByRole('alert')).toHaveTextContent(text, { exact: false });
    expect(mockBack).not.toHaveBeenCalled();
  });
});
