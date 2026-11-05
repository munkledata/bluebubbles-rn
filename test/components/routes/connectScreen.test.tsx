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

// Setup runs before the encrypted database is open, so saving a setting fails here as it does on a
// real phone; the store must keep the choice anyway.
jest.mock('@db/database', () => ({
  getDatabase: () => {
    throw new Error('Database not initialized');
  },
}));

// eslint-disable-next-line import/first
import ConnectScreen from '../../../app/(setup)/connect';
// eslint-disable-next-line import/first
import { useSyncSettingsStore } from '@state/syncSettingsStore';

beforeEach(() => {
  jest.clearAllMocks();
  useSyncSettingsStore.setState({ messagesPerChat: 0, unsaved: false, hydrated: false });
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

  it('offers how many messages per chat the first sync downloads, before connecting', async () => {
    await renderWithTheme(<ConnectScreen />);

    expect(screen.getByText('Messages per chat')).toBeTruthy();
    expect(screen.getByText('All')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'More messages per chat' }).props.accessibilityState,
    ).toEqual({ disabled: true });

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Fewer messages per chat' }));
    });
    expect(screen.getByText('500')).toBeTruthy();
    expect(useSyncSettingsStore.getState()).toMatchObject({ messagesPerChat: 500, unsaved: true });
  });
});
