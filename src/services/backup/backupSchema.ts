import { z } from 'zod/v4';

/**
 * Import limits are intentionally generous for real settings-only backups, but finite for
 * untrusted files. The whole plaintext is validated before any restore write begins.
 *
 * `encodedCharacters` is larger than `plaintextBytes` because base64 expands ciphertext by
 * roughly one third. `fileBytes` also covers legacy plaintext JSON and a trailing newline.
 */
export const BACKUP_LIMITS = {
  fileBytes: 6 * 1024 * 1024,
  encodedCharacters: 6 * 1024 * 1024,
  plaintextCharacters: 4 * 1024 * 1024,
  plaintextBytes: 4 * 1024 * 1024,
  kvEntries: 10_000,
  themes: 500,
  chatCustomizations: 2_000,
  keyCharacters: 4_096,
  valueCharacters: 256 * 1024,
  themeNameCharacters: 256,
  themeModeCharacters: 32,
  themeTokensCharacters: 256 * 1024,
  chatGuidCharacters: 4_096,
  chatNameCharacters: 1_024,
  chatColorCharacters: 128,
  muteTypeCharacters: 64,
} as const;

export const MIN_NEW_BACKUP_PASSPHRASE_LENGTH = 12;

/**
 * A deliberately small, understandable block-list for NEW exports. This is not a password
 * strength estimator; it only catches especially predictable phrases that satisfy the length
 * rule. Imports do not call this rule, so an existing backup with a short/old passphrase remains
 * usable.
 */
const COMMON_BACKUP_PASSPHRASES: ReadonlySet<string> = new Set([
  '',
  '000000000000',
  '111111111111',
  '123456789012',
  'aaaaaaaaaaaa',
  'correct horse battery staple',
  'letmein123456',
  'password1234',
  'password12345',
  'password123456',
  'qwerty123456',
  'this is a password',
]);

export type NewBackupPassphraseIssue = 'too-short' | 'too-common';

function normalizePassphraseForComparison(passphrase: string): string {
  return passphrase.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function getNewBackupPassphraseIssue(passphrase: string): NewBackupPassphraseIssue | null {
  // Count user-visible Unicode code points and ignore padding at the ends; six emoji or three
  // letters surrounded by spaces must not masquerade as twelve characters.
  if (Array.from(passphrase.trim()).length < MIN_NEW_BACKUP_PASSPHRASE_LENGTH) return 'too-short';
  return COMMON_BACKUP_PASSPHRASES.has(normalizePassphraseForComparison(passphrase))
    ? 'too-common'
    : null;
}

/** Backup file format. version is bumped if the shape ever changes. */
export const BackupSchema = z.object({
  version: z.literal(1),
  exportedAt: z.number(),
  appVersion: z.string().max(128).optional(),
  kv: z
    .array(
      z.object({
        key: z.string().max(BACKUP_LIMITS.keyCharacters),
        value: z.string().max(BACKUP_LIMITS.valueCharacters).nullable(),
      }),
    )
    .max(BACKUP_LIMITS.kvEntries),
  themes: z
    .array(
      z.object({
        name: z.string().max(BACKUP_LIMITS.themeNameCharacters),
        mode: z.string().max(BACKUP_LIMITS.themeModeCharacters),
        tokens: z.string().max(BACKUP_LIMITS.themeTokensCharacters),
        isPreset: z.number().int().min(0).max(1).optional(),
      }),
    )
    .max(BACKUP_LIMITS.themes),
  chatCustomizations: z
    .array(
      z.object({
        guid: z.string().max(BACKUP_LIMITS.chatGuidCharacters),
        customName: z.string().max(BACKUP_LIMITS.chatNameCharacters).nullable(),
        customColor: z.string().max(BACKUP_LIMITS.chatColorCharacters).nullable(),
        muteType: z.string().max(BACKUP_LIMITS.muteTypeCharacters).nullable(),
        isPinned: z.number().int().min(0).max(1),
        isArchived: z.number().int().min(0).max(1),
      }),
    )
    .max(BACKUP_LIMITS.chatCustomizations),
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
 * The kv keys a backup is allowed to carry — the user's SETTINGS, and nothing else.
 *
 * An allow-list, not a deny-list, and the shape is the whole point. `kv` is a shared bag: the
 * settings below sit next to per-chat composer drafts and device-local bookkeeping, so
 * "everything except keys that look secret" exported all three. Concretely, that shipped:
 *   • `draft.<chat guid>` — the key embeds the counterparty's phone number or email and the value
 *     is UNSENT message text (the chat screen never deletes the row, it writes ''). That is
 *     message content and a handle in a file the user is told holds neither.
 *   • `sync.deletionsSyncedAt` — the deleted-message catch-up watermark. Restoring a backup taken
 *     on a more current device drags the target's watermark FORWARD, so the skipped window is
 *     never fetched and everything deleted on the Mac in it stays visible in the thread forever.
 *   • `maintenance.searchTextBackfill.v1` — a one-shot per-install migration flag.
 * A deny-list carries every FUTURE key by default, which is exactly how those three got in; an
 * allow-list fails closed, so a new device-local key is simply never exported. The cost is that a
 * new SETTING must be added here to be backed up — deliberately, the safe direction.
 *
 * Grouped by the store that owns each key; keys are duplicated as literals because those stores
 * import `@db/database` and must not be pulled into this pure, Node-testable module.
 */
const BACKUP_KV_KEYS: ReadonlySet<string> = new Set([
  // themeStore — the active PRESET only. `theme.custom` is a row id, meaningless anywhere else
  // (restored themes get fresh ids), which is why `restoreKv` has always skipped it.
  'theme.preset',
  // syncSettingsStore
  'sync.messagesPerChat',
  // featureSettingsStore — the boolean FLAGS…
  'privateApi.enabled',
  'privateApi.sendTypingIndicators',
  'privateApi.sendReadReceipts',
  'privateApi.sendSubjectLines',
  'attachments.autoDownload',
  'attachments.autoDownloadWifiOnly',
  'conversation.sendWithReturn',
  'conversation.showDeliveryTimestamps',
  'chatList.compact',
  'chatList.filterUnknownSenders',
  'notifications.messages',
  // Error-report consent is deliberately device-local and versioned. Restoring a backup must not
  // silently opt a fresh install in; current-device legacy choices migrate inside the store.
  // …and its typed value settings.
  'downloads.maxConcurrent',
  'attachments.autoDownloadDestination',
]);

/**
 * Whether a kv pair may cross the device boundary — in EITHER direction. Applied on export and
 * again on import: a backup file is untrusted input, so the same gate stops a hand-edited or
 * foreign file from planting a draft or shoving the deletion watermark forward on restore.
 * `isSecretKey` stays as the second line of defence, so a settings key that ever grew a
 * credential-ish name is dropped even though it is named above.
 */
export function isBackupKey(key: string): boolean {
  return BACKUP_KV_KEYS.has(key) && !isSecretKey(key);
}

/**
 * Distinguish an encrypted backup envelope (a base64 SecretBox blob) from a legacy
 * plaintext JSON backup (which always starts with `{`). Lets import auto-route.
 */
export function looksEncrypted(text: string): boolean {
  return !/^\s*\{/.test(text);
}
