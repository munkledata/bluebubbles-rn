import { eq, sql } from 'drizzle-orm';
import { chats } from '../schema';
import {
  runInTransactionContext,
  type DbCommitGuard,
  type DbTransactionContext,
  withDbTransaction,
} from '../transaction';
import type { AppDatabase } from '../types';
import {
  MAX_CUSTOM_FOLDER_CHAT_GUID_CODE_POINTS,
  MAX_CUSTOM_FOLDER_MEMBERS,
  MAX_CUSTOM_FOLDER_NAME_CODE_POINTS,
  MAX_CUSTOM_FOLDERS,
  normalizeCustomFolderName,
} from './customFolders';
import { kvSetWithinTransaction, THEME_CUSTOM_KEY } from './kv';

// ---- Backup / restore reads + writes (settings, themes, chat customizations, custom folders) ----

export interface KvPair {
  key: string;
  value: string | null;
}
export interface ThemeRow {
  name: string;
  mode: string;
  tokens: string;
  isPreset: number;
}
export interface ChatCustomizationRow {
  guid: string;
  customName: string | null;
  customColor: string | null;
  muteType: string | null;
  isPinned: number;
  /** Optional only for legacy backup callers that predate PIN-01. */
  pinOrder?: number | null;
  isArchived: number;
}
export interface PortableChatParticipant {
  service: string;
  address: string;
}
export interface PortableChatIdentityRow {
  version: 1;
  service: string;
  kind: 'direct' | 'group' | 'unknown';
  serverChatIdentifier: string | null;
  participants: PortableChatParticipant[];
}
export interface PortableChatCustomizationRow {
  identity: PortableChatIdentityRow;
  customName: string | null;
  customColor: string | null;
  muteType: string | null;
  isPinned: number;
  pinOrder: number | null;
  isArchived: number;
}

interface ChatCustomizationExportRow extends Omit<ChatCustomizationRow, 'guid'> {
  chatId: number;
  guid: string;
  chatIdentifier: string | null;
  style: number | null;
  participantAddress: string | null;
  participantService: string | null;
}

const MAX_BACKUP_CUSTOM_FOLDER_IDENTITIES = 10_000;
const MAX_BACKUP_CUSTOM_FOLDER_ASSOCIATIONS = 25_000;
const MAX_BACKUP_CHAT_PARTICIPANTS = 512;
// Apply coarse SQL allocation caps before JSON aggregation. The JavaScript check below then
// mirrors BackupV3Schema's exact UTF-16 string-length semantics without truncating evidence.
const MAX_BACKUP_CHAT_SERVICE_CHARACTERS = 128;
const MAX_BACKUP_CHAT_IDENTIFIER_CHARACTERS = 4_096;
const MAX_BACKUP_CHAT_PARTICIPANT_ADDRESS_CHARACTERS = 4_096;
const DEFAULT_BACKUP_MAX_RAW_BYTES = 4 * 1024 * 1024;
const ESTIMATED_JSON_BYTES_PER_CUSTOM_FOLDER = 96;
const ESTIMATED_JSON_BYTES_PER_CUSTOM_FOLDER_ASSOCIATION = 12;
const ESTIMATED_JSON_BYTES_PER_CUSTOM_FOLDER_IDENTITY = 128;

interface CustomFolderExportLimits {
  maxRawBytes: number;
  chatServiceCharacters: number;
  chatIdentifierCharacters: number;
  chatParticipantAddressCharacters: number;
  chatParticipants: number;
}

const DEFAULT_CUSTOM_FOLDER_EXPORT_LIMITS: CustomFolderExportLimits = {
  maxRawBytes: DEFAULT_BACKUP_MAX_RAW_BYTES,
  chatServiceCharacters: MAX_BACKUP_CHAT_SERVICE_CHARACTERS,
  chatIdentifierCharacters: MAX_BACKUP_CHAT_IDENTIFIER_CHARACTERS,
  chatParticipantAddressCharacters: MAX_BACKUP_CHAT_PARTICIPANT_ADDRESS_CHARACTERS,
  chatParticipants: MAX_BACKUP_CHAT_PARTICIPANTS,
};

interface CustomFolderHeaderProbeRow {
  folderId: number;
  invalidTypeCount: number;
  nameCharacters: number;
  nameBytes: number;
  nameJsonBytes: number;
}

interface CustomFolderHeaderExportRow {
  folderId: number;
  name: string;
  showUnreadBadge: number;
}

interface CustomFolderMemberCountProbeRow {
  rowCount: number;
}

interface CustomFolderMemberProbeRow {
  folderId: number;
  chatId: number | null;
  invalidTypeCount: number;
  guidCharacters: number;
  guidBytes: number;
  hasNullCharacter: number;
}

interface CustomFolderIdentityProbeRow {
  chatId: number;
  invalidTypeCount: number;
  guidCharacters: number;
  guidBytes: number;
  identifierCharacters: number;
  identifierBytes: number;
  identifierJsonBytes: number;
  hasKnownKind: number;
  identifierHasContent: number;
  participantStatsJson: string;
}

interface CustomFolderIdentityExportRow {
  chatId: number;
  guid: string;
  chatIdentifier: string | null;
  style: number | null;
  participantsJson: string;
}

interface CustomFolderPortableIdentityRow {
  chatId: number;
  identity: PortableChatIdentityRow;
}

interface CustomFolderBackupExportRows {
  folders: CustomFolderHeaderExportRow[];
  members: Array<Pick<CustomFolderMemberProbeRow, 'folderId' | 'chatId'>>;
  identities: CustomFolderPortableIdentityRow[];
}

export interface CustomFolderBackupRow {
  name: string;
  showUnreadBadge: 0 | 1;
  sourceMemberCount: number;
  memberIndexes: number[];
}

export interface CustomFolderBackupData {
  customFolderChatIdentities: PortableChatIdentityRow[];
  customFolders: CustomFolderBackupRow[];
}

export interface BackupBaseExportData {
  kv: KvPair[];
  themes: ThemeRow[];
  chatCustomizations: PortableChatCustomizationRow[];
}

export interface BackupV3ExportData extends BackupBaseExportData, CustomFolderBackupData {}

/** SQL fragments are composed into the single restore statement below. */
const BACKUP_PHONE_COMPACT_SQL = sql`
  REPLACE(
    REPLACE(
      REPLACE(
        REPLACE(REPLACE(REPLACE(raw_address, ' ', ''), '+', ''), '-', ''),
        '(',
        ''
      ),
      ')',
      ''
    ),
    '.',
    ''
  )
`;

const BACKUP_NORMALIZED_ADDRESS_SQL = sql`
  CASE
    WHEN INSTR(raw_address, '@') > 0 THEN LOWER(raw_address)
    WHEN phone_compact <> '' AND phone_compact NOT GLOB '*[^0-9]*'
      THEN CASE
        WHEN LENGTH(phone_compact) = 11 AND SUBSTR(phone_compact, 1, 1) = '1'
          THEN SUBSTR(phone_compact, 2)
        ELSE phone_compact
      END
    ELSE raw_address
  END
`;

function portableChatKind(
  style: number | null,
  guid: string,
  participantCount: number,
): 'direct' | 'group' | 'unknown' {
  if (style === 43) return 'group';
  if (style === 45) return 'direct';
  const marker = guid.split(';', 3)[1];
  if (marker === '+') return 'group';
  if (marker === '-') return 'direct';
  if (participantCount > 1) return 'group';
  if (participantCount === 1) return 'direct';
  return 'unknown';
}

/** Keep export service identity byte-for-byte aligned with the case-insensitive restore SQL. */
function portableChatService(
  guid: string,
  participantServices: readonly string[],
): 'iMessage' | 'SMS' | 'RCS' {
  const guidPrefix = guid.slice(0, 6).toLowerCase();
  if (guidPrefix === 'rcs;-;') return 'RCS';
  if (guidPrefix === 'sms;-;') return 'SMS';

  const namedServices = participantServices
    .map((service) => service.trim().toLowerCase())
    .filter((service) => service.length > 0);
  if (namedServices.length > 0 && namedServices.every((service) => service === 'sms')) return 'SMS';
  return 'iMessage';
}

function buildPortableChatIdentity(
  guid: string,
  chatIdentifier: string | null,
  style: number | null,
  participants: PortableChatParticipant[],
): PortableChatIdentityRow {
  return {
    version: 1,
    service: portableChatService(
      guid,
      participants.map((participant) => participant.service),
    ),
    kind: portableChatKind(style, guid, participants.length),
    serverChatIdentifier: chatIdentifier?.trim() || null,
    participants,
  };
}

function hasPortableRestoreEvidence(identity: PortableChatIdentityRow): boolean {
  return (
    identity.kind !== 'unknown' &&
    (identity.serverChatIdentifier !== null || identity.participants.length > 0)
  );
}

/**
 * Validated backup rows serialized before the caller takes the process-wide DB lock.
 *
 * Keeping the bounded JSON preparation outside the transaction lets the transaction execute a
 * fixed number of set-based statements instead of holding the mutex across a JavaScript row loop.
 */
export interface PreparedBackupRestore {
  kvJson: string;
  themesJson: string;
  chatCustomizationsJson: string;
  customFolderChatIdentitiesJson: string;
  customFoldersJson: string;
}

export interface PreparedBackupRestoreResult {
  chatCustomizations: number;
  customFolders: number;
  customFolderMemberships: number;
}

/**
 * Every kv pair, unfiltered. `kv` also holds per-chat composer drafts and device-local sync
 * bookkeeping, so a generic CALLER decides what may leave the device. Backup export uses the
 * bounded allowlisted snapshot reader below; nothing here may import that service-owned policy
 * because `src/db` must not reach into `src/services`.
 */
export async function getAllKv(db: AppDatabase): Promise<KvPair[]> {
  return db.all<KvPair>(sql`SELECT key, value FROM kv ORDER BY key`);
}

/**
 * User-created themes only (built-in presets are code, not rows).
 *
 * `ORDER BY id` matters beyond tidiness: a backup carries no ids, so `restoreThemes` pairs entries
 * with rows positionally within each (name, mode) group. Exporting in id order — the same order
 * the restore cursor uses — is what keeps two same-named themes from swapping palettes on a
 * restore back onto the device they came from.
 */
export async function getAllThemes(db: AppDatabase): Promise<ThemeRow[]> {
  return db.all<ThemeRow>(
    sql`SELECT name, mode, tokens, is_preset AS isPreset FROM themes WHERE is_preset = 0 ORDER BY id`,
  );
}

/**
 * Chats that carry any local customization worth backing up.
 *
 * `marked_unread_at` and `deleted_at` are deliberately NOT among the columns, in either direction.
 * They are per-device STATE, not settings: a stale `deleted_at` carried in from a backup would
 * hide a conversation this device is actively using (the tombstone also floors the unread count),
 * and a backup taken before a deletion would, if it wrote the column back as NULL, RESURRECT every
 * conversation the user had deleted since. Same reasoning that keeps both columns out of
 * `upsertChats`' conflict set — a foreign source of truth must not get a vote on them.
 */
export async function getChatCustomizations(
  db: AppDatabase,
): Promise<PortableChatCustomizationRow[]> {
  return buildPortableChatCustomizations(await readChatCustomizationExportRows(db));
}

async function readChatCustomizationExportRows(
  db: AppDatabase,
): Promise<ChatCustomizationExportRow[]> {
  return db.all<ChatCustomizationExportRow>(sql`
    SELECT c.id AS chatId, c.guid, c.chat_identifier AS chatIdentifier, c.style,
           c.custom_name AS customName, c.custom_color AS customColor,
           c.mute_type AS muteType, c.is_pinned AS isPinned, c.pin_order AS pinOrder,
           c.is_archived AS isArchived,
           h.address AS participantAddress, h.service AS participantService
      FROM chats AS c
      LEFT JOIN chat_handles AS ch ON ch.chat_id = c.id
      LEFT JOIN handles AS h ON h.id = ch.handle_id
     WHERE c.custom_name IS NOT NULL OR c.custom_color IS NOT NULL OR c.mute_type IS NOT NULL
        OR c.is_pinned = 1 OR c.is_archived = 1
     ORDER BY c.id, h.id
  `);
}

function buildPortableChatCustomizations(
  rows: readonly ChatCustomizationExportRow[],
): PortableChatCustomizationRow[] {
  const grouped = new Map<
    number,
    {
      customization: PortableChatCustomizationRow;
      participants: Set<string>;
      guid: string;
      style: number | null;
    }
  >();
  for (const row of rows) {
    let group = grouped.get(row.chatId);
    if (!group) {
      group = {
        customization: {
          identity: {
            version: 1,
            service: 'iMessage',
            kind: 'unknown',
            serverChatIdentifier: row.chatIdentifier?.trim() || null,
            participants: [],
          },
          customName: row.customName,
          customColor: row.customColor,
          muteType: row.muteType,
          isPinned: row.isPinned,
          pinOrder: row.pinOrder ?? null,
          isArchived: row.isArchived,
        },
        participants: new Set(),
        guid: row.guid,
        style: row.style,
      };
      grouped.set(row.chatId, group);
    }

    if (row.participantAddress !== null && row.participantAddress.length > 0) {
      const participant = {
        service: row.participantService ?? '',
        address: row.participantAddress,
      };
      const key = JSON.stringify([participant.service, participant.address]);
      if (!group.participants.has(key)) {
        group.participants.add(key);
        group.customization.identity.participants.push(participant);
      }
    }
  }
  return [...grouped.values()].map(({ customization, guid, style }) => {
    const participants = customization.identity.participants;
    return {
      ...customization,
      identity: buildPortableChatIdentity(
        guid,
        customization.identity.serverChatIdentifier,
        style,
        participants,
      ),
    };
  });
}

interface BackupBaseExportRows {
  kv: KvPair[];
  themes: ThemeRow[];
  chatCustomizations: BoundedChatCustomizationExportRow[];
  estimatedBytes: number;
}

/**
 * Service-owned schema limits passed down to the snapshot reader. Keeping this structural contract
 * here avoids an architecture-breaking db -> service import while preventing the two layers from
 * silently drifting apart.
 */
export interface BackupExportLimits {
  kvKeys: readonly string[];
  maxRawBytes: number;
  kvEntries: number;
  themes: number;
  chatCustomizations: number;
  keyCharacters: number;
  valueCharacters: number;
  themeNameCharacters: number;
  themeModeCharacters: number;
  themeTokensCharacters: number;
  chatGuidCharacters: number;
  chatServiceCharacters: number;
  chatIdentifierCharacters: number;
  chatParticipantAddressCharacters: number;
  chatParticipants: number;
  chatNameCharacters: number;
  chatColorCharacters: number;
  muteTypeCharacters: number;
}

interface KvExportProbeRow {
  rowCount: number;
  invalidTypeCount: number;
  rawBytes: number;
  maxKeyCharacters: number;
  maxKeyBytes: number;
  maxValueCharacters: number;
  maxValueBytes: number;
}

interface ThemeExportProbeRow {
  rowCount: number;
  invalidTypeCount: number;
  rawBytes: number;
  maxNameCharacters: number;
  maxNameBytes: number;
  maxModeCharacters: number;
  maxModeBytes: number;
  maxTokensCharacters: number;
  maxTokensBytes: number;
}

interface ChatCustomizationProbeRow {
  chatId: number;
  invalidTypeCount: number;
  metadataRawBytes: number;
  guidCharacters: number;
  guidBytes: number;
  identifierCharacters: number;
  identifierBytes: number;
  customNameCharacters: number;
  customNameBytes: number;
  customColorCharacters: number;
  customColorBytes: number;
  muteTypeCharacters: number;
  muteTypeBytes: number;
  participantStatsJson: string;
}

interface ParticipantProbeStats {
  linkCount: number;
  count: number;
  invalidTypeCount: number;
  rawBytes: number;
  maxServiceCharacters: number;
  maxServiceBytes: number;
  maxAddressCharacters: number;
  maxAddressBytes: number;
}

interface ParticipantBudgetProbeRow {
  chatId: number;
  participantStatsJson: string;
}

interface ParticipantBudgetStats {
  count: number;
  jsonBytes: number;
}

interface BoundedChatCustomizationExportRow extends Omit<
  ChatCustomizationExportRow,
  'participantAddress' | 'participantService'
> {
  participantsJson: string;
}

const MAX_UTF8_BYTES_PER_SQL_CHARACTER = 4;
const ESTIMATED_JSON_BYTES_PER_KV_ENTRY = 32;
const ESTIMATED_JSON_BYTES_PER_THEME = 64;
const ESTIMATED_JSON_BYTES_PER_CHAT_CUSTOMIZATION = 192;

function assertBackupExportLimits(limits: BackupExportLimits): void {
  const numericLimits = Object.entries(limits).filter(([name]) => name !== 'kvKeys');
  if (
    numericLimits.some(
      ([, value]) => typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0,
    )
  ) {
    throw new Error('Backup export limits are invalid.');
  }
  if (
    limits.kvKeys.length > limits.kvEntries ||
    new Set(limits.kvKeys).size !== limits.kvKeys.length ||
    limits.kvKeys.some((key) => key.length === 0 || key.length > limits.keyCharacters)
  ) {
    throw new Error('Backup export key allow-list is invalid.');
  }
}

function requireProbeRow<T>(rows: readonly T[], label: string): T {
  const row = rows[0];
  if (!row) throw new Error(`Backup export ${label} probe returned no result.`);
  return row;
}

function requireProbeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Backup export ${label} probe is invalid.`);
  }
  return value;
}

function assertProbeStringBound(
  characters: unknown,
  bytes: unknown,
  maxCharacters: number,
  label: string,
): void {
  if (
    requireProbeInteger(characters, `${label} character`) > maxCharacters ||
    requireProbeInteger(bytes, `${label} byte`) > maxCharacters * MAX_UTF8_BYTES_PER_SQL_CHARACTER
  ) {
    throw new Error(`Backup export ${label} exceeds its safety bound.`);
  }
}

function hasProbeStringBound(
  characters: unknown,
  bytes: unknown,
  maxCharacters: number,
  label: string,
): boolean {
  const characterCount = requireProbeInteger(characters, `${label} character`);
  const byteCount = requireProbeInteger(bytes, `${label} byte`);
  return (
    characterCount <= maxCharacters && byteCount <= maxCharacters * MAX_UTF8_BYTES_PER_SQL_CHARACTER
  );
}

function addEstimatedBackupBytes(
  current: number,
  additional: number,
  limit: number,
  label: string,
): number {
  const next = current + requireProbeInteger(additional, `${label} raw-byte`);
  if (!Number.isSafeInteger(next) || next > limit) {
    throw new Error(`Backup export ${label} exceeds its aggregate safety bound.`);
  }
  return next;
}

function parseParticipantProbeStats(value: string): ParticipantProbeStats {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Backup export participant probe is invalid.');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Backup export participant probe is invalid.');
  }
  const record = parsed as Record<string, unknown>;
  return {
    linkCount: requireProbeInteger(record.linkCount, 'participant link count'),
    count: requireProbeInteger(record.count, 'participant count'),
    invalidTypeCount: requireProbeInteger(record.invalidTypeCount, 'participant type'),
    rawBytes: requireProbeInteger(record.rawBytes, 'participant raw-byte'),
    maxServiceCharacters: requireProbeInteger(
      record.maxServiceCharacters,
      'participant service character',
    ),
    maxServiceBytes: requireProbeInteger(record.maxServiceBytes, 'participant service byte'),
    maxAddressCharacters: requireProbeInteger(
      record.maxAddressCharacters,
      'participant address character',
    ),
    maxAddressBytes: requireProbeInteger(record.maxAddressBytes, 'participant address byte'),
  };
}

function parseParticipantBudgetStats(value: string): ParticipantBudgetStats {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Backup export participant budget probe is invalid.');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Backup export participant budget probe is invalid.');
  }
  const record = parsed as Record<string, unknown>;
  return {
    count: requireProbeInteger(record.count, 'deduplicated participant count'),
    jsonBytes: requireProbeInteger(record.jsonBytes, 'deduplicated participant JSON-byte'),
  };
}

function parseBoundedChatParticipants(
  value: string,
  maxParticipants: number,
): PortableChatParticipant[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Backup chat customization participants are invalid.');
  }
  if (!Array.isArray(parsed) || parsed.length > maxParticipants) {
    throw new Error('Backup chat customization participants exceed their safety bound.');
  }
  return parsed.map((participant) => {
    if (
      typeof participant !== 'object' ||
      participant === null ||
      !('service' in participant) ||
      !('address' in participant) ||
      typeof participant.service !== 'string' ||
      typeof participant.address !== 'string' ||
      participant.address.length === 0
    ) {
      throw new Error('Backup chat customization participant is invalid.');
    }
    return { service: participant.service, address: participant.address };
  });
}

function buildBoundedPortableChatCustomizations(
  rows: readonly BoundedChatCustomizationExportRow[],
  maxParticipants: number,
): PortableChatCustomizationRow[] {
  return rows.map((row) => {
    const participants = parseBoundedChatParticipants(row.participantsJson, maxParticipants);
    return {
      identity: buildPortableChatIdentity(row.guid, row.chatIdentifier, row.style, participants),
      customName: row.customName,
      customColor: row.customColor,
      muteType: row.muteType,
      isPinned: row.isPinned,
      pinOrder: row.pinOrder ?? null,
      isArchived: row.isArchived,
    };
  });
}

function readBackupBaseRowsWithinTransaction(
  context: DbTransactionContext,
  limits: BackupExportLimits,
): Promise<BackupBaseExportRows> {
  return runInTransactionContext(context, async (db) => {
    const kvPredicate =
      limits.kvKeys.length === 0
        ? sql`0`
        : sql`key IN (${sql.join(
            limits.kvKeys.map((key) => sql`${key}`),
            sql`, `,
          )})`;
    const kvProbe = requireProbeRow<KvExportProbeRow>(
      await db.all<KvExportProbeRow>(sql`
        WITH kv_probe AS MATERIALIZED (
          SELECT key
            FROM kv
           WHERE ${kvPredicate}
           ORDER BY key
           LIMIT ${limits.kvEntries + 1}
        )
        SELECT COUNT(*) AS rowCount,
               COALESCE(SUM(CASE
                 WHEN typeof(selected.key) <> 'text'
                   OR (selected.value IS NOT NULL AND typeof(selected.value) <> 'text')
                 THEN 1 ELSE 0
               END), 0) AS invalidTypeCount,
               COALESCE(SUM(
                 length(CAST(selected.key AS BLOB)) +
                 length(CAST(COALESCE(selected.value, '') AS BLOB))
               ), 0) AS rawBytes,
               COALESCE(MAX(length(substr(
                 selected.key, 1, ${limits.keyCharacters + 1}
               ))), 0) AS maxKeyCharacters,
               COALESCE(MAX(length(CAST(selected.key AS BLOB))), 0) AS maxKeyBytes,
               COALESCE(MAX(length(substr(
                 COALESCE(selected.value, ''), 1, ${limits.valueCharacters + 1}
               ))), 0) AS maxValueCharacters,
               COALESCE(MAX(length(CAST(COALESCE(selected.value, '') AS BLOB))), 0) AS maxValueBytes
          FROM kv_probe AS probe
          JOIN kv AS selected ON selected.key = probe.key
      `),
      'kv',
    );
    const themeProbe = requireProbeRow<ThemeExportProbeRow>(
      await db.all<ThemeExportProbeRow>(sql`
        WITH theme_probe AS MATERIALIZED (
          SELECT id
            FROM themes INDEXED BY themes_backup_export_idx
           WHERE is_preset = 0
           ORDER BY id
           LIMIT ${limits.themes + 1}
        )
        SELECT COUNT(*) AS rowCount,
               COALESCE(SUM(CASE
                 WHEN typeof(selected.name) <> 'text' OR typeof(selected.mode) <> 'text'
                   OR typeof(selected.tokens) <> 'text'
                 THEN 1 ELSE 0
               END), 0) AS invalidTypeCount,
               COALESCE(SUM(
                 length(CAST(selected.name AS BLOB)) +
                 length(CAST(selected.mode AS BLOB)) +
                 length(CAST(selected.tokens AS BLOB))
               ), 0) AS rawBytes,
               COALESCE(MAX(length(substr(
                 selected.name, 1, ${limits.themeNameCharacters + 1}
               ))), 0) AS maxNameCharacters,
               COALESCE(MAX(length(CAST(selected.name AS BLOB))), 0) AS maxNameBytes,
               COALESCE(MAX(length(substr(
                 selected.mode, 1, ${limits.themeModeCharacters + 1}
               ))), 0) AS maxModeCharacters,
               COALESCE(MAX(length(CAST(selected.mode AS BLOB))), 0) AS maxModeBytes,
               COALESCE(MAX(length(substr(
                 selected.tokens, 1, ${limits.themeTokensCharacters + 1}
               ))), 0) AS maxTokensCharacters,
               COALESCE(MAX(length(CAST(selected.tokens AS BLOB))), 0) AS maxTokensBytes
          FROM theme_probe AS probe
          JOIN themes AS selected ON selected.id = probe.id
      `),
      'theme',
    );
    const chatProbe = await db.all<ChatCustomizationProbeRow>(sql`
      WITH chat_probe AS MATERIALIZED (
        SELECT id
          FROM chats INDEXED BY chats_backup_export_idx
         WHERE custom_name IS NOT NULL OR custom_color IS NOT NULL OR mute_type IS NOT NULL
            OR is_pinned = 1 OR is_archived = 1
         ORDER BY id
         LIMIT ${limits.chatCustomizations + 1}
      )
      SELECT c.id AS chatId,
             CASE
               WHEN typeof(c.guid) <> 'text'
                 OR (c.chat_identifier IS NOT NULL AND typeof(c.chat_identifier) <> 'text')
                 OR (c.custom_name IS NOT NULL AND typeof(c.custom_name) <> 'text')
                 OR (c.custom_color IS NOT NULL AND typeof(c.custom_color) <> 'text')
                 OR (c.mute_type IS NOT NULL AND typeof(c.mute_type) <> 'text')
               THEN 1 ELSE 0
             END AS invalidTypeCount,
             length(CAST(c.guid AS BLOB)) +
               length(CAST(COALESCE(c.chat_identifier, '') AS BLOB)) +
               length(CAST(COALESCE(c.custom_name, '') AS BLOB)) +
               length(CAST(COALESCE(c.custom_color, '') AS BLOB)) +
               length(CAST(COALESCE(c.mute_type, '') AS BLOB)) AS metadataRawBytes,
             length(substr(c.guid, 1, ${limits.chatGuidCharacters + 1})) AS guidCharacters,
             length(CAST(c.guid AS BLOB)) AS guidBytes,
             length(substr(
               COALESCE(c.chat_identifier, ''), 1, ${limits.chatIdentifierCharacters + 1}
             )) AS identifierCharacters,
             length(CAST(COALESCE(c.chat_identifier, '') AS BLOB)) AS identifierBytes,
             length(substr(
               COALESCE(c.custom_name, ''), 1, ${limits.chatNameCharacters + 1}
             )) AS customNameCharacters,
             length(CAST(COALESCE(c.custom_name, '') AS BLOB)) AS customNameBytes,
             length(substr(
               COALESCE(c.custom_color, ''), 1, ${limits.chatColorCharacters + 1}
             )) AS customColorCharacters,
             length(CAST(COALESCE(c.custom_color, '') AS BLOB)) AS customColorBytes,
             length(substr(
               COALESCE(c.mute_type, ''), 1, ${limits.muteTypeCharacters + 1}
             )) AS muteTypeCharacters,
             length(CAST(COALESCE(c.mute_type, '') AS BLOB)) AS muteTypeBytes,
             (
               SELECT json_object(
                 'linkCount', (
                   SELECT COUNT(*)
                     FROM (
                       SELECT 1
                         FROM chat_handles AS raw_chat_handle
                        WHERE raw_chat_handle.chat_id = c.id
                        ORDER BY raw_chat_handle.handle_id
                        LIMIT ${limits.chatParticipants + 1}
                     ) AS raw_participant_link
                 ),
                 'count', COUNT(*),
                 'invalidTypeCount', COALESCE(SUM(CASE
                   WHEN typeof(COALESCE(handle.service, '')) <> 'text'
                     OR typeof(handle.address) <> 'text'
                   THEN 1 ELSE 0
                 END), 0),
                 'rawBytes', COALESCE(SUM(
                   length(CAST(COALESCE(handle.service, '') AS BLOB)) +
                   length(CAST(handle.address AS BLOB))
                 ), 0),
                 'maxServiceCharacters', COALESCE(MAX(length(substr(
                   COALESCE(handle.service, ''), 1, ${limits.chatServiceCharacters + 1}
                 ))), 0),
                 'maxServiceBytes', COALESCE(MAX(
                   length(CAST(COALESCE(handle.service, '') AS BLOB))
                 ), 0),
                 'maxAddressCharacters', COALESCE(MAX(length(substr(
                   handle.address, 1, ${limits.chatParticipantAddressCharacters + 1}
                 ))), 0),
                 'maxAddressBytes', COALESCE(MAX(length(CAST(handle.address AS BLOB))), 0)
               )
                 FROM (
                   SELECT handle_id
                     FROM chat_handles
                    WHERE chat_id = c.id
                    ORDER BY handle_id
                    LIMIT ${limits.chatParticipants + 1}
                 ) AS chat_handle
                 JOIN handles AS handle ON handle.id = chat_handle.handle_id
                WHERE handle.address IS NOT NULL
                  AND handle.address <> ''
             ) AS participantStatsJson
        FROM chat_probe AS probe
        JOIN chats AS c ON c.id = probe.id
       ORDER BY c.id
    `);

    const kvCount = requireProbeInteger(kvProbe.rowCount, 'kv count');
    const themeCount = requireProbeInteger(themeProbe.rowCount, 'theme count');
    if (requireProbeInteger(kvProbe.invalidTypeCount, 'kv type') > 0) {
      throw new Error('Backup export kv data has an invalid type.');
    }
    if (requireProbeInteger(themeProbe.invalidTypeCount, 'theme type') > 0) {
      throw new Error('Backup export theme data has an invalid type.');
    }
    if (kvCount > limits.kvEntries)
      throw new Error('Backup export kv count exceeds its safety bound.');
    if (themeCount > limits.themes) {
      throw new Error('Backup export theme count exceeds its safety bound.');
    }
    if (chatProbe.length > limits.chatCustomizations) {
      throw new Error('Backup export chat customization count exceeds its safety bound.');
    }
    assertProbeStringBound(
      kvProbe.maxKeyCharacters,
      kvProbe.maxKeyBytes,
      limits.keyCharacters,
      'kv key',
    );
    assertProbeStringBound(
      kvProbe.maxValueCharacters,
      kvProbe.maxValueBytes,
      limits.valueCharacters,
      'kv value',
    );
    assertProbeStringBound(
      themeProbe.maxNameCharacters,
      themeProbe.maxNameBytes,
      limits.themeNameCharacters,
      'theme name',
    );
    assertProbeStringBound(
      themeProbe.maxModeCharacters,
      themeProbe.maxModeBytes,
      limits.themeModeCharacters,
      'theme mode',
    );
    assertProbeStringBound(
      themeProbe.maxTokensCharacters,
      themeProbe.maxTokensBytes,
      limits.themeTokensCharacters,
      'theme tokens',
    );

    let estimatedBytes =
      requireProbeInteger(kvProbe.rawBytes, 'kv raw-byte') +
      requireProbeInteger(themeProbe.rawBytes, 'theme raw-byte') +
      kvCount * ESTIMATED_JSON_BYTES_PER_KV_ENTRY +
      themeCount * ESTIMATED_JSON_BYTES_PER_THEME;
    for (const chat of chatProbe) {
      requireProbeInteger(chat.chatId, 'chat id');
      if (requireProbeInteger(chat.invalidTypeCount, 'chat type') > 0) {
        throw new Error('Backup export chat customization data has an invalid type.');
      }
      assertProbeStringBound(
        chat.guidCharacters,
        chat.guidBytes,
        limits.chatGuidCharacters,
        'chat guid',
      );
      assertProbeStringBound(
        chat.identifierCharacters,
        chat.identifierBytes,
        limits.chatIdentifierCharacters,
        'chat identifier',
      );
      assertProbeStringBound(
        chat.customNameCharacters,
        chat.customNameBytes,
        limits.chatNameCharacters,
        'chat name',
      );
      assertProbeStringBound(
        chat.customColorCharacters,
        chat.customColorBytes,
        limits.chatColorCharacters,
        'chat color',
      );
      assertProbeStringBound(
        chat.muteTypeCharacters,
        chat.muteTypeBytes,
        limits.muteTypeCharacters,
        'chat mute type',
      );
      const participants = parseParticipantProbeStats(chat.participantStatsJson);
      if (participants.invalidTypeCount > 0) {
        throw new Error('Backup export chat participant data has an invalid type.');
      }
      if (
        participants.linkCount > limits.chatParticipants ||
        participants.count > limits.chatParticipants
      ) {
        throw new Error('Backup export chat participant count exceeds its safety bound.');
      }
      assertProbeStringBound(
        participants.maxServiceCharacters,
        participants.maxServiceBytes,
        limits.chatServiceCharacters,
        'chat participant service',
      );
      assertProbeStringBound(
        participants.maxAddressCharacters,
        participants.maxAddressBytes,
        limits.chatParticipantAddressCharacters,
        'chat participant address',
      );
      estimatedBytes +=
        requireProbeInteger(chat.metadataRawBytes, 'chat metadata raw-byte') +
        ESTIMATED_JSON_BYTES_PER_CHAT_CUSTOMIZATION;
      if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes > limits.maxRawBytes) {
        throw new Error('Backup export base data exceeds its aggregate safety bound.');
      }
    }

    // Field sizes and raw link counts are now known safe. Only then group bounded handles to
    // preserve the legacy first-seen `(service, address)` deduplication semantics.
    const participantBudgetProbe = await db.all<ParticipantBudgetProbeRow>(sql`
      WITH chat_probe AS MATERIALIZED (
        SELECT id
          FROM chats INDEXED BY chats_backup_export_idx
         WHERE custom_name IS NOT NULL OR custom_color IS NOT NULL OR mute_type IS NOT NULL
            OR is_pinned = 1 OR is_archived = 1
         ORDER BY id
         LIMIT ${limits.chatCustomizations + 1}
      )
      SELECT c.id AS chatId,
             (
               SELECT json_object(
                 'count', COUNT(*),
                 'jsonBytes', CASE WHEN COUNT(*) = 0 THEN 2 ELSE
                   COALESCE(SUM(length(CAST(json_object(
                     'service', participant.service,
                     'address', participant.address
                   ) AS BLOB))), 0) + COUNT(*) + 1
                 END
               )
                 FROM (
                   SELECT COALESCE(handle.service, '') AS service,
                          handle.address AS address
                     FROM (
                       SELECT handle_id
                         FROM chat_handles
                        WHERE chat_id = c.id
                        ORDER BY handle_id
                        LIMIT ${limits.chatParticipants + 1}
                     ) AS chat_handle
                     JOIN handles AS handle ON handle.id = chat_handle.handle_id
                    WHERE handle.address IS NOT NULL
                      AND handle.address <> ''
                    GROUP BY COALESCE(handle.service, ''), handle.address
                    ORDER BY MIN(handle.id)
                 ) AS participant
             ) AS participantStatsJson
        FROM chat_probe AS probe
        JOIN chats AS c ON c.id = probe.id
       ORDER BY c.id
    `);
    for (const row of participantBudgetProbe) {
      requireProbeInteger(row.chatId, 'participant budget chat id');
      const participants = parseParticipantBudgetStats(row.participantStatsJson);
      estimatedBytes += participants.jsonBytes;
      if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes > limits.maxRawBytes) {
        throw new Error('Backup export base data exceeds its aggregate safety bound.');
      }
    }
    if (participantBudgetProbe.length !== chatProbe.length) {
      throw new Error('Backup export participant budget probe is incomplete.');
    }
    if (estimatedBytes > limits.maxRawBytes) {
      throw new Error('Backup export base data exceeds its aggregate safety bound.');
    }

    const kv = await db.all<KvPair>(sql`
      SELECT key, value
        FROM kv
       WHERE ${kvPredicate}
       ORDER BY key
       LIMIT ${limits.kvEntries + 1}
    `);
    const themes = await db.all<ThemeRow>(sql`
      SELECT name, mode, tokens, is_preset AS isPreset
        FROM themes INDEXED BY themes_backup_export_idx
       WHERE is_preset = 0
       ORDER BY id
       LIMIT ${limits.themes + 1}
    `);
    const chatCustomizations = await db.all<BoundedChatCustomizationExportRow>(sql`
      WITH chat_probe AS MATERIALIZED (
        SELECT id
          FROM chats INDEXED BY chats_backup_export_idx
         WHERE custom_name IS NOT NULL OR custom_color IS NOT NULL OR mute_type IS NOT NULL
            OR is_pinned = 1 OR is_archived = 1
         ORDER BY id
         LIMIT ${limits.chatCustomizations + 1}
      )
      SELECT c.id AS chatId, c.guid, c.chat_identifier AS chatIdentifier, c.style,
             c.custom_name AS customName, c.custom_color AS customColor,
             c.mute_type AS muteType, c.is_pinned AS isPinned, c.pin_order AS pinOrder,
             c.is_archived AS isArchived,
             COALESCE(
               (
                 SELECT json_group_array(
                   json_object('service', participant.service, 'address', participant.address)
                 )
                   FROM (
                     SELECT COALESCE(handle.service, '') AS service,
                            handle.address AS address
                       FROM (
                         SELECT handle_id
                           FROM chat_handles
                          WHERE chat_id = c.id
                          ORDER BY handle_id
                          LIMIT ${limits.chatParticipants + 1}
                       ) AS chat_handle
                      JOIN handles AS handle ON handle.id = chat_handle.handle_id
                      WHERE handle.address IS NOT NULL
                        AND handle.address <> ''
                      GROUP BY COALESCE(handle.service, ''), handle.address
                      ORDER BY MIN(handle.id)
                      LIMIT ${limits.chatParticipants + 1}
                   ) AS participant
               ),
               '[]'
             ) AS participantsJson
        FROM chat_probe AS probe
        JOIN chats AS c ON c.id = probe.id
       ORDER BY c.id
    `);
    return { kv, themes, chatCustomizations, estimatedBytes };
  });
}

function readCustomFolderBackupRowsWithinTransaction(
  context: DbTransactionContext,
  limits: CustomFolderExportLimits = DEFAULT_CUSTOM_FOLDER_EXPORT_LIMITS,
  initialEstimatedBytes = 0,
): Promise<CustomFolderBackupExportRows> {
  return runInTransactionContext(context, async (db) => {
    const numericLimits = [
      limits.maxRawBytes,
      limits.chatServiceCharacters,
      limits.chatIdentifierCharacters,
      limits.chatParticipantAddressCharacters,
      limits.chatParticipants,
    ];
    if (
      numericLimits.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
      !Number.isSafeInteger(initialEstimatedBytes) ||
      initialEstimatedBytes < 0 ||
      initialEstimatedBytes > limits.maxRawBytes
    ) {
      throw new Error('Custom folder backup export limits are invalid.');
    }
    let estimatedBytes = initialEstimatedBytes;

    // Probe only small numeric facts first. A corrupt oversized name never crosses the native
    // bridge, and 101 folders fail before any membership or identity work begins.
    const folderProbe = await db.all<CustomFolderHeaderProbeRow>(sql`
      WITH folder_ids AS MATERIALIZED (
        SELECT id
          FROM custom_folders INDEXED BY custom_folders_order_idx
         ORDER BY sort_order ASC, id ASC
         LIMIT ${MAX_CUSTOM_FOLDERS + 1}
      )
      SELECT folder.id AS folderId,
             CASE WHEN typeof(folder.id) <> 'integer'
                    OR typeof(folder.name) <> 'text'
                    OR typeof(folder.sort_order) <> 'integer'
                    OR typeof(folder.show_unread_badge) <> 'integer'
                    OR folder.show_unread_badge NOT IN (0, 1)
               THEN 1 ELSE 0 END AS invalidTypeCount,
             length(substr(
               folder.name, 1, ${MAX_CUSTOM_FOLDER_NAME_CODE_POINTS + 1}
             )) AS nameCharacters,
             length(CAST(substr(
               folder.name, 1, ${MAX_CUSTOM_FOLDER_NAME_CODE_POINTS + 1}
             ) AS BLOB)) AS nameBytes,
             length(CAST(json_quote(substr(
               folder.name, 1, ${MAX_CUSTOM_FOLDER_NAME_CODE_POINTS + 1}
             )) AS BLOB)) AS nameJsonBytes
        FROM folder_ids AS probe
        JOIN custom_folders AS folder ON folder.id = probe.id
       ORDER BY folder.sort_order ASC, folder.id ASC
    `);
    if (folderProbe.length > MAX_CUSTOM_FOLDERS) {
      throw new Error('Custom folder count exceeds its backup safety bound.');
    }
    const folderIds = new Set<number>();
    for (const row of folderProbe) {
      const folderId = requireProbeInteger(row.folderId, 'custom folder id');
      if (folderId <= 0 || folderIds.has(folderId)) {
        throw new Error('Custom folder backup row has an invalid folder id.');
      }
      folderIds.add(folderId);
      if (requireProbeInteger(row.invalidTypeCount, 'custom folder type') > 0) {
        throw new Error('Custom folder backup metadata is invalid.');
      }
      assertProbeStringBound(
        row.nameCharacters,
        row.nameBytes,
        MAX_CUSTOM_FOLDER_NAME_CODE_POINTS,
        'custom folder name',
      );
    }

    const folders: CustomFolderHeaderExportRow[] = await db.all<CustomFolderHeaderExportRow>(sql`
      SELECT id AS folderId, name, show_unread_badge AS showUnreadBadge
        FROM custom_folders INDEXED BY custom_folders_order_idx
       ORDER BY sort_order ASC, id ASC
       LIMIT ${MAX_CUSTOM_FOLDERS + 1}
    `);
    if (
      folders.length !== folderProbe.length ||
      folders.some((folder, index) => folder.folderId !== folderProbe[index]?.folderId)
    ) {
      throw new Error('Custom folder backup metadata probe is incomplete.');
    }
    let folderBytes = 0;
    for (const [index, folder] of folders.entries()) {
      const normalizedName = normalizeCustomFolderName(folder.name);
      if (
        normalizedName !== folder.name ||
        (folder.showUnreadBadge !== 0 && folder.showUnreadBadge !== 1)
      ) {
        throw new Error('Custom folder backup metadata is invalid.');
      }
      folderBytes +=
        requireProbeInteger(folderProbe[index]?.nameJsonBytes, 'custom folder name JSON-byte') +
        ESTIMATED_JSON_BYTES_PER_CUSTOM_FOLDER;
    }
    estimatedBytes = addEstimatedBackupBytes(
      estimatedBytes,
      folderBytes,
      limits.maxRawBytes,
      'custom-folder data',
    );

    // The named reverse index makes the innermost max-plus-one selector stop before any join,
    // window, grouping, or JSON work. The later reads are safe because this proves the entire
    // membership table contains at most 25,000 rows for this committed snapshot.
    const memberCountProbe = requireProbeRow<CustomFolderMemberCountProbeRow>(
      await db.all<CustomFolderMemberCountProbeRow>(sql`
        WITH member_ids AS MATERIALIZED (
          SELECT rowid
            FROM custom_folder_members INDEXED BY custom_folder_members_chat_guid_idx
           ORDER BY chat_guid ASC, folder_id ASC
           LIMIT ${MAX_BACKUP_CUSTOM_FOLDER_ASSOCIATIONS + 1}
        )
        SELECT COUNT(*) AS rowCount FROM member_ids
      `),
      'custom folder membership count',
    );
    const memberCount = requireProbeInteger(
      memberCountProbe.rowCount,
      'custom folder membership count',
    );
    if (memberCount > MAX_BACKUP_CUSTOM_FOLDER_ASSOCIATIONS) {
      throw new Error('Custom folder memberships exceed their aggregate backup safety bound.');
    }

    const memberProbe = await db.all<CustomFolderMemberProbeRow>(sql`
      WITH member_ids AS MATERIALIZED (
        SELECT rowid
          FROM custom_folder_members INDEXED BY custom_folder_members_chat_guid_idx
         ORDER BY chat_guid ASC, folder_id ASC
         LIMIT ${MAX_BACKUP_CUSTOM_FOLDER_ASSOCIATIONS + 1}
      )
      SELECT member.folder_id AS folderId,
             chat.id AS chatId,
             CASE WHEN typeof(member.folder_id) <> 'integer'
                    OR typeof(member.chat_guid) <> 'text'
               THEN 1 ELSE 0 END AS invalidTypeCount,
             length(substr(
               member.chat_guid, 1, ${MAX_CUSTOM_FOLDER_CHAT_GUID_CODE_POINTS + 1}
             )) AS guidCharacters,
             length(CAST(substr(
               member.chat_guid, 1, ${MAX_CUSTOM_FOLDER_CHAT_GUID_CODE_POINTS + 1}
             ) AS BLOB)) AS guidBytes,
             CASE WHEN instr(substr(
               member.chat_guid, 1, ${MAX_CUSTOM_FOLDER_CHAT_GUID_CODE_POINTS + 1}
             ), char(0)) > 0 THEN 1 ELSE 0 END AS hasNullCharacter
        FROM member_ids AS probe
        JOIN custom_folder_members AS member ON member.rowid = probe.rowid
        LEFT JOIN chats AS chat INDEXED BY chats_guid_idx ON chat.guid = member.chat_guid
       ORDER BY member.chat_guid ASC, member.folder_id ASC
    `);
    if (memberProbe.length !== memberCount) {
      throw new Error('Custom folder membership probe is incomplete.');
    }
    const memberCounts = new Map<number, number>();
    const members: CustomFolderBackupExportRows['members'] = [];
    for (const row of memberProbe) {
      const folderId = requireProbeInteger(row.folderId, 'custom folder membership folder id');
      if (folderId <= 0 || !folderIds.has(folderId)) {
        throw new Error('Custom folder membership has an invalid folder id.');
      }
      if (requireProbeInteger(row.invalidTypeCount, 'custom folder membership type') > 0) {
        throw new Error('Custom folder membership contains an invalid chat GUID.');
      }
      assertProbeStringBound(
        row.guidCharacters,
        row.guidBytes,
        MAX_CUSTOM_FOLDER_CHAT_GUID_CODE_POINTS,
        'custom folder membership chat GUID',
      );
      if (requireProbeInteger(row.hasNullCharacter, 'custom folder membership NUL') !== 0) {
        throw new Error('Custom folder membership contains an invalid chat GUID.');
      }
      if (row.chatId !== null && (!Number.isSafeInteger(row.chatId) || row.chatId <= 0)) {
        throw new Error('Custom folder membership has an invalid chat id.');
      }
      memberCounts.set(folderId, (memberCounts.get(folderId) ?? 0) + 1);
      members.push({ folderId, chatId: row.chatId });
    }
    if ([...memberCounts.values()].some((count) => count > MAX_CUSTOM_FOLDER_MEMBERS)) {
      throw new Error('Custom folder membership exceeds its backup safety bound.');
    }
    estimatedBytes = addEstimatedBackupBytes(
      estimatedBytes,
      members.length * ESTIMATED_JSON_BYTES_PER_CUSTOM_FOLDER_ASSOCIATION,
      limits.maxRawBytes,
      'custom-folder data',
    );

    const candidateChatIds = [
      ...new Set(members.flatMap((member) => (member.chatId === null ? [] : [member.chatId]))),
    ];
    if (candidateChatIds.length === 0) return { folders, members, identities: [] };
    const candidateChatIdsJson = JSON.stringify(candidateChatIds);
    const identityProbe = await db.all<CustomFolderIdentityProbeRow>(sql`
      WITH requested_chat AS MATERIALIZED (
        SELECT CAST(entry.value AS INTEGER) AS chat_id,
               CAST(entry.key AS INTEGER) AS occurrence
          FROM json_each(${candidateChatIdsJson}) AS entry
         ORDER BY CAST(entry.key AS INTEGER)
         LIMIT ${MAX_BACKUP_CUSTOM_FOLDER_ASSOCIATIONS + 1}
      )
      SELECT chat.id AS chatId,
             CASE WHEN typeof(chat.guid) <> 'text'
                    OR (chat.chat_identifier IS NOT NULL
                        AND typeof(chat.chat_identifier) <> 'text')
                    OR (chat.style IS NOT NULL AND typeof(chat.style) <> 'integer')
               THEN 1 ELSE 0 END AS invalidTypeCount,
             length(substr(
               chat.guid, 1, ${MAX_CUSTOM_FOLDER_CHAT_GUID_CODE_POINTS + 1}
             )) AS guidCharacters,
             length(CAST(substr(
               chat.guid, 1, ${MAX_CUSTOM_FOLDER_CHAT_GUID_CODE_POINTS + 1}
             ) AS BLOB)) AS guidBytes,
             length(substr(
               COALESCE(chat.chat_identifier, ''),
               1,
               ${limits.chatIdentifierCharacters + 1}
             )) AS identifierCharacters,
             length(CAST(substr(
               COALESCE(chat.chat_identifier, ''),
               1,
               ${limits.chatIdentifierCharacters + 1}
             ) AS BLOB)) AS identifierBytes,
             length(CAST(json_quote(CASE WHEN chat.chat_identifier IS NULL THEN NULL ELSE
               substr(chat.chat_identifier, 1, ${limits.chatIdentifierCharacters + 1})
             END) AS BLOB)) AS identifierJsonBytes,
             CASE WHEN chat.style IN (43, 45) OR (
               instr(substr(
                 chat.guid, 1, ${MAX_CUSTOM_FOLDER_CHAT_GUID_CODE_POINTS + 1}
               ), ';') > 0
               AND substr(
                 substr(chat.guid, 1, ${MAX_CUSTOM_FOLDER_CHAT_GUID_CODE_POINTS + 1}),
                 instr(substr(
                   chat.guid, 1, ${MAX_CUSTOM_FOLDER_CHAT_GUID_CODE_POINTS + 1}
                 ), ';') + 1,
                 2
               ) IN ('+;', '-;')
             ) THEN 1 ELSE 0 END AS hasKnownKind,
             CASE WHEN chat.chat_identifier IS NOT NULL
                        AND length(trim(substr(
                          chat.chat_identifier,
                          1,
                          ${limits.chatIdentifierCharacters + 1}
                        ))) > 0
               THEN 1 ELSE 0 END AS identifierHasContent,
             (
               SELECT json_object(
                 'linkCount', COUNT(raw_handle.handle_id),
                 'count', COALESCE(SUM(CASE
                   WHEN handle.id IS NOT NULL AND handle.address IS NOT NULL
                     AND handle.address <> '' THEN 1 ELSE 0 END
                 ), 0),
                 'invalidTypeCount', COALESCE(SUM(CASE
                   WHEN raw_handle.handle_id IS NOT NULL AND handle.id IS NULL THEN 1
                   WHEN handle.address IS NOT NULL AND handle.address <> '' AND (
                     typeof(handle.address) <> 'text'
                     OR typeof(COALESCE(handle.service, '')) <> 'text'
                   ) THEN 1 ELSE 0 END
                 ), 0),
                 'rawBytes', COALESCE(SUM(CASE
                   WHEN handle.id IS NOT NULL AND handle.address IS NOT NULL
                     AND handle.address <> '' THEN
                       length(CAST(substr(
                         COALESCE(handle.service, ''),
                         1,
                         ${limits.chatServiceCharacters + 1}
                       ) AS BLOB)) +
                       length(CAST(substr(
                         handle.address,
                         1,
                         ${limits.chatParticipantAddressCharacters + 1}
                       ) AS BLOB))
                   ELSE 0 END
                 ), 0),
                 'maxServiceCharacters', COALESCE(MAX(CASE
                   WHEN handle.id IS NOT NULL AND handle.address IS NOT NULL
                     AND handle.address <> '' THEN length(substr(
                       COALESCE(handle.service, ''),
                       1,
                       ${limits.chatServiceCharacters + 1}
                     )) ELSE 0 END
                 ), 0),
                 'maxServiceBytes', COALESCE(MAX(CASE
                   WHEN handle.id IS NOT NULL AND handle.address IS NOT NULL
                     AND handle.address <> '' THEN length(CAST(substr(
                       COALESCE(handle.service, ''),
                       1,
                       ${limits.chatServiceCharacters + 1}
                     ) AS BLOB)) ELSE 0 END
                 ), 0),
                 'maxAddressCharacters', COALESCE(MAX(CASE
                   WHEN handle.id IS NOT NULL AND handle.address IS NOT NULL
                     AND handle.address <> '' THEN length(substr(
                       handle.address,
                       1,
                       ${limits.chatParticipantAddressCharacters + 1}
                     )) ELSE 0 END
                 ), 0),
                 'maxAddressBytes', COALESCE(MAX(CASE
                   WHEN handle.id IS NOT NULL AND handle.address IS NOT NULL
                     AND handle.address <> '' THEN length(CAST(substr(
                       handle.address,
                       1,
                       ${limits.chatParticipantAddressCharacters + 1}
                     ) AS BLOB)) ELSE 0 END
                 ), 0)
               )
                 FROM (
                   SELECT handle_id
                     FROM chat_handles
                    WHERE chat_id = chat.id
                    ORDER BY handle_id ASC
                    LIMIT ${limits.chatParticipants + 1}
                 ) AS raw_handle
                 LEFT JOIN handles AS handle ON handle.id = raw_handle.handle_id
             ) AS participantStatsJson
        FROM requested_chat AS request
        JOIN chats AS chat ON chat.id = request.chat_id
       ORDER BY request.occurrence ASC
    `);
    if (identityProbe.length !== candidateChatIds.length) {
      throw new Error('Custom folder identity probe is incomplete.');
    }

    const candidateIdSet = new Set(candidateChatIds);
    const identityProbeByChatId = new Map<number, CustomFolderIdentityProbeRow>();
    const exportableChatIds: number[] = [];
    for (const row of identityProbe) {
      const chatId = requireProbeInteger(row.chatId, 'custom folder identity chat id');
      if (chatId <= 0 || !candidateIdSet.has(chatId) || identityProbeByChatId.has(chatId)) {
        throw new Error('Custom folder identity probe is inconsistent.');
      }
      identityProbeByChatId.set(chatId, row);
      const participants = parseParticipantProbeStats(row.participantStatsJson);
      const identityStringsAreCoarselyValid =
        requireProbeInteger(row.invalidTypeCount, 'custom folder identity type') === 0 &&
        hasProbeStringBound(
          row.identifierCharacters,
          row.identifierBytes,
          limits.chatIdentifierCharacters,
          'custom folder chat identifier',
        ) &&
        participants.invalidTypeCount === 0 &&
        participants.linkCount <= limits.chatParticipants &&
        participants.count <= limits.chatParticipants &&
        hasProbeStringBound(
          participants.maxServiceCharacters,
          participants.maxServiceBytes,
          limits.chatServiceCharacters,
          'custom folder participant service',
        ) &&
        hasProbeStringBound(
          participants.maxAddressCharacters,
          participants.maxAddressBytes,
          limits.chatParticipantAddressCharacters,
          'custom folder participant address',
        );
      assertProbeStringBound(
        row.guidCharacters,
        row.guidBytes,
        MAX_CUSTOM_FOLDER_CHAT_GUID_CODE_POINTS,
        'custom folder identity guid',
      );
      const hasKnownKind = requireProbeInteger(row.hasKnownKind, 'custom folder identity kind');
      const identifierHasContent = requireProbeInteger(
        row.identifierHasContent,
        'custom folder identity evidence',
      );
      if (hasKnownKind > 1 || identifierHasContent > 1) {
        throw new Error('Custom folder identity probe is invalid.');
      }
      if (
        identityStringsAreCoarselyValid &&
        (hasKnownKind === 1 || participants.count > 0) &&
        (identifierHasContent === 1 || participants.count > 0)
      ) {
        exportableChatIds.push(chatId);
      }
    }
    if (identityProbeByChatId.size !== candidateChatIds.length) {
      throw new Error('Custom folder identity probe is incomplete.');
    }
    if (exportableChatIds.length === 0) return { folders, members, identities: [] };

    // Measure escaped participant objects before json_group_array can allocate the arrays. The
    // raw handle prefix is already capped, and the accepted total shares the base snapshot budget.
    const exportableChatIdsJson = JSON.stringify(exportableChatIds);
    const participantBudgetProbe = await db.all<ParticipantBudgetProbeRow>(sql`
      WITH requested_chat AS MATERIALIZED (
        SELECT CAST(entry.value AS INTEGER) AS chat_id,
               CAST(entry.key AS INTEGER) AS occurrence
          FROM json_each(${exportableChatIdsJson}) AS entry
         ORDER BY CAST(entry.key AS INTEGER)
         LIMIT ${MAX_BACKUP_CUSTOM_FOLDER_ASSOCIATIONS + 1}
      )
      SELECT chat.id AS chatId,
             (
               SELECT json_object(
                 'count', COUNT(*),
                 'jsonBytes', CASE WHEN COUNT(*) = 0 THEN 2 ELSE
                   COALESCE(SUM(length(CAST(json_object(
                     'service', participant.service,
                     'address', participant.address
                   ) AS BLOB))), 0) + COUNT(*) + 1
                 END
               )
                 FROM (
                   SELECT COALESCE(handle.service, '') AS service,
                          handle.address AS address
                     FROM (
                       SELECT handle_id
                         FROM chat_handles
                        WHERE chat_id = chat.id
                        ORDER BY handle_id ASC
                        LIMIT ${limits.chatParticipants + 1}
                     ) AS raw_handle
                     JOIN handles AS handle ON handle.id = raw_handle.handle_id
                    WHERE handle.address IS NOT NULL
                      AND handle.address <> ''
                    GROUP BY COALESCE(handle.service, ''), handle.address
                    ORDER BY MIN(handle.id) ASC
                 ) AS participant
             ) AS participantStatsJson
        FROM requested_chat AS request
        JOIN chats AS chat ON chat.id = request.chat_id
       ORDER BY request.occurrence ASC
    `);
    if (participantBudgetProbe.length !== exportableChatIds.length) {
      throw new Error('Custom folder participant budget probe is incomplete.');
    }
    const budgetedIdentityIds = new Set<number>();
    for (const row of participantBudgetProbe) {
      const chatId = requireProbeInteger(row.chatId, 'custom folder participant budget chat id');
      const identity = identityProbeByChatId.get(chatId);
      if (!identity || budgetedIdentityIds.has(chatId)) {
        throw new Error('Custom folder participant budget probe is inconsistent.');
      }
      budgetedIdentityIds.add(chatId);
      const participants = parseParticipantBudgetStats(row.participantStatsJson);
      if (participants.count > limits.chatParticipants) {
        throw new Error('Custom folder participant budget exceeds its safety bound.');
      }
      const identityBytes =
        requireProbeInteger(identity.guidBytes, 'custom folder identity guid byte') +
        requireProbeInteger(
          identity.identifierJsonBytes,
          'custom folder identity identifier JSON-byte',
        ) +
        participants.jsonBytes +
        ESTIMATED_JSON_BYTES_PER_CUSTOM_FOLDER_IDENTITY;
      estimatedBytes = addEstimatedBackupBytes(
        estimatedBytes,
        identityBytes,
        limits.maxRawBytes,
        'custom-folder data',
      );
    }

    // Exact JavaScript/Zod string rules can reject a SQL-bounded candidate (for example, one
    // astral code point consumes two UTF-16 units). Aggregate at most max-plus-one candidates at
    // a time, validate each batch exactly, and retain only portable identities. This preserves
    // omission semantics without letting all 25,000 associations allocate participant arrays.
    const identities: CustomFolderPortableIdentityRow[] = [];
    const returnedIdentityIds = new Set<number>();
    const identityBatchSize = MAX_BACKUP_CUSTOM_FOLDER_IDENTITIES + 1;
    for (let offset = 0; offset < exportableChatIds.length; offset += identityBatchSize) {
      const batchChatIds = exportableChatIds.slice(offset, offset + identityBatchSize);
      const batchChatIdsJson = JSON.stringify(batchChatIds);
      const batchRows = await db.all<CustomFolderIdentityExportRow>(sql`
        WITH requested_chat AS MATERIALIZED (
          SELECT CAST(entry.value AS INTEGER) AS chat_id,
                 CAST(entry.key AS INTEGER) AS occurrence
            FROM json_each(${batchChatIdsJson}) AS entry
           ORDER BY CAST(entry.key AS INTEGER)
           LIMIT ${identityBatchSize}
        )
        SELECT chat.id AS chatId,
               chat.guid,
               chat.chat_identifier AS chatIdentifier,
               chat.style,
               COALESCE(
                 (
                   SELECT json_group_array(
                     json_object('service', participant.service, 'address', participant.address)
                   )
                     FROM (
                       SELECT COALESCE(handle.service, '') AS service,
                              handle.address AS address
                         FROM (
                           SELECT handle_id
                             FROM chat_handles
                            WHERE chat_id = chat.id
                            ORDER BY handle_id ASC
                            LIMIT ${limits.chatParticipants + 1}
                         ) AS raw_handle
                         JOIN handles AS handle ON handle.id = raw_handle.handle_id
                        WHERE handle.address IS NOT NULL
                          AND handle.address <> ''
                        GROUP BY COALESCE(handle.service, ''), handle.address
                        ORDER BY MIN(handle.id) ASC
                     ) AS participant
                 ),
                 '[]'
               ) AS participantsJson
          FROM requested_chat AS request
          JOIN chats AS chat ON chat.id = request.chat_id
         ORDER BY request.occurrence ASC
      `);
      if (batchRows.length !== batchChatIds.length) {
        throw new Error('Custom folder identity export is incomplete.');
      }
      for (const [index, row] of batchRows.entries()) {
        if (
          !Number.isSafeInteger(row.chatId) ||
          row.chatId <= 0 ||
          row.chatId !== batchChatIds[index] ||
          returnedIdentityIds.has(row.chatId)
        ) {
          throw new Error('Custom folder identity export is inconsistent.');
        }
        returnedIdentityIds.add(row.chatId);
        const participants = parseBackupParticipants(row.participantsJson);
        if (!hasBackupSchemaBoundedIdentityStrings(row.chatIdentifier, participants)) continue;
        const identity = buildPortableChatIdentity(
          row.guid,
          row.chatIdentifier,
          row.style,
          participants,
        );
        if (!hasPortableRestoreEvidence(identity)) continue;
        if (identities.length >= MAX_BACKUP_CUSTOM_FOLDER_IDENTITIES) {
          throw new Error('Custom folder chat identities exceed their backup safety bound.');
        }
        identities.push({ chatId: row.chatId, identity });
      }
    }
    if (returnedIdentityIds.size !== exportableChatIds.length) {
      throw new Error('Custom folder identity export is incomplete.');
    }
    return { folders, members, identities };
  });
}

function parseBackupParticipants(value: string | null): PortableChatParticipant[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value ?? '[]');
  } catch {
    throw new Error('Custom folder chat participants are invalid.');
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_BACKUP_CHAT_PARTICIPANTS) {
    throw new Error('Custom folder chat participants exceed their safety bound.');
  }
  return parsed.map((participant) => {
    if (
      typeof participant !== 'object' ||
      participant === null ||
      !('service' in participant) ||
      !('address' in participant) ||
      typeof participant.service !== 'string' ||
      typeof participant.address !== 'string' ||
      participant.address.length === 0
    ) {
      throw new Error('Custom folder chat participant is invalid.');
    }
    return { service: participant.service, address: participant.address };
  });
}

/** Match the final Zod string semantics after SQL has already capped allocation by bytes. */
function hasBackupSchemaBoundedIdentityStrings(
  chatIdentifier: string | null,
  participants: readonly PortableChatParticipant[],
): boolean {
  return (
    (chatIdentifier === null || chatIdentifier.length <= MAX_BACKUP_CHAT_IDENTIFIER_CHARACTERS) &&
    participants.every(
      (participant) =>
        participant.service.length <= MAX_BACKUP_CHAT_SERVICE_CHARACTERS &&
        participant.address.length <= MAX_BACKUP_CHAT_PARTICIPANT_ADDRESS_CHARACTERS,
    )
  );
}

function buildCustomFolderBackupData(rows: CustomFolderBackupExportRows): CustomFolderBackupData {
  const folderIds = new Set<number>();
  const memberCounts = new Map<number, number>();
  const membersByFolder = new Map<
    number,
    Array<Pick<CustomFolderMemberProbeRow, 'folderId' | 'chatId'>>
  >();
  for (const folder of rows.folders) {
    if (
      !Number.isSafeInteger(folder.folderId) ||
      folder.folderId <= 0 ||
      folderIds.has(folder.folderId)
    ) {
      throw new Error('Custom folder backup row has an invalid folder id.');
    }
    folderIds.add(folder.folderId);
  }
  for (const member of rows.members) {
    if (!folderIds.has(member.folderId)) {
      throw new Error('Custom folder membership has an invalid folder id.');
    }
    if (member.chatId !== null && (!Number.isSafeInteger(member.chatId) || member.chatId <= 0)) {
      throw new Error('Custom folder membership has an invalid chat id.');
    }
    memberCounts.set(member.folderId, (memberCounts.get(member.folderId) ?? 0) + 1);
    const folderMembers = membersByFolder.get(member.folderId) ?? [];
    folderMembers.push(member);
    membersByFolder.set(member.folderId, folderMembers);
  }
  if (folderIds.size > MAX_CUSTOM_FOLDERS) {
    throw new Error('Custom folder count exceeds its backup safety bound.');
  }
  if (rows.members.length > MAX_BACKUP_CUSTOM_FOLDER_ASSOCIATIONS) {
    throw new Error('Custom folder memberships exceed their aggregate backup safety bound.');
  }
  if ([...memberCounts.values()].some((count) => count > MAX_CUSTOM_FOLDER_MEMBERS)) {
    throw new Error('Custom folder membership exceeds its backup safety bound.');
  }

  const customFolderChatIdentities: PortableChatIdentityRow[] = [];
  const identityIndexes = new Map<number, number>();
  const identityRows = new Map<number, PortableChatIdentityRow>();
  for (const row of rows.identities) {
    if (!Number.isSafeInteger(row.chatId) || row.chatId <= 0 || identityRows.has(row.chatId)) {
      throw new Error('Custom folder identity export is inconsistent.');
    }
    identityRows.set(row.chatId, row.identity);
  }
  const customFolders: CustomFolderBackupRow[] = [];

  for (const folder of rows.folders) {
    const normalizedName = normalizeCustomFolderName(folder.name);
    if (
      normalizedName !== folder.name ||
      (folder.showUnreadBadge !== 0 && folder.showUnreadBadge !== 1)
    ) {
      throw new Error('Custom folder backup metadata is invalid.');
    }
    const backupFolder: CustomFolderBackupRow = {
      name: folder.name,
      showUnreadBadge: folder.showUnreadBadge,
      sourceMemberCount: memberCounts.get(folder.folderId) ?? 0,
      memberIndexes: [],
    };
    for (const member of membersByFolder.get(folder.folderId) ?? []) {
      // No chat row or no bounded portable evidence means there is nothing stable to carry. The
      // complete source count still lets restore report the omission.
      if (member.chatId === null) continue;
      const identity = identityRows.get(member.chatId);
      if (!identity) continue;
      let identityIndex = identityIndexes.get(member.chatId);
      if (identityIndex === undefined) {
        if (customFolderChatIdentities.length >= MAX_BACKUP_CUSTOM_FOLDER_IDENTITIES) {
          throw new Error('Custom folder chat identities exceed their backup safety bound.');
        }
        identityIndex = customFolderChatIdentities.length;
        identityIndexes.set(member.chatId, identityIndex);
        customFolderChatIdentities.push(identity);
      }
      backupFolder.memberIndexes.push(identityIndex);
    }
    customFolders.push(backupFolder);
  }

  return { customFolderChatIdentities, customFolders };
}

/**
 * Snapshot ordered folder metadata, complete durable membership counts, and portable identity
 * evidence behind the shared DB coordinator. Temporarily absent members are counted but omitted
 * from the identity registry because an opaque GUID is not portable across rebuilt Macs.
 */
export async function getCustomFolderBackupData(
  db: AppDatabase,
  commitGuard?: DbCommitGuard,
): Promise<CustomFolderBackupData> {
  const rows = await withDbTransaction(
    db,
    (context) => readCustomFolderBackupRowsWithinTransaction(context),
    commitGuard,
  );
  return buildCustomFolderBackupData(rows);
}

function buildBackupBaseExportData(
  rows: BackupBaseExportRows,
  limits: BackupExportLimits,
): BackupBaseExportData {
  return {
    kv: rows.kv,
    themes: rows.themes,
    chatCustomizations: buildBoundedPortableChatCustomizations(
      rows.chatCustomizations,
      limits.chatParticipants,
    ),
  };
}

/** Read the folder-independent v2 payload from one bounded, committed database snapshot. */
export async function getBackupBaseExportData(
  db: AppDatabase,
  limits: BackupExportLimits,
  commitGuard?: DbCommitGuard,
): Promise<BackupBaseExportData> {
  assertBackupExportLimits(limits);
  const rows = await withDbTransaction(
    db,
    (context) => readBackupBaseRowsWithinTransaction(context, limits),
    commitGuard,
  );
  return buildBackupBaseExportData(rows, limits);
}

/** Read every v3 backup domain from one committed point in time on the shared connection. */
export async function getBackupV3ExportData(
  db: AppDatabase,
  limits: BackupExportLimits,
  commitGuard?: DbCommitGuard,
): Promise<BackupV3ExportData> {
  assertBackupExportLimits(limits);
  const rows = await withDbTransaction(
    db,
    async (context) => {
      const base = await readBackupBaseRowsWithinTransaction(context, limits);
      const customFolders = await readCustomFolderBackupRowsWithinTransaction(
        context,
        limits,
        base.estimatedBytes,
      );
      return { base, customFolders };
    },
    commitGuard,
  );
  return {
    ...buildBackupBaseExportData(rows.base, limits),
    ...buildCustomFolderBackupData(rows.customFolders),
  };
}

export async function restoreKv(
  db: AppDatabase,
  items: KvPair[],
  commitGuard?: DbCommitGuard,
): Promise<void> {
  for (const it of items) {
    // The active custom-theme id is device-specific — restored themes get fresh ids, so a
    // backed-up pointer would dangle. Skip it; restoreThemes still brings the themes over.
    if (it.key === THEME_CUSTOM_KEY) continue;
    const value = it.value;
    if (value != null) {
      await withDbTransaction(
        db,
        (context) => kvSetWithinTransaction(context, it.key, value),
        commitGuard,
      );
    }
  }
}

/** Pairing key for a backed-up theme. JSON, so no name/mode text can ever forge a separator. */
function themeIdentity(name: string, mode: string): string {
  return JSON.stringify([name, mode]);
}

/**
 * Restore custom themes, PAIRING each backed-up theme with an existing row of the same
 * (name, mode) — one row per backup entry — and inserting the ones left unpaired.
 *
 * `onConflictDoUpdate` is not usable here: `themes` has NO unique index (`id INTEGER PRIMARY KEY
 * AUTOINCREMENT` is its only key) and no id travels in a backup, so a conflict clause has nothing
 * to arbitrate on — naming a non-indexed target throws "ON CONFLICT clause does not match any
 * PRIMARY KEY or UNIQUE constraint". A plain insert is no good either: restoring the same backup
 * twice — an utterly normal recovery action — then left two indistinguishable copies of every
 * custom theme that no later restore could dedupe.
 *
 * (name, mode) is NOT a key either, and that is why the pairing uses an id cursor rather than a
 * broad UPDATE by name. The theme editor seeds every new theme's name to 'My Theme', so
 * a user who builds two palettes without renaming them has two rows with identical (name, mode) —
 * the normal case, not an exotic one. A `WHERE name = ? AND mode = ?` UPDATE matches BOTH of them:
 * entry 1 wrote its tokens over both twins and entry 2 overwrote them again, so the palette the
 * user hand-built was destroyed by the very restore meant to recover it. On a fresh device (the
 * primary use of a backup) it was worse: entry 1 inserted, entry 2's UPDATE matched that
 * brand-new row and rewrote it, and only ONE of the two themes survived at all.
 *
 * The id cursor fixes both without reading the whole themes table into memory. A serialized MAX(id)
 * captures the original generation, then each backup entry claims at most one matching id after the
 * previous claim and at or below that cutoff. The k-th twin in the backup therefore lands on the
 * k-th twin in the table, while rows inserted BY THIS RESTORE are invisible to later entries —
 * precisely what stops entry 2 from swallowing entry 1's insert.
 *
 * The insert deliberately carries NO `WHERE NOT EXISTS (name, mode)` guard: it would re-introduce
 * the fresh-device loss (entry 2 would find entry 1's just-inserted twin and skip). What that
 * gives up is only the case of a theme created by the editor DURING a restore, which needs the
 * Themes screen open mid-import and costs a duplicate row, not a lost palette.
 *
 * Update-then-insert, never delete-then-insert. Each item gets its own short transaction instead of
 * holding the process-wide DB mutex across an import of up to 500 themes. A later failure therefore
 * leaves the successfully restored prefix committed, matching this helper's previous behavior.
 */
export async function restoreThemes(
  db: AppDatabase,
  items: ThemeRow[],
  commitGuard?: DbCommitGuard,
): Promise<void> {
  if (items.length === 0) return;

  // Queue the cutoff read so it cannot observe another transaction's uncommitted generation.
  const cutoff = await withDbTransaction(
    db,
    async () => {
      const rows = await db.all<{ maxId: number }>(sql`
        SELECT COALESCE(MAX(id), 0) AS maxId FROM themes
      `);
      return rows[0]?.maxId ?? 0;
    },
    commitGuard,
  );

  // (name, mode) → the last original row claimed for that identity.
  const lastClaimed = new Map<string, number>();

  for (const t of items) {
    const key = themeIdentity(t.name, t.mode);
    const afterId = lastClaimed.get(key) ?? 0;
    const claimedId = await withDbTransaction(
      db,
      async () => {
        const rows = await db.all<{ id: number }>(sql`
          SELECT id
            FROM themes
           WHERE is_preset = 0
             AND name = ${t.name}
             AND mode = ${t.mode}
             AND id > ${afterId}
             AND id <= ${cutoff}
           ORDER BY id
           LIMIT 1
        `);
        const id = rows[0]?.id;
        if (id != null) {
          // By id, so exactly one row is touched however many twins share the name. The preset guard
          // is redundant against the claim query but kept: a built-in preset must never be rewritten.
          await db.run(
            sql`UPDATE themes SET tokens = ${t.tokens} WHERE id = ${id} AND is_preset = 0`,
          );
          return id;
        } else {
          await db.run(sql`
            INSERT INTO themes (name, mode, tokens, is_preset)
            VALUES (${t.name}, ${t.mode}, ${t.tokens}, 0)
          `);
          return null;
        }
      },
      commitGuard,
    );
    // Advance only after COMMIT. A failed transaction throws before this point and cannot consume
    // an original row from the in-memory cursor.
    if (claimedId != null) lastClaimed.set(key, claimedId);
  }
}

/**
 * Apply backed-up customizations to chats that exist locally (UPDATE only).
 *
 * The `set` list is exactly the customizable columns the backup reads — no `deleted_at`, no
 * `marked_unread_at`, so a restore can neither resurrect a locally-deleted conversation nor hide a
 * live one behind a tombstone copied from another device.
 */
/** Transaction-context one-row primitive for an owner that already holds the write queue. */
export async function restoreChatCustomizationWithinTransaction(
  context: DbTransactionContext,
  customization: ChatCustomizationRow,
): Promise<number> {
  return runInTransactionContext(context, async (db) => {
    let pinOrder: number | null = null;
    if (customization.isPinned === 1) {
      if (customization.pinOrder != null) {
        pinOrder = customization.pinOrder;
      } else {
        const rows = await db.all<{ value: number | null }>(sql`
          SELECT MAX(pin_order) AS value FROM chats WHERE is_pinned = 1
        `);
        pinOrder = (rows[0]?.value ?? -1) + 1;
      }
    }
    const rows = await db
      .update(chats)
      .set({
        customName: customization.customName,
        customColor: customization.customColor,
        muteType: customization.muteType,
        isPinned: customization.isPinned === 1,
        pinOrder,
        isArchived: customization.isArchived === 1,
      })
      .where(eq(chats.guid, customization.guid))
      .returning({ id: chats.id });
    return rows.length;
  });
}

/**
 * Atomically apply one fully validated backup with a fixed number of set-based statements.
 *
 * JSON input is bounded and serialized by the service before it enters the transaction. Theme
 * occurrence ranks preserve the existing id-ordered twin pairing: the first backed-up `(name,
 * mode)` row updates the first matching local row, and only unmatched occurrences are inserted.
 *
 * Chat matching happens inside this same transaction. V2 combines service, direct/group kind, an
 * exact normalized participant set, and the stable server chat identifier when present. Conflicting
 * evidence, zero/multiple candidates, or multiple backup rows targeting one local chat all skip.
 * V1 can safely derive only direct `service;-;address` identities; group/opaque GUID rows skip
 * instead of risking customization of an unrelated group on another Mac. The caller reports every
 * skip to the user.
 */
export function restorePreparedBackupWithinTransaction(
  context: DbTransactionContext,
  input: PreparedBackupRestore,
): Promise<PreparedBackupRestoreResult> {
  return runInTransactionContext(context, async (db) => {
    await db.run(sql`
      INSERT INTO kv (key, value)
      SELECT json_extract(entry.value, '$.key'), json_extract(entry.value, '$.value')
        FROM json_each(${input.kvJson}) AS entry
       WHERE json_extract(entry.value, '$.value') IS NOT NULL
       ORDER BY CAST(entry.key AS INTEGER)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);

    await db.run(sql`
      WITH source_rows AS (
        SELECT CAST(entry.key AS INTEGER) AS source_index,
               json_extract(entry.value, '$.name') AS name,
               json_extract(entry.value, '$.mode') AS mode,
               json_extract(entry.value, '$.tokens') AS tokens
          FROM json_each(${input.themesJson}) AS entry
      ),
      source AS (
        SELECT source_index, name, mode, tokens,
               ROW_NUMBER() OVER (
                 PARTITION BY name, mode
                 ORDER BY source_index
               ) AS occurrence
          FROM source_rows
      ),
      existing AS (
        SELECT id, name, mode,
               ROW_NUMBER() OVER (
                 PARTITION BY name, mode
                 ORDER BY id
               ) AS occurrence
          FROM themes
         WHERE is_preset = 0
      ),
      matched AS (
        SELECT existing.id, source.tokens
          FROM source
          JOIN existing
            ON existing.name = source.name
           AND existing.mode = source.mode
           AND existing.occurrence = source.occurrence
      )
      UPDATE themes
         SET tokens = (SELECT matched.tokens FROM matched WHERE matched.id = themes.id)
       WHERE id IN (SELECT id FROM matched)
         AND is_preset = 0
    `);

    await db.run(sql`
      WITH source_rows AS (
        SELECT CAST(entry.key AS INTEGER) AS source_index,
               json_extract(entry.value, '$.name') AS name,
               json_extract(entry.value, '$.mode') AS mode,
               json_extract(entry.value, '$.tokens') AS tokens
          FROM json_each(${input.themesJson}) AS entry
      ),
      source AS (
        SELECT source_index, name, mode, tokens,
               ROW_NUMBER() OVER (
                 PARTITION BY name, mode
                 ORDER BY source_index
               ) AS occurrence
          FROM source_rows
      ),
      existing AS (
        SELECT id, name, mode,
               ROW_NUMBER() OVER (
                 PARTITION BY name, mode
                 ORDER BY id
               ) AS occurrence
          FROM themes
         WHERE is_preset = 0
      )
      INSERT INTO themes (name, mode, tokens, is_preset)
      SELECT source.name, source.mode, source.tokens, 0
        FROM source
        LEFT JOIN existing
          ON existing.name = source.name
         AND existing.mode = source.mode
         AND existing.occurrence = source.occurrence
       WHERE existing.id IS NULL
       ORDER BY source.source_index
    `);

    await db.run(sql`DROP TABLE IF EXISTS temp.gator_backup_restored_folder_members`);
    await db.run(sql`DROP TABLE IF EXISTS temp.gator_backup_restored_folders`);
    await db.run(sql`DROP TABLE IF EXISTS temp.gator_backup_resolved_chats`);
    try {
      await db.run(sql`
        CREATE TEMP TABLE gator_backup_resolved_chats AS
        WITH source_input AS (
          SELECT 'customization' AS restore_scope,
                 CAST(entry.key AS INTEGER) AS restore_index,
                 CAST(entry.key AS INTEGER) * 2 AS source_index,
                 entry.value AS source_json
            FROM json_each(${input.chatCustomizationsJson}) AS entry
          UNION ALL
          SELECT 'folder' AS restore_scope,
                 CAST(entry.key AS INTEGER) AS restore_index,
                 CAST(entry.key AS INTEGER) * 2 + 1 AS source_index,
                 entry.value AS source_json
            FROM json_each(${input.customFolderChatIdentitiesJson}) AS entry
        ),
        source_rows_raw AS (
          SELECT restore_scope,
                 restore_index,
                 source_index,
                 source_json,
               json_extract(source_json, '$.identity.version') AS identity_version,
               json_extract(source_json, '$.guid') AS guid,
               CASE
                 WHEN INSTR(COALESCE(json_extract(source_json, '$.guid'), ''), ';') > 0
                   THEN SUBSTR(
                     json_extract(source_json, '$.guid'),
                     INSTR(json_extract(source_json, '$.guid'), ';') + 1
                   )
                 ELSE ''
               END AS legacy_remainder,
               LOWER(TRIM(COALESCE(json_extract(source_json, '$.identity.service'), '')))
                 AS portable_service,
               json_extract(source_json, '$.identity.kind') AS portable_kind,
               NULLIF(
                 TRIM(json_extract(source_json, '$.identity.serverChatIdentifier')),
                 ''
               ) AS server_chat_identifier,
               json_extract(source_json, '$.customName') AS custom_name,
               json_extract(source_json, '$.customColor') AS custom_color,
               json_extract(source_json, '$.muteType') AS mute_type,
               json_extract(source_json, '$.isPinned') AS is_pinned,
               json_extract(source_json, '$.pinOrder') AS pin_order,
               json_extract(source_json, '$.isArchived') AS is_archived
            FROM source_input
      ),
      source_rows AS (
        SELECT source_rows_raw.*,
               CASE
                 WHEN identity_version = 1 THEN portable_service
                 WHEN LOWER(SUBSTR(COALESCE(guid, ''), 1, 6)) = 'rcs;-;' THEN 'rcs'
                 WHEN LOWER(SUBSTR(COALESCE(guid, ''), 1, 6)) = 'sms;-;' THEN 'sms'
                 ELSE 'imessage'
               END AS service,
               CASE
                 WHEN identity_version = 1 THEN portable_kind
                 WHEN INSTR(legacy_remainder, ';') > 0
                   THEN CASE SUBSTR(legacy_remainder, 1, INSTR(legacy_remainder, ';') - 1)
                     WHEN '-' THEN 'direct'
                     WHEN '+' THEN 'group'
                     ELSE 'unknown'
                   END
                 ELSE 'unknown'
               END AS kind,
               TRIM(
                 CASE
                   WHEN INSTR(legacy_remainder, ';') > 0
                     THEN SUBSTR(legacy_remainder, INSTR(legacy_remainder, ';') + 1)
                   ELSE ''
                 END
               ) AS legacy_raw_address
          FROM source_rows_raw
      ),
      source_participant_raw AS (
        SELECT source_rows.source_index,
               LOWER(TRIM(COALESCE(json_extract(participant.value, '$.service'), ''))) AS service,
               TRIM(COALESCE(json_extract(participant.value, '$.address'), '')) AS raw_address
          FROM source_rows
          JOIN json_each(source_rows.source_json, '$.identity.participants') AS participant
            ON TRUE
         WHERE source_rows.identity_version = 1
      ),
      source_participant_cleaned AS (
        SELECT source_index, service, raw_address,
               ${BACKUP_PHONE_COMPACT_SQL} AS phone_compact
          FROM source_participant_raw
         WHERE raw_address <> ''
      ),
      source_participants AS (
        SELECT DISTINCT source_index, service,
               ${BACKUP_NORMALIZED_ADDRESS_SQL} AS normalized_address
          FROM source_participant_cleaned
      ),
      source_participant_counts AS (
        SELECT source_index, COUNT(*) AS participant_count
          FROM source_participants
         GROUP BY source_index
      ),
      source_address_identity_raw AS (
        SELECT source_index, 'stable' AS identity_role,
               server_chat_identifier AS raw_address
          FROM source_rows
         WHERE identity_version = 1
           AND kind = 'direct'
           AND server_chat_identifier IS NOT NULL
        UNION ALL
        SELECT source_index, 'legacy' AS identity_role,
               legacy_raw_address AS raw_address
          FROM source_rows
         WHERE identity_version IS NULL
           AND kind = 'direct'
           AND legacy_raw_address <> ''
      ),
      source_address_identity_cleaned AS (
        SELECT source_index, identity_role, raw_address,
               ${BACKUP_PHONE_COMPACT_SQL} AS phone_compact
          FROM source_address_identity_raw
      ),
      source_address_identities AS (
        SELECT source_index, identity_role,
               ${BACKUP_NORMALIZED_ADDRESS_SQL} AS normalized_address
          FROM source_address_identity_cleaned
      ),
      local_participant_raw AS (
        SELECT chat_handles.chat_id,
               LOWER(TRIM(COALESCE(handles.service, ''))) AS service,
               TRIM(handles.address) AS raw_address
          FROM chat_handles
          JOIN handles ON handles.id = chat_handles.handle_id
      ),
      local_participant_cleaned AS (
        SELECT chat_id, service, raw_address,
               ${BACKUP_PHONE_COMPACT_SQL} AS phone_compact
          FROM local_participant_raw
         WHERE raw_address <> ''
      ),
      local_participants AS (
        SELECT DISTINCT chat_id, service,
               ${BACKUP_NORMALIZED_ADDRESS_SQL} AS normalized_address
          FROM local_participant_cleaned
      ),
      local_participant_counts AS (
        SELECT chat_id, COUNT(*) AS participant_count
          FROM local_participants
         GROUP BY chat_id
      ),
      local_service_summary AS (
        SELECT chat_id,
               SUM(CASE WHEN service <> '' THEN 1 ELSE 0 END) AS named_service_count,
               SUM(CASE WHEN service = 'sms' THEN 1 ELSE 0 END) AS sms_service_count
          FROM local_participant_raw
         GROUP BY chat_id
      ),
      local_chats_raw AS (
        SELECT chats.id AS chat_id, chats.guid, chats.style,
               CASE
                 WHEN INSTR(chats.guid, ';') > 0
                   THEN SUBSTR(chats.guid, INSTR(chats.guid, ';') + 1)
                 ELSE ''
               END AS guid_remainder,
               NULLIF(TRIM(chats.chat_identifier), '') AS server_chat_identifier,
               COALESCE(local_participant_counts.participant_count, 0) AS participant_count,
               COALESCE(local_service_summary.named_service_count, 0) AS named_service_count,
               COALESCE(local_service_summary.sms_service_count, 0) AS sms_service_count
          FROM chats
          LEFT JOIN local_participant_counts
            ON local_participant_counts.chat_id = chats.id
          LEFT JOIN local_service_summary
            ON local_service_summary.chat_id = chats.id
      ),
      local_chats AS (
        SELECT local_chats_raw.*,
               CASE
                 WHEN LOWER(SUBSTR(guid, 1, 6)) = 'rcs;-;' THEN 'rcs'
                 WHEN LOWER(SUBSTR(guid, 1, 6)) = 'sms;-;' THEN 'sms'
                 WHEN named_service_count > 0 AND named_service_count = sms_service_count THEN 'sms'
                 ELSE 'imessage'
               END AS service,
               CASE
                 WHEN style = 43 THEN 'group'
                 WHEN style = 45 THEN 'direct'
                 WHEN INSTR(guid_remainder, ';') > 0
                   THEN CASE SUBSTR(guid_remainder, 1, INSTR(guid_remainder, ';') - 1)
                     WHEN '-' THEN 'direct'
                     WHEN '+' THEN 'group'
                     ELSE 'unknown'
                   END
                 WHEN participant_count > 1 THEN 'group'
                 WHEN participant_count = 1 THEN 'direct'
                 ELSE 'unknown'
               END AS kind,
               TRIM(
                 CASE
                   WHEN INSTR(guid_remainder, ';') > 0
                     THEN SUBSTR(guid_remainder, INSTR(guid_remainder, ';') + 1)
                   ELSE ''
                 END
               ) AS guid_raw_address
          FROM local_chats_raw
      ),
      local_address_identity_raw AS (
        SELECT chat_id, 'stable' AS identity_role,
               server_chat_identifier AS raw_address
          FROM local_chats
         WHERE kind = 'direct'
           AND server_chat_identifier IS NOT NULL
        UNION ALL
        SELECT chat_id, 'legacy' AS identity_role,
               guid_raw_address AS raw_address
          FROM local_chats
         WHERE kind = 'direct'
           AND INSTR(guid_remainder, ';') > 0
           AND SUBSTR(guid_remainder, 1, INSTR(guid_remainder, ';') - 1) = '-'
           AND guid_raw_address <> ''
      ),
      local_address_identity_cleaned AS (
        SELECT chat_id, identity_role, raw_address,
               ${BACKUP_PHONE_COMPACT_SQL} AS phone_compact
          FROM local_address_identity_raw
      ),
      local_address_identities AS (
        SELECT chat_id, identity_role,
               ${BACKUP_NORMALIZED_ADDRESS_SQL} AS normalized_address
          FROM local_address_identity_cleaned
      ),
      legacy_candidates AS (
        SELECT source_rows.source_index, local_chats.chat_id
          FROM source_address_identities
          JOIN source_rows
            ON source_rows.source_index = source_address_identities.source_index
          JOIN local_address_identities
            ON local_address_identities.identity_role = 'legacy'
           AND local_address_identities.normalized_address =
             source_address_identities.normalized_address
          JOIN local_chats ON local_chats.chat_id = local_address_identities.chat_id
         WHERE source_address_identities.identity_role = 'legacy'
           AND source_rows.identity_version IS NULL
           AND source_rows.kind = 'direct'
           AND local_chats.kind = 'direct'
           AND local_chats.service = source_rows.service
      ),
      legacy_summary AS (
        SELECT source_index, COUNT(*) AS candidate_count, MIN(chat_id) AS chat_id
          FROM legacy_candidates
         GROUP BY source_index
      ),
      legacy_resolved AS (
        SELECT source_index, chat_id
          FROM legacy_summary
         WHERE candidate_count = 1
      ),
      participant_match_counts AS (
        SELECT source_participants.source_index, local_participants.chat_id,
               COUNT(*) AS matched_count
          FROM source_participants
          JOIN local_participants
            ON local_participants.service = source_participants.service
           AND local_participants.normalized_address =
             source_participants.normalized_address
         GROUP BY source_participants.source_index, local_participants.chat_id
      ),
      participant_candidates AS (
        SELECT participant_match_counts.source_index, participant_match_counts.chat_id
          FROM participant_match_counts
          JOIN source_participant_counts
            ON source_participant_counts.source_index =
              participant_match_counts.source_index
          JOIN local_participant_counts
            ON local_participant_counts.chat_id = participant_match_counts.chat_id
          JOIN source_rows
            ON source_rows.source_index = participant_match_counts.source_index
          JOIN local_chats
            ON local_chats.chat_id = participant_match_counts.chat_id
         WHERE participant_match_counts.matched_count =
               source_participant_counts.participant_count
           AND participant_match_counts.matched_count =
               local_participant_counts.participant_count
           AND source_rows.identity_version = 1
           AND source_rows.service <> ''
           AND source_rows.kind <> 'unknown'
           AND local_chats.service = source_rows.service
           AND local_chats.kind = source_rows.kind
      ),
      stable_direct_matches AS (
        SELECT source_rows.source_index, local_chats.chat_id
          FROM source_address_identities
          JOIN source_rows
            ON source_rows.source_index = source_address_identities.source_index
          JOIN local_address_identities
            ON local_address_identities.identity_role = 'stable'
           AND local_address_identities.normalized_address =
             source_address_identities.normalized_address
          JOIN local_chats ON local_chats.chat_id = local_address_identities.chat_id
         WHERE source_address_identities.identity_role = 'stable'
           AND source_rows.identity_version = 1
           AND source_rows.service <> ''
           AND source_rows.kind = 'direct'
           AND local_chats.service = source_rows.service
           AND local_chats.kind = 'direct'
      ),
      stable_group_matches AS (
        SELECT source_rows.source_index, local_chats.chat_id
          FROM source_rows
          JOIN local_chats
            ON local_chats.service = source_rows.service
           AND local_chats.kind = 'group'
           AND local_chats.server_chat_identifier =
             source_rows.server_chat_identifier
         WHERE source_rows.identity_version = 1
           AND source_rows.service <> ''
           AND source_rows.kind = 'group'
           AND source_rows.server_chat_identifier IS NOT NULL
      ),
      stable_identity_matches AS (
        SELECT source_index, chat_id FROM stable_direct_matches
        UNION
        SELECT source_index, chat_id FROM stable_group_matches
      ),
      stable_candidates AS (
        SELECT stable_identity_matches.source_index, stable_identity_matches.chat_id
          FROM stable_identity_matches
          LEFT JOIN source_participant_counts
            ON source_participant_counts.source_index =
              stable_identity_matches.source_index
          LEFT JOIN local_participant_counts
            ON local_participant_counts.chat_id = stable_identity_matches.chat_id
         WHERE source_participant_counts.participant_count IS NULL
            OR local_participant_counts.participant_count IS NULL
            OR EXISTS (
              SELECT 1
                FROM participant_candidates
               WHERE participant_candidates.source_index =
                       stable_identity_matches.source_index
                 AND participant_candidates.chat_id =
                       stable_identity_matches.chat_id
            )
      ),
      stable_summary AS (
        SELECT source_index, COUNT(*) AS candidate_count, MIN(chat_id) AS chat_id
          FROM stable_candidates
         GROUP BY source_index
      ),
      participant_summary AS (
        SELECT participant_candidates.source_index, COUNT(*) AS candidate_count,
               MIN(participant_candidates.chat_id) AS chat_id,
               SUM(
                 CASE
                   WHEN source_rows.server_chat_identifier IS NULL
                     OR local_chats.server_chat_identifier IS NULL
                     OR EXISTS (
                       SELECT 1
                         FROM stable_identity_matches
                        WHERE stable_identity_matches.source_index =
                                participant_candidates.source_index
                          AND stable_identity_matches.chat_id =
                                participant_candidates.chat_id
                     )
                     THEN 1
                   ELSE 0
                 END
               ) AS compatible_count
          FROM participant_candidates
          JOIN source_rows ON source_rows.source_index = participant_candidates.source_index
          JOIN local_chats ON local_chats.chat_id = participant_candidates.chat_id
         GROUP BY participant_candidates.source_index
      ),
      intersection_summary AS (
        SELECT stable_candidates.source_index, COUNT(*) AS candidate_count,
               MIN(stable_candidates.chat_id) AS chat_id
          FROM stable_candidates
          JOIN participant_candidates
            ON participant_candidates.source_index = stable_candidates.source_index
           AND participant_candidates.chat_id = stable_candidates.chat_id
         GROUP BY stable_candidates.source_index
      ),
      portable_resolution AS (
        SELECT source_rows.source_index,
               CASE
                 WHEN COALESCE(stable_summary.candidate_count, 0) > 0
                  AND COALESCE(participant_summary.candidate_count, 0) > 0
                   THEN CASE
                     WHEN intersection_summary.candidate_count = 1
                       THEN intersection_summary.chat_id
                     ELSE NULL
                   END
                 WHEN stable_summary.candidate_count = 1 THEN stable_summary.chat_id
                 WHEN participant_summary.candidate_count = 1
                  AND participant_summary.compatible_count = 1
                   THEN participant_summary.chat_id
                 ELSE NULL
               END AS chat_id
          FROM source_rows
          LEFT JOIN stable_summary ON stable_summary.source_index = source_rows.source_index
          LEFT JOIN participant_summary
            ON participant_summary.source_index = source_rows.source_index
          LEFT JOIN intersection_summary
            ON intersection_summary.source_index = source_rows.source_index
         WHERE source_rows.identity_version = 1
      ),
      portable_resolved AS (
        SELECT source_index, chat_id
          FROM portable_resolution
         WHERE chat_id IS NOT NULL
      ),
      resolved_candidates AS (
        SELECT source_index, chat_id FROM legacy_resolved
        UNION ALL
        SELECT source_index, chat_id FROM portable_resolved
      ),
      resolved_ranked AS (
        SELECT resolved_candidates.source_index, resolved_candidates.chat_id,
               source_rows.restore_scope,
               COUNT(*) OVER (
                 PARTITION BY source_rows.restore_scope, resolved_candidates.chat_id
               ) AS source_count
          FROM resolved_candidates
          JOIN source_rows ON source_rows.source_index = resolved_candidates.source_index
      ),
      resolved AS (
        SELECT source_index, chat_id
          FROM resolved_ranked
         WHERE source_count = 1
      )
      SELECT source_rows.*, resolved.chat_id
          FROM source_rows
          JOIN resolved ON resolved.source_index = source_rows.source_index
      `);

      const appliedRows = await db.all<{ id: number }>(sql`
        WITH source AS (
          SELECT *
            FROM temp.gator_backup_resolved_chats
           WHERE restore_scope = 'customization'
        ),
      source_pin_ranked AS (
        SELECT source_index, chat_id,
               ROW_NUMBER() OVER (
                 ORDER BY CASE WHEN pin_order IS NULL THEN 1 ELSE 0 END,
                          pin_order ASC,
                          source_index ASC
               ) - 1 AS normalized_pin_order
          FROM source
         WHERE is_pinned = 1
      ),
      untouched_pin_base AS (
        SELECT COALESCE(MAX(c.pin_order), -1) + 1 AS next_pin_order
          FROM chats AS c
         WHERE c.is_pinned = 1
           AND NOT EXISTS (SELECT 1 FROM source WHERE source.chat_id = c.id)
      )
      UPDATE chats
         SET custom_name = (SELECT source.custom_name FROM source WHERE source.chat_id = chats.id),
             custom_color = (SELECT source.custom_color FROM source WHERE source.chat_id = chats.id),
             mute_type = (SELECT source.mute_type FROM source WHERE source.chat_id = chats.id),
             is_pinned = (SELECT source.is_pinned FROM source WHERE source.chat_id = chats.id),
             pin_order = (
               SELECT CASE
                 WHEN source.is_pinned != 1 THEN NULL
                 ELSE (SELECT next_pin_order FROM untouched_pin_base)
                      + (SELECT source_pin_ranked.normalized_pin_order
                           FROM source_pin_ranked
                          WHERE source_pin_ranked.chat_id = source.chat_id)
               END
                 FROM source
                WHERE source.chat_id = chats.id
             ),
             is_archived = (SELECT source.is_archived FROM source WHERE source.chat_id = chats.id)
       WHERE id IN (SELECT chat_id FROM source)
      RETURNING id
      `);

      const applied = appliedRows.length;
      if (!Number.isSafeInteger(applied) || applied < 0) {
        throw new Error('Backup restore returned an invalid chat count.');
      }

      // Existing local folders win capacity and retain their current position. New names append in
      // backup order; exact-name matches merge idempotently instead of creating duplicate folders.
      await db.run(sql`
        WITH source AS (
          SELECT CAST(entry.key AS INTEGER) AS source_index,
                 json_extract(entry.value, '$.name') AS name,
                 json_extract(entry.value, '$.showUnreadBadge') AS show_unread_badge
            FROM json_each(${input.customFoldersJson}) AS entry
        ),
        existing_summary AS (
          SELECT COUNT(*) AS folder_count,
                 COALESCE(MAX(sort_order), -1) AS max_sort_order
            FROM custom_folders
        ),
        new_source AS (
          SELECT source.*,
                 ROW_NUMBER() OVER (ORDER BY source.source_index) AS new_rank
            FROM source
           WHERE NOT EXISTS (
             SELECT 1 FROM custom_folders WHERE custom_folders.name = source.name
           )
        )
        INSERT INTO custom_folders (name, sort_order, show_unread_badge)
        SELECT new_source.name,
               existing_summary.max_sort_order + new_source.new_rank,
               new_source.show_unread_badge
          FROM new_source
          CROSS JOIN existing_summary
         WHERE new_source.new_rank <=
               MAX(0, ${MAX_CUSTOM_FOLDERS} - existing_summary.folder_count)
         ORDER BY new_source.source_index
      `);

      await db.run(sql`
        CREATE TEMP TABLE gator_backup_restored_folders AS
        WITH source AS (
          SELECT CAST(entry.key AS INTEGER) AS source_index,
                 json_extract(entry.value, '$.name') AS name,
                 json_extract(entry.value, '$.showUnreadBadge') AS show_unread_badge,
                 json_extract(entry.value, '$.sourceMemberCount') AS source_member_count
            FROM json_each(${input.customFoldersJson}) AS entry
        )
        SELECT source.source_index,
               folder.id AS folder_id,
               source.show_unread_badge,
               source.source_member_count
          FROM source
          JOIN custom_folders AS folder ON folder.name = source.name
      `);

      await db.run(sql`
        UPDATE custom_folders
           SET show_unread_badge = (
             SELECT restored.show_unread_badge
               FROM temp.gator_backup_restored_folders AS restored
              WHERE restored.folder_id = custom_folders.id
           )
         WHERE id IN (SELECT folder_id FROM temp.gator_backup_restored_folders)
      `);

      // Merge resolved portable members without pruning local-only or currently unresolvable rows.
      // Existing memberships consume capacity first; deterministic file order selects any remaining
      // additions up to the same 5,000-member bound used by the folder editor.
      await db.run(sql`
        CREATE TEMP TABLE gator_backup_restored_folder_members AS
        WITH source_members AS (
          SELECT CAST(folder_entry.key AS INTEGER) AS folder_source_index,
                 CAST(member_entry.key AS INTEGER) AS member_order,
                 CAST(member_entry.value AS INTEGER) AS identity_index
            FROM json_each(${input.customFoldersJson}) AS folder_entry
            JOIN json_each(folder_entry.value, '$.memberIndexes') AS member_entry ON TRUE
        ),
        resolved_source AS (
          SELECT restored.folder_id,
                 source_members.member_order,
                 chat.guid AS chat_guid
            FROM source_members
            JOIN temp.gator_backup_restored_folders AS restored
              ON restored.source_index = source_members.folder_source_index
            JOIN temp.gator_backup_resolved_chats AS resolved
              ON resolved.restore_scope = 'folder'
             AND resolved.restore_index = source_members.identity_index
            JOIN chats AS chat ON chat.id = resolved.chat_id
           WHERE length(chat.guid) BETWEEN 1 AND ${MAX_CUSTOM_FOLDER_CHAT_GUID_CODE_POINTS}
             AND length(CAST(chat.guid AS BLOB)) <=
                 ${MAX_CUSTOM_FOLDER_CHAT_GUID_CODE_POINTS * 4}
             AND instr(chat.guid, char(0)) = 0
        ),
        deduplicated AS (
          SELECT folder_id, chat_guid, MIN(member_order) AS member_order
            FROM resolved_source
           GROUP BY folder_id, chat_guid
        ),
        existing_counts AS (
          SELECT restored.folder_id, COUNT(member.chat_guid) AS member_count
            FROM temp.gator_backup_restored_folders AS restored
            LEFT JOIN custom_folder_members AS member ON member.folder_id = restored.folder_id
           GROUP BY restored.folder_id
        ),
        existing_matches AS (
          SELECT deduplicated.folder_id, deduplicated.chat_guid
            FROM deduplicated
            JOIN custom_folder_members AS member
              ON member.folder_id = deduplicated.folder_id
             AND member.chat_guid = deduplicated.chat_guid
        ),
        new_candidates AS (
          SELECT deduplicated.folder_id,
                 deduplicated.chat_guid,
                 deduplicated.member_order
            FROM deduplicated
            LEFT JOIN custom_folder_members AS member
              ON member.folder_id = deduplicated.folder_id
             AND member.chat_guid = deduplicated.chat_guid
           WHERE member.chat_guid IS NULL
        ),
        new_ranked AS (
          SELECT new_candidates.*,
                 ROW_NUMBER() OVER (
                   PARTITION BY new_candidates.folder_id
                   ORDER BY new_candidates.member_order ASC, new_candidates.chat_guid ASC
                 ) AS new_rank
            FROM new_candidates
        ),
        eligible_new AS (
          SELECT new_ranked.folder_id, new_ranked.chat_guid
            FROM new_ranked
            JOIN existing_counts ON existing_counts.folder_id = new_ranked.folder_id
           WHERE new_ranked.new_rank <=
                 MAX(0, ${MAX_CUSTOM_FOLDER_MEMBERS} - existing_counts.member_count)
        )
        SELECT folder_id, chat_guid FROM existing_matches
        UNION ALL
        SELECT folder_id, chat_guid FROM eligible_new
      `);

      await db.run(sql`
        INSERT OR IGNORE INTO custom_folder_members (folder_id, chat_guid)
        SELECT folder_id, chat_guid
          FROM temp.gator_backup_restored_folder_members
         ORDER BY folder_id ASC, chat_guid ASC
      `);

      const resultRows = await db.all<{
        customFolders: number;
        customFolderMemberships: number;
      }>(sql`
        SELECT (
                 SELECT COUNT(*) FROM temp.gator_backup_restored_folders
               ) AS customFolders,
               (
                 SELECT COUNT(*) FROM temp.gator_backup_restored_folder_members
               ) AS customFolderMemberships
      `);
      const customFolders = resultRows[0]?.customFolders ?? 0;
      const customFolderMemberships = resultRows[0]?.customFolderMemberships ?? 0;
      if (
        !Number.isSafeInteger(customFolders) ||
        customFolders < 0 ||
        !Number.isSafeInteger(customFolderMemberships) ||
        customFolderMemberships < 0
      ) {
        throw new Error('Backup restore returned invalid custom folder counts.');
      }
      return {
        chatCustomizations: applied,
        customFolders,
        customFolderMemberships,
      };
    } finally {
      await db.run(sql`DROP TABLE IF EXISTS temp.gator_backup_restored_folder_members`);
      await db.run(sql`DROP TABLE IF EXISTS temp.gator_backup_restored_folders`);
      await db.run(sql`DROP TABLE IF EXISTS temp.gator_backup_resolved_chats`);
    }
  });
}

/**
 * Public owner: restore at most one chat row per short transaction. The input is backup-controlled
 * and can contain many chats, so no transaction spans the loop. An optional account commit guard
 * rejects a queued/late row before BEGIN or COMMIT.
 */
export async function restoreChatCustomizations(
  db: AppDatabase,
  items: ChatCustomizationRow[],
  commitGuard?: DbCommitGuard,
): Promise<number> {
  let applied = 0;
  for (const c of items) {
    applied += await withDbTransaction(
      db,
      (context) => restoreChatCustomizationWithinTransaction(context, c),
      commitGuard,
    );
  }
  return applied;
}
