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
import {
  deleteServerBackupSlot,
  listServerBackupSlots,
  restoreServerBackupSlot,
  saveServerBackupSlot,
  ServerBackupSlotError,
} from '@/services/backup/serverBackupSlots';

const lease = { generation: 7, isCurrent: () => true };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('server backup slots', () => {
  it('keeps legacy plaintext out of slot state and sends only locally produced ciphertext', async () => {
    mockList.mockResolvedValue([
      { name: 'Old', data: { theme: 'plaintext' }, createdAt: 1, updatedAt: 2 },
      { name: 'Nightly', data: 'BB2.remote-ciphertext', createdAt: 3, updatedAt: 4 },
    ]);
    const slots = await listServerBackupSlots(lease);
    expect(slots).toEqual([
      { name: 'Nightly', ciphertext: 'BB2.remote-ciphertext', createdAt: 3, updatedAt: 4 },
      { name: 'Old', ciphertext: null, createdAt: 1, updatedAt: 2 },
    ]);

    mockCreateCiphertext.mockResolvedValue('BB2.new-ciphertext');
    mockSave.mockResolvedValue({
      name: 'Nightly',
      data: 'BB2.new-ciphertext',
      createdAt: 3,
      updatedAt: 5,
    });
    await saveServerBackupSlot(
      {
        name: ' Nightly ',
        passphrase: 'private passphrase',
        now: 10,
        existingSlotNames: ['Nightly'],
      },
      lease,
    );

    expect(mockCreateCiphertext).toHaveBeenCalledWith('private passphrase', 10, lease);
    expect(mockSave).toHaveBeenCalledWith(
      mockHttp,
      { name: 'Nightly', data: 'BB2.new-ciphertext' },
      undefined,
    );
    expect(JSON.stringify(mockSave.mock.calls)).not.toContain('private passphrase');
  });

  it('uses the encrypted-only restore boundary and exact-name delete', async () => {
    const slot = {
      name: 'Phone A',
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
    await expect(deleteServerBackupSlot(slot.name, lease)).resolves.toBe(true);
    expect(mockImportCiphertext).toHaveBeenCalledWith(
      'BB2.remote-ciphertext',
      'restore passphrase',
      lease,
    );
    expect(mockDelete).toHaveBeenCalledWith(mockHttp, 'Phone A', undefined);

    expect(() =>
      restoreServerBackupSlot({ ...slot, ciphertext: null }, 'restore passphrase', lease),
    ).toThrow(ServerBackupSlotError);
  });
});
