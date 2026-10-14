/* eslint-disable import/first -- Jest mocks must be registered before importing their consumers. */
// A repository bug that reports more restored rows than the validated backup could contain. The
// real restore still runs; only its reported counts are inflated.
jest.mock('@db/repositories', () => {
  const actual = jest.requireActual('@db/repositories');
  return {
    ...actual,
    restorePreparedBackupWithinTransaction: async (...args: unknown[]) => {
      const applied = await actual.restorePreparedBackupWithinTransaction(...args);
      return { ...applied, handleColors: applied.handleColors + 1 };
    },
  };
});

import { kvGet } from '@db/repositories';
import { restoreBackup } from '@/services/backup/backup';
import type { BackupV3 } from '@/services/backup/backupSchema';
import { createTestDb } from '../support/testDb';
import { kvSet } from '../support/repositoryWrappers';

describe('backup restore count check', () => {
  it('rolls back a restore whose applied counts exceed the validated backup', async () => {
    const destination = await createTestDb();
    try {
      await kvSet(destination.db, 'theme.preset', 'before');
      const backup: BackupV3 = {
        version: 3,
        exportedAt: 1,
        kv: [{ key: 'theme.preset', value: 'after' }],
        themes: [],
        chatCustomizations: [],
        customFolderChatIdentities: [],
        customFolders: [],
      };

      await expect(restoreBackup(destination.db, backup)).rejects.toThrow(
        'Backup restore returned counts outside the validated source bounds.',
      );
      // Reported as failed, so nothing from it may have been committed.
      expect(await kvGet(destination.db, 'theme.preset')).toBe('before');
    } finally {
      destination.raw.close();
    }
  });
});
