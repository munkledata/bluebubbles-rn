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
  chatServiceCharacters: 128,
  chatIdentifierCharacters: 4_096,
  chatParticipantAddressCharacters: 4_096,
  chatParticipants: 512,
  chatNameCharacters: 1_024,
  chatColorCharacters: 128,
  muteTypeCharacters: 64,
} as const;

export const MIN_NEW_BACKUP_PASSPHRASE_LENGTH = 15;

/**
 * A deliberately finite, understandable blocklist for NEW exports. It covers common passwords,
 * predictable long variants, and app-specific guesses without imposing character-class rules.
 * Imports do not call this rule, so an existing backup with a short/old passphrase remains usable.
 */
const COMMON_BACKUP_PASSPHRASES: ReadonlySet<string> = new Set([
  '000000000000',
  '111111111111',
  '123456789012',
  'aaaaaaaaaaaa',
  'adminadminadmin',
  'backupbackupbackup',
  'bluebubbles1234',
  'bluebubblesbluebubbles',
  'changemechangeme',
  'correct horse battery staple',
  'dragon123456789',
  'footballfootball',
  'gatorbackup12345',
  'gatorgatorgator',
  'iloveyouiloveyou',
  'letmein123456',
  'letmeinletmein',
  'monkey123456789',
  'password password',
  'password1234',
  'password12345',
  'password123456',
  'password123456789',
  'passwordpassword',
  'qwerty123456',
  'qwerty123456789',
  'qwertyuiopasdfg',
  'this is a password',
  'welcome12345678',
]);

export type NewBackupPassphraseIssue = 'too-short' | 'too-common';

function normalizePassphraseForComparison(passphrase: string): string {
  return passphrase.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

export function getNewBackupPassphraseIssue(passphrase: string): NewBackupPassphraseIssue | null {
  // Count normalized Unicode code points and collapse whitespace padding that adds no useful
  // guessing resistance. Check the blocklist first so a familiar short password gets the more
  // useful rejection reason instead of only "too short."
  const normalized = normalizePassphraseForComparison(passphrase);
  if (normalized.length === 0) return 'too-short';
  if (COMMON_BACKUP_PASSPHRASES.has(normalized)) return 'too-common';
  return Array.from(normalized).length < MIN_NEW_BACKUP_PASSPHRASE_LENGTH ? 'too-short' : null;
}

const KvPairSchema = z.object({
  key: z.string().max(BACKUP_LIMITS.keyCharacters),
  value: z.string().max(BACKUP_LIMITS.valueCharacters).nullable(),
});

const ThemeSchema = z.object({
  name: z.string().max(BACKUP_LIMITS.themeNameCharacters),
  mode: z.string().max(BACKUP_LIMITS.themeModeCharacters),
  tokens: z.string().max(BACKUP_LIMITS.themeTokensCharacters),
  isPreset: z.number().int().min(0).max(1).optional(),
});

const ChatCustomizationShape = {
  customName: z.string().max(BACKUP_LIMITS.chatNameCharacters).nullable(),
  customColor: z.string().max(BACKUP_LIMITS.chatColorCharacters).nullable(),
  muteType: z.string().max(BACKUP_LIMITS.muteTypeCharacters).nullable(),
  isPinned: z.number().int().min(0).max(1),
  // Optional keeps pre-PIN-01 v1/v2 backups importable. Restore assigns legacy pins a stable rank.
  pinOrder: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  isArchived: z.number().int().min(0).max(1),
} as const;

/**
 * Version 1 is retained exactly for existing files. Restore can safely migrate a parseable direct
 * `service;-;address` GUID; group/opaque GUIDs carry too little identity evidence and are reported
 * as skipped instead of being guessed across Macs.
 */
const LegacyChatCustomizationSchema = z.object({
  guid: z.string().max(BACKUP_LIMITS.chatGuidCharacters),
  ...ChatCustomizationShape,
});

/**
 * Portable chat identity v1. Matching semantics are versioned separately from the outer backup so
 * a future normalizer can coexist with files produced today. Addresses remain lossless in the
 * file; restore normalizes both the backed-up and local values with the same version-1 rules.
 */
const PortableChatIdentitySchema = z.object({
  version: z.literal(1),
  service: z.string().max(BACKUP_LIMITS.chatServiceCharacters),
  kind: z.enum(['direct', 'group', 'unknown']),
  serverChatIdentifier: z.string().max(BACKUP_LIMITS.chatIdentifierCharacters).nullable(),
  participants: z
    .array(
      z.object({
        service: z.string().max(BACKUP_LIMITS.chatServiceCharacters),
        address: z.string().min(1).max(BACKUP_LIMITS.chatParticipantAddressCharacters),
      }),
    )
    .max(BACKUP_LIMITS.chatParticipants),
});

const PortableChatCustomizationSchema = z.object({
  identity: PortableChatIdentitySchema,
  ...ChatCustomizationShape,
});

const BackupCommonShape = {
  exportedAt: z.number(),
  appVersion: z.string().max(128).optional(),
  kv: z.array(KvPairSchema).max(BACKUP_LIMITS.kvEntries),
  themes: z.array(ThemeSchema).max(BACKUP_LIMITS.themes),
} as const;

export const BackupV1Schema = z.object({
  version: z.literal(1),
  ...BackupCommonShape,
  chatCustomizations: z.array(LegacyChatCustomizationSchema).max(BACKUP_LIMITS.chatCustomizations),
});

export const BackupV2Schema = z.object({
  version: z.literal(2),
  ...BackupCommonShape,
  chatCustomizations: z
    .array(PortableChatCustomizationSchema)
    .max(BACKUP_LIMITS.chatCustomizations),
});

/** New exports are v2; v1 remains accepted for GUID-only backward compatibility. */
export const BackupSchema = z.discriminatedUnion('version', [BackupV1Schema, BackupV2Schema]);

export type Backup = z.infer<typeof BackupSchema>;
export type BackupV1 = z.infer<typeof BackupV1Schema>;
export type BackupV2 = z.infer<typeof BackupV2Schema>;

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
 * Distinguish an encrypted backup envelope (legacy base64 or the BB2 text format) from a
 * plaintext JSON backup (which always starts with `{`). Lets import auto-route.
 */
export function looksEncrypted(text: string): boolean {
  return !/^\s*\{/.test(text);
}
