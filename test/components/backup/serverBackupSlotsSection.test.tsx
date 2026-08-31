import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { act, fireEvent, renderWithTheme, screen, waitFor } from '../support/renderWithTheme';

const mockListServerBackupSlots = jest.fn();
const mockSaveServerBackupSlot = jest.fn();
const mockRestoreServerBackupSlot = jest.fn();
const mockDeleteServerBackupSlot = jest.fn();
const mockShowDialog = jest.fn();
const mockTryBeginOperation = jest.fn();
const mockFinishOperation = jest.fn();
const mockUnsubscribe = jest.fn();

let mockAccountCurrent = true;
let mockGenerationInvalidation: (() => void) | null = null;

jest.mock('@ui/dialog/dialogStore', () => ({
  showDialog: (...args: unknown[]) => mockShowDialog(...args),
}));

jest.mock('@/services/realtime/deliveryCoordinator', () => ({
  subscribeRealtimeGenerationInvalidation: (generation: number, listener: () => void) => {
    if (generation !== 7) throw new Error(`Unexpected generation ${generation}`);
    mockGenerationInvalidation = listener;
    return mockUnsubscribe;
  },
}));

jest.mock('@/services/backup/backupService', () => {
  class BackupAccountChangedError extends Error {
    constructor() {
      super('backup-account-changed');
      this.name = 'BackupAccountChangedError';
    }
  }

  class BackupPassphraseRejectedError extends Error {
    readonly issue: 'too-short' | 'too-common';

    constructor(rejectionIssue: 'too-short' | 'too-common') {
      super(`backup-passphrase-rejected:${rejectionIssue}`);
      this.name = 'BackupPassphraseRejectedError';
      this.issue = rejectionIssue;
    }
  }

  return {
    BackupAccountChangedError,
    BackupPassphraseRejectedError,
    createEncryptedBackupCiphertext: jest.fn(),
    importEncryptedBackup: jest.fn(),
    isBackupAccountChangedError: (error: unknown) => error instanceof BackupAccountChangedError,
  };
});

jest.mock('@/services/backup/serverBackupSlots', () => {
  class ServerBackupSlotError extends Error {
    readonly kind: string;

    constructor(errorKind: string) {
      super(`server-backup-slot:${errorKind}`);
      this.name = 'ServerBackupSlotError';
      this.kind = errorKind;
    }
  }

  return {
    SERVER_BACKUP_SLOT_LIMITS: {
      nameCharacters: 80,
      ciphertextCharacters: 900 * 1024,
      slots: 10,
    },
    ServerBackupSlotError,
    normalizeServerBackupSlotName: (value: string) => {
      const normalized = value.normalize('NFC').trim();
      if (
        normalized.length === 0 ||
        normalized.length > 80 ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)
      ) {
        throw new ServerBackupSlotError('invalid-name');
      }
      return normalized;
    },
    listServerBackupSlots: (...args: unknown[]) => mockListServerBackupSlots(...args),
    saveServerBackupSlot: (...args: unknown[]) => mockSaveServerBackupSlot(...args),
    restoreServerBackupSlot: (...args: unknown[]) => mockRestoreServerBackupSlot(...args),
    deleteServerBackupSlot: (...args: unknown[]) => mockDeleteServerBackupSlot(...args),
  };
});

// eslint-disable-next-line import/first
import { UnimplementedEndpointError } from '@core/api/errors';
// eslint-disable-next-line import/first
import {
  BackupAccountChangedError,
  BackupPassphraseRejectedError,
} from '@/services/backup/backupService';
// eslint-disable-next-line import/first
import { ServerBackupSlotError, type ServerBackupSlot } from '@/services/backup/serverBackupSlots';
// eslint-disable-next-line import/first
import { ServerBackupSlotsSection } from '@/ui/backup/ServerBackupSlotsSection';

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

const lease = {
  generation: 7,
  isCurrent: () => mockAccountCurrent,
};

const validSlot: ServerBackupSlot = {
  name: 'Daily',
  ciphertext: 'encrypted-daily',
  createdAt: 1_000,
  updatedAt: 2_000,
};

const restoreResult = {
  kv: 2,
  themes: 3,
  chatCustomizations: 4,
  chatCustomizationsSkipped: 5,
  customFolders: 6,
  customFoldersSkipped: 7,
  customFolderMemberships: 8,
  customFolderMembershipsSkipped: 9,
};

async function renderSection(options: { operationBusy?: boolean } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { gcTime: Infinity, retry: false },
    },
  });
  const view = await renderWithTheme(
    <QueryClientProvider client={queryClient}>
      <ServerBackupSlotsSection
        lease={lease}
        operationBusy={options.operationBusy ?? false}
        tryBeginOperation={mockTryBeginOperation}
        finishOperation={mockFinishOperation}
      />
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

async function waitForLoadedSlots(): Promise<void> {
  await screen.findByText(/SAVED ON SERVER/);
}

async function fillSaveForm(name = 'Daily'): Promise<void> {
  await fireEvent.changeText(screen.getByLabelText('Server backup name'), name);
  await fireEvent.changeText(
    screen.getByLabelText('Server backup passphrase'),
    'river-lantern-orbit-92',
  );
  await fireEvent.changeText(
    screen.getByLabelText('Confirm server backup passphrase'),
    'river-lantern-orbit-92',
  );
}

function lastDialogButtons(): Array<{
  text: string;
  style?: string;
  onPress?: () => void;
}> {
  const buttons = mockShowDialog.mock.calls.at(-1)?.[2] as
    Array<{ text: string; style?: string; onPress?: () => void }> | undefined;
  if (!buttons) throw new Error('Expected the last dialog to include buttons');
  return buttons;
}

async function pressDialogAction(label: string): Promise<void> {
  const button = lastDialogButtons().find((candidate) => candidate.text === label);
  if (!button?.onPress) throw new Error(`Expected a ${label} dialog action`);
  await act(async () => button.onPress?.());
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
  mockAccountCurrent = true;
  mockGenerationInvalidation = null;
  mockListServerBackupSlots.mockResolvedValue([]);
  mockSaveServerBackupSlot.mockResolvedValue(validSlot);
  mockRestoreServerBackupSlot.mockResolvedValue(restoreResult);
  mockDeleteServerBackupSlot.mockResolvedValue(true);
  mockTryBeginOperation.mockReturnValue(true);
});

describe('ServerBackupSlotsSection query states', () => {
  it('shows a progress state until the server responds, then an empty state', async () => {
    const pending = deferred<ServerBackupSlot[]>();
    mockListServerBackupSlots.mockReturnValueOnce(pending.promise);

    await renderSection();

    expect(screen.getByText('Checking…')).toBeTruthy();
    expect(screen.queryByLabelText('Server backup name')).toBeNull();

    await act(async () => pending.resolve([]));

    expect(await screen.findByText('No server backups yet.')).toBeTruthy();
    expect(screen.getByLabelText('Server backup name')).toBeTruthy();
  });

  it('explains when the server does not implement encrypted backup slots', async () => {
    mockListServerBackupSlots.mockRejectedValueOnce(
      new UnimplementedEndpointError('/api/v1/backup/settings'),
    );

    await renderSection();

    expect(
      await screen.findByText(/Named encrypted backups aren’t supported on this server/),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByLabelText('Server backup name')).toBeNull();
  });

  it('offers a working retry after an ordinary list failure', async () => {
    mockListServerBackupSlots.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([]);

    await renderSection();

    expect(await screen.findByText(/Couldn’t load server backups/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('No server backups yet.')).toBeTruthy();
    expect(mockListServerBackupSlots).toHaveBeenCalledTimes(2);
  });

  it('shows compatible and legacy slots with the correct actions enabled', async () => {
    const legacySlot: ServerBackupSlot = {
      name: 'Old Mac',
      ciphertext: null,
      createdAt: 0,
      updatedAt: Number.NaN,
    };
    mockListServerBackupSlots.mockResolvedValueOnce([validSlot, legacySlot]);

    await renderSection();
    await waitForLoadedSlots();

    expect(screen.getByText('SAVED ON SERVER (2)')).toBeTruthy();
    expect(screen.getByText('Legacy or incompatible data')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Restore Old Mac' }).props.accessibilityState.disabled,
    ).toBe(true);
    expect(
      screen.getByRole('button', { name: 'Delete Old Mac' }).props.accessibilityState.disabled,
    ).toBe(false);
    expect(
      screen.getByRole('button', { name: 'Restore Daily' }).props.accessibilityState.disabled,
    ).toBe(false);
  });

  it('disables every mutating action while another backup operation owns the screen', async () => {
    mockListServerBackupSlots.mockResolvedValueOnce([validSlot]);

    await renderSection({ operationBusy: true });
    await waitForLoadedSlots();

    expect(
      screen.getByRole('button', { name: 'Save encrypted backup to server' }).props
        .accessibilityState.disabled,
    ).toBe(true);
    expect(
      screen.getByRole('button', { name: 'Restore Daily' }).props.accessibilityState.disabled,
    ).toBe(true);
    expect(
      screen.getByRole('button', { name: 'Delete Daily' }).props.accessibilityState.disabled,
    ).toBe(true);
  });
});

describe('ServerBackupSlotsSection save flow', () => {
  it('keeps save disabled for invalid names, weak phrases, and mismatched confirmation', async () => {
    await renderSection();
    await waitForLoadedSlots();
    const save = screen.getByRole('button', { name: 'Save encrypted backup to server' });

    expect(save.props.accessibilityState.disabled).toBe(true);

    await fireEvent.changeText(screen.getByLabelText('Server backup name'), 'Bad\u0007Name');
    await fireEvent.changeText(screen.getByLabelText('Server backup passphrase'), 'password1234');
    await fireEvent.changeText(
      screen.getByLabelText('Confirm server backup passphrase'),
      'password1234',
    );
    expect(save.props.accessibilityState.disabled).toBe(true);

    await fireEvent.changeText(screen.getByLabelText('Server backup name'), 'Daily');
    await fireEvent.changeText(
      screen.getByLabelText('Server backup passphrase'),
      'river-lantern-orbit-92',
    );
    await fireEvent.changeText(
      screen.getByLabelText('Confirm server backup passphrase'),
      'does-not-match-the-passphrase',
    );
    expect(save.props.accessibilityState.disabled).toBe(true);

    await fireEvent.changeText(
      screen.getByLabelText('Confirm server backup passphrase'),
      'river-lantern-orbit-92',
    );
    expect(save.props.accessibilityState.disabled).toBe(false);
  });

  it('saves a normalized name, publishes the slot, and clears the secret fields', async () => {
    const saved = { ...validSlot, name: 'Travel', updatedAt: 4_000 };
    mockListServerBackupSlots.mockResolvedValueOnce([]).mockResolvedValueOnce([saved]);
    mockSaveServerBackupSlot.mockResolvedValueOnce(saved);
    jest.spyOn(Date, 'now').mockReturnValue(3_000);

    const { queryClient } = await renderSection();
    await waitForLoadedSlots();
    await fillSaveForm('  Travel  ');
    await fireEvent.press(screen.getByRole('button', { name: 'Save encrypted backup to server' }));

    await waitFor(() =>
      expect(mockSaveServerBackupSlot).toHaveBeenCalledWith(
        {
          name: 'Travel',
          passphrase: 'river-lantern-orbit-92',
          now: 3_000,
          existingSlotNames: [],
        },
        lease,
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() =>
      expect(mockShowDialog).toHaveBeenCalledWith(
        'Server backup saved',
        '“Travel” now contains a new encrypted backup.',
      ),
    );
    expect(await screen.findByText('Travel')).toBeTruthy();
    expect(screen.getByLabelText('Server backup name').props.value).toBe('');
    expect(screen.getByLabelText('Server backup passphrase').props.value).toBe('');
    expect(screen.getByLabelText('Confirm server backup passphrase').props.value).toBe('');
    expect(queryClient.getQueryData(['server', 'backup-slots', 7])).toEqual([saved]);
    expect(mockFinishOperation).toHaveBeenCalledTimes(1);
  });

  it('requires confirmation before replacing a named slot', async () => {
    const replacement = { ...validSlot, updatedAt: 5_000 };
    mockListServerBackupSlots
      .mockResolvedValueOnce([validSlot])
      .mockResolvedValueOnce([replacement]);
    mockSaveServerBackupSlot.mockResolvedValueOnce(replacement);

    await renderSection();
    await waitForLoadedSlots();
    await fillSaveForm(' Daily ');
    await fireEvent.press(screen.getByRole('button', { name: 'Save encrypted backup to server' }));

    expect(mockSaveServerBackupSlot).not.toHaveBeenCalled();
    expect(mockShowDialog).toHaveBeenCalledWith(
      'Replace server backup?',
      expect.stringContaining('This replaces “Daily”'),
      expect.any(Array),
    );

    await pressDialogAction('Replace');

    await waitFor(() => expect(mockSaveServerBackupSlot).toHaveBeenCalledTimes(1));
    expect(mockSaveServerBackupSlot.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ name: 'Daily', existingSlotNames: ['Daily'] }),
    );
    await waitFor(() =>
      expect(mockShowDialog).toHaveBeenLastCalledWith(
        'Server backup saved',
        '“Daily” now contains a new encrypted backup.',
      ),
    );
  });

  it('does not start a save when the shared operation coordinator refuses ownership', async () => {
    mockTryBeginOperation.mockReturnValueOnce(false);

    await renderSection();
    await waitForLoadedSlots();
    await fillSaveForm('Travel');
    await fireEvent.press(screen.getByRole('button', { name: 'Save encrypted backup to server' }));

    expect(mockTryBeginOperation).toHaveBeenCalledTimes(1);
    expect(mockSaveServerBackupSlot).not.toHaveBeenCalled();
    expect(mockFinishOperation).not.toHaveBeenCalled();
  });

  it.each([
    [
      'short passphrase rejection',
      () => new BackupPassphraseRejectedError('too-short'),
      'Use at least 15 characters.',
    ],
    [
      'common passphrase rejection',
      () => new BackupPassphraseRejectedError('too-common'),
      'Choose a less common passphrase.',
    ],
    [
      'oversized ciphertext',
      () => new ServerBackupSlotError('ciphertext-too-large'),
      'This backup is too large for the server’s 1 MB slot endpoint. Use local export instead.',
    ],
    [
      'slot limit',
      () => new ServerBackupSlotError('slot-limit'),
      'This device won’t add more than 10 visible slots. Delete a slot first.',
    ],
    [
      'rejected normalized name',
      () => new ServerBackupSlotError('invalid-name'),
      'Choose a shorter backup name.',
    ],
    [
      'unsupported endpoint',
      () => new UnimplementedEndpointError('/api/v1/backup/settings'),
      'Server backups aren’t supported on this server.',
    ],
    [
      'ordinary connection failure',
      () => new Error('offline'),
      'Couldn’t save the server backup. Check your connection.',
    ],
  ])('shows actionable copy for a %s', async (_case, makeError, expectedMessage) => {
    mockSaveServerBackupSlot.mockRejectedValueOnce(makeError());

    await renderSection();
    await waitForLoadedSlots();
    await fillSaveForm('Travel');
    await fireEvent.press(screen.getByRole('button', { name: 'Save encrypted backup to server' }));

    await waitFor(() =>
      expect(mockShowDialog).toHaveBeenCalledWith('Server backup', expectedMessage),
    );
    expect(mockFinishOperation).toHaveBeenCalledTimes(1);
  });

  it('aborts and suppresses a delayed old-account save result', async () => {
    const pending = deferred<ServerBackupSlot>();
    mockSaveServerBackupSlot.mockReturnValueOnce(pending.promise);

    const { queryClient } = await renderSection();
    await waitForLoadedSlots();
    await fillSaveForm('Travel');
    await fireEvent.press(screen.getByRole('button', { name: 'Save encrypted backup to server' }));
    await waitFor(() => expect(mockSaveServerBackupSlot).toHaveBeenCalledTimes(1));
    const signal = mockSaveServerBackupSlot.mock.calls[0]?.[2] as AbortSignal;
    expect(signal.aborted).toBe(false);

    await act(async () => {
      mockAccountCurrent = false;
      mockGenerationInvalidation?.();
    });
    expect(signal.aborted).toBe(true);

    await act(async () => pending.resolve({ ...validSlot, name: 'Travel' }));
    await waitFor(() => expect(mockFinishOperation).toHaveBeenCalledTimes(1));

    expect(mockShowDialog).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(['server', 'backup-slots', 7])).toEqual([]);
  });
});

describe('ServerBackupSlotsSection restore and delete flows', () => {
  beforeEach(() => {
    mockListServerBackupSlots.mockResolvedValue([validSlot]);
  });

  it('asks for the original passphrase before starting a restore', async () => {
    await renderSection();
    await waitForLoadedSlots();
    await fireEvent.press(screen.getByRole('button', { name: 'Restore Daily' }));

    expect(mockShowDialog).toHaveBeenCalledWith(
      'Restore server backup',
      'Enter this backup’s passphrase above first.',
    );
    expect(mockRestoreServerBackupSlot).not.toHaveBeenCalled();
    expect(mockTryBeginOperation).not.toHaveBeenCalled();
  });

  it('restores with an older passphrase and reports every applied and skipped count', async () => {
    await renderSection();
    await waitForLoadedSlots();
    await fireEvent.changeText(screen.getByLabelText('Server backup passphrase'), 'old-short-pass');
    await fireEvent.press(screen.getByRole('button', { name: 'Restore Daily' }));

    await waitFor(() =>
      expect(mockRestoreServerBackupSlot).toHaveBeenCalledWith(validSlot, 'old-short-pass', lease),
    );
    await waitFor(() =>
      expect(mockShowDialog).toHaveBeenCalledWith(
        'Restored',
        'Settings: 2, themes: 3, chats restored: 4, chats skipped: 5, folders matched/restored: 6, folders skipped: 7, folder members matched: 8, folder members skipped: 9.',
      ),
    );
    expect(screen.getByLabelText('Server backup passphrase').props.value).toBe('');
    expect(mockFinishOperation).toHaveBeenCalledTimes(1);
  });

  it('shows a safe restore failure and quietly handles account retirement', async () => {
    mockRestoreServerBackupSlot.mockRejectedValueOnce(new Error('bad ciphertext'));

    await renderSection();
    await waitForLoadedSlots();
    await fireEvent.changeText(screen.getByLabelText('Server backup passphrase'), 'wrong');
    await fireEvent.press(screen.getByRole('button', { name: 'Restore Daily' }));

    await waitFor(() =>
      expect(mockShowDialog).toHaveBeenCalledWith(
        'Restore server backup',
        'Couldn’t restore — check the passphrase and that this is a valid Gator backup.',
      ),
    );

    mockShowDialog.mockClear();
    mockRestoreServerBackupSlot.mockRejectedValueOnce(new BackupAccountChangedError());
    await fireEvent.press(screen.getByRole('button', { name: 'Restore Daily' }));
    await waitFor(() => expect(mockRestoreServerBackupSlot).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mockFinishOperation).toHaveBeenCalledTimes(2));
    expect(mockShowDialog).not.toHaveBeenCalled();
  });

  it('deletes only after confirmation and removes the slot from the visible cache', async () => {
    mockListServerBackupSlots.mockResolvedValueOnce([validSlot]).mockResolvedValueOnce([]);

    const { queryClient } = await renderSection();
    await waitForLoadedSlots();
    await fireEvent.press(screen.getByRole('button', { name: 'Delete Daily' }));

    expect(mockDeleteServerBackupSlot).not.toHaveBeenCalled();
    expect(mockShowDialog).toHaveBeenCalledWith(
      'Delete server backup?',
      expect.stringContaining('Delete “Daily” from the server?'),
      expect.any(Array),
    );

    await pressDialogAction('Delete');

    await waitFor(() => expect(mockDeleteServerBackupSlot).toHaveBeenCalledTimes(1));
    expect(mockDeleteServerBackupSlot).toHaveBeenCalledWith(
      'Daily',
      lease,
      expect.any(AbortSignal),
    );
    await waitFor(() => expect(screen.queryByText('Daily')).toBeNull());
    expect(queryClient.getQueryData(['server', 'backup-slots', 7])).toEqual([]);
    expect(mockFinishOperation).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'unsupported endpoint',
      new UnimplementedEndpointError('/api/v1/backup/settings'),
      'Server backups aren’t supported on this server.',
    ],
    [
      'ordinary connection failure',
      new Error('offline'),
      'Couldn’t delete the server backup. Check your connection.',
    ],
  ])('explains a delete %s without removing the slot', async (_case, error, expectedMessage) => {
    mockDeleteServerBackupSlot.mockRejectedValueOnce(error);

    await renderSection();
    await waitForLoadedSlots();
    await fireEvent.press(screen.getByRole('button', { name: 'Delete Daily' }));
    await pressDialogAction('Delete');

    await waitFor(() =>
      expect(mockShowDialog).toHaveBeenLastCalledWith('Delete server backup', expectedMessage),
    );
    expect(screen.getByText('Daily')).toBeTruthy();
    expect(mockFinishOperation).toHaveBeenCalledTimes(1);
  });

  it('aborts an active delete when the section unmounts', async () => {
    const pending = deferred<boolean>();
    mockDeleteServerBackupSlot.mockReturnValueOnce(pending.promise);

    const view = await renderSection();
    await waitForLoadedSlots();
    await fireEvent.press(screen.getByRole('button', { name: 'Delete Daily' }));
    await pressDialogAction('Delete');
    await waitFor(() => expect(mockDeleteServerBackupSlot).toHaveBeenCalledTimes(1));
    const signal = mockDeleteServerBackupSlot.mock.calls[0]?.[2] as AbortSignal;
    expect(signal.aborted).toBe(false);

    await view.unmount();

    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(true));
    await waitFor(() => expect(mockFinishOperation).toHaveBeenCalledTimes(1));
    expect(mockShowDialog).toHaveBeenCalledTimes(1);
  });
});
