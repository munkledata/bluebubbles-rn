import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import Constants from 'expo-constants';
import { getDatabase } from '@db/database';
import { getSecretBox } from '../clients';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
  type RealtimeDeliveryLease,
} from '../realtime/deliveryCoordinator';
import {
  assertBackupFileSize,
  assertBackupSourceTextWithinLimit,
  buildBackup,
  openBackup,
  parseBackup,
  restoreBackup,
  sealBackup,
  serializeBackup,
  type RestoreResult,
} from './backup';
import {
  getNewBackupPassphraseIssue,
  looksEncrypted,
  type Backup,
  type NewBackupPassphraseIssue,
} from './backupSchema';

const ACCOUNT_CHANGED_MESSAGE = 'backup-account-changed';
let backupFileSequence = 0;

/** Expected cancellation when a backup screen outlives the account that opened it. */
export class BackupAccountChangedError extends Error {
  constructor() {
    super(ACCOUNT_CHANGED_MESSAGE);
    this.name = 'BackupAccountChangedError';
  }
}

export function isBackupAccountChangedError(error: unknown): boolean {
  return error instanceof BackupAccountChangedError;
}

/** A programming/UI boundary error: only NEW exports are subject to the stronger rule. */
export class BackupPassphraseRejectedError extends Error {
  constructor(readonly issue: NewBackupPassphraseIssue) {
    super(`backup-passphrase-rejected:${issue}`);
    this.name = 'BackupPassphraseRejectedError';
  }
}

function assertCurrent(lease: RealtimeDeliveryLease): void {
  if (!lease.isCurrent()) throw new BackupAccountChangedError();
}

/** Read account-owned rows in a short tracked slot, then disown the result if Disconnect won. */
async function buildCurrentBackup(now: number, lease: RealtimeDeliveryLease): Promise<Backup> {
  const built: { value?: Backup } = {};
  const outcome = await runTrackedRealtimeWork(lease, async (activeLease) => {
    assertCurrent(activeLease);
    const db = getDatabase();
    assertCurrent(activeLease);
    const candidate = await buildBackup(db, {
      exportedAt: now,
      appVersion: Constants.expoConfig?.version,
    });
    assertCurrent(activeLease);
    built.value = candidate;
  });
  if (outcome === 'paused' || built.value === undefined) throw new BackupAccountChangedError();
  assertCurrent(lease);
  return built.value;
}

/**
 * Apply the complete mutation in one teardown-visible slot. The low-level restore uses the same
 * immutable lease as a last-moment commit guard for account-owned chat customizations.
 */
async function restoreCurrentBackup(
  backup: Backup,
  lease: RealtimeDeliveryLease,
): Promise<RestoreResult> {
  const restored: { value?: RestoreResult } = {};
  try {
    const outcome = await runTrackedRealtimeWork(lease, async (activeLease) => {
      assertCurrent(activeLease);
      const db = getDatabase();
      assertCurrent(activeLease);
      restored.value = await restoreBackup(db, backup, () => activeLease.isCurrent());
      assertCurrent(activeLease);
    });
    if (outcome === 'paused' || restored.value === undefined) throw new BackupAccountChangedError();
    assertCurrent(lease);
    return restored.value;
  } catch (error) {
    // A DB commit guard has its own error type. At this boundary the lease is the authority, so
    // normalize every ownership loss to the quiet cancellation understood by the screen.
    if (!lease.isCurrent()) throw new BackupAccountChangedError();
    throw error;
  }
}

function nextBackupFileName(now: number, lease: RealtimeDeliveryLease, extension: string): string {
  backupFileSequence += 1;
  return `gator-backup-${lease.generation}-${now}-${backupFileSequence}.${extension}`;
}

function deleteGeneratedFile(file: File): void {
  try {
    if (file.exists) file.delete();
  } catch {
    // Cleanup is best-effort. In particular, never replace BackupAccountChangedError in a finally:
    // the retired screen must stay quiet even if Android has already reclaimed its picker cache.
  }
}

/**
 * Read the private cache copy produced by DocumentPicker and always remove it. File IO is not
 * account mutation, so this deliberately stays outside the teardown drain; the immutable screen
 * lease rejects a result that returns after Disconnect.
 */
export async function readPickedBackupCopy(
  uri: string,
  lease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<string> {
  const file = new File(uri);
  try {
    assertCurrent(lease);
    // `File.text()` has no streaming/capped form. Stat the private picker copy first so a hostile
    // document cannot be materialized as an unbounded JS string.
    assertBackupFileSize(file.size);
    const content = await file.text();
    assertCurrent(lease);
    // Defend against a stale/inaccurate stat (or a file changed between stat and read).
    assertBackupSourceTextWithinLimit(content);
    return content.trim();
  } finally {
    deleteGeneratedFile(file);
  }
}

/**
 * Atomically re-check ownership and INVOKE the native share sheet, without awaiting the sheet in
 * the tracked slot. Disconnect must not sit behind a user-controlled OS dialog, but a delayed A
 * export must also never open that dialog after B has connected.
 */
async function shareGeneratedFile(
  file: File,
  options: { mimeType: string; dialogTitle: string },
  lease: RealtimeDeliveryLease,
): Promise<void> {
  let sharePromise: Promise<void> | undefined;
  const outcome = await runTrackedRealtimeWork(lease, async (activeLease) => {
    assertCurrent(activeLease);
    sharePromise = Sharing.shareAsync(file.uri, options);
    // Attach a handler in the same turn. We await the original promise below, but this prevents a
    // very fast native rejection from briefly becoming unhandled while the tracked slot settles.
    void sharePromise.catch(() => {});
  });
  if (outcome === 'paused' || sharePromise === undefined) throw new BackupAccountChangedError();
  await sharePromise;
  assertCurrent(lease);
}

/**
 * Build the backup, write it to a cache file, and open the share sheet so the
 * user can save it to Drive/Files/etc. The file holds only non-secret settings.
 */
export async function exportBackup(
  now: number,
  lease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<void> {
  const backup = await buildCurrentBackup(now, lease);
  const json = serializeBackup(backup, 2);
  const sharingAvailable = await Sharing.isAvailableAsync();
  assertCurrent(lease);
  if (!sharingAvailable) throw new Error('sharing-unavailable');

  const file = new File(Paths.cache, nextBackupFileName(now, lease, 'json'));
  try {
    assertCurrent(lease);
    if (file.exists) file.delete();
    file.create();
    file.write(json);
    assertCurrent(lease);
    await shareGeneratedFile(
      file,
      {
        mimeType: 'application/json',
        dialogTitle: 'Export Gator backup',
      },
      lease,
    );
  } finally {
    // Don't leave the plaintext export lingering in the cache directory.
    deleteGeneratedFile(file);
  }
}

/** Validate + apply a backup pasted/loaded as raw JSON text. */
export async function importBackupText(
  text: string,
  lease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<RestoreResult> {
  assertCurrent(lease);
  const backup = parseBackup(text);
  return restoreCurrentBackup(backup, lease);
}

/**
 * Build, encrypt under `passphrase`, and share an encrypted backup file (.gatorbackup).
 * The cache file is deleted in a finally so nothing lingers. This is the secure default
 * — the encrypted blob is the only thing that leaves the device.
 */
export async function exportEncryptedBackup(
  passphrase: string,
  now: number,
  lease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<void> {
  assertCurrent(lease);
  const passphraseIssue = getNewBackupPassphraseIssue(passphrase);
  if (passphraseIssue) throw new BackupPassphraseRejectedError(passphraseIssue);
  const backup = await buildCurrentBackup(now, lease);
  const box = await getSecretBox();
  const sealed = await sealBackup(box, backup, passphrase);
  assertCurrent(lease);
  const sharingAvailable = await Sharing.isAvailableAsync();
  assertCurrent(lease);
  if (!sharingAvailable) throw new Error('sharing-unavailable');

  const file = new File(Paths.cache, nextBackupFileName(now, lease, 'gatorbackup'));
  try {
    assertCurrent(lease);
    if (file.exists) file.delete();
    file.create();
    file.write(sealed);
    assertCurrent(lease);
    await shareGeneratedFile(
      file,
      {
        mimeType: 'application/octet-stream',
        dialogTitle: 'Export Gator backup',
      },
      lease,
    );
  } finally {
    deleteGeneratedFile(file);
  }
}

/** Decrypt + apply an encrypted backup. Throws on wrong passphrase / tamper / bad payload. */
export async function importEncryptedBackup(
  text: string,
  passphrase: string,
  lease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<RestoreResult> {
  assertCurrent(lease);
  const box = await getSecretBox();
  const backup = await openBackup(box, text.trim(), passphrase);
  assertCurrent(lease);
  return restoreCurrentBackup(backup, lease);
}

/**
 * Restore from pasted/loaded text, auto-detecting encrypted (.gatorbackup) vs legacy
 * plaintext JSON. Legacy plaintext needs no passphrase; encrypted requires it.
 */
export async function importBackupAuto(
  text: string,
  passphrase: string,
  lease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<RestoreResult> {
  assertCurrent(lease);
  assertBackupSourceTextWithinLimit(text);
  return looksEncrypted(text)
    ? importEncryptedBackup(text, passphrase, lease)
    : importBackupText(text, lease);
}
