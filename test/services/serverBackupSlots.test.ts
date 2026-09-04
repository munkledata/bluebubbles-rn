const mockList = jest.fn();
const mockSave = jest.fn();
const mockDelete = jest.fn();
const mockCreateCiphertext = jest.fn();
const mockImportCiphertext = jest.fn();
const mockHttp = {};

jest.mock('@core/api', () => ({
  backupsApi: {
    listSettingsBackups: (...args: unknown[]) => mockList(...args),
    saveSettingsBackup: (...args: unknown[]) => mockSave(...args),
    deleteSettingsBackup: (...args: unknown[]) => mockDelete(...args),
  },
}));
jest.mock('@/services/clients', () => ({ http: mockHttp }));
jest.mock('@/services/backup/backupService', () => ({
  BackupAccountChangedError: class BackupAccountChangedError extends Error {},
  createEncryptedBackupCiphertext: (...args: unknown[]) => mockCreateCiphertext(...args),
  importEncryptedBackup: (...args: unknown[]) => mockImportCiphertext(...args),
}));

// eslint-disable-next-line import/first
import { ApiError } from '@core/api/errors';
// eslint-disable-next-line import/first
import { BackupAccountChangedError } from '@/services/backup/backupService';
// eslint-disable-next-line import/first
import {
  deleteServerBackupSlot,
  listServerBackupSlots,
  restoreServerBackupSlot,
  saveServerBackupSlot,
  ServerBackupSlotError,
} from '@/services/backup/serverBackupSlots';

const lease = { generation: 7, isCurrent: () => true };
const OLD_REVISION = '00112233445566778899aabbccddeeff';
const NEW_REVISION = 'ffeeddccbbaa99887766554433221100';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('server backup slots', () => {
  it('keeps plaintext out of slot state and sends the displayed revision with ciphertext', async () => {
    mockList.mockResolvedValue({
      revisionFence: true,
      backups: [
        {
          name: 'Old',
          data: { theme: 'plaintext' },
          revision: '11112222333344445555666677778888',
          createdAt: 1,
          updatedAt: 2,
        },
        {
          name: 'Nightly',
          data: 'BB2.remote-ciphertext',
          revision: OLD_REVISION,
          createdAt: 3,
          updatedAt: 4,
        },
      ],
    });
    const snapshot = await listServerBackupSlots(lease);
    expect(snapshot).toEqual({
      revisionFence: true,
      slots: [
        {
          name: 'Nightly',
          revision: OLD_REVISION,
          ciphertext: 'BB2.remote-ciphertext',
          createdAt: 3,
          updatedAt: 4,
        },
        {
          name: 'Old',
          revision: '11112222333344445555666677778888',
          ciphertext: null,
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    });

    mockCreateCiphertext.mockResolvedValue('BB2.new-ciphertext');
    mockSave.mockResolvedValue({
      name: 'Nightly',
      data: 'BB2.new-ciphertext',
      revision: NEW_REVISION,
      createdAt: 3,
      updatedAt: 5,
    });
    await saveServerBackupSlot(
      {
        name: ' Nightly ',
        passphrase: 'private passphrase',
        now: 10,
        snapshot,
      },
      lease,
    );

    expect(mockCreateCiphertext).toHaveBeenCalledWith('private passphrase', 10, lease);
    expect(mockSave).toHaveBeenCalledWith(
      mockHttp,
      { name: 'Nightly', data: 'BB2.new-ciphertext', expectedRevision: OLD_REVISION },
      undefined,
    );
    expect(JSON.stringify(mockSave.mock.calls)).not.toContain('private passphrase');
  });

  it('uses create-only null and blocks every mutation on a pre-fence server', async () => {
    mockCreateCiphertext.mockResolvedValue('BB2.new-ciphertext');
    mockSave.mockResolvedValue({
      name: 'Travel',
      data: 'BB2.new-ciphertext',
      revision: NEW_REVISION,
      createdAt: 3,
      updatedAt: 5,
    });
    const fencedEmpty = { slots: [], revisionFence: true };

    await saveServerBackupSlot(
      {
        name: 'Travel',
        passphrase: 'private passphrase',
        now: 10,
        snapshot: fencedEmpty,
      },
      lease,
    );
    expect(mockSave).toHaveBeenCalledWith(
      mockHttp,
      { name: 'Travel', data: 'BB2.new-ciphertext', expectedRevision: null },
      undefined,
    );

    jest.clearAllMocks();
    const legacySlot = {
      name: 'Legacy',
      revision: null,
      ciphertext: 'BB2.remote-ciphertext',
      createdAt: 1,
      updatedAt: 2,
    };
    await expect(
      saveServerBackupSlot(
        {
          name: 'Legacy',
          passphrase: 'private passphrase',
          now: 10,
          snapshot: { slots: [legacySlot], revisionFence: false },
        },
        lease,
      ),
    ).rejects.toMatchObject({ kind: 'revision-fence-required' });
    await expect(
      deleteServerBackupSlot({ slot: legacySlot, revisionFence: false }, lease),
    ).rejects.toMatchObject({ kind: 'revision-fence-required' });
    expect(mockCreateCiphertext).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('uses the encrypted-only restore boundary and exact-name delete', async () => {
    const slot = {
      name: 'Phone A',
      revision: OLD_REVISION,
      ciphertext: 'BB2.remote-ciphertext',
      createdAt: 1,
      updatedAt: 2,
    };
    const result = {
      kv: 1,
      themes: 2,
      chatCustomizations: 3,
      chatCustomizationsSkipped: 0,
    };
    mockImportCiphertext.mockResolvedValue(result);
    mockDelete.mockResolvedValue(true);

    await expect(restoreServerBackupSlot(slot, 'restore passphrase', lease)).resolves.toBe(result);
    await expect(deleteServerBackupSlot({ slot, revisionFence: true }, lease)).resolves.toBe(true);
    expect(mockImportCiphertext).toHaveBeenCalledWith(
      'BB2.remote-ciphertext',
      'restore passphrase',
      lease,
    );
    expect(mockDelete).toHaveBeenCalledWith(
      mockHttp,
      { name: 'Phone A', expectedRevision: OLD_REVISION },
      undefined,
    );

    expect(() =>
      restoreServerBackupSlot({ ...slot, ciphertext: null }, 'restore passphrase', lease),
    ).toThrow(ServerBackupSlotError);
  });

  it('maps save and delete conflicts without retrying an unconditional mutation', async () => {
    const slot = {
      name: 'Daily',
      revision: OLD_REVISION,
      ciphertext: 'BB2.remote-ciphertext',
      createdAt: 1,
      updatedAt: 2,
    };
    const conflict = new ApiError('bad_request', 'conflict', 409);
    mockCreateCiphertext.mockResolvedValue('BB2.new-ciphertext');
    mockSave.mockRejectedValueOnce(conflict);

    await expect(
      saveServerBackupSlot(
        {
          name: 'Daily',
          passphrase: 'private passphrase',
          now: 10,
          snapshot: { slots: [slot], revisionFence: true },
        },
        lease,
      ),
    ).rejects.toMatchObject({ kind: 'revision-conflict' });
    expect(mockSave).toHaveBeenCalledTimes(1);

    mockDelete.mockRejectedValueOnce(conflict);
    await expect(
      deleteServerBackupSlot({ slot, revisionFence: true }, lease),
    ).rejects.toMatchObject({ kind: 'revision-conflict' });
    expect(mockDelete).toHaveBeenCalledTimes(1);
  });

  it('prefers account retirement when it races with a revision conflict', async () => {
    let current = true;
    const retiringLease = { generation: 8, isCurrent: () => current };
    const conflict = new ApiError('bad_request', 'conflict', 409);
    mockCreateCiphertext.mockResolvedValue('BB2.new-ciphertext');
    mockSave.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          queueMicrotask(() => {
            reject(conflict);
            queueMicrotask(() => {
              current = false;
            });
          });
        }),
    );

    await expect(
      saveServerBackupSlot(
        {
          name: 'Travel',
          passphrase: 'private passphrase',
          now: 10,
          snapshot: { slots: [], revisionFence: true },
        },
        retiringLease,
      ),
    ).rejects.toBeInstanceOf(BackupAccountChangedError);
  });

  it('does not return a list when account retirement wins the outer await', async () => {
    let current = true;
    const retiringLease = { generation: 8, isCurrent: () => current };
    mockList.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          queueMicrotask(() => {
            resolve({ backups: [], revisionFence: true });
            queueMicrotask(() => {
              current = false;
            });
          });
        }),
    );

    await expect(listServerBackupSlots(retiringLease)).rejects.toBeInstanceOf(
      BackupAccountChangedError,
    );
  });
});
