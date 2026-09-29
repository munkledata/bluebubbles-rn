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
    expect(screen.getByText(/built-in system certificate authorities/)).toBeTruthy();
    expect(screen.getByText(/authorities added in Android Settings are not accepted/)).toBeTruthy();
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
    expect(screen.getByText(/automatically asks your connected Gator server/)).toBeTruthy();
    expect(screen.getByText(/phone does not contact the page or image host directly/)).toBeTruthy();
    expect(
      screen.getByText(/hosts can learn the requested URL and your server's IP address/),
    ).toBeTruthy();
    expect(
      screen.getByText(/asks Google to center on the server-provided precise coordinates/),
    ).toBeTruthy();
    expect(screen.getByText(/Maps SDK crash diagnostics/)).toBeTruthy();
    expect(
      screen.getByText(/Find My is separate.*does not read this phone's location/),
    ).toBeTruthy();
    expect(screen.getByText(/only when your connected server offers it/)).toBeTruthy();
    expect(screen.getByText(/foreground location access.*15 seconds/)).toBeTruthy();
    expect(screen.getByText(/does not collect location in the background/)).toBeTruthy();
    expect(screen.getByText(/SQLCipher-encrypted outgoing queue/)).toBeTruthy();
    expect(screen.getByText(/no more than 15 minutes.*does not read a new location/)).toBeTruthy();
    expect(
      screen.getByText(
        /deny permission.*cancel.*turn off location services.*nothing is queued or sent/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/external provider may receive the URL or precise coordinates/),
    ).toBeTruthy();
    expect(
      screen.getByText(/FaceTime actions appear only.*separately gated capability/),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Starting a call sends the address.*does not save that address on the phone/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/copy it to the system clipboard.*system share sheet/)).toBeTruthy();
    expect(screen.getByText(/no longer has a configurable Redacted Mode/)).toBeTruthy();
    expect(screen.getByText(/keeps protected content out of Android Recents/)).toBeTruthy();
    expect(screen.getByText(/Secure Screen setting blocks screenshots/)).toBeTruthy();
  });

  it('names both the encrypted rows and every plaintext file class', async () => {
    await renderWithTheme(<StoragePrivacyScreen />);

    expect(screen.getByText(/SQLCipher-encrypted database/)).toBeTruthy();
    expect(screen.getByText(/authoritative App Lock setting/)).toBeTruthy();
    expect(screen.getByText(/ordinary app-private on\/off mirrors/)).toBeTruthy();
    expect(screen.getByText(/no message content or credentials/)).toBeTruthy();
    expect(
      screen.getByText(/App Lock does not make the database key biometric-bound/),
    ).toBeTruthy();
    expect(screen.getByText(/Downloaded or staged attachments/)).toBeTruthy();
    expect(screen.getByText(/legacy incoming-share copies/)).toBeTruthy();
    expect(screen.getByText(/image or other Android\/Expo-managed caches/)).toBeTruthy();
    expect(screen.getByText(/operational preferences and databases/)).toBeTruthy();
    expect(screen.getByText(/Firebase stores installation.*FCM registration token/)).toBeTruthy();
    expect(
      screen.getByText(/operational metadata may remain until you clear app data or uninstall/),
    ).toBeTruthy();
    expect(screen.getByText(/non-secret, zero-byte account-revocation marker/)).toBeTruthy();
    expect(screen.getByText(/automatically exported to Photos or the Gator album/)).toBeTruthy();
    expect(screen.getByText(/shared media storage/)).toBeTruthy();
    expect(
      screen.getByText(
        /closed or in the background finishes downloading.*only in Gator’s private cache/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/keeps a bounded encrypted record.*retries it on a later foreground/),
    ).toBeTruthy();
    expect(screen.getByText(/Turning off auto-download.*cancels queued copies/)).toBeTruthy();
    expect(screen.getByText(/app logs before another account can connect/)).toBeTruthy();
    expect(
      screen.getByText(/limits its ordinary downloaded-attachment cache to 2 GiB/),
    ).toBeTruthy();
    expect(screen.getByText(/preserving at least 512 MiB/)).toBeTruthy();
    expect(screen.getByText(/needed for an outgoing send.*are protected/)).toBeTruthy();
    expect(screen.getByText(/This release requires Android 16 or newer/)).toBeTruthy();
    expect(screen.getByText(/blocks the next connection/)).toBeTruthy();
    expect(screen.getByText(/opaque crash-site code without a filename/)).toBeTruthy();
    expect(
      screen.getByText(/does not delete copies exported to Photos or the Gator album/),
    ).toBeTruthy();
    expect(
      screen.getByText(/encrypts a new backup before writing a temporary share file/),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /does not contain messages, drafts, unread state, diagnostic consent, files, or credentials/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/device-owned contact colors/)).toBeTruthy();
    expect(screen.getByText(/Folder and color identities can include participant/)).toBeTruthy();
    expect(screen.getByText(/attempts to delete the temporary file/)).toBeTruthy();
    expect(screen.getByText(/no longer has a plaintext export path/)).toBeTruthy();
  });
});
