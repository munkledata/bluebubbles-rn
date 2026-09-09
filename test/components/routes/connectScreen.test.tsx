import React from 'react';
import { act, fireEvent, renderWithTheme, screen } from '../support/renderWithTheme';

const mockPush = jest.fn();

jest.mock('@ui', () => ({
  ...jest.requireActual('@ui/theme'),
  ...jest.requireActual('@ui/primitives'),
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// eslint-disable-next-line import/first
import ConnectScreen from '../../../app/(setup)/connect';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('ConnectScreen', () => {
  it('renders the catalog copy and preserves both setup choices', async () => {
    await renderWithTheme(<ConnectScreen />);

    expect(screen.getByText('Connect')).toBeTruthy();
    expect(screen.getByText(/Scan the QR code shown on your Gator Server/)).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Scan QR Code' }));
    });
    expect(mockPush).toHaveBeenLastCalledWith('/scan');

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Enter Manually' }));
    });
    expect(mockPush).toHaveBeenLastCalledWith('/manual');
  });
});
