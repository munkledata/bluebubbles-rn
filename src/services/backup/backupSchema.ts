import { z } from 'zod';

/** Backup file format. version is bumped if the shape ever changes. */
export const BackupSchema = z.object({
  version: z.literal(1),
  exportedAt: z.number(),
  appVersion: z.string().optional(),
  kv: z.array(z.object({ key: z.string(), value: z.string().nullable() })),
  themes: z.array(
    z.object({
      name: z.string(),
      mode: z.string(),
      tokens: z.string(),
      isPreset: z.number().optional(),
    }),
  ),
  chatCustomizations: z.array(
    z.object({
      guid: z.string(),
      customName: z.string().nullable(),
      customColor: z.string().nullable(),
      muteType: z.string().nullable(),
      isPinned: z.number(),
      isArchived: z.number(),
    }),
  ),
});

export type Backup = z.infer<typeof BackupSchema>;

/**
 * A kv key that might hold a secret. Backups must NEVER export these — secrets
 * live in the Keystore-backed SecureVault, not kv, but this is a hard guard
 * against a future key leaking a credential/token into the plaintext export.
 */
// Broad on purpose: any key containing a credential-ish word is excluded from the
// export. "key" is matched anywhere (catches api_key, apiKey, encryptionKey, …).
const SECRET_KEY_RE = /password|passwd|token|secret|credential|auth|key/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

/**
 * Distinguish an encrypted backup envelope (a base64 SecretBox blob) from a legacy
 * plaintext JSON backup (which always starts with `{`). Lets import auto-route.
 */
export function looksEncrypted(text: string): boolean {
  return !/^\s*\{/.test(text);
}
