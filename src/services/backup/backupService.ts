import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import Constants from 'expo-constants';
import { getDatabase } from '@db/database';
import { getSecretBox } from '@/services';
import {
  buildBackup,
  openBackup,
  parseBackup,
  restoreBackup,
  sealBackup,
  type RestoreResult,
} from './backup';
import { looksEncrypted } from './backupSchema';

/**
 * Build the backup, write it to a cache file, and open the share sheet so the
 * user can save it to Drive/Files/etc. The file holds only non-secret settings.
 */
export async function exportBackup(now: number): Promise<void> {
  const backup = await buildBackup(getDatabase(), {
    exportedAt: now,
    appVersion: Constants.expoConfig?.version,
  });
  const json = JSON.stringify(backup, null, 2);
  const file = new File(Paths.cache, 'gator-backup.json');
  if (file.exists) file.delete();
  file.create();
  file.write(json);

  if (!(await Sharing.isAvailableAsync())) {
    if (file.exists) file.delete();
    throw new Error('sharing-unavailable');
  }
  try {
    await Sharing.shareAsync(file.uri, {
      mimeType: 'application/json',
      dialogTitle: 'Export Gator backup',
    });
  } finally {
    // Don't leave the plaintext export lingering in the cache directory.
    if (file.exists) file.delete();
  }
}

/** Validate + apply a backup pasted/loaded as raw JSON text. */
export async function importBackupText(text: string): Promise<RestoreResult> {
  const backup = parseBackup(text);
  return restoreBackup(getDatabase(), backup);
}

/**
 * Build, encrypt under `passphrase`, and share an encrypted backup file (.gatorbackup).
 * The cache file is deleted in a finally so nothing lingers. This is the secure default
 * — the encrypted blob is the only thing that leaves the device.
 */
export async function exportEncryptedBackup(passphrase: string, now: number): Promise<void> {
  const backup = await buildBackup(getDatabase(), {
    exportedAt: now,
    appVersion: Constants.expoConfig?.version,
  });
  const box = await getSecretBox();
  const sealed = await sealBackup(box, backup, passphrase);
  const file = new File(Paths.cache, 'gator-backup.gatorbackup');
  if (file.exists) file.delete();
  file.create();
  file.write(sealed);

  if (!(await Sharing.isAvailableAsync())) {
    if (file.exists) file.delete();
    throw new Error('sharing-unavailable');
  }
  try {
    await Sharing.shareAsync(file.uri, {
      mimeType: 'application/octet-stream',
      dialogTitle: 'Export Gator backup',
    });
  } finally {
    if (file.exists) file.delete();
  }
}

/** Decrypt + apply an encrypted backup. Throws on wrong passphrase / tamper / bad payload. */
export async function importEncryptedBackup(
  text: string,
  passphrase: string,
): Promise<RestoreResult> {
  const box = await getSecretBox();
  const backup = await openBackup(box, text.trim(), passphrase);
  return restoreBackup(getDatabase(), backup);
}

/**
 * Restore from pasted/loaded text, auto-detecting encrypted (.gatorbackup) vs legacy
 * plaintext JSON. Legacy plaintext needs no passphrase; encrypted requires it.
 */
export async function importBackupAuto(text: string, passphrase: string): Promise<RestoreResult> {
  return looksEncrypted(text) ? importEncryptedBackup(text, passphrase) : importBackupText(text);
}
