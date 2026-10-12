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
  class BackupExportLimitError extends Error {
    field: 'chat-nickname' | 'theme-name' | 'folder-memberships';
    constructor(field: 'chat-nickname' | 'theme-name' | 'folder-memberships') {
      super(field);
      this.field = field;
    }
  }
  return {
    BackupExportLimitError,
    BackupPassphraseRejectedError,
    exportEncryptedBackup: jest.fn(async () => undefined),
    importBackupAuto: jest.fn(),
    isBackupAccountChangedError: () => false,
  };
});

jest.mock('@/services/backup/pickedBackupDocument', () => ({
  readPickedBackupDocument: jest.fn(),
}));

// eslint-disable-next-line import/first
import BackupScreen, { pickBackupFileForLease } from '../../../app/(app)/backup';
// eslint-disable-next-line import/first
import { exportEncryptedBackup, importBackupAuto } from '@/services/backup/backupService';
// eslint-disable-next-line import/first
import { showDialog } from '@ui/dialog/dialogStore';

const mockExport = exportEncryptedBackup as jest.Mock;
const mockImport = importBackupAuto as jest.Mock;

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

  it.each([
    ['chat-nickname', 'A conversation’s phone-local nickname is too long to back up.'],
    ['theme-name', 'A custom theme’s name is too long to back up.'],
    ['folder-memberships', 'Your folders hold more chats in total than a backup can include'],
  ] as const)('says what to change when a %s is too large to back up', async (field, opening) => {
    const { BackupExportLimitError } = jest.requireMock('@/services/backup/backupService') as {
      BackupExportLimitError: new (field: string) => Error;
    };
    mockExport.mockRejectedValueOnce(new BackupExportLimitError(field));
    await renderWithTheme(<BackupScreen />);
    await fireEvent.changeText(screen.getByPlaceholderText('Passphrase'), 'river-lantern-orbit-92');
    await fireEvent.changeText(
      screen.getByPlaceholderText('Confirm passphrase'),
      'river-lantern-orbit-92',
    );

    await fireEvent.press(screen.getByRole('button', { name: 'Export encrypted backup' }));

    await waitFor(() =>
      expect(showDialog).toHaveBeenCalledWith('Backup', expect.stringContaining(opening)),
    );
    expect(showDialog).not.toHaveBeenCalledWith('Backup', 'Export failed.');
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

  it('does not read a delayed provider URI after the account retires', async () => {
    const pickerResult = deferred<{
      canceled: false;
      assets: { uri: string; size?: number }[];
    }>();
    const getDocumentAsync = jest.fn(() => pickerResult.promise);
    const readDocument = jest.fn(async () => 'picked-backup');
    const lease = { generation: 7, isCurrent: () => mockAccountCurrent };
    const pending = pickBackupFileForLease(lease, async () => ({ getDocumentAsync }), readDocument);
    await waitFor(() => expect(getDocumentAsync).toHaveBeenCalledTimes(1));

    mockAccountCurrent = false;
    pickerResult.resolve({
      canceled: false,
      assets: [{ uri: 'content://documents/account-a.gatorbackup', size: 123 }],
    });

    await expect(pending).resolves.toBeNull();
    expect(readDocument).not.toHaveBeenCalled();
  });

  it('requests no cache copy and forwards provider metadata to the bounded reader', async () => {
    const getDocumentAsync = jest.fn(async () => ({
      canceled: false,
      assets: [{ uri: 'content://documents/current.gatorbackup', size: 321 }],
    }));
    const readDocument = jest.fn(async () => '  picked-backup  ');
    const lease = { generation: 7, isCurrent: () => true };

    await expect(
      pickBackupFileForLease(lease, async () => ({ getDocumentAsync }), readDocument),
    ).resolves.toBe('  picked-backup  ');
    expect(getDocumentAsync).toHaveBeenCalledWith(
      expect.objectContaining({ copyToCacheDirectory: false }),
    );
    expect(readDocument).toHaveBeenCalledWith(
      'content://documents/current.gatorbackup',
      321,
      expect.anything(),
    );
  });

  it('cancels and discards a provider read when its account retires', async () => {
    let observedSignal: AbortSignal | undefined;
    const readDocument = jest.fn(
      async (_uri: string, _size?: number | null, signal?: AbortSignal) => {
        observedSignal = signal;
        return await new Promise<string>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        });
      },
    );
    const getDocumentAsync = jest.fn(async () => ({
      canceled: false,
      assets: [{ uri: 'content://documents/account-a.gatorbackup', size: null }],
    }));
    const lease = { generation: 7, isCurrent: () => mockAccountCurrent };

    const pending = pickBackupFileForLease(lease, async () => ({ getDocumentAsync }), readDocument);
    await waitFor(() => expect(readDocument).toHaveBeenCalledTimes(1));

    mockAccountCurrent = false;
    mockInvalidateAccount?.();

    await expect(pending).resolves.toBeNull();
    expect(observedSignal?.aborted).toBe(true);
  });
});
