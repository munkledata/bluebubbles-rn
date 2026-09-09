const mockGetSecretBox = jest.fn();

jest.mock('@/services/clients', () => ({ getSecretBox: mockGetSecretBox }));

import { utf8Encode } from '@utils/bytes';
import { BACKUP_LIMITS, BackupV3Schema } from '@/services/backup/backupSchema';
import { buildNearLimitBackupRestoreFixture } from '@/services/boot/dbBackupRestoreWave';

describe('BACKUP-02 near-limit native fixture', () => {
  it('is valid v3 data exactly 4 KiB below the production plaintext cap', () => {
    const { backup, plaintext } = buildNearLimitBackupRestoreFixture();

    expect(BackupV3Schema.parse(backup)).toEqual(backup);
    expect(utf8Encode(plaintext)).toHaveLength(BACKUP_LIMITS.plaintextBytes - 4 * 1024);
    expect(backup.themes).toHaveLength(16);
    expect(backup.customFolders).toEqual([
      expect.objectContaining({ sourceMemberCount: 1, memberIndexes: [0] }),
    ]);
  });
});
