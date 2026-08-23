import React from 'react';
import { renderWithTheme, screen } from '../support/renderWithTheme';

jest.mock('@ui', () => ({
  ...jest.requireActual('@ui/theme'),
  ...jest.requireActual('@ui/primitives'),
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ back: jest.fn() }) }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// eslint-disable-next-line import/first
import StoragePrivacyScreen from '../../../app/(app)/storage-privacy';

describe('StoragePrivacyScreen', () => {
  it('names both the encrypted rows and every plaintext file class', async () => {
    await renderWithTheme(<StoragePrivacyScreen />);

    expect(screen.getByText(/SQLCipher-encrypted database/)).toBeTruthy();
    expect(
      screen.getByText(/Server credentials, the database key, the App Lock flag/),
    ).toBeTruthy();
    expect(
      screen.getByText(/App Lock does not make the database key biometric-bound/),
    ).toBeTruthy();
    expect(screen.getByText(/Downloaded or staged attachments/)).toBeTruthy();
    expect(screen.getByText(/incoming-share copies/)).toBeTruthy();
    expect(screen.getByText(/image or WebView caches/)).toBeTruthy();
    expect(screen.getByText(/automatically exported to Photos or the Gator album/)).toBeTruthy();
    expect(screen.getByText(/shared media storage/)).toBeTruthy();
    expect(screen.getByText(/app logs before another account can connect/)).toBeTruthy();
    expect(
      screen.getByText(/limits its ordinary downloaded-attachment cache to 2 GiB/),
    ).toBeTruthy();
    expect(screen.getByText(/preserving at least 512 MiB/)).toBeTruthy();
    expect(screen.getByText(/needed for an outgoing send are protected/)).toBeTruthy();
    expect(
      screen.getByText(/Android 7 devices keep persistent attachment downloads disabled/),
    ).toBeTruthy();
    expect(screen.getByText(/blocks the next connection/)).toBeTruthy();
    expect(
      screen.getByText(/does not delete copies exported to Photos or the Gator album/),
    ).toBeTruthy();
    expect(
      screen.getByText(/encrypts a backup before writing its temporary share file/),
    ).toBeTruthy();
  });
});
