import {
  getAllKv,
  getAllThemes,
  getChatCustomizations,
  restoreChatCustomizations,
  restoreKv,
  restoreThemes,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import type { SecretBox } from '@core/crypto';
import { BackupSchema, isBackupKey, type Backup } from './backupSchema';

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
export async function restoreBackup(db: AppDatabase, backup: Backup): Promise<RestoreResult> {
  const kv = backup.kv.filter((p) => isBackupKey(p.key));
  await restoreKv(db, kv);
  await restoreThemes(
    db,
    backup.themes.map((t) => ({ ...t, isPreset: 0 })),
  );
  const applied = await restoreChatCustomizations(db, backup.chatCustomizations);
  return { kv: kv.length, themes: backup.themes.length, chatCustomizations: applied };
}

/** Parse + validate raw JSON text into a Backup (throws ZodError on bad input). */
export function parseBackup(text: string): Backup {
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
  return box.seal(JSON.stringify(backup), passphrase);
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
  return parseBackup(await box.open(sealed, passphrase));
}
