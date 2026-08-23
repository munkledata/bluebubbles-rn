import React from 'react';
import { fireEvent, renderWithTheme, screen, waitFor } from '../support/renderWithTheme';
import { BACKUP_LIMITS } from '@/services/backup/backupSchema';

const mockBack = jest.fn();
let mockAccountCurrent = true;

jest.mock('@ui', () => ({
  ...jest.requireActual('@ui/theme'),
  ...jest.requireActual('@ui/primitives'),
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ back: mockBack }) }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@/services/realtime/deliveryCoordinator', () => ({
  captureRealtimeDeliveryLease: () => ({
    generation: 7,
    isCurrent: () => mockAccountCurrent,
  }),
}));
jest.mock('@/services/backup/backupService', () => {
  class BackupPassphraseRejectedError extends Error {
    issue: 'too-short' | 'too-common';
    constructor(issue: 'too-short' | 'too-common') {
      super(issue);
      this.issue = issue;
    }
  }
  return {
    BackupPassphraseRejectedError,
    exportEncryptedBackup: jest.fn(async () => undefined),
    importBackupAuto: jest.fn(),
    isBackupAccountChangedError: () => false,
    readPickedBackupCopy: jest.fn(),
  };
});

// eslint-disable-next-line import/first
import BackupScreen from '../../../app/(app)/backup';
// eslint-disable-next-line import/first
import { exportEncryptedBackup } from '@/services/backup/backupService';

const mockExport = exportEncryptedBackup as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockAccountCurrent = true;
  mockExport.mockResolvedValue(undefined);
});

describe('BackupScreen passphrase boundary', () => {
  it('explains the stronger export rule and caps pasted input in the TextInput', async () => {
    await renderWithTheme(<BackupScreen />);

    expect(screen.getByText(/Use at least 12 characters, avoid common phrases/)).toBeTruthy();
    expect(screen.getByPlaceholderText('…or paste backup contents here').props.maxLength).toBe(
      BACKUP_LIMITS.encodedCharacters,
    );
  });

  it('keeps common phrases disabled and exports a distinct 12+ character passphrase', async () => {
    await renderWithTheme(<BackupScreen />);
    const pass = screen.getByPlaceholderText('Passphrase');
    const confirm = screen.getByPlaceholderText('Confirm passphrase');
    const exportButton = screen.getByRole('button', { name: 'Export encrypted backup' });

    await fireEvent.changeText(pass, 'password1234');
    await fireEvent.changeText(confirm, 'password1234');
    expect(exportButton.props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(exportButton);
    expect(mockExport).not.toHaveBeenCalled();

    await fireEvent.changeText(pass, 'river-lantern-orbit-92');
    await fireEvent.changeText(confirm, 'river-lantern-orbit-92');
    expect(exportButton.props.accessibilityState.disabled).toBe(false);
    await fireEvent.press(exportButton);
    await waitFor(() =>
      expect(mockExport).toHaveBeenCalledWith(
        'river-lantern-orbit-92',
        expect.any(Number),
        expect.objectContaining({ generation: 7 }),
      ),
    );
  });

  it('hides typed passphrases and pasted backup text on a stale handoff render', async () => {
    const view = await renderWithTheme(<BackupScreen />);
    await fireEvent.changeText(screen.getByPlaceholderText('Passphrase'), 'account-A-passphrase');
    await fireEvent.changeText(
      screen.getByPlaceholderText('…or paste backup contents here'),
      'account-A-encrypted-backup',
    );
    expect(screen.getByDisplayValue('account-A-passphrase')).toBeTruthy();
    expect(screen.getByDisplayValue('account-A-encrypted-backup')).toBeTruthy();

    mockAccountCurrent = false;
    await view.rerender(<BackupScreen />);

    expect(screen.queryByDisplayValue('account-A-passphrase')).toBeNull();
    expect(screen.queryByDisplayValue('account-A-encrypted-backup')).toBeNull();
    expect(screen.queryByPlaceholderText('Passphrase')).toBeNull();
  });
});
