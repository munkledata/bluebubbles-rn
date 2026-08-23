import {
  getAllKv,
  getAllThemes,
  getChatCustomizations,
  restoreChatCustomizations,
  restoreKv,
  restoreThemes,
} from '@db/repositories';
import { DbCommitGuardRejectedError, type DbCommitGuard } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import type { SecretBox } from '@core/crypto';
import { utf8Encode } from '@utils/bytes';
import { BACKUP_LIMITS, BackupSchema, isBackupKey, type Backup } from './backupSchema';

export type BackupInputLimitKind =
  'file-size-unavailable' | 'file-too-large' | 'encoded-too-large' | 'plaintext-too-large';

/** A stable, user-safe failure for an input rejected before expensive decode/parse work. */
export class BackupInputLimitError extends Error {
  constructor(readonly kind: BackupInputLimitKind) {
    super(`backup-input-limit:${kind}`);
    this.name = 'BackupInputLimitError';
  }
}

/** Fail closed before reading a user-selected file into a JS string. */
export function assertBackupFileSize(size: number | null): void {
  if (size === null || !Number.isFinite(size) || size < 0) {
    throw new BackupInputLimitError('file-size-unavailable');
  }
  if (size > BACKUP_LIMITS.fileBytes) throw new BackupInputLimitError('file-too-large');
}

/** Bound either pasted text or a just-read file before base64 decode / route detection. */
export function assertBackupSourceTextWithinLimit(text: string): void {
  if (text.length > BACKUP_LIMITS.encodedCharacters) {
    throw new BackupInputLimitError('encoded-too-large');
  }
}

/** Bound decrypted or legacy plaintext before JSON.parse's object-allocation amplification. */
export function assertBackupPlaintextWithinLimit(text: string): void {
  if (
    text.length > BACKUP_LIMITS.plaintextCharacters ||
    utf8Encode(text).length > BACKUP_LIMITS.plaintextBytes
  ) {
    throw new BackupInputLimitError('plaintext-too-large');
  }
}

/** Validate app-built data too, so a newly exported file is guaranteed to be importable. */
export function serializeBackup(backup: Backup, indent?: number): string {
  const serialized = JSON.stringify(BackupSchema.parse(backup), null, indent);
  assertBackupPlaintextWithinLimit(serialized);
  return serialized;
}

/**
 * Gather a backup of the user's settings (kv), custom themes, and per-chat
 * customizations. Pure data assembly (no file IO) so it is Node-testable.
 * SECURITY: kv is exported through the `isBackupKey` ALLOW-list, so only named
 * settings leave the device — never a credential (those live in the SecureVault),
 * never a per-chat draft (unsent text, keyed by the counterparty's address), and
 * never device-local sync bookkeeping. See `backupSchema.ts` for why the list is
 * inverted rather than a deny-list.
 */
export async function buildBackup(
  db: AppDatabase,
  opts: { exportedAt: number; appVersion?: string },
): Promise<Backup> {
  const [kv, themes, chatCustomizations] = await Promise.all([
    getAllKv(db),
    getAllThemes(db),
    getChatCustomizations(db),
  ]);
  return {
    version: 1,
    exportedAt: opts.exportedAt,
    appVersion: opts.appVersion,
    kv: kv.filter((p) => isBackupKey(p.key)),
    themes,
    chatCustomizations,
  };
}

export interface RestoreResult {
  kv: number;
  themes: number;
  chatCustomizations: number;
}

/**
 * Apply a validated backup. kv + themes are upserted; chat customizations are
 * applied only to chats that already exist locally. Node-testable.
 *
 * The kv allow-list runs again on IMPORT: a backup file is untrusted input (hand-edited, or made
 * by another install), and re-gating it here is what stops one from planting a composer draft or
 * pushing this device's deletion watermark past messages it has not caught up on yet.
 */
function assertRestoreOwned(ownershipGuard?: DbCommitGuard): void {
  if (ownershipGuard && !ownershipGuard()) throw new DbCommitGuardRejectedError();
}

export async function restoreBackup(
  db: AppDatabase,
  backup: Backup,
  ownershipGuard?: DbCommitGuard,
): Promise<RestoreResult> {
  const kv = backup.kv.filter((p) => isBackupKey(p.key));
  assertRestoreOwned(ownershipGuard);
  await restoreKv(db, kv, ownershipGuard);
  assertRestoreOwned(ownershipGuard);
  await restoreThemes(
    db,
    backup.themes.map((t) => ({ ...t, isPreset: 0 })),
    ownershipGuard,
  );
  assertRestoreOwned(ownershipGuard);

  // Chat GUIDs are server-account identities even though two servers can emit the same bytes.
  // The repository owns one short transaction per row (guarded when this import is account-bound),
  // so neither an ordinary restore nor an untrusted large backup can join/hold a neighbouring lock.
  const applied = await restoreChatCustomizations(db, backup.chatCustomizations, ownershipGuard);
  assertRestoreOwned(ownershipGuard);
  return { kv: kv.length, themes: backup.themes.length, chatCustomizations: applied };
}

/** Parse + validate bounded raw JSON text into a Backup (throws on size, JSON, or schema errors). */
export function parseBackup(text: string): Backup {
  assertBackupPlaintextWithinLimit(text);
  return parseSizeCheckedBackup(text);
}

function parseSizeCheckedBackup(text: string): Backup {
  return BackupSchema.parse(JSON.parse(text));
}

/**
 * Seal a backup into an encrypted, base64 envelope under a user passphrase
 * (XChaCha20-Poly1305 + Argon2id, via SecretBox). The `box` is injected so this stays
 * pure + Node-testable. The encrypted envelope is the ONLY thing that should leave the
 * device (an unencrypted backup on cloud storage would defeat the protection).
 */
export async function sealBackup(
  box: SecretBox,
  backup: Backup,
  passphrase: string,
): Promise<string> {
  const plaintext = serializeBackup(backup);
  return box.seal(plaintext, passphrase);
}

/**
 * Open + validate an encrypted backup envelope. Throws on a wrong passphrase or tamper
 * (authenticated decryption) and on a malformed/old inner payload (parseBackup → zod).
 * The `isBackupKey` allow-list in `restoreBackup` still runs on import, so the
 * settings-only guarantee survives the encrypt/decrypt round-trip.
 */
export async function openBackup(
  box: SecretBox,
  sealed: string,
  passphrase: string,
): Promise<Backup> {
  // SecretBox's base64 decoder allocates a byte buffer. Reject over-sized text before entering it.
  assertBackupSourceTextWithinLimit(sealed);
  const plaintext = await box.open(sealed.trim(), passphrase);
  // Authenticated decryption proves integrity, not size. Bound the result before JSON.parse.
  assertBackupPlaintextWithinLimit(plaintext);
  return parseSizeCheckedBackup(plaintext);
}
