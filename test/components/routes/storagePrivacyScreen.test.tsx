import React from 'react';
import type { DialogButton } from '@ui/dialog/dialogStore';
import { act, fireEvent, renderWithTheme, screen } from '../support/renderWithTheme';

const mockRepairStuckDownloads = jest.fn();
const mockResolveIssue = jest.fn();
// Stand-in for the download service's shared repair progress.
let mockRepairProgress: number | null = null;
const mockRepairListeners = new Set<() => void>();
function setMockRepairProgress(value: number | null): void {
  mockRepairProgress = value;
  for (const listener of mockRepairListeners) listener();
}
const mockShowDialog = jest.fn<number, [string, string?, DialogButton[]?]>(() => 1);
let mockBootIssues: { stage: string; code: string; level: string }[] = [];
jest.mock('@/features/boot/useForegroundBootState', () => ({
  useForegroundBootState: () => ({ status: 'ready', runId: 1, issues: mockBootIssues }),
}));
jest.mock('@/services/download', () => ({
  repairStuckDownloads: () => mockRepairStuckDownloads(),
  getDownloadRepairProgress: () => mockRepairProgress,
  subscribeDownloadRepair: (listener: () => void) => {
    mockRepairListeners.add(listener);
    return () => mockRepairListeners.delete(listener);
  },
}));
jest.mock('@/services/boot/foregroundBoot', () => ({
  resolveAttachmentCacheRecoveryIssue: () => mockResolveIssue(),
}));
jest.mock('@ui/dialog/dialogStore', () => ({
  showDialog: (title: string, message?: string, buttons?: DialogButton[]) =>
    mockShowDialog(title, message, buttons),
}));
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
    // Review M214: crashes carry a fingerprint; the promise about message text must stay explicit.
    expect(
      screen.getByText(
        /short code for where in Gator’s code the error happened—never message text/,
      ),
    ).toBeTruthy();
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
    expect(screen.getByText(/App Lock clears displayed notifications/)).toBeTruthy();
    expect(screen.getByText(/including after unlock and during its grace period/)).toBeTruthy();
    expect(screen.getByText(/Generic scheduled reminders remain scheduled/)).toBeTruthy();
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

// Review item 888: an old download cache too big for the startup check paused new downloads on
// every launch, and restarting never helped. Storage & File Privacy offers the repair.
describe('Repair Downloads', () => {
  const pausedIssue = {
    stage: 'attachment-cache',
    code: 'attachment-cache-recovery-unavailable',
    level: 'degraded',
  };

  beforeEach(() => {
    mockBootIssues = [];
    mockRepairProgress = null;
    mockRepairListeners.clear();
    mockRepairStuckDownloads.mockReset();
    mockResolveIssue.mockReset();
    mockShowDialog.mockClear();
  });

  /** Like the service: progress shows while the repair runs and clears when it settles. */
  function repairResolvingWith(result: unknown): void {
    mockRepairStuckDownloads.mockImplementation(async () => {
      setMockRepairProgress(0);
      setMockRepairProgress(null);
      return result;
    });
  }

  async function confirmRepair(): Promise<void> {
    await fireEvent.press(screen.getByRole('button', { name: 'Repair Downloads' }));
    const [title, , buttons] = mockShowDialog.mock.calls.at(-1) ?? [];
    expect(title).toBe('Repair Downloads?');
    await act(async () => {
      buttons?.find((button) => button.text === 'Repair')?.onPress?.();
    });
  }

  it('is not offered while downloads work', async () => {
    await renderWithTheme(<StoragePrivacyScreen />);

    expect(screen.queryByRole('button', { name: 'Repair Downloads' })).toBeNull();
    expect(screen.queryByText(/New downloads are paused/)).toBeNull();
  });

  it('asks first, shows progress, ignores a second tap, then reports and clears the warning', async () => {
    mockBootIssues = [pausedIssue];
    let finish: (result: unknown) => void = () => undefined;
    mockRepairStuckDownloads.mockImplementation(() => {
      setMockRepairProgress(1_200);
      return new Promise((resolve) => {
        finish = (result) => {
          setMockRepairProgress(null);
          resolve(result);
        };
      });
    });
    await renderWithTheme(<StoragePrivacyScreen />);
    expect(screen.getByText(/New downloads are paused/)).toBeTruthy();

    await confirmRepair();
    expect(mockShowDialog.mock.calls[0]?.[1]).toMatch(/at least 512 MiB.*kept free/);
    expect(screen.getByRole('button', { name: 'Repairing… 1,200 checked' })).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Repairing… 1,200 checked' }));
    expect(mockShowDialog).toHaveBeenCalledTimes(1);
    expect(mockRepairStuckDownloads).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish({ status: 'repaired', checkedFiles: 9_000, removedFiles: 4_904, withinQuota: true });
    });
    expect(mockResolveIssue).toHaveBeenCalledTimes(1);
    expect(mockShowDialog).toHaveBeenLastCalledWith(
      'Downloads Repaired',
      expect.stringMatching(/work again.*removed 4,904 older downloaded attachments/),
      undefined,
    );
  });

  it('shows a repair already running when the screen is opened again', async () => {
    mockBootIssues = [pausedIssue];
    mockRepairProgress = 300;
    await renderWithTheme(<StoragePrivacyScreen />);

    await fireEvent.press(screen.getByRole('button', { name: 'Repairing… 300 checked' }));

    expect(mockShowDialog).not.toHaveBeenCalled();
    expect(mockRepairStuckDownloads).not.toHaveBeenCalled();
  });

  it('does nothing when the confirmation is cancelled', async () => {
    mockBootIssues = [pausedIssue];
    await renderWithTheme(<StoragePrivacyScreen />);

    await fireEvent.press(screen.getByRole('button', { name: 'Repair Downloads' }));
    const buttons = mockShowDialog.mock.calls.at(-1)?.[2];
    await act(async () => {
      buttons?.find((button) => button.text === 'Cancel')?.onPress?.();
    });

    expect(mockRepairStuckDownloads).not.toHaveBeenCalled();
  });

  // Independent review of 888: below 512 MiB free the cache is emptied and downloads can still be
  // refused, so the result must not claim downloads work again.
  it('says new downloads may still be refused when the phone stays too full', async () => {
    mockBootIssues = [pausedIssue];
    repairResolvingWith({
      status: 'repaired',
      checkedFiles: 3,
      removedFiles: 3,
      withinQuota: false,
    });
    await renderWithTheme(<StoragePrivacyScreen />);

    await confirmRepair();

    expect(mockResolveIssue).toHaveBeenCalledTimes(1);
    const [title, message] = mockShowDialog.mock.calls.at(-1) ?? [];
    expect(title).toBe('Downloads Back On');
    expect(message).toMatch(/removed 3 older downloaded attachments/);
    expect(message).toMatch(/may be refused until at least 512 MiB is free/);
    expect(message).not.toMatch(/work again/);
  });

  it('retires the warning when downloads already work', async () => {
    mockBootIssues = [pausedIssue];
    repairResolvingWith({ status: 'not-needed' });
    await renderWithTheme(<StoragePrivacyScreen />);

    await confirmRepair();

    expect(mockResolveIssue).toHaveBeenCalledTimes(1);
    expect(mockShowDialog).toHaveBeenLastCalledWith(
      'Downloads Already Work',
      expect.any(String),
      undefined,
    );
  });

  it('keeps the warning and explains when files in use stop the repair', async () => {
    mockBootIssues = [pausedIssue];
    repairResolvingWith({ status: 'blocked', checkedFiles: 100, removedFiles: 0 });
    await renderWithTheme(<StoragePrivacyScreen />);

    await confirmRepair();

    expect(mockResolveIssue).not.toHaveBeenCalled();
    expect(mockShowDialog).toHaveBeenLastCalledWith(
      'Couldn’t Finish Repair',
      expect.stringMatching(/in use or were opened in the last few minutes/),
      undefined,
    );
    expect(screen.getByRole('button', { name: 'Repair Downloads' })).toBeTruthy();
  });

  it('keeps the warning when Disconnect stops the repair', async () => {
    mockBootIssues = [pausedIssue];
    repairResolvingWith({ status: 'stale' });
    await renderWithTheme(<StoragePrivacyScreen />);

    await confirmRepair();

    expect(mockResolveIssue).not.toHaveBeenCalled();
    expect(mockShowDialog).toHaveBeenLastCalledWith(
      'Repair Stopped',
      expect.stringMatching(/disconnected from this account/),
      undefined,
    );
  });

  it('keeps the warning and says what is left to try when the repair fails', async () => {
    mockBootIssues = [pausedIssue];
    mockRepairStuckDownloads.mockRejectedValue(new Error('Attachment cache scan corrupt'));
    await renderWithTheme(<StoragePrivacyScreen />);

    await confirmRepair();

    expect(mockResolveIssue).not.toHaveBeenCalled();
    expect(mockShowDialog).toHaveBeenLastCalledWith(
      'Couldn’t Repair Downloads',
      expect.stringMatching(/Try again later/),
      undefined,
    );
    expect(screen.getByRole('button', { name: 'Repair Downloads' })).toBeTruthy();
  });
});
