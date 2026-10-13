import { buildBackupWithCustomFolders } from '@/services/backup/backup';
import { BackupV2Schema, type BackupV2 } from '@/services/backup/backupSchema';
import type { AppDatabase } from '@db/types';

/**
 * Build a version-2 backup (the oldest format restore still accepts) from the current export.
 * The app now writes version 4 only; tests use this to keep older backup files restorable. The v2
 * schema keeps the shared settings/themes/chat-customization fields and drops the newer ones.
 */
export async function buildV2Backup(
  db: AppDatabase,
  opts: { exportedAt: number; appVersion?: string },
): Promise<BackupV2> {
  return BackupV2Schema.parse({ ...(await buildBackupWithCustomFolders(db, opts)), version: 2 });
}
