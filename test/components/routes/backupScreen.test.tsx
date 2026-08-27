import React from 'react';
import { act, fireEvent, renderWithTheme, screen, waitFor } from '../support/renderWithTheme';
import { BACKUP_LIMITS } from '@/services/backup/backupSchema';

const mockBack = jest.fn();
let mockAccountCurrent = true;
let mockInvalidateAccount: (() => void) | null = null;

jest.mock('@ui', () => ({
  ...jest.requireActual('@ui/theme'),
  ...jest.requireActual('@ui/primitives'),
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ back: mockBack }) }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@ui/dialog/dialogStore', () => ({ showDialog: jest.fn() }));
jest.mock('@/ui/backup/ServerBackupSlotsSection', () => ({
  ServerBackupSlotsSection: () => null,
}));
jest.mock('@/services/realtime/deliveryCoordinator', () => ({
  captureRealtimeDeliveryLease: () => ({
    generation: 7,
    isCurrent: () => mockAccountCurrent,
  }),
  subscribeRealtimeGenerationInvalidation: (_generation: number, listener: () => void) => {
    mockInvalidateAccount = listener;
    return () => {
      if (mockInvalidateAccount === listener) mockInvalidateAccount = null;
    };
  },
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
import BackupScreen, { pickBackupFileForLease } from '../../../app/(app)/backup';
// eslint-disable-next-line import/first
import {
  exportEncryptedBackup,
  importBackupAuto,
  readPickedBackupCopy,
} from '@/services/backup/backupService';
// eslint-disable-next-line import/first
import { showDialog } from '@ui/dialog/dialogStore';

const mockExport = exportEncryptedBackup as jest.Mock;
const mockImport = importBackupAuto as jest.Mock;
const mockReadPickedBackupCopy = readPickedBackupCopy as jest.Mock;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAccountCurrent = true;
  mockInvalidateAccount = null;
  mockExport.mockResolvedValue(undefined);
  mockReadPickedBackupCopy.mockResolvedValue('picked-backup');
});

describe('BackupScreen passphrase boundary', () => {
  it('explains the stronger export rule and caps pasted input in the TextInput', async () => {
    await renderWithTheme(<BackupScreen />);

    expect(screen.getByText(/Use at least 15 characters.*several unrelated words/)).toBeTruthy();
    expect(screen.getByPlaceholderText('…or paste backup contents here').props.maxLength).toBe(
      BACKUP_LIMITS.encodedCharacters,
    );
  });

  it('keeps common phrases disabled and exports a distinct 15+ character passphrase', async () => {
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

  it('hides typed secrets immediately when the mounted account generation retires', async () => {
    await renderWithTheme(<BackupScreen />);
    await fireEvent.changeText(screen.getByPlaceholderText('Passphrase'), 'account-A-passphrase');
    await fireEvent.changeText(
      screen.getByPlaceholderText('…or paste backup contents here'),
      'account-A-encrypted-backup',
    );

    expect(mockInvalidateAccount).not.toBeNull();
    await act(async () => {
      mockAccountCurrent = false;
      mockInvalidateAccount?.();
    });

    expect(screen.queryByDisplayValue('account-A-passphrase')).toBeNull();
    expect(screen.queryByDisplayValue('account-A-encrypted-backup')).toBeNull();
    expect(screen.queryByPlaceholderText('Passphrase')).toBeNull();
  });

  it('keeps a delayed old-account export failure silent', async () => {
    const result = deferred<void>();
    mockExport.mockReturnValueOnce(result.promise);
    await renderWithTheme(<BackupScreen />);
    await fireEvent.changeText(screen.getByPlaceholderText('Passphrase'), 'river-lantern-orbit-92');
    await fireEvent.changeText(
      screen.getByPlaceholderText('Confirm passphrase'),
      'river-lantern-orbit-92',
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Export encrypted backup' }));
    await waitFor(() => expect(mockExport).toHaveBeenCalledTimes(1));

    mockAccountCurrent = false;
    await act(async () => {
      result.reject(new Error('old export failed'));
      await result.promise.catch(() => undefined);
    });

    expect(showDialog).not.toHaveBeenCalled();
  });

  it('keeps a delayed old-account restore failure silent', async () => {
    const result = deferred<never>();
    mockImport.mockReturnValueOnce(result.promise);
    await renderWithTheme(<BackupScreen />);
    await fireEvent.changeText(
      screen.getByPlaceholderText('…or paste backup contents here'),
      'account-A-encrypted-backup',
    );
    await fireEvent.press(screen.getByText('Restore from backup'));
    await waitFor(() => expect(mockImport).toHaveBeenCalledTimes(1));

    mockAccountCurrent = false;
    await act(async () => {
      result.reject(new Error('old restore failed'));
      await result.promise.catch(() => undefined);
    });

    expect(showDialog).not.toHaveBeenCalled();
  });

  it('hands a delayed picker cache copy to cleanup after the account retires', async () => {
    const pickerResult = deferred<{
      canceled: false;
      assets: Array<{ uri: string }>;
    }>();
    const getDocumentAsync = jest.fn(() => pickerResult.promise);
    const lease = { generation: 7, isCurrent: () => mockAccountCurrent };
    const pending = pickBackupFileForLease(lease, async () => ({ getDocumentAsync }));
    await waitFor(() => expect(getDocumentAsync).toHaveBeenCalledTimes(1));

    mockAccountCurrent = false;
    pickerResult.resolve({
      canceled: false,
      assets: [{ uri: 'file:///cache/account-a.gatorbackup' }],
    });

    await expect(pending).resolves.toBeNull();
    expect(mockReadPickedBackupCopy).toHaveBeenCalledWith(
      'file:///cache/account-a.gatorbackup',
      lease,
    );
  });
});
