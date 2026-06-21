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
import { BackupSchema, isSecretKey, type Backup } from './backupSchema';

/**
 * Gather a backup of the user's settings (kv), custom themes, and per-chat
 * customizations. Pure data assembly (no file IO) so it is Node-testable.
 * SECURITY: secret-looking kv keys are filtered out — the export must never
 * contain a server password, auth token, or the DB encryption key (those live
 * in the SecureVault, never here).
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
    kv: kv.filter((p) => !isSecretKey(p.key)),
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
 */
export async function restoreBackup(db: AppDatabase, backup: Backup): Promise<RestoreResult> {
  const kv = backup.kv.filter((p) => !isSecretKey(p.key)); // defence-in-depth on import too
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
 * The isSecretKey filter in `restoreBackup` still runs on import, so the no-secrets
 * guarantee survives the encrypt/decrypt round-trip.
 */
export async function openBackup(
  box: SecretBox,
  sealed: string,
  passphrase: string,
): Promise<Backup> {
  return parseBackup(await box.open(sealed, passphrase));
}
