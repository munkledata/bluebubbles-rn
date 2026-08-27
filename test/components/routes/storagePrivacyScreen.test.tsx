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
  it('explains what leaves the device, where it goes, and what disconnect does not delete', async () => {
    await renderWithTheme(<StoragePrivacyScreen />);

    expect(screen.getByText(/self-hosted server you connect/)).toBeTruthy();
    expect(screen.getByText(/HTTP does not protect this traffic/)).toBeTruthy();
    expect(
      screen.getByText(/does not delete conversations or files stored by your server/),
    ).toBeTruthy();
    expect(screen.getByText(/Deleting a chat or message in Gator is also local-only/)).toBeTruthy();
    expect(screen.getByText(/up to 64 existing chat phone or email addresses/)).toBeTruthy();
    expect(screen.getByText(/does not upload your whole address book/)).toBeTruthy();
    expect(screen.getByText(/the device contact photo is not sent/)).toBeTruthy();
    expect(screen.getByText(/contact entries.*remain after Disconnect/)).toBeTruthy();
    expect(screen.getByText(/clear its app data or uninstall it/)).toBeTruthy();
    expect(screen.getByText(/FCM.*token and device label/)).toBeTruthy();
    expect(screen.getByText(/passes from that server through Google FCM/)).toBeTruthy();
    expect(screen.getByText(/push-payload encryption.*not always enabled/)).toBeTruthy();
    expect(screen.getByText(/new or unset installation.*starts off/)).toBeTruthy();
    expect(screen.getByText(/not the original error message or stack trace/)).toBeTruthy();
    expect(
      screen.getByText(/does not download third-party link previews or map tiles/),
    ).toBeTruthy();
    expect(
      screen.getByText(/external provider may receive the URL or precise coordinates/),
    ).toBeTruthy();
    expect(screen.getByText(/no longer has a configurable Redacted Mode/)).toBeTruthy();
    expect(screen.getByText(/keeps protected content out of Android Recents/)).toBeTruthy();
    expect(screen.getByText(/Secure Screen setting blocks screenshots/)).toBeTruthy();
  });

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
    expect(screen.getByText(/opaque crash-site code without a filename/)).toBeTruthy();
    expect(
      screen.getByText(/does not delete copies exported to Photos or the Gator album/),
    ).toBeTruthy();
    expect(screen.getByText(/encrypts it before writing a temporary share file/)).toBeTruthy();
    expect(
      screen.getByText(/not messages, drafts, diagnostic consent, or credentials/),
    ).toBeTruthy();
    expect(screen.getByText(/attempts to delete that file/)).toBeTruthy();
  });
});
