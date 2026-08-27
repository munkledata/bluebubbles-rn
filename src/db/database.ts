import * as Crypto from 'expo-crypto';
import { open } from '@op-engineering/op-sqlite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/op-sqlite';
import { runMigrations, type SqlRunner } from './migrate';
import { MIGRATIONS } from './migrations';
import { handles } from './schema';
import type {
  AppDatabase,
  DbRuntimeConcurrencyWaveChecks,
  DbRuntimeConcurrencyWaveRunner,
} from './types';

const DB_NAME = 'gator.db';

type RawDb = ReturnType<typeof open>;

let rawDb: RawDb | null = null;
let dbInstance: AppDatabase | null = null;

function extractRows(res: unknown): Array<Record<string, unknown>> {
  const r = res as { rows?: unknown };
  if (Array.isArray(r?.rows)) return r.rows as Array<Record<string, unknown>>;
  const legacy = (r?.rows as { _array?: unknown })?._array;
  if (Array.isArray(legacy)) return legacy as Array<Record<string, unknown>>;
  return [];
}

/** Adapt op-sqlite's execute API to the migration SqlRunner interface. */
function opRunner(db: RawDb): SqlRunner {
  return {
    async exec(sql, params) {
      await db.execute(sql, (params as never[]) ?? []);
    },
    async query(sql, params) {
      const res = await db.execute(sql, (params as never[]) ?? []);
      return extractRows(res) as never[];
    },
  };
}

/**
 * Adapter so drizzle-orm's op-sqlite driver works with op-sqlite v17, whose API
 * diverged from what drizzle expects. drizzle calls a SYNCHRONOUS
 * `execute().rows._array` plus `executeAsync`/`executeRawAsync`; op-sqlite v17
 * instead provides async `execute` (rows as a plain array), `executeSync`, and
 * `executeRaw` (with `rawRows`). This Proxy presents the legacy interface drizzle
 * wants while delegating to the real handle. Migrations and `reactiveExecute`
 * keep using the un-adapted handle.
 */
function drizzleAdapter(db: RawDb): RawDb {
  const wrap = (r: { rows?: unknown[] }): unknown => ({ ...r, rows: { _array: r.rows ?? [] } });
  // op-sqlite batches reactive notifications on its thread pool; flush after
  // writes so `reactiveExecute` subscribers (the live conversation list) re-run.
  const flush = (): void => void db.flushPendingReactiveQueries();
  let transactionOpen = false;
  const transactionCommand = (statement: string): string =>
    statement.trim().replace(/;+$/, '').toUpperCase();
  const flushAfter = (command: string): void => {
    if (command.startsWith('BEGIN')) {
      transactionOpen = true;
      return;
    }
    if (command === 'COMMIT' || command === 'ROLLBACK') {
      transactionOpen = false;
      flush();
      return;
    }
    if (!transactionOpen) flush();
  };
  const retireFailedRollback = (command: string): void => {
    // SQLite may auto-abort before reporting a ROLLBACK error. The shared transaction owner
    // deliberately contains that cleanup error, so the adapter must not suppress every later
    // autocommit notification under a stale in-memory transaction flag.
    if (command === 'ROLLBACK') transactionOpen = false;
  };
  const overrides: Record<string, unknown> = {
    execute: (statement: string, params?: unknown[]) => {
      const command = transactionCommand(statement);
      try {
        const r = db.executeSync(statement, (params as never[]) ?? []);
        flushAfter(command);
        return wrap(r);
      } catch (error) {
        retireFailedRollback(command);
        throw error;
      }
    },
    executeAsync: async (statement: string, params?: unknown[]) => {
      const command = transactionCommand(statement);
      try {
        const r = await db.execute(statement, (params as never[]) ?? []);
        flushAfter(command);
        return wrap(r);
      } catch (error) {
        retireFailedRollback(command);
        throw error;
      }
    },
    executeRawAsync: async (statement: string, params?: unknown[]) => {
      const command = transactionCommand(statement);
      try {
        const r = await db.executeRaw(statement, (params as never[]) ?? []);
        flushAfter(command);
        return r.rawRows;
      } catch (error) {
        retireFailedRollback(command);
        throw error;
      }
    },
  };
  return new Proxy(db as object, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && prop in overrides) return overrides[prop];
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as RawDb;
}

/**
 * Open the encrypted database (once), enable FK enforcement, run migrations, and
 * return the Drizzle handle. SQLCipher transparently AES-encrypts the file using
 * `encryptionKey` (op-sqlite is built with the sqlcipher flag in package.json).
 */
export async function initDatabase(encryptionKey: string): Promise<AppDatabase> {
  if (dbInstance) return dbInstance;
  const opened = open({ name: DB_NAME, encryptionKey });
  try {
    await opened.execute('PRAGMA foreign_keys = ON');
    await runMigrations(opRunner(opened));
    const database = drizzle(drizzleAdapter(opened)) as unknown as AppDatabase;

    // Publish the pair only after every fallible initialization step succeeds. A failed key,
    // PRAGMA, or migration must never leave getRawDatabase() pointing at a poisoned handle, and a
    // later retry must be free to open the file normally.
    rawDb = opened;
    dbInstance = database;
    return database;
  } catch (error) {
    try {
      opened.close();
    } catch {
      // Preserve the initialization failure; close is best-effort cleanup of an unusable handle.
    }
    throw error;
  }
}

export function getDatabase(): AppDatabase {
  if (!dbInstance) throw new Error('Database not initialized — call initDatabase() first.');
  return dbInstance;
}

/** Raw op-sqlite handle, for low-level checks (e.g. the on-device SQLCipher test). */
export function getRawDatabase(): RawDb {
  if (!rawDb) throw new Error('Database not initialized — call initDatabase() first.');
  return rawDb;
}

const DRIVER_SELF_TEST_DB_NAME = 'driver-selftest.db';
const DRIVER_SELF_TEST_KEY_BYTES = 32;
const DRIVER_SELF_TEST_REACTIVE_TIMEOUT_MS = 5_000;
const DRIVER_SELF_TEST_MIGRATION_COUNT = 40 as const;
const DRIVER_SELF_TEST_MIGRATION_HEAD = '0040_chats_pin_order' as const;
const DRIVER_SELF_TEST_PARTIAL_MIGRATION_COUNT = 29;
const DRIVER_HISTORY_SELF_TEST_DB_NAME = 'driver-history-selftest.db';
const DRIVER_HISTORY_SELF_TEST_KEY = 'db-03b2a-public-throwaway-key-v1';
const DRIVER_HISTORY_SELF_TEST_WRONG_KEY = 'db-03b2a-wrong-public-throwaway-key-v1';
const DRIVER_HISTORY_STOP_MESSAGE = 'db-03b2a-stop-after-reviewed-head';

interface DriverHistoryCase {
  readonly count: 24 | 27 | 29;
  readonly head:
    '0024_scheduled_recurrence' | '0027_message_payload_data' | '0029_chats_deleted_at';
  readonly next:
    '0025_error_reports' | '0028_chats_marked_unread_at' | '0030_attachment_cache_entries';
  readonly digest: string;
  readonly representativeCommit: string;
}

/**
 * Immutable repository-history provenance for the three reviewed DB-03B2A repository heads.
 * These records do not claim store distribution: the repository has no release tags or retained
 * historical APK/database samples.
 */
const DRIVER_HISTORY_CASES = [
  {
    count: 24,
    head: '0024_scheduled_recurrence',
    next: '0025_error_reports',
    digest: 'd7cce2d30a027e90dc2bd046fea104037c04c8128099161608ec41a21ad2bfbb',
    representativeCommit: '51a513f52e22411769480ad4f2ee0c67be550565',
  },
  {
    count: 27,
    head: '0027_message_payload_data',
    next: '0028_chats_marked_unread_at',
    digest: '4874c622bc085c32cc769f532b77e91634e2be82d73997ed6fe10bdcf078205c',
    representativeCommit: 'f0167bee099afa04f79b21182cfbcefc7367be61',
  },
  {
    count: 29,
    head: '0029_chats_deleted_at',
    next: '0030_attachment_cache_entries',
    digest: '1daf75189a26297b49e5c6fc7c7d968f5d5cf87a50f0338b95eaa0ae2766c8ea',
    representativeCommit: '0564a80b572f16faf63c4d7b13c798a72451c845',
  },
] as const satisfies readonly DriverHistoryCase[];

export interface DbDriverContractChecks {
  encryptedOpen: boolean;
  wrongKeyRejected: boolean;
  migrationRollback: boolean;
  migrationRetry: boolean;
  migrationLedger: boolean;
  migrationData: boolean;
  fts5: boolean;
  integrity: boolean;
  idempotent: boolean;
  rollback: boolean;
  syncReactive: boolean;
  asyncReactive: boolean;
  rawReactive: boolean;
  rekey: boolean;
  newKeyReopen: boolean;
  oldKeyRejected: boolean;
  historicalProvenance: boolean;
  historical0024: boolean;
  historical0027: boolean;
  historical0029: boolean;
  historicalReadOnly: boolean;
  historicalWrongKeyRejected: boolean;
  historicalData: boolean;
  historicalFts5: boolean;
  historicalIntegrity: boolean;
  historicalIdempotent: boolean;
  historicalCleanup: boolean;
  cleanup: boolean;
}

export type DbDriverContractFailureCode =
  | 'key-generation'
  | 'pre-cleanup'
  | 'encrypted-open'
  | 'migration-rollback'
  | 'wrong-key-not-rejected'
  | 'correct-key-reopen'
  | 'migration-retry'
  | 'migration-ledger'
  | 'migration-data'
  | 'fts5'
  | 'integrity'
  | 'idempotent'
  | 'rollback'
  | 'sync-reactive'
  | 'async-reactive'
  | 'raw-reactive'
  | 'rekey'
  | 'new-key-reopen'
  | 'old-key-not-rejected'
  | 'historical-provenance'
  | 'historical-pre-cleanup'
  | 'historical-0024-fixture'
  | 'historical-0024-read-only'
  | 'historical-0024-wrong-key-not-rejected'
  | 'historical-0024-migration'
  | 'historical-0024-data'
  | 'historical-0024-fts5'
  | 'historical-0024-integrity'
  | 'historical-0024-idempotent'
  | 'historical-0027-fixture'
  | 'historical-0027-read-only'
  | 'historical-0027-wrong-key-not-rejected'
  | 'historical-0027-migration'
  | 'historical-0027-data'
  | 'historical-0027-fts5'
  | 'historical-0027-integrity'
  | 'historical-0027-idempotent'
  | 'historical-cleanup'
  | 'cleanup'
  | 'internal';

export type DbDriverContractResult =
  | {
      schema: 3;
      suite: 'android-db-contract';
      status: 'pass';
      migrationCount: typeof DRIVER_SELF_TEST_MIGRATION_COUNT;
      migrationHead: typeof DRIVER_SELF_TEST_MIGRATION_HEAD;
      checks: DbDriverContractChecks;
    }
  | {
      schema: 3;
      suite: 'android-db-contract';
      status: 'fail';
      migrationCount: typeof DRIVER_SELF_TEST_MIGRATION_COUNT;
      migrationHead: typeof DRIVER_SELF_TEST_MIGRATION_HEAD;
      checks: DbDriverContractChecks;
      failureCode: DbDriverContractFailureCode;
    };

function emptyDbDriverContractChecks(): DbDriverContractChecks {
  return {
    encryptedOpen: false,
    wrongKeyRejected: false,
    migrationRollback: false,
    migrationRetry: false,
    migrationLedger: false,
    migrationData: false,
    fts5: false,
    integrity: false,
    idempotent: false,
    rollback: false,
    syncReactive: false,
    asyncReactive: false,
    rawReactive: false,
    rekey: false,
    newKeyReopen: false,
    oldKeyRejected: false,
    historicalProvenance: false,
    historical0024: false,
    historical0027: false,
    historical0029: false,
    historicalReadOnly: false,
    historicalWrongKeyRejected: false,
    historicalData: false,
    historicalFts5: false,
    historicalIntegrity: false,
    historicalIdempotent: false,
    historicalCleanup: false,
    cleanup: false,
  };
}

export const DB_DRIVER_CONTRACT_INTERNAL_FAILURE: DbDriverContractResult = {
  schema: 3,
  suite: 'android-db-contract',
  status: 'fail',
  migrationCount: DRIVER_SELF_TEST_MIGRATION_COUNT,
  migrationHead: DRIVER_SELF_TEST_MIGRATION_HEAD,
  checks: emptyDbDriverContractChecks(),
  failureCode: 'internal',
};

function randomDriverSelfTestKey(): string {
  let hex = '';
  for (const byte of Crypto.getRandomBytes(DRIVER_SELF_TEST_KEY_BYTES)) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

function deleteDriverSelfTestDatabase(): boolean {
  let cleanup: RawDb | undefined;
  try {
    cleanup = open({ name: DRIVER_SELF_TEST_DB_NAME });
    cleanup.delete();
    return true;
  } catch {
    try {
      cleanup?.close();
    } catch {
      // The finite cleanup=false result is authoritative; never replace it with a close error.
    }
    return false;
  }
}

function requireDriverContract(condition: boolean): asserts condition {
  if (!condition) throw new Error('database driver contract assertion failed');
}

function isExpectedDriverMigrationConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('attachment_cache_entries_state_lru_idx') && message.includes('already exists')
  );
}

function hasExactStringColumn(
  rows: Array<Record<string, unknown>>,
  column: string,
  expected: readonly string[],
): boolean {
  return (
    rows.length === expected.length && rows.every((row, index) => row[column] === expected[index])
  );
}

type DbHistoricalMigrationFailureCode = Extract<
  DbDriverContractFailureCode,
  `historical-${string}`
>;

interface DbHistoricalMigrationChecks {
  historicalProvenance: boolean;
  historical0024: boolean;
  historical0027: boolean;
  historicalReadOnly: boolean;
  historicalWrongKeyRejected: boolean;
  historicalData: boolean;
  historicalFts5: boolean;
  historicalIntegrity: boolean;
  historicalIdempotent: boolean;
  historicalCleanup: boolean;
}

type DbHistoricalMigrationResult =
  | { status: 'pass'; checks: DbHistoricalMigrationChecks }
  | {
      status: 'fail';
      checks: DbHistoricalMigrationChecks;
      failureCode: DbHistoricalMigrationFailureCode;
    };

function emptyDbHistoricalMigrationChecks(): DbHistoricalMigrationChecks {
  return {
    historicalProvenance: false,
    historical0024: false,
    historical0027: false,
    historicalReadOnly: false,
    historicalWrongKeyRejected: false,
    historicalData: false,
    historicalFts5: false,
    historicalIntegrity: false,
    historicalIdempotent: false,
    historicalCleanup: false,
  };
}

function deleteDriverHistorySelfTestDatabase(): boolean {
  let cleanup: RawDb | undefined;
  try {
    cleanup = open({ name: DRIVER_HISTORY_SELF_TEST_DB_NAME });
    cleanup.delete();
    return true;
  } catch {
    try {
      cleanup?.close();
    } catch {
      // The finite false result remains authoritative for this one disposable filename.
    }
    return false;
  }
}

async function driverHistoryPrefixDigest(history: DriverHistoryCase): Promise<string> {
  return Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    JSON.stringify(MIGRATIONS.slice(0, history.count)),
  );
}

function isExpectedDriverHistoryStop(error: unknown): boolean {
  return error instanceof Error && error.message.includes(DRIVER_HISTORY_STOP_MESSAGE);
}

async function driverHistoryNextMigrationRolledBack(
  handle: RawDb,
  history: DriverHistoryCase,
): Promise<boolean> {
  const scheduledColumns = extractRows(
    await handle.execute('PRAGMA table_info(scheduled_messages)'),
  );
  const messageColumns = extractRows(await handle.execute('PRAGMA table_info(messages)'));
  const chatColumns = extractRows(await handle.execute('PRAGMA table_info(chats)'));
  const tables = extractRows(
    await handle.execute(
      `SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('error_reports', 'attachment_cache_entries')
        ORDER BY name`,
    ),
  );
  const hasColumn = (rows: Array<Record<string, unknown>>, name: string): boolean =>
    rows.some((row) => row.name === name);
  const hasTable = (name: string): boolean => tables.some((row) => row.name === name);
  return (
    hasColumn(scheduledColumns, 'recurrence') &&
    hasColumn(messageColumns, 'payload_data') === (history.count === 27) &&
    !hasColumn(chatColumns, 'marked_unread_at') &&
    !hasColumn(chatColumns, 'deleted_at') &&
    hasTable('error_reports') === (history.count === 27) &&
    !hasTable('attachment_cache_entries')
  );
}

function driverHistoryPrefix(history: DriverHistoryCase): string {
  return `driver-history-${String(history.count).padStart(4, '0')}`;
}

function driverHistoryFtsToken(
  history: DriverHistoryCase,
  kind: 'persistent' | 'orange' | 'violet',
): string {
  return `driverhistory${String(history.count).padStart(4, '0')}${kind}sentinel`;
}

async function seedDriverHistoryFixture(handle: RawDb, history: DriverHistoryCase): Promise<void> {
  const prefix = driverHistoryPrefix(history);
  await handle.execute('INSERT INTO chats (guid, display_name) VALUES (?, ?)', [
    `${prefix}-chat`,
    `Repository head ${history.head}`,
  ]);
  const chatRows = extractRows(
    await handle.execute('SELECT id FROM chats WHERE guid = ?', [`${prefix}-chat`]),
  );
  const chatId = chatRows[0]?.id;
  requireDriverContract(typeof chatId === 'number');

  const targetGuid = `${prefix}-target`;
  await handle.execute(
    `INSERT INTO messages
       (guid, chat_id, text, date_deleted, associated_message_guid)
     VALUES (?, ?, ?, ?, ?)`,
    [
      `${prefix}-deleted`,
      chatId,
      driverHistoryFtsToken(history, 'persistent'),
      history.count * 100,
      history.count === 24 ? `p:0/${targetGuid}` : targetGuid,
    ],
  );
  if (history.count >= 27) {
    await handle.execute(
      `INSERT INTO error_reports (level, message, created_at)
       VALUES (?, ?, ?)`,
      ['error', `${prefix} safe historical diagnostic`, history.count],
    );
  }
  await handle.execute(
    `INSERT INTO scheduled_messages
       (server_id, chat_guid, payload, scheduled_for, status, attempts)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [null, `${prefix}-local-sending`, '{}', 1000, 'sending', 2],
  );
  await handle.execute(
    `INSERT INTO scheduled_messages
       (server_id, chat_guid, payload, scheduled_for, status, attempts)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [history.count, `${prefix}-server-sending`, '{}', 1001, 'sending', 3],
  );
  await handle.execute(
    `INSERT INTO scheduled_messages
       (server_id, chat_guid, payload, scheduled_for, status, attempts)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [null, `${prefix}-local-pending`, '{}', 1002, 'pending', 4],
  );
  await handle.execute('INSERT INTO kv (key, value) VALUES (?, ?)', [
    'privacy.redactedMode',
    'retired',
  ]);
  await handle.execute('INSERT INTO kv (key, value) VALUES (?, ?)', [
    `${prefix}.preserved`,
    'preserved',
  ]);

  const validReaction = JSON.stringify({
    targetGuid,
    reaction: 2000,
    selectedMessageText: 'discard',
    nested: { keep: 'preserved' },
  });
  await handle.execute(
    `INSERT INTO outgoing_queue (temp_guid, chat_guid, kind, payload)
     VALUES (?, ?, ?, ?)`,
    [`${prefix}-reaction-valid`, `${prefix}-chat`, 'reaction', validReaction],
  );
  await handle.execute(
    `INSERT INTO outgoing_queue (temp_guid, chat_guid, kind, payload)
     VALUES (?, ?, ?, ?)`,
    [`${prefix}-reaction-malformed`, `${prefix}-chat`, 'reaction', '{"selectedMessageText":'],
  );
  await handle.execute(
    `INSERT INTO outgoing_queue (temp_guid, chat_guid, kind, payload)
     VALUES (?, ?, ?, ?)`,
    [
      `${prefix}-message-control`,
      `${prefix}-chat`,
      'message',
      '{"selectedMessageText":"preserve","body":"message-control"}',
    ],
  );
}

async function verifyDriverHistoryFixture(
  handle: RawDb,
  history: DriverHistoryCase,
): Promise<boolean> {
  const prefix = driverHistoryPrefix(history);
  const expectedNames = MIGRATIONS.slice(0, history.count).map((migration) => migration.name);
  const ledger = extractRows(await handle.execute('SELECT name FROM _migrations ORDER BY name'));
  const trigger = extractRows(
    await handle.execute(
      `SELECT name FROM sqlite_master
        WHERE type = 'trigger' AND name = 'driver_history_stop_after_reviewed_head'`,
    ),
  );
  const messages = extractRows(
    await handle.execute(
      `SELECT guid, text, date_deleted, associated_message_guid
         FROM messages WHERE guid = ?`,
      [`${prefix}-deleted`],
    ),
  );
  const schedules = extractRows(
    await handle.execute(
      `SELECT server_id, chat_guid, status, attempts FROM scheduled_messages
        WHERE chat_guid LIKE ? ORDER BY chat_guid`,
      [`${prefix}-%`],
    ),
  );
  const kv = extractRows(
    await handle.execute(
      `SELECT key, value FROM kv
        WHERE key = 'privacy.redactedMode' OR key = ? ORDER BY key`,
      [`${prefix}.preserved`],
    ),
  );
  const outgoing = extractRows(
    await handle.execute(
      `SELECT temp_guid, kind, payload FROM outgoing_queue
        WHERE temp_guid LIKE ? ORDER BY temp_guid`,
      [`${prefix}-%`],
    ),
  );
  const errors =
    history.count === 27
      ? extractRows(
          await handle.execute(
            `SELECT level, message, created_at FROM error_reports
              ORDER BY id`,
          ),
        )
      : [];
  const fts = extractRows(
    await handle.execute(
      `SELECT messages_fts.rowid
         FROM messages_fts
         JOIN messages ON messages.id = messages_fts.rowid
        WHERE messages_fts MATCH ? AND messages.guid = ?`,
      [driverHistoryFtsToken(history, 'persistent'), `${prefix}-deleted`],
    ),
  );
  const expectedTarget = history.count === 24 ? `p:0/${prefix}-target` : `${prefix}-target`;
  const localPending = schedules.find((row) => row.chat_guid === `${prefix}-local-pending`);
  const localSending = schedules.find((row) => row.chat_guid === `${prefix}-local-sending`);
  const serverSending = schedules.find((row) => row.chat_guid === `${prefix}-server-sending`);
  return (
    hasExactStringColumn(ledger, 'name', expectedNames) &&
    trigger.length === 0 &&
    (await driverHistoryNextMigrationRolledBack(handle, history)) &&
    messages.length === 1 &&
    messages[0]?.guid === `${prefix}-deleted` &&
    messages[0]?.text === driverHistoryFtsToken(history, 'persistent') &&
    messages[0]?.date_deleted === history.count * 100 &&
    messages[0]?.associated_message_guid === expectedTarget &&
    schedules.length === 3 &&
    localPending?.server_id === null &&
    localPending.status === 'pending' &&
    localPending.attempts === 4 &&
    localSending?.server_id === null &&
    localSending.status === 'sending' &&
    localSending.attempts === 2 &&
    serverSending?.server_id === history.count &&
    serverSending.status === 'sending' &&
    serverSending.attempts === 3 &&
    kv.length === 2 &&
    kv.find((row) => row.key === 'privacy.redactedMode')?.value === 'retired' &&
    kv.find((row) => row.key === `${prefix}.preserved`)?.value === 'preserved' &&
    outgoing.length === 3 &&
    outgoing.find((row) => row.temp_guid === `${prefix}-reaction-valid`)?.payload ===
      JSON.stringify({
        targetGuid: `${prefix}-target`,
        reaction: 2000,
        selectedMessageText: 'discard',
        nested: { keep: 'preserved' },
      }) &&
    outgoing.find((row) => row.temp_guid === `${prefix}-reaction-malformed`)?.payload ===
      '{"selectedMessageText":' &&
    outgoing.find((row) => row.temp_guid === `${prefix}-message-control`)?.payload ===
      '{"selectedMessageText":"preserve","body":"message-control"}' &&
    (history.count === 24 ||
      (errors.length === 1 &&
        errors[0]?.level === 'error' &&
        errors[0]?.message === `${prefix} safe historical diagnostic` &&
        errors[0]?.created_at === history.count)) &&
    fts.length === 1
  );
}

async function verifyDriverHistoryMigratedData(
  handle: RawDb,
  history: DriverHistoryCase,
): Promise<boolean> {
  const prefix = driverHistoryPrefix(history);
  const messages = extractRows(
    await handle.execute(`SELECT guid, associated_message_guid FROM messages WHERE guid = ?`, [
      `${prefix}-deleted`,
    ]),
  );
  const deletionLedger = extractRows(
    await handle.execute(`SELECT guid, date_deleted FROM message_deletion_ledger WHERE guid = ?`, [
      `${prefix}-deleted`,
    ]),
  );
  const errors = extractRows(await handle.execute('SELECT id FROM error_reports'));
  const schedules = extractRows(
    await handle.execute(
      `SELECT server_id, chat_guid, status, attempts FROM scheduled_messages
        WHERE chat_guid LIKE ? ORDER BY chat_guid`,
      [`${prefix}-%`],
    ),
  );
  const kv = extractRows(
    await handle.execute(
      `SELECT key, value FROM kv
        WHERE key = 'privacy.redactedMode' OR key = ? ORDER BY key`,
      [`${prefix}.preserved`],
    ),
  );
  const outgoing = extractRows(
    await handle.execute(
      `SELECT temp_guid, kind, payload FROM outgoing_queue
        WHERE temp_guid LIKE ? ORDER BY temp_guid`,
      [`${prefix}-%`],
    ),
  );
  const localSending = schedules.find((row) => row.chat_guid === `${prefix}-local-sending`);
  const localPending = schedules.find((row) => row.chat_guid === `${prefix}-local-pending`);
  const serverSending = schedules.find((row) => row.chat_guid === `${prefix}-server-sending`);
  const validPayload = outgoing.find(
    (row) => row.temp_guid === `${prefix}-reaction-valid`,
  )?.payload;
  let parsedReaction: Record<string, unknown> | undefined;
  if (typeof validPayload === 'string') {
    try {
      const parsed: unknown = JSON.parse(validPayload);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        parsedReaction = parsed as Record<string, unknown>;
      }
    } catch {
      parsedReaction = undefined;
    }
  }
  const nested = parsedReaction?.nested;
  return (
    messages.length === 1 &&
    messages[0]?.associated_message_guid === `${prefix}-target` &&
    deletionLedger.length === 1 &&
    deletionLedger[0]?.guid === `${prefix}-deleted` &&
    deletionLedger[0]?.date_deleted === history.count * 100 &&
    errors.length === 0 &&
    schedules.length === 3 &&
    localSending?.server_id === null &&
    localSending.status === 'uncertain' &&
    localSending.attempts === 5 &&
    localPending?.server_id === null &&
    localPending.status === 'pending' &&
    localPending.attempts === 4 &&
    serverSending?.server_id === history.count &&
    serverSending.status === 'sending' &&
    serverSending.attempts === 3 &&
    kv.length === 1 &&
    kv[0]?.key === `${prefix}.preserved` &&
    kv[0]?.value === 'preserved' &&
    outgoing.length === 3 &&
    parsedReaction?.targetGuid === `${prefix}-target` &&
    parsedReaction.reaction === 2000 &&
    !Object.prototype.hasOwnProperty.call(parsedReaction, 'selectedMessageText') &&
    nested !== null &&
    typeof nested === 'object' &&
    !Array.isArray(nested) &&
    (nested as Record<string, unknown>).keep === 'preserved' &&
    outgoing.find((row) => row.temp_guid === `${prefix}-reaction-malformed`)?.payload ===
      '{"selectedMessageText":' &&
    outgoing.find((row) => row.temp_guid === `${prefix}-message-control`)?.payload ===
      '{"selectedMessageText":"preserve","body":"message-control"}'
  );
}

async function verifyDriverHistoryFts(handle: RawDb, history: DriverHistoryCase): Promise<boolean> {
  const prefix = driverHistoryPrefix(history);
  const persistent = extractRows(
    await handle.execute(
      `SELECT messages_fts.rowid
         FROM messages_fts
         JOIN messages ON messages.id = messages_fts.rowid
        WHERE messages_fts MATCH ? AND messages.guid = ?`,
      [driverHistoryFtsToken(history, 'persistent'), `${prefix}-deleted`],
    ),
  );
  await handle.execute(
    'INSERT INTO messages (guid, chat_id, text) SELECT ?, id, ? FROM chats WHERE guid = ?',
    [`${prefix}-fts`, driverHistoryFtsToken(history, 'orange'), `${prefix}-chat`],
  );
  const messageRows = extractRows(
    await handle.execute('SELECT id FROM messages WHERE guid = ?', [`${prefix}-fts`]),
  );
  const messageId = messageRows[0]?.id;
  requireDriverContract(typeof messageId === 'number');
  const inserted = extractRows(
    await handle.execute('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?', [
      driverHistoryFtsToken(history, 'orange'),
    ]),
  );
  await handle.execute('UPDATE messages SET text = ? WHERE guid = ?', [
    driverHistoryFtsToken(history, 'violet'),
    `${prefix}-fts`,
  ]);
  const stale = extractRows(
    await handle.execute('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?', [
      driverHistoryFtsToken(history, 'orange'),
    ]),
  );
  const updated = extractRows(
    await handle.execute('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?', [
      driverHistoryFtsToken(history, 'violet'),
    ]),
  );
  await handle.execute('DELETE FROM messages WHERE guid = ?', [`${prefix}-fts`]);
  const deleted = extractRows(
    await handle.execute('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?', [
      driverHistoryFtsToken(history, 'violet'),
    ]),
  );
  return (
    persistent.length === 1 &&
    inserted.length === 1 &&
    inserted[0]?.rowid === messageId &&
    stale.length === 0 &&
    updated.length === 1 &&
    updated[0]?.rowid === messageId &&
    deleted.length === 0
  );
}

/** Same-process logical fixtures for the two pre-0029 repository heads. */
async function runDbHistoricalMigrationSelfTest(): Promise<DbHistoricalMigrationResult> {
  const checks = emptyDbHistoricalMigrationChecks();
  let phase: DbHistoricalMigrationFailureCode = 'historical-provenance';
  let failureCode: DbHistoricalMigrationFailureCode | undefined;

  try {
    for (const history of DRIVER_HISTORY_CASES) {
      const digest = await driverHistoryPrefixDigest(history);
      requireDriverContract(
        history.representativeCommit.length === 40 &&
          MIGRATIONS[history.count - 1]?.name === history.head &&
          MIGRATIONS[history.count]?.name === history.next &&
          digest === history.digest,
      );
    }
    checks.historicalProvenance = true;

    for (const history of DRIVER_HISTORY_CASES) {
      if (history.count === 29) continue;
      const phasePrefix = history.count === 24 ? 'historical-0024' : 'historical-0027';
      phase = 'historical-pre-cleanup';
      requireDriverContract(deleteDriverHistorySelfTestDatabase());

      phase = `${phasePrefix}-fixture`;
      {
        const prepared = open({
          name: DRIVER_HISTORY_SELF_TEST_DB_NAME,
          encryptionKey: DRIVER_HISTORY_SELF_TEST_KEY,
        });
        try {
          await prepared.execute('PRAGMA foreign_keys = ON');
          await prepared.execute(
            `CREATE TABLE IF NOT EXISTS _migrations
              (name TEXT PRIMARY KEY, applied_at INTEGER)`,
          );
          await prepared.execute(
            `CREATE TRIGGER driver_history_stop_after_reviewed_head
               BEFORE INSERT ON _migrations
               WHEN NEW.name = '${history.next}'
             BEGIN
               SELECT RAISE(ABORT, '${DRIVER_HISTORY_STOP_MESSAGE}');
             END`,
          );
          let stoppedAtExpectedHead = false;
          try {
            await runMigrations(opRunner(prepared));
          } catch (error) {
            stoppedAtExpectedHead = isExpectedDriverHistoryStop(error);
          }
          const partialLedger = extractRows(
            await prepared.execute('SELECT name FROM _migrations ORDER BY name'),
          );
          requireDriverContract(
            stoppedAtExpectedHead &&
              hasExactStringColumn(
                partialLedger,
                'name',
                MIGRATIONS.slice(0, history.count).map((migration) => migration.name),
              ) &&
              (await driverHistoryNextMigrationRolledBack(prepared, history)),
          );
          await prepared.execute('DROP TRIGGER driver_history_stop_after_reviewed_head');
          await seedDriverHistoryFixture(prepared, history);
          requireDriverContract(await verifyDriverHistoryFixture(prepared, history));
        } finally {
          prepared.close();
        }
      }

      phase = `${phasePrefix}-wrong-key-not-rejected`;
      let wrongKeyRejected = false;
      let wrongKeyHandle: RawDb | undefined;
      try {
        wrongKeyHandle = open({
          name: DRIVER_HISTORY_SELF_TEST_DB_NAME,
          encryptionKey: DRIVER_HISTORY_SELF_TEST_WRONG_KEY,
          readOnly: true,
        });
        await wrongKeyHandle.execute('SELECT count(*) FROM sqlite_master');
      } catch {
        wrongKeyRejected = true;
      } finally {
        wrongKeyHandle?.close();
      }
      requireDriverContract(wrongKeyRejected);
      if (history.count === 27) checks.historicalWrongKeyRejected = true;

      phase = `${phasePrefix}-read-only`;
      {
        const readOnly = open({
          name: DRIVER_HISTORY_SELF_TEST_DB_NAME,
          encryptionKey: DRIVER_HISTORY_SELF_TEST_KEY,
          readOnly: true,
        });
        try {
          await readOnly.execute('SELECT count(*) FROM sqlite_master');
          requireDriverContract(await verifyDriverHistoryFixture(readOnly, history));
        } finally {
          readOnly.close();
        }
      }
      if (history.count === 27) checks.historicalReadOnly = true;

      phase = `${phasePrefix}-migration`;
      {
        const reopened = open({
          name: DRIVER_HISTORY_SELF_TEST_DB_NAME,
          encryptionKey: DRIVER_HISTORY_SELF_TEST_KEY,
        });
        try {
          await reopened.execute('PRAGMA foreign_keys = ON');
          requireDriverContract(await verifyDriverHistoryFixture(reopened, history));
          const expectedTail = MIGRATIONS.slice(history.count).map((migration) => migration.name);
          const migrated = await runMigrations(opRunner(reopened));
          const fullLedger = extractRows(
            await reopened.execute('SELECT name FROM _migrations ORDER BY name'),
          );
          requireDriverContract(
            migrated.length === expectedTail.length &&
              migrated.every((name, index) => name === expectedTail[index]) &&
              hasExactStringColumn(
                fullLedger,
                'name',
                MIGRATIONS.map((migration) => migration.name),
              ),
          );
          if (history.count === 24) checks.historical0024 = true;
          else checks.historical0027 = true;

          phase = `${phasePrefix}-data`;
          requireDriverContract(await verifyDriverHistoryMigratedData(reopened, history));
          if (history.count === 27) checks.historicalData = true;

          phase = `${phasePrefix}-fts5`;
          requireDriverContract(await verifyDriverHistoryFts(reopened, history));
          if (history.count === 27) checks.historicalFts5 = true;

          phase = `${phasePrefix}-integrity`;
          const foreignKeys = extractRows(await reopened.execute('PRAGMA foreign_keys'));
          const foreignKeyViolations = extractRows(
            await reopened.execute('PRAGMA foreign_key_check'),
          );
          const integrity = extractRows(await reopened.execute('PRAGMA integrity_check'));
          requireDriverContract(
            foreignKeys.length === 1 &&
              foreignKeys[0]?.foreign_keys === 1 &&
              foreignKeyViolations.length === 0 &&
              integrity.length === 1 &&
              integrity[0]?.integrity_check === 'ok',
          );
          if (history.count === 27) checks.historicalIntegrity = true;

          phase = `${phasePrefix}-idempotent`;
          const idempotent = await runMigrations(opRunner(reopened));
          requireDriverContract(idempotent.length === 0);
          if (history.count === 27) checks.historicalIdempotent = true;
        } finally {
          reopened.close();
        }
      }
    }
  } catch {
    failureCode = phase;
  } finally {
    checks.historicalCleanup = deleteDriverHistorySelfTestDatabase();
    if (!checks.historicalCleanup) failureCode = 'historical-cleanup';
  }

  if (!failureCode && Object.values(checks).every(Boolean)) {
    return { status: 'pass', checks };
  }
  return {
    status: 'fail',
    checks,
    failureCode: failureCode ?? 'historical-provenance',
  };
}

interface ReactiveProbe {
  result: Promise<boolean>;
  unsubscribe(): void;
}

function subscribeForDriverSelfTestValue(
  db: RawDb,
  expected: string,
  waitForExpected = false,
): ReactiveProbe {
  let settled = false;
  let settle!: (matches: boolean) => void;
  const result = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  const finish = (matches: boolean): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    settle(matches);
  };
  const timer = setTimeout(() => finish(false), DRIVER_SELF_TEST_REACTIVE_TIMEOUT_MS);
  let unsubscribe: (() => void) | undefined;
  try {
    unsubscribe = db.reactiveExecute({
      query: 'SELECT display_name FROM handles WHERE id = 1',
      arguments: [],
      fireOn: [{ table: 'handles', ids: [1] }],
      callback: (response: unknown) => {
        const value = extractRows(response)[0]?.display_name;
        if (value === expected) finish(true);
        else if (!waitForExpected) finish(false);
      },
    });
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
  return {
    result,
    unsubscribe: () => {
      clearTimeout(timer);
      unsubscribe?.();
    },
  };
}

/**
 * DEV-only Android contract for the installed SQLCipher/op-sqlite/Drizzle boundary.
 *
 * Every operation targets one fixed throwaway filename. The production singleton and its
 * `gator.db` handle are never read, replaced, or published here. Migrations use the exact
 * production runner. A deliberate 0030 index conflict proves that one failed migration rolls back
 * its own statements while the preceding 29 migrations remain committed; it does not claim the
 * whole 38-migration chain is one atomic transaction. Two additional logical fixtures exercise
 * the exact repository-recorded 0024 and 0027 heads on a second fixed disposable file. This remains
 * a same-process close/reopen proof; process-death execution belongs to the separate Android lane.
 */
export async function runDbDriverSelfTest(): Promise<DbDriverContractResult> {
  const checks = emptyDbDriverContractChecks();
  let failureCode: DbDriverContractFailureCode | undefined;
  let phase: DbDriverContractFailureCode = 'internal';

  try {
    phase = 'key-generation';
    const keyA = randomDriverSelfTestKey();
    const keyB = randomDriverSelfTestKey();
    requireDriverContract(keyA.length === 64 && keyB.length === 64 && keyA !== keyB);

    phase = 'pre-cleanup';
    requireDriverContract(deleteDriverSelfTestDatabase());

    phase = 'encrypted-open';
    {
      const initial = open({ name: DRIVER_SELF_TEST_DB_NAME, encryptionKey: keyA });
      try {
        await initial.execute('PRAGMA foreign_keys = ON');
        await initial.execute(
          `CREATE TABLE driver_contract_migration_conflict (
            state TEXT NOT NULL,
            last_used_at INTEGER NOT NULL,
            path TEXT NOT NULL
          )`,
        );
        await initial.execute(
          `CREATE INDEX attachment_cache_entries_state_lru_idx
             ON driver_contract_migration_conflict (state, last_used_at, path)`,
        );
        const conflictOwnerBefore = extractRows(
          await initial.execute(
            `SELECT tbl_name FROM sqlite_master
              WHERE type = 'index' AND name = 'attachment_cache_entries_state_lru_idx'`,
          ),
        );
        requireDriverContract(
          conflictOwnerBefore.length === 1 &&
            conflictOwnerBefore[0]?.tbl_name === 'driver_contract_migration_conflict',
        );
        checks.encryptedOpen = true;

        phase = 'migration-rollback';
        const expectedMigrationNames = MIGRATIONS.map((migration) => migration.name);
        requireDriverContract(
          expectedMigrationNames.length === DRIVER_SELF_TEST_MIGRATION_COUNT &&
            expectedMigrationNames[0] === '0001_init' &&
            expectedMigrationNames[DRIVER_SELF_TEST_MIGRATION_COUNT - 1] ===
              DRIVER_SELF_TEST_MIGRATION_HEAD &&
            new Set(expectedMigrationNames).size === DRIVER_SELF_TEST_MIGRATION_COUNT,
        );
        let expectedMigrationConflict = false;
        try {
          await runMigrations(opRunner(initial));
        } catch (error) {
          expectedMigrationConflict = isExpectedDriverMigrationConflict(error);
        }
        const partialLedger = extractRows(
          await initial.execute('SELECT name FROM _migrations ORDER BY name'),
        );
        const rolledBackTable = extractRows(
          await initial.execute(
            `SELECT name FROM sqlite_master
              WHERE type = 'table' AND name = 'attachment_cache_entries'`,
          ),
        );
        const conflictOwnerAfter = extractRows(
          await initial.execute(
            `SELECT tbl_name FROM sqlite_master
              WHERE type = 'index' AND name = 'attachment_cache_entries_state_lru_idx'`,
          ),
        );
        requireDriverContract(
          expectedMigrationConflict &&
            hasExactStringColumn(
              partialLedger,
              'name',
              expectedMigrationNames.slice(0, DRIVER_SELF_TEST_PARTIAL_MIGRATION_COUNT),
            ) &&
            rolledBackTable.length === 0 &&
            conflictOwnerAfter.length === 1 &&
            conflictOwnerAfter[0]?.tbl_name === 'driver_contract_migration_conflict',
        );
        checks.migrationRollback = true;
      } finally {
        initial.close();
      }
    }

    phase = 'wrong-key-not-rejected';
    let wrongKeyRejected = false;
    let wrongKeyHandle: RawDb | undefined;
    try {
      wrongKeyHandle = open({ name: DRIVER_SELF_TEST_DB_NAME, encryptionKey: keyB });
      await wrongKeyHandle.execute('SELECT count(*) FROM sqlite_master');
    } catch {
      wrongKeyRejected = true;
    } finally {
      wrongKeyHandle?.close();
    }
    requireDriverContract(wrongKeyRejected);
    checks.wrongKeyRejected = true;

    phase = 'correct-key-reopen';
    {
      const reopened = open({ name: DRIVER_SELF_TEST_DB_NAME, encryptionKey: keyA });
      try {
        await reopened.execute('PRAGMA foreign_keys = ON');
        const expectedMigrationNames = MIGRATIONS.map((migration) => migration.name);
        const expectedTailNames = expectedMigrationNames.slice(
          DRIVER_SELF_TEST_PARTIAL_MIGRATION_COUNT,
        );
        const persistedPartialLedger = extractRows(
          await reopened.execute('SELECT name FROM _migrations ORDER BY name'),
        );
        requireDriverContract(
          hasExactStringColumn(
            persistedPartialLedger,
            'name',
            expectedMigrationNames.slice(0, DRIVER_SELF_TEST_PARTIAL_MIGRATION_COUNT),
          ),
        );

        await reopened.execute('DROP INDEX attachment_cache_entries_state_lru_idx');
        await reopened.execute('DROP TABLE driver_contract_migration_conflict');

        phase = 'migration-data';
        await reopened.execute(
          `INSERT INTO chats (guid, display_name)
           VALUES (?, ?)`,
          ['driver-contract-chat', 'Driver Contract'],
        );
        const chatRows = extractRows(
          await reopened.execute('SELECT id FROM chats WHERE guid = ?', ['driver-contract-chat']),
        );
        const chatId = chatRows[0]?.id;
        requireDriverContract(typeof chatId === 'number');

        await reopened.execute(
          `INSERT INTO handles (id, address, display_name)
           VALUES (?, ?, ?)`,
          [1, 'driver-contract@example.invalid', 'seed'],
        );
        await reopened.execute(
          `INSERT INTO messages (guid, chat_id, text, date_deleted)
           VALUES (?, ?, ?, ?)`,
          ['driver-contract-deleted', chatId, 'deleted control', 1234],
        );
        await reopened.execute(
          `INSERT INTO messages (guid, chat_id, text, date_deleted)
           VALUES (?, ?, ?, NULL)`,
          ['driver-contract-visible', chatId, 'persistentsentinel'],
        );
        await reopened.execute(
          `INSERT INTO error_reports (level, message, created_at)
           VALUES (?, ?, ?)`,
          ['error', 'driver contract safe error', 1],
        );
        await reopened.execute(
          `INSERT INTO scheduled_messages
             (server_id, chat_guid, payload, scheduled_for, status, attempts)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [null, 'driver-contract-local-sending', '{}', 1000, 'sending', 2],
        );
        await reopened.execute(
          `INSERT INTO scheduled_messages
             (server_id, chat_guid, payload, scheduled_for, status, attempts)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [7, 'driver-contract-server-sending', '{}', 1001, 'sending', 3],
        );
        await reopened.execute(
          `INSERT INTO scheduled_messages
             (server_id, chat_guid, payload, scheduled_for, status, attempts)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [null, 'driver-contract-local-pending', '{}', 1002, 'pending', 4],
        );
        await reopened.execute('INSERT INTO kv (key, value) VALUES (?, ?)', [
          'privacy.redactedMode',
          'retired',
        ]);
        await reopened.execute('INSERT INTO kv (key, value) VALUES (?, ?)', [
          'privacy.redactedMode.extra',
          'preserved',
        ]);

        const validReactionBefore =
          '{"targetGuid":"driver-contract-target","reaction":2000,"selectedMessageText":"discard","nested":{"keep":"preserved"}}';
        const malformedReaction = '{"selectedMessageText":';
        const nonReactionControl = '{"selectedMessageText":"preserve","body":"message-control"}';
        await reopened.execute(
          `INSERT INTO outgoing_queue (temp_guid, chat_guid, kind, payload)
           VALUES (?, ?, ?, ?)`,
          [
            'driver-contract-reaction-valid',
            'driver-contract-chat',
            'reaction',
            validReactionBefore,
          ],
        );
        await reopened.execute(
          `INSERT INTO outgoing_queue (temp_guid, chat_guid, kind, payload)
           VALUES (?, ?, ?, ?)`,
          [
            'driver-contract-reaction-malformed',
            'driver-contract-chat',
            'reaction',
            malformedReaction,
          ],
        );
        await reopened.execute(
          `INSERT INTO outgoing_queue (temp_guid, chat_guid, kind, payload)
           VALUES (?, ?, ?, ?)`,
          [
            'driver-contract-message-control',
            'driver-contract-chat',
            'message',
            nonReactionControl,
          ],
        );

        const preMigrationMessages = extractRows(
          await reopened.execute(
            `SELECT guid, date_deleted FROM messages
              WHERE guid IN (?, ?) ORDER BY guid`,
            ['driver-contract-deleted', 'driver-contract-visible'],
          ),
        );
        const preMigrationErrors = extractRows(
          await reopened.execute(
            'SELECT level, message, created_at FROM error_reports ORDER BY id',
          ),
        );
        const preMigrationSchedules = extractRows(
          await reopened.execute(
            `SELECT server_id, chat_guid, status, attempts FROM scheduled_messages
              ORDER BY chat_guid`,
          ),
        );
        const preMigrationKv = extractRows(
          await reopened.execute('SELECT key, value FROM kv ORDER BY key'),
        );
        const preMigrationOutgoing = extractRows(
          await reopened.execute(
            `SELECT temp_guid, kind, payload FROM outgoing_queue
              WHERE temp_guid LIKE 'driver-contract-%' ORDER BY temp_guid`,
          ),
        );
        const preLocalSending = preMigrationSchedules.find(
          (row) => row.chat_guid === 'driver-contract-local-sending',
        );
        const preServerSending = preMigrationSchedules.find(
          (row) => row.chat_guid === 'driver-contract-server-sending',
        );
        const preLocalPending = preMigrationSchedules.find(
          (row) => row.chat_guid === 'driver-contract-local-pending',
        );
        requireDriverContract(
          preMigrationMessages.length === 2 &&
            preMigrationMessages.find((row) => row.guid === 'driver-contract-deleted')
              ?.date_deleted === 1234 &&
            preMigrationMessages.find((row) => row.guid === 'driver-contract-visible')
              ?.date_deleted === null &&
            preMigrationErrors.length === 1 &&
            preMigrationErrors[0]?.level === 'error' &&
            preMigrationErrors[0]?.message === 'driver contract safe error' &&
            preMigrationErrors[0]?.created_at === 1 &&
            preMigrationSchedules.length === 3 &&
            preLocalSending?.server_id === null &&
            preLocalSending.status === 'sending' &&
            preLocalSending.attempts === 2 &&
            preServerSending?.server_id === 7 &&
            preServerSending.status === 'sending' &&
            preServerSending.attempts === 3 &&
            preLocalPending?.server_id === null &&
            preLocalPending.status === 'pending' &&
            preLocalPending.attempts === 4 &&
            preMigrationKv.length === 2 &&
            preMigrationKv.find((row) => row.key === 'privacy.redactedMode')?.value === 'retired' &&
            preMigrationKv.find((row) => row.key === 'privacy.redactedMode.extra')?.value ===
              'preserved' &&
            preMigrationOutgoing.length === 3 &&
            preMigrationOutgoing.find((row) => row.temp_guid === 'driver-contract-reaction-valid')
              ?.payload === validReactionBefore &&
            preMigrationOutgoing.find(
              (row) => row.temp_guid === 'driver-contract-reaction-malformed',
            )?.payload === malformedReaction &&
            preMigrationOutgoing.find((row) => row.temp_guid === 'driver-contract-message-control')
              ?.payload === nonReactionControl,
        );

        phase = 'migration-retry';
        const retriedMigrations = await runMigrations(opRunner(reopened));
        requireDriverContract(
          retriedMigrations.length === expectedTailNames.length &&
            retriedMigrations.every((name, index) => name === expectedTailNames[index]),
        );
        checks.migrationRetry = true;

        phase = 'migration-ledger';
        const fullLedger = extractRows(
          await reopened.execute('SELECT name FROM _migrations ORDER BY name'),
        );
        requireDriverContract(hasExactStringColumn(fullLedger, 'name', expectedMigrationNames));
        checks.migrationLedger = true;

        phase = 'migration-data';
        const deletionLedger = extractRows(
          await reopened.execute(
            'SELECT guid, date_deleted FROM message_deletion_ledger ORDER BY guid',
          ),
        );
        const remainingErrors = extractRows(await reopened.execute('SELECT id FROM error_reports'));
        const migratedSchedules = extractRows(
          await reopened.execute(
            `SELECT server_id, chat_guid, status, attempts FROM scheduled_messages
              ORDER BY chat_guid`,
          ),
        );
        const migratedKv = extractRows(
          await reopened.execute('SELECT key, value FROM kv ORDER BY key'),
        );
        const migratedOutgoing = extractRows(
          await reopened.execute(
            `SELECT temp_guid, kind, payload FROM outgoing_queue
              WHERE temp_guid LIKE 'driver-contract-%' ORDER BY temp_guid`,
          ),
        );
        const localSending = migratedSchedules.find(
          (row) => row.chat_guid === 'driver-contract-local-sending',
        );
        const serverSending = migratedSchedules.find(
          (row) => row.chat_guid === 'driver-contract-server-sending',
        );
        const localPending = migratedSchedules.find(
          (row) => row.chat_guid === 'driver-contract-local-pending',
        );
        const validReactionAfter = migratedOutgoing.find(
          (row) => row.temp_guid === 'driver-contract-reaction-valid',
        )?.payload;
        let parsedReaction: Record<string, unknown> | undefined;
        if (typeof validReactionAfter === 'string') {
          try {
            const parsed: unknown = JSON.parse(validReactionAfter);
            if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
              parsedReaction = parsed as Record<string, unknown>;
            }
          } catch {
            parsedReaction = undefined;
          }
        }
        const nestedReaction = parsedReaction?.nested;
        requireDriverContract(
          deletionLedger.length === 1 &&
            deletionLedger[0]?.guid === 'driver-contract-deleted' &&
            deletionLedger[0]?.date_deleted === 1234 &&
            remainingErrors.length === 0 &&
            migratedSchedules.length === 3 &&
            localSending?.server_id === null &&
            localSending.status === 'uncertain' &&
            localSending.attempts === 5 &&
            serverSending?.server_id === 7 &&
            serverSending.status === 'sending' &&
            serverSending.attempts === 3 &&
            localPending?.server_id === null &&
            localPending.status === 'pending' &&
            localPending.attempts === 4 &&
            migratedKv.length === 1 &&
            migratedKv[0]?.key === 'privacy.redactedMode.extra' &&
            migratedKv[0]?.value === 'preserved' &&
            migratedOutgoing.length === 3 &&
            parsedReaction?.targetGuid === 'driver-contract-target' &&
            parsedReaction.reaction === 2000 &&
            !Object.prototype.hasOwnProperty.call(parsedReaction, 'selectedMessageText') &&
            nestedReaction !== null &&
            typeof nestedReaction === 'object' &&
            !Array.isArray(nestedReaction) &&
            (nestedReaction as Record<string, unknown>).keep === 'preserved' &&
            migratedOutgoing.find((row) => row.temp_guid === 'driver-contract-reaction-malformed')
              ?.payload === malformedReaction &&
            migratedOutgoing.find((row) => row.temp_guid === 'driver-contract-message-control')
              ?.payload === nonReactionControl,
        );
        checks.migrationData = true;

        phase = 'fts5';
        await reopened.execute(
          `INSERT INTO messages (guid, chat_id, text)
           VALUES (?, ?, ?)`,
          ['driver-contract-fts', chatId, 'orangesentinel'],
        );
        const ftsMessageRows = extractRows(
          await reopened.execute('SELECT id FROM messages WHERE guid = ?', ['driver-contract-fts']),
        );
        const ftsMessageId = ftsMessageRows[0]?.id;
        requireDriverContract(typeof ftsMessageId === 'number');
        const insertedFts = extractRows(
          await reopened.execute(
            `SELECT rowid FROM messages_fts
              WHERE messages_fts MATCH 'orangesentinel'`,
          ),
        );
        await reopened.execute('UPDATE messages SET text = ? WHERE guid = ?', [
          'violetsentinel',
          'driver-contract-fts',
        ]);
        const staleFts = extractRows(
          await reopened.execute(
            `SELECT rowid FROM messages_fts
              WHERE messages_fts MATCH 'orangesentinel'`,
          ),
        );
        const updatedFts = extractRows(
          await reopened.execute(
            `SELECT rowid FROM messages_fts
              WHERE messages_fts MATCH 'violetsentinel'`,
          ),
        );
        await reopened.execute('DELETE FROM messages WHERE guid = ?', ['driver-contract-fts']);
        const deletedFts = extractRows(
          await reopened.execute(
            `SELECT rowid FROM messages_fts
              WHERE messages_fts MATCH 'violetsentinel'`,
          ),
        );
        const persistentFtsBeforeRekey = extractRows(
          await reopened.execute(
            `SELECT messages_fts.rowid
               FROM messages_fts
               JOIN messages ON messages.id = messages_fts.rowid
              WHERE messages_fts MATCH 'persistentsentinel'
                AND messages.guid = 'driver-contract-visible'`,
          ),
        );
        requireDriverContract(
          insertedFts.length === 1 &&
            insertedFts[0]?.rowid === ftsMessageId &&
            staleFts.length === 0 &&
            updatedFts.length === 1 &&
            updatedFts[0]?.rowid === ftsMessageId &&
            deletedFts.length === 0 &&
            persistentFtsBeforeRekey.length === 1,
        );
        checks.fts5 = true;

        phase = 'integrity';
        const foreignKeys = extractRows(await reopened.execute('PRAGMA foreign_keys'));
        const foreignKeyViolations = extractRows(
          await reopened.execute('PRAGMA foreign_key_check'),
        );
        const integrity = extractRows(await reopened.execute('PRAGMA integrity_check'));
        requireDriverContract(
          foreignKeys.length === 1 &&
            foreignKeys[0]?.foreign_keys === 1 &&
            foreignKeyViolations.length === 0 &&
            integrity.length === 1 &&
            integrity[0]?.integrity_check === 'ok',
        );
        checks.integrity = true;

        phase = 'idempotent';
        const idempotentMigrations = await runMigrations(opRunner(reopened));
        requireDriverContract(idempotentMigrations.length === 0);
        checks.idempotent = true;

        const seed = extractRows(
          await reopened.execute('SELECT id, display_name FROM handles WHERE id = 1'),
        );
        requireDriverContract(seed[0]?.id === 1 && seed[0]?.display_name === 'seed');

        const database = drizzle(drizzleAdapter(reopened)) as unknown as AppDatabase;

        phase = 'rollback';
        let transactionOpen = false;
        await database.run(sql`BEGIN IMMEDIATE`);
        transactionOpen = true;
        const commitProbe = subscribeForDriverSelfTestValue(reopened, 'committed');
        try {
          await database.run(sql`
            UPDATE handles SET display_name = ${'committed'} WHERE id = ${1}
          `);
          await database.run(sql`COMMIT`);
          transactionOpen = false;
          requireDriverContract(await commitProbe.result);
        } finally {
          commitProbe.unsubscribe();
          if (transactionOpen) {
            try {
              await database.run(sql`ROLLBACK`);
            } catch {
              // Preserve the original transaction failure as the finite contract result.
            }
          }
        }
        const afterCommit = extractRows(
          await reopened.execute('SELECT display_name FROM handles WHERE id = 1'),
        );
        requireDriverContract(afterCommit[0]?.display_name === 'committed');

        await database.run(sql`BEGIN IMMEDIATE`);
        transactionOpen = true;
        // Subscribe after BEGIN so an unchanged BEGIN flush cannot satisfy this probe. The UPDATE
        // may briefly publish an uncommitted value, but the production ROLLBACK route must drive the
        // subscriber back to the durable committed value instead of leaving stale UI behind.
        const rollbackProbe = subscribeForDriverSelfTestValue(reopened, 'committed', true);
        try {
          await database.run(sql`
            UPDATE handles SET display_name = ${'rolled-back'} WHERE id = ${1}
          `);
          await database.run(sql`ROLLBACK`);
          transactionOpen = false;
          requireDriverContract(await rollbackProbe.result);
        } finally {
          rollbackProbe.unsubscribe();
          if (transactionOpen) {
            try {
              await database.run(sql`ROLLBACK`);
            } catch {
              // Preserve the original transaction failure as the finite rollback result.
            }
          }
        }
        const afterRollback = extractRows(
          await reopened.execute('SELECT display_name FROM handles WHERE id = 1'),
        );
        requireDriverContract(afterRollback[0]?.display_name === 'committed');
        checks.rollback = true;

        phase = 'sync-reactive';
        const syncProbe = subscribeForDriverSelfTestValue(reopened, 'sync-route');
        try {
          const rows: Array<{ id: number; display_name: string }> = await database.all(sql`
            UPDATE handles SET display_name = ${'sync-route'} WHERE id = ${1}
            RETURNING id, display_name
          `);
          requireDriverContract(rows[0]?.id === 1 && rows[0]?.display_name === 'sync-route');
          requireDriverContract(await syncProbe.result);
          checks.syncReactive = true;
        } finally {
          syncProbe.unsubscribe();
        }

        phase = 'async-reactive';
        const asyncProbe = subscribeForDriverSelfTestValue(reopened, 'async-route');
        try {
          await database.run(sql`
            UPDATE handles SET display_name = ${'async-route'} WHERE id = ${1}
          `);
          requireDriverContract(await asyncProbe.result);
          checks.asyncReactive = true;
        } finally {
          asyncProbe.unsubscribe();
        }

        phase = 'raw-reactive';
        const rawProbe = subscribeForDriverSelfTestValue(reopened, 'raw-route');
        try {
          const rows: Array<{ id: number; displayName: string | null }> = await database
            .update(handles)
            .set({ displayName: 'raw-route' })
            .where(eq(handles.id, 1))
            .returning({ id: handles.id, displayName: handles.displayName });
          requireDriverContract(rows[0]?.id === 1 && rows[0]?.displayName === 'raw-route');
          requireDriverContract(await rawProbe.result);
          checks.rawReactive = true;
        } finally {
          rawProbe.unsubscribe();
        }

        phase = 'rekey';
        await reopened.execute(`PRAGMA rekey = '${keyB}'`);
        checks.rekey = true;
      } finally {
        reopened.close();
      }
    }

    phase = 'new-key-reopen';
    {
      const rekeyed = open({ name: DRIVER_SELF_TEST_DB_NAME, encryptionKey: keyB });
      try {
        const finalRow = extractRows(
          await rekeyed.execute('SELECT id, display_name FROM handles WHERE id = 1'),
        );
        const finalLedger = extractRows(
          await rekeyed.execute('SELECT name FROM _migrations ORDER BY name'),
        );
        const persistedFts = extractRows(
          await rekeyed.execute(
            `SELECT messages_fts.rowid
               FROM messages_fts
               JOIN messages ON messages.id = messages_fts.rowid
              WHERE messages_fts MATCH 'persistentsentinel'
                AND messages.guid = 'driver-contract-visible'`,
          ),
        );
        requireDriverContract(
          finalRow[0]?.id === 1 &&
            finalRow[0]?.display_name === 'raw-route' &&
            persistedFts.length === 1 &&
            hasExactStringColumn(
              finalLedger,
              'name',
              MIGRATIONS.map((migration) => migration.name),
            ),
        );
        checks.newKeyReopen = true;
      } finally {
        rekeyed.close();
      }
    }

    phase = 'old-key-not-rejected';
    let oldKeyRejected = false;
    let oldKeyHandle: RawDb | undefined;
    try {
      oldKeyHandle = open({ name: DRIVER_SELF_TEST_DB_NAME, encryptionKey: keyA });
      await oldKeyHandle.execute('SELECT count(*) FROM sqlite_master');
    } catch {
      oldKeyRejected = true;
    } finally {
      oldKeyHandle?.close();
    }
    requireDriverContract(oldKeyRejected);
    checks.oldKeyRejected = true;

    phase = 'historical-provenance';
    requireDriverContract(
      checks.migrationRollback &&
        checks.migrationRetry &&
        checks.migrationLedger &&
        checks.migrationData &&
        checks.fts5 &&
        checks.integrity &&
        checks.idempotent &&
        checks.wrongKeyRejected,
    );
    checks.historical0029 = true;
    const historicalResult = await runDbHistoricalMigrationSelfTest();
    Object.assign(checks, historicalResult.checks);
    if (historicalResult.status === 'fail') {
      phase = historicalResult.failureCode;
      throw new Error('finite historical migration self-test failure');
    }
  } catch {
    failureCode = phase;
  } finally {
    checks.cleanup = deleteDriverSelfTestDatabase();
    if (!checks.cleanup) failureCode = 'cleanup';
  }

  if (!failureCode && Object.values(checks).every(Boolean)) {
    return {
      schema: 3,
      suite: 'android-db-contract',
      status: 'pass',
      migrationCount: DRIVER_SELF_TEST_MIGRATION_COUNT,
      migrationHead: DRIVER_SELF_TEST_MIGRATION_HEAD,
      checks,
    };
  }
  return {
    schema: 3,
    suite: 'android-db-contract',
    status: 'fail',
    migrationCount: DRIVER_SELF_TEST_MIGRATION_COUNT,
    migrationHead: DRIVER_SELF_TEST_MIGRATION_HEAD,
    checks,
    failureCode: failureCode ?? 'internal',
  };
}

const DB_RUNTIME_CONCURRENCY_SELF_TEST_NAME = 'driver-runtime-concurrency-selftest.db';
// These public DEV-only keys protect no user data and open only the fixed disposable file above.
const DB_RUNTIME_CONCURRENCY_SELF_TEST_KEY_A = 'db-02c-public-throwaway-key-a-v1';
const DB_RUNTIME_CONCURRENCY_SELF_TEST_KEY_B = 'db-02c-public-throwaway-key-b-v1';
const DB_RUNTIME_CONCURRENCY_SELF_TEST_MIGRATION_COUNT = 40 as const;
const DB_RUNTIME_CONCURRENCY_SELF_TEST_MIGRATION_HEAD = '0040_chats_pin_order' as const;
const DB_RUNTIME_CONCURRENCY_SENTINEL_KEY = 'gator-db-runtime-wave-sentinel';
const DB_RUNTIME_CONCURRENCY_SENTINEL_VALUE = 'committed';

export interface DbRuntimeConcurrencyDatabaseChecks extends DbRuntimeConcurrencyWaveChecks {
  readonly preCleanup: boolean;
  readonly encryptedOpen: boolean;
  readonly migrationLedger: boolean;
  readonly newKeyReopen: boolean;
  readonly oldKeyRejected: boolean;
  readonly integrity: boolean;
  readonly databaseCleanup: boolean;
}

export type DbRuntimeConcurrencyDatabaseFailureCode =
  | 'pre-cleanup'
  | 'encrypted-open'
  | 'migration-ledger'
  | 'rollback-isolation'
  | 'sync-chunks'
  | 'live-messages'
  | 'attachment-construction'
  | 'upload-outside-db-owner'
  | 'rekey-exclusive'
  | 'queued-writers-blocked'
  | 'rekey-applied'
  | 'queued-writers-resumed'
  | 'upload-settlement'
  | 'queue-drained'
  | 'sentinel-commit'
  | 'new-key-reopen'
  | 'old-key-rejected'
  | 'integrity'
  | 'database-cleanup'
  | 'internal';

export type DbRuntimeConcurrencyDatabaseResult =
  | {
      readonly status: 'pass';
      readonly checks: DbRuntimeConcurrencyDatabaseChecks;
    }
  | {
      readonly status: 'fail';
      readonly checks: DbRuntimeConcurrencyDatabaseChecks;
      readonly failureCode: DbRuntimeConcurrencyDatabaseFailureCode;
    };

type MutableDbRuntimeConcurrencyDatabaseChecks = {
  -readonly [K in keyof DbRuntimeConcurrencyDatabaseChecks]: DbRuntimeConcurrencyDatabaseChecks[K];
};

function emptyDbRuntimeConcurrencyDatabaseChecks(): MutableDbRuntimeConcurrencyDatabaseChecks {
  return {
    preCleanup: false,
    encryptedOpen: false,
    migrationLedger: false,
    rollbackIsolation: false,
    syncChunks: false,
    liveMessages: false,
    attachmentConstruction: false,
    uploadOutsideDbOwner: false,
    rekeyExclusive: false,
    queuedWritersBlocked: false,
    rekeyApplied: false,
    queuedWritersResumed: false,
    uploadSettlement: false,
    queueDrained: false,
    sentinelCommit: false,
    newKeyReopen: false,
    oldKeyRejected: false,
    integrity: false,
    databaseCleanup: false,
  };
}

/** Delete only the fixed DB-02C disposable file; this has no production-DB capability. */
export function cleanupDbRuntimeConcurrencySelfTestDatabase(): boolean {
  let cleanup: RawDb | undefined;
  try {
    cleanup = open({ name: DB_RUNTIME_CONCURRENCY_SELF_TEST_NAME });
    cleanup.delete();
    return true;
  } catch {
    try {
      cleanup?.close();
    } catch {
      // The finite false result remains authoritative for this fixed disposable filename.
    }
    return false;
  }
}

function dbRuntimeConcurrencyMigrationNames(): string[] {
  const names = MIGRATIONS.map((migration) => migration.name);
  requireDriverContract(
    names.length === DB_RUNTIME_CONCURRENCY_SELF_TEST_MIGRATION_COUNT &&
      names[0] === '0001_init' &&
      names[DB_RUNTIME_CONCURRENCY_SELF_TEST_MIGRATION_COUNT - 1] ===
        DB_RUNTIME_CONCURRENCY_SELF_TEST_MIGRATION_HEAD &&
      new Set(names).size === DB_RUNTIME_CONCURRENCY_SELF_TEST_MIGRATION_COUNT,
  );
  return names;
}

function firstDbRuntimeConcurrencyWaveFailure(
  checks: DbRuntimeConcurrencyWaveChecks,
): DbRuntimeConcurrencyDatabaseFailureCode | undefined {
  if (!checks.rollbackIsolation) return 'rollback-isolation';
  if (!checks.syncChunks) return 'sync-chunks';
  if (!checks.liveMessages) return 'live-messages';
  if (!checks.attachmentConstruction) return 'attachment-construction';
  if (!checks.uploadOutsideDbOwner) return 'upload-outside-db-owner';
  if (!checks.rekeyExclusive) return 'rekey-exclusive';
  if (!checks.queuedWritersBlocked) return 'queued-writers-blocked';
  if (!checks.rekeyApplied) return 'rekey-applied';
  if (!checks.queuedWritersResumed) return 'queued-writers-resumed';
  if (!checks.uploadSettlement) return 'upload-settlement';
  if (!checks.queueDrained) return 'queue-drained';
  if (!checks.sentinelCommit) return 'sentinel-commit';
  return undefined;
}

/**
 * Run DB-02C on one fixed disposable SQLCipher database before ordinary foreground boot.
 *
 * The callback receives only the adapted throwaway database and one fixed-key rekey closure. The
 * production singleton, account vault, raw handle, filenames, and keys never cross the boundary.
 * The exclusive host harness owns the timeout by stopping this whole process; a JavaScript timeout
 * here could otherwise close/delete the file while native SQLite work was still running.
 */
export async function runDbRuntimeConcurrencySelfTest(
  runWave: DbRuntimeConcurrencyWaveRunner,
): Promise<DbRuntimeConcurrencyDatabaseResult> {
  const checks = emptyDbRuntimeConcurrencyDatabaseChecks();
  let phase: DbRuntimeConcurrencyDatabaseFailureCode = 'internal';
  let failureCode: DbRuntimeConcurrencyDatabaseFailureCode | undefined;
  let handle: RawDb | undefined;

  try {
    phase = 'pre-cleanup';
    requireDriverContract(cleanupDbRuntimeConcurrencySelfTestDatabase());
    checks.preCleanup = true;

    phase = 'encrypted-open';
    handle = open({
      name: DB_RUNTIME_CONCURRENCY_SELF_TEST_NAME,
      encryptionKey: DB_RUNTIME_CONCURRENCY_SELF_TEST_KEY_A,
    });
    const activeHandle = handle;
    await activeHandle.execute('PRAGMA foreign_keys = ON');
    await activeHandle.execute('SELECT count(*) FROM sqlite_master');
    checks.encryptedOpen = true;

    phase = 'migration-ledger';
    const expectedMigrationNames = dbRuntimeConcurrencyMigrationNames();
    const appliedMigrations = await runMigrations(opRunner(activeHandle));
    const ledger = extractRows(
      await activeHandle.execute('SELECT name FROM _migrations ORDER BY name'),
    );
    requireDriverContract(
      hasExactStringColumn(
        appliedMigrations.map((name) => ({ name })),
        'name',
        expectedMigrationNames,
      ) && hasExactStringColumn(ledger, 'name', expectedMigrationNames),
    );
    checks.migrationLedger = true;

    const database = drizzle(drizzleAdapter(activeHandle)) as unknown as AppDatabase;
    phase = 'internal';
    const waveChecks = await runWave(database, {
      rawRekey: async () => {
        await activeHandle.execute(`PRAGMA rekey = '${DB_RUNTIME_CONCURRENCY_SELF_TEST_KEY_B}'`);
      },
    });
    checks.rollbackIsolation = waveChecks.rollbackIsolation === true;
    checks.syncChunks = waveChecks.syncChunks === true;
    checks.liveMessages = waveChecks.liveMessages === true;
    checks.attachmentConstruction = waveChecks.attachmentConstruction === true;
    checks.uploadOutsideDbOwner = waveChecks.uploadOutsideDbOwner === true;
    checks.rekeyExclusive = waveChecks.rekeyExclusive === true;
    checks.queuedWritersBlocked = waveChecks.queuedWritersBlocked === true;
    checks.rekeyApplied = waveChecks.rekeyApplied === true;
    checks.queuedWritersResumed = waveChecks.queuedWritersResumed === true;
    checks.uploadSettlement = waveChecks.uploadSettlement === true;
    checks.queueDrained = waveChecks.queueDrained === true;
    checks.sentinelCommit = waveChecks.sentinelCommit === true;
    failureCode = firstDbRuntimeConcurrencyWaveFailure(checks);

    phase = 'new-key-reopen';
    activeHandle.close();
    handle = undefined;
    {
      const rekeyed = open({
        name: DB_RUNTIME_CONCURRENCY_SELF_TEST_NAME,
        encryptionKey: DB_RUNTIME_CONCURRENCY_SELF_TEST_KEY_B,
        readOnly: true,
      });
      try {
        await rekeyed.execute('SELECT count(*) FROM sqlite_master');
        const sentinel = extractRows(
          await rekeyed.execute('SELECT value FROM kv WHERE key = ?', [
            DB_RUNTIME_CONCURRENCY_SENTINEL_KEY,
          ]),
        );
        requireDriverContract(
          sentinel.length === 1 && sentinel[0]?.value === DB_RUNTIME_CONCURRENCY_SENTINEL_VALUE,
        );
        checks.newKeyReopen = true;

        phase = 'integrity';
        const integrity = extractRows(await rekeyed.execute('PRAGMA integrity_check'));
        const foreignKeyViolations = extractRows(await rekeyed.execute('PRAGMA foreign_key_check'));
        requireDriverContract(
          integrity.length === 1 &&
            integrity[0]?.integrity_check === 'ok' &&
            foreignKeyViolations.length === 0,
        );
        checks.integrity = true;
      } finally {
        rekeyed.close();
      }
    }

    phase = 'old-key-rejected';
    let oldKeyRejected = false;
    let oldKeyHandle: RawDb | undefined;
    try {
      oldKeyHandle = open({
        name: DB_RUNTIME_CONCURRENCY_SELF_TEST_NAME,
        encryptionKey: DB_RUNTIME_CONCURRENCY_SELF_TEST_KEY_A,
        readOnly: true,
      });
      await oldKeyHandle.execute('SELECT count(*) FROM sqlite_master');
    } catch {
      oldKeyRejected = true;
    } finally {
      oldKeyHandle?.close();
    }
    requireDriverContract(oldKeyRejected);
    checks.oldKeyRejected = true;
  } catch {
    failureCode ??= phase;
  } finally {
    try {
      handle?.close();
    } catch {
      failureCode ??= 'internal';
    }
    checks.databaseCleanup = cleanupDbRuntimeConcurrencySelfTestDatabase();
    if (!checks.databaseCleanup) failureCode = 'database-cleanup';
  }

  if (!failureCode && Object.values(checks).every(Boolean)) {
    return { status: 'pass', checks };
  }
  return { status: 'fail', checks, failureCode: failureCode ?? 'internal' };
}

const DB_PROCESS_RELAUNCH_SELF_TEST_NAME = 'driver-relaunch-selftest.db';
// This is deliberately a public, compile-time DEV test key. It never protects production data and
// never enters the account vault; its only purpose is to let two fresh app processes open the same
// fixed throwaway SQLCipher file.
const DB_PROCESS_RELAUNCH_SELF_TEST_KEY = 'db-03b1-public-throwaway-key-v1';
const DB_PROCESS_RELAUNCH_SELF_TEST_SENTINEL = 'driver-relaunch-continuity-v1';
const DB_PROCESS_RELAUNCH_SELF_TEST_PARTIAL_MIGRATION_COUNT = 29;
const DB_PROCESS_RELAUNCH_SELF_TEST_PARTIAL_MIGRATION_HEAD = '0029_chats_deleted_at';
const DB_PROCESS_RELAUNCH_SELF_TEST_RETRY_MIGRATION_START = '0030_attachment_cache_entries';
const DB_PROCESS_RELAUNCH_SELF_TEST_MIGRATION_COUNT = 40 as const;
const DB_PROCESS_RELAUNCH_SELF_TEST_MIGRATION_HEAD = '0040_chats_pin_order' as const;

export interface DbProcessRelaunchPrepareChecks {
  preCleanup: boolean;
  encryptedOpen: boolean;
  migrationRollback: boolean;
  partialLedger: boolean;
  continuitySentinel: boolean;
}

export type DbProcessRelaunchPrepareFailureCode =
  'pre-cleanup' | 'encrypted-open' | 'migration-rollback' | 'database-cleanup' | 'internal';

export interface DbProcessRelaunchPrepareFailure {
  status: 'fail';
  checks: DbProcessRelaunchPrepareChecks;
  failureCode: DbProcessRelaunchPrepareFailureCode;
  databaseCleanup: boolean;
}

export interface DbProcessRelaunchResumeChecks {
  readOnlyContinuityOpen: boolean;
  sameFileState: boolean;
  partialLedger: boolean;
  continuitySentinel: boolean;
  migrationRetry: boolean;
  migrationLedger: boolean;
  integrity: boolean;
  idempotent: boolean;
  databaseCleanup: boolean;
}

export type DbProcessRelaunchResumeFailureCode =
  | 'read-only-continuity-open'
  | 'same-file-state'
  | 'migration-retry'
  | 'migration-ledger'
  | 'integrity'
  | 'idempotent'
  | 'database-cleanup'
  | 'internal';

export type DbProcessRelaunchResumeResult =
  | {
      status: 'pass';
      migrationCount: typeof DB_PROCESS_RELAUNCH_SELF_TEST_MIGRATION_COUNT;
      migrationHead: typeof DB_PROCESS_RELAUNCH_SELF_TEST_MIGRATION_HEAD;
      checks: DbProcessRelaunchResumeChecks;
    }
  | {
      status: 'fail';
      migrationCount: typeof DB_PROCESS_RELAUNCH_SELF_TEST_MIGRATION_COUNT;
      migrationHead: typeof DB_PROCESS_RELAUNCH_SELF_TEST_MIGRATION_HEAD;
      checks: DbProcessRelaunchResumeChecks;
      failureCode: DbProcessRelaunchResumeFailureCode;
    };

function emptyDbProcessRelaunchPrepareChecks(): DbProcessRelaunchPrepareChecks {
  return {
    preCleanup: false,
    encryptedOpen: false,
    migrationRollback: false,
    partialLedger: false,
    continuitySentinel: false,
  };
}

function emptyDbProcessRelaunchResumeChecks(): DbProcessRelaunchResumeChecks {
  return {
    readOnlyContinuityOpen: false,
    sameFileState: false,
    partialLedger: false,
    continuitySentinel: false,
    migrationRetry: false,
    migrationLedger: false,
    integrity: false,
    idempotent: false,
    databaseCleanup: false,
  };
}

/** Delete only the fixed DB-03B1 disposable file; this has no production-DB capability. */
export function cleanupDbProcessRelaunchSelfTestDatabase(): boolean {
  let cleanup: RawDb | undefined;
  try {
    cleanup = open({ name: DB_PROCESS_RELAUNCH_SELF_TEST_NAME });
    cleanup.delete();
    return true;
  } catch {
    try {
      cleanup?.close();
    } catch {
      // The finite false result is authoritative; never replace it with a close error.
    }
    return false;
  }
}

interface DbProcessRelaunchPartialState {
  conflictOwner: boolean;
  rolledBackTableAbsent: boolean;
  partialLedger: boolean;
  continuitySentinel: boolean;
}

function dbProcessRelaunchMigrationNames(): string[] {
  const names = MIGRATIONS.map((migration) => migration.name);
  requireDriverContract(
    names.length === DB_PROCESS_RELAUNCH_SELF_TEST_MIGRATION_COUNT &&
      names[0] === '0001_init' &&
      names[DB_PROCESS_RELAUNCH_SELF_TEST_PARTIAL_MIGRATION_COUNT - 1] ===
        DB_PROCESS_RELAUNCH_SELF_TEST_PARTIAL_MIGRATION_HEAD &&
      names[DB_PROCESS_RELAUNCH_SELF_TEST_PARTIAL_MIGRATION_COUNT] ===
        DB_PROCESS_RELAUNCH_SELF_TEST_RETRY_MIGRATION_START &&
      names[DB_PROCESS_RELAUNCH_SELF_TEST_MIGRATION_COUNT - 1] ===
        DB_PROCESS_RELAUNCH_SELF_TEST_MIGRATION_HEAD &&
      new Set(names).size === DB_PROCESS_RELAUNCH_SELF_TEST_MIGRATION_COUNT,
  );
  return names;
}

async function inspectDbProcessRelaunchPartialState(
  handle: RawDb,
): Promise<DbProcessRelaunchPartialState> {
  const expectedMigrationNames = dbProcessRelaunchMigrationNames();
  const ledger = extractRows(await handle.execute('SELECT name FROM _migrations ORDER BY name'));
  const rolledBackTable = extractRows(
    await handle.execute(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'attachment_cache_entries'`,
    ),
  );
  const conflictOwner = extractRows(
    await handle.execute(
      `SELECT tbl_name FROM sqlite_master
        WHERE type = 'index' AND name = 'attachment_cache_entries_state_lru_idx'`,
    ),
  );
  const sentinel = extractRows(
    await handle.execute(
      `SELECT continuity_value FROM driver_relaunch_contract_state
        ORDER BY continuity_value`,
    ),
  );
  return {
    conflictOwner:
      conflictOwner.length === 1 && conflictOwner[0]?.tbl_name === 'driver_relaunch_contract_state',
    rolledBackTableAbsent: rolledBackTable.length === 0,
    partialLedger: hasExactStringColumn(
      ledger,
      'name',
      expectedMigrationNames.slice(0, DB_PROCESS_RELAUNCH_SELF_TEST_PARTIAL_MIGRATION_COUNT),
    ),
    continuitySentinel:
      sentinel.length === 1 &&
      sentinel[0]?.continuity_value === DB_PROCESS_RELAUNCH_SELF_TEST_SENTINEL,
  };
}

/**
 * Prepare the fixed DB-03B1 file and retain its native handle until the host kills this process.
 *
 * `onPrepared` receives finite booleans only. Production passes a callback that atomically arms the
 * durable ready marker, logs the finite READY result, and never settles. No handle, runner, key, SQL,
 * path, row, or adapter crosses this boundary.
 */
export async function prepareDbProcessRelaunchSelfTest(
  onPrepared: (checks: Readonly<DbProcessRelaunchPrepareChecks>) => Promise<never>,
): Promise<DbProcessRelaunchPrepareFailure> {
  const checks = emptyDbProcessRelaunchPrepareChecks();
  let phase: DbProcessRelaunchPrepareFailureCode = 'internal';
  let failureCode: DbProcessRelaunchPrepareFailureCode | undefined;
  let handle: RawDb | undefined;

  try {
    phase = 'pre-cleanup';
    requireDriverContract(cleanupDbProcessRelaunchSelfTestDatabase());
    checks.preCleanup = true;

    phase = 'encrypted-open';
    handle = open({
      name: DB_PROCESS_RELAUNCH_SELF_TEST_NAME,
      encryptionKey: DB_PROCESS_RELAUNCH_SELF_TEST_KEY,
    });
    await handle.execute('PRAGMA foreign_keys = ON');
    await handle.execute(
      `CREATE TABLE driver_relaunch_contract_state (
        continuity_value TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        last_used_at INTEGER NOT NULL,
        path TEXT NOT NULL
      )`,
    );
    await handle.execute(
      `INSERT INTO driver_relaunch_contract_state
        (continuity_value, state, last_used_at, path)
       VALUES (?, 'ready', 1, 'fixed')`,
      [DB_PROCESS_RELAUNCH_SELF_TEST_SENTINEL],
    );
    await handle.execute(
      `CREATE INDEX attachment_cache_entries_state_lru_idx
         ON driver_relaunch_contract_state (state, last_used_at, path)`,
    );
    checks.encryptedOpen = true;

    phase = 'migration-rollback';
    dbProcessRelaunchMigrationNames();
    let expectedMigrationConflict = false;
    try {
      await runMigrations(opRunner(handle));
    } catch (error) {
      expectedMigrationConflict = isExpectedDriverMigrationConflict(error);
    }
    const partialState = await inspectDbProcessRelaunchPartialState(handle);
    requireDriverContract(
      expectedMigrationConflict && partialState.conflictOwner && partialState.rolledBackTableAbsent,
    );
    checks.migrationRollback = true;

    phase = 'migration-rollback';
    requireDriverContract(partialState.partialLedger);
    checks.partialLedger = true;

    phase = 'migration-rollback';
    requireDriverContract(partialState.continuitySentinel);
    checks.continuitySentinel = true;
  } catch {
    failureCode = phase;
  }

  if (failureCode || !handle) {
    try {
      handle?.close();
    } catch {
      // Cleanup below is the authoritative result for this disposable file.
    }
    const databaseCleanup = cleanupDbProcessRelaunchSelfTestDatabase();
    return {
      status: 'fail',
      checks,
      failureCode: databaseCleanup ? (failureCode ?? 'internal') : 'database-cleanup',
      databaseCleanup,
    };
  }

  try {
    return await onPrepared(Object.freeze({ ...checks }));
  } finally {
    // The host kills the successful process while `onPrepared` is pending, so this close is reached
    // only by a test or by an unexpected callback rejection.
    handle.close();
  }
}

/**
 * Resume DB-03B1 after a real process death.
 *
 * The first native open is read-only, which makes a missing file fail instead of recreating it.
 * `onReadOnlyVerified` atomically records the resuming phase only after that handle is closed and
 * before the read-write reopen. Every later mutation remains private to this fixed disposable DB.
 */
export async function resumeDbProcessRelaunchSelfTest(
  onReadOnlyVerified: () => void,
): Promise<DbProcessRelaunchResumeResult> {
  const checks = emptyDbProcessRelaunchResumeChecks();
  let phase: DbProcessRelaunchResumeFailureCode = 'internal';
  let failureCode: DbProcessRelaunchResumeFailureCode | undefined;

  try {
    phase = 'read-only-continuity-open';
    {
      const readOnly = open({
        name: DB_PROCESS_RELAUNCH_SELF_TEST_NAME,
        encryptionKey: DB_PROCESS_RELAUNCH_SELF_TEST_KEY,
        readOnly: true,
      });
      try {
        await readOnly.execute('SELECT count(*) FROM sqlite_master');
        checks.readOnlyContinuityOpen = true;

        phase = 'same-file-state';
        const partialState = await inspectDbProcessRelaunchPartialState(readOnly);
        requireDriverContract(partialState.conflictOwner && partialState.rolledBackTableAbsent);

        phase = 'same-file-state';
        requireDriverContract(partialState.partialLedger);
        checks.partialLedger = true;

        phase = 'same-file-state';
        requireDriverContract(partialState.continuitySentinel);
        checks.continuitySentinel = true;
      } finally {
        readOnly.close();
      }
    }

    phase = 'same-file-state';
    onReadOnlyVerified();

    phase = 'same-file-state';
    {
      const reopened = open({
        name: DB_PROCESS_RELAUNCH_SELF_TEST_NAME,
        encryptionKey: DB_PROCESS_RELAUNCH_SELF_TEST_KEY,
      });
      try {
        await reopened.execute('PRAGMA foreign_keys = ON');
        const foreignKeys = extractRows(await reopened.execute('PRAGMA foreign_keys'));
        const partialState = await inspectDbProcessRelaunchPartialState(reopened);
        requireDriverContract(
          foreignKeys.length === 1 &&
            foreignKeys[0]?.foreign_keys === 1 &&
            partialState.conflictOwner &&
            partialState.rolledBackTableAbsent &&
            partialState.partialLedger &&
            partialState.continuitySentinel,
        );
        checks.sameFileState = true;

        await reopened.execute('DROP INDEX attachment_cache_entries_state_lru_idx');
        await reopened.execute('DROP TABLE driver_relaunch_contract_state');

        phase = 'migration-retry';
        const expectedMigrationNames = dbProcessRelaunchMigrationNames();
        const expectedTailNames = expectedMigrationNames.slice(
          DB_PROCESS_RELAUNCH_SELF_TEST_PARTIAL_MIGRATION_COUNT,
        );
        const retriedMigrations = await runMigrations(opRunner(reopened));
        requireDriverContract(
          retriedMigrations.length === expectedTailNames.length &&
            retriedMigrations.every((name, index) => name === expectedTailNames[index]),
        );
        checks.migrationRetry = true;

        phase = 'migration-ledger';
        const fullLedger = extractRows(
          await reopened.execute('SELECT name FROM _migrations ORDER BY name'),
        );
        requireDriverContract(hasExactStringColumn(fullLedger, 'name', expectedMigrationNames));
        checks.migrationLedger = true;

        phase = 'integrity';
        const integrity = extractRows(await reopened.execute('PRAGMA integrity_check'));
        const foreignKeyViolations = extractRows(
          await reopened.execute('PRAGMA foreign_key_check'),
        );
        requireDriverContract(
          integrity.length === 1 &&
            integrity[0]?.integrity_check === 'ok' &&
            foreignKeyViolations.length === 0,
        );
        checks.integrity = true;

        phase = 'idempotent';
        const idempotentMigrations = await runMigrations(opRunner(reopened));
        requireDriverContract(idempotentMigrations.length === 0);
        checks.idempotent = true;
      } finally {
        reopened.close();
      }
    }
  } catch {
    failureCode = phase;
  } finally {
    checks.databaseCleanup = cleanupDbProcessRelaunchSelfTestDatabase();
    if (!checks.databaseCleanup) failureCode = 'database-cleanup';
  }

  if (!failureCode && Object.values(checks).every(Boolean)) {
    return {
      status: 'pass',
      migrationCount: DB_PROCESS_RELAUNCH_SELF_TEST_MIGRATION_COUNT,
      migrationHead: DB_PROCESS_RELAUNCH_SELF_TEST_MIGRATION_HEAD,
      checks,
    };
  }
  return {
    status: 'fail',
    migrationCount: DB_PROCESS_RELAUNCH_SELF_TEST_MIGRATION_COUNT,
    migrationHead: DB_PROCESS_RELAUNCH_SELF_TEST_MIGRATION_HEAD,
    checks,
    failureCode: failureCode ?? 'internal',
  };
}

const DB_ACTIVE_WAL_WRITE_DEATH_SELF_TEST_NAME = 'driver-wal-write-death-selftest.db';
// This public DEV-only key protects no user data. It can open only the fixed disposable file above.
const DB_ACTIVE_WAL_WRITE_DEATH_SELF_TEST_KEY = 'db-03b2b1-public-throwaway-key-v1';
const DB_ACTIVE_WAL_WRITE_DEATH_BASELINE = 'db-03b2b1-baseline-v1';
const DB_ACTIVE_WAL_WRITE_DEATH_RECOVERY = 'db-03b2b1-recovery-v1';
const DB_ACTIVE_WAL_WRITE_DEATH_CANARY_COUNT = 128;
const DB_ACTIVE_WAL_WRITE_DEATH_CANARY_BYTES = 8_192;

export interface DbActiveWalWriteDeathPrepareChecks {
  preCleanup: boolean;
  encryptedOpen: boolean;
  walMode: boolean;
  baselineCommitted: boolean;
  walCheckpointTruncated: boolean;
  writeTransactionOpen: boolean;
  uncommittedCanaryWritten: boolean;
}

export type DbActiveWalWriteDeathPrepareFailureCode =
  | 'pre-cleanup'
  | 'encrypted-open'
  | 'wal-mode'
  | 'baseline-commit'
  | 'wal-checkpoint'
  | 'write-transaction'
  | 'uncommitted-canary'
  | 'database-cleanup'
  | 'internal';

export interface DbActiveWalWriteDeathPrepareFailure {
  status: 'fail';
  checks: DbActiveWalWriteDeathPrepareChecks;
  failureCode: DbActiveWalWriteDeathPrepareFailureCode;
  databaseCleanup: boolean;
}

export interface DbActiveWalWriteDeathResumeChecks {
  readOnlyRecoveryOpen: boolean;
  walMode: boolean;
  baselinePresent: boolean;
  uncommittedAbsent: boolean;
  integrity: boolean;
  foreignKeys: boolean;
  recoveryCommit: boolean;
  reopenPersistence: boolean;
  databaseCleanup: boolean;
}

export type DbActiveWalWriteDeathResumeFailureCode =
  | 'read-only-recovery-open'
  | 'recovered-state'
  | 'integrity'
  | 'foreign-keys'
  | 'recovery-commit'
  | 'reopen-persistence'
  | 'database-cleanup'
  | 'internal';

export type DbActiveWalWriteDeathResumeResult =
  | {
      status: 'pass';
      checks: DbActiveWalWriteDeathResumeChecks;
    }
  | {
      status: 'fail';
      checks: DbActiveWalWriteDeathResumeChecks;
      failureCode: DbActiveWalWriteDeathResumeFailureCode;
    };

function emptyDbActiveWalWriteDeathPrepareChecks(): DbActiveWalWriteDeathPrepareChecks {
  return {
    preCleanup: false,
    encryptedOpen: false,
    walMode: false,
    baselineCommitted: false,
    walCheckpointTruncated: false,
    writeTransactionOpen: false,
    uncommittedCanaryWritten: false,
  };
}

function emptyDbActiveWalWriteDeathResumeChecks(): DbActiveWalWriteDeathResumeChecks {
  return {
    readOnlyRecoveryOpen: false,
    walMode: false,
    baselinePresent: false,
    uncommittedAbsent: false,
    integrity: false,
    foreignKeys: false,
    recoveryCommit: false,
    reopenPersistence: false,
    databaseCleanup: false,
  };
}

function pragmaContainsString(rows: Array<Record<string, unknown>>, expected: string): boolean {
  return (
    rows.length === 1 &&
    Object.values(rows[0] ?? {}).some(
      (value) => typeof value === 'string' && value.toLowerCase() === expected,
    )
  );
}

function isSuccessfulTruncateCheckpoint(rows: Array<Record<string, unknown>>): boolean {
  if (rows.length !== 1) return false;
  const values = Object.values(rows[0] ?? {});
  return values.length === 3 && values.every((value) => value === 0);
}

interface DbActiveWalWriteDeathState {
  rowCount: number;
  baselinePresent: boolean;
  uncommittedCount: number;
  uncommittedCanariesExact: boolean;
  recoveryPresent: boolean;
}

async function inspectDbActiveWalWriteDeathState(
  handle: RawDb,
): Promise<DbActiveWalWriteDeathState> {
  const rows = extractRows(
    await handle.execute(
      `SELECT id, state FROM driver_wal_write_death_contract
        ORDER BY id`,
    ),
  );
  const uncommitted = rows.filter((row) => row.state === 'uncommitted');
  return {
    rowCount: rows.length,
    baselinePresent: rows[0]?.id === 1 && rows[0]?.state === DB_ACTIVE_WAL_WRITE_DEATH_BASELINE,
    uncommittedCount: uncommitted.length,
    uncommittedCanariesExact: uncommitted.every((row, index) => row.id === 100 + index),
    recoveryPresent: rows[1]?.id === 2 && rows[1]?.state === DB_ACTIVE_WAL_WRITE_DEATH_RECOVERY,
  };
}

/** Delete only the fixed DB-03B2B1 disposable main file. */
export function cleanupDbActiveWalWriteDeathSelfTestDatabase(): boolean {
  let cleanup: RawDb | undefined;
  try {
    cleanup = open({ name: DB_ACTIVE_WAL_WRITE_DEATH_SELF_TEST_NAME });
    cleanup.delete();
    return true;
  } catch {
    try {
      cleanup?.close();
    } catch {
      // The finite false result is authoritative; never replace it with a close error.
    }
    return false;
  }
}

/**
 * Retire WAL sidecars only after the final read-only persistence proof has closed its handle.
 * The fixed main-file delete is attempted even when checkpoint, mode, or close retirement fails.
 */
function retireDbActiveWalWriteDeathSelfTestDatabase(): boolean {
  let retirement: RawDb | undefined;
  let retirementSucceeded = false;
  try {
    retirement = open({
      name: DB_ACTIVE_WAL_WRITE_DEATH_SELF_TEST_NAME,
      encryptionKey: DB_ACTIVE_WAL_WRITE_DEATH_SELF_TEST_KEY,
    });
    const checkpoint = extractRows(retirement.executeSync('PRAGMA wal_checkpoint(TRUNCATE)'));
    requireDriverContract(isSuccessfulTruncateCheckpoint(checkpoint));
    const selectedDeleteMode = extractRows(retirement.executeSync('PRAGMA journal_mode = DELETE'));
    requireDriverContract(pragmaContainsString(selectedDeleteMode, 'delete'));
    const confirmedDeleteMode = extractRows(retirement.executeSync('PRAGMA journal_mode'));
    requireDriverContract(pragmaContainsString(confirmedDeleteMode, 'delete'));
    retirement.close();
    retirement = undefined;
    retirementSucceeded = true;
  } catch {
    try {
      retirement?.close();
    } catch {
      // Main-file deletion below is still attempted; the finite false result remains authoritative.
    }
  }

  const mainFileDeleted = cleanupDbActiveWalWriteDeathSelfTestDatabase();
  return retirementSucceeded && mainFileDeleted;
}

/**
 * Commit one baseline, truncate its WAL, then retain an active multi-page write transaction until
 * the host crashes this exact process. The callback receives booleans only; no handle, key, SQL,
 * path, row, or byte count crosses the boundary.
 */
export async function prepareDbActiveWalWriteDeathSelfTest(
  onPrepared: (checks: Readonly<DbActiveWalWriteDeathPrepareChecks>) => Promise<never>,
): Promise<DbActiveWalWriteDeathPrepareFailure> {
  const checks = emptyDbActiveWalWriteDeathPrepareChecks();
  let phase: DbActiveWalWriteDeathPrepareFailureCode = 'internal';
  let failureCode: DbActiveWalWriteDeathPrepareFailureCode | undefined;
  let handle: RawDb | undefined;
  let transactionOpen = false;

  try {
    phase = 'pre-cleanup';
    requireDriverContract(cleanupDbActiveWalWriteDeathSelfTestDatabase());
    checks.preCleanup = true;

    phase = 'encrypted-open';
    handle = open({
      name: DB_ACTIVE_WAL_WRITE_DEATH_SELF_TEST_NAME,
      encryptionKey: DB_ACTIVE_WAL_WRITE_DEATH_SELF_TEST_KEY,
    });
    await handle.execute('SELECT count(*) FROM sqlite_master');
    checks.encryptedOpen = true;

    phase = 'wal-mode';
    await handle.execute('PRAGMA foreign_keys = ON');
    const enabledWal = extractRows(await handle.execute('PRAGMA journal_mode = WAL'));
    const confirmedWal = extractRows(await handle.execute('PRAGMA journal_mode'));
    requireDriverContract(
      pragmaContainsString(enabledWal, 'wal') && pragmaContainsString(confirmedWal, 'wal'),
    );
    checks.walMode = true;

    phase = 'baseline-commit';
    await handle.execute(
      `CREATE TABLE driver_wal_write_death_contract (
        id INTEGER PRIMARY KEY,
        state TEXT NOT NULL,
        payload BLOB NOT NULL
      )`,
    );
    await handle.execute('BEGIN IMMEDIATE');
    transactionOpen = true;
    await handle.execute(
      `INSERT INTO driver_wal_write_death_contract (id, state, payload)
       VALUES (1, ?, zeroblob(?))`,
      [DB_ACTIVE_WAL_WRITE_DEATH_BASELINE, DB_ACTIVE_WAL_WRITE_DEATH_CANARY_BYTES],
    );
    await handle.execute('COMMIT');
    transactionOpen = false;
    const baseline = await inspectDbActiveWalWriteDeathState(handle);
    requireDriverContract(
      baseline.rowCount === 1 &&
        baseline.baselinePresent &&
        baseline.uncommittedCount === 0 &&
        baseline.uncommittedCanariesExact &&
        !baseline.recoveryPresent,
    );
    checks.baselineCommitted = true;

    phase = 'wal-checkpoint';
    await handle.execute('PRAGMA wal_autocheckpoint = 0');
    const checkpoint = extractRows(await handle.execute('PRAGMA wal_checkpoint(TRUNCATE)'));
    requireDriverContract(isSuccessfulTruncateCheckpoint(checkpoint));
    checks.walCheckpointTruncated = true;

    phase = 'write-transaction';
    await handle.execute('PRAGMA cache_size = 8');
    await handle.execute('PRAGMA cache_spill = ON');
    await handle.execute('BEGIN IMMEDIATE');
    transactionOpen = true;
    checks.writeTransactionOpen = true;

    phase = 'uncommitted-canary';
    await handle.execute(
      `WITH RECURSIVE canary(value) AS (
         SELECT 0
         UNION ALL
         SELECT value + 1 FROM canary WHERE value + 1 < ${DB_ACTIVE_WAL_WRITE_DEATH_CANARY_COUNT}
       )
       INSERT INTO driver_wal_write_death_contract (id, state, payload)
       SELECT 100 + value, 'uncommitted', zeroblob(${DB_ACTIVE_WAL_WRITE_DEATH_CANARY_BYTES})
       FROM canary`,
    );
    const active = await inspectDbActiveWalWriteDeathState(handle);
    requireDriverContract(
      active.baselinePresent &&
        active.rowCount === 1 + DB_ACTIVE_WAL_WRITE_DEATH_CANARY_COUNT &&
        active.uncommittedCount === DB_ACTIVE_WAL_WRITE_DEATH_CANARY_COUNT &&
        active.uncommittedCanariesExact &&
        !active.recoveryPresent,
    );
    checks.uncommittedCanaryWritten = true;
  } catch {
    failureCode = phase;
  }

  if (failureCode || !handle) {
    if (transactionOpen && handle) {
      try {
        await handle.execute('ROLLBACK');
      } catch {
        // Fixed-file cleanup below is authoritative.
      }
    }
    try {
      handle?.close();
    } catch {
      // Fixed-file cleanup below is authoritative.
    }
    const databaseCleanup = cleanupDbActiveWalWriteDeathSelfTestDatabase();
    return {
      status: 'fail',
      checks,
      failureCode: databaseCleanup ? (failureCode ?? 'internal') : 'database-cleanup',
      databaseCleanup,
    };
  }

  try {
    return await onPrepared(Object.freeze({ ...checks }));
  } finally {
    // A successful device run crashes the process before this executes. Tests and unexpected
    // callback rejection retire the transaction without accidentally committing the canary.
    try {
      await handle.execute('ROLLBACK');
    } finally {
      handle.close();
    }
  }
}

/**
 * Recover DB-03B2B1 after abrupt process death. The first SQL statement uses a read-only handle and
 * must find the committed baseline without any uncommitted canary before write access is possible.
 */
export async function resumeDbActiveWalWriteDeathSelfTest(
  onReadOnlyVerified: () => void,
): Promise<DbActiveWalWriteDeathResumeResult> {
  const checks = emptyDbActiveWalWriteDeathResumeChecks();
  let phase: DbActiveWalWriteDeathResumeFailureCode = 'internal';
  let failureCode: DbActiveWalWriteDeathResumeFailureCode | undefined;

  try {
    phase = 'read-only-recovery-open';
    {
      const readOnly = open({
        name: DB_ACTIVE_WAL_WRITE_DEATH_SELF_TEST_NAME,
        encryptionKey: DB_ACTIVE_WAL_WRITE_DEATH_SELF_TEST_KEY,
        readOnly: true,
      });
      try {
        const recovered = await inspectDbActiveWalWriteDeathState(readOnly);
        checks.readOnlyRecoveryOpen = true;

        phase = 'recovered-state';
        const journalMode = extractRows(await readOnly.execute('PRAGMA journal_mode'));
        requireDriverContract(pragmaContainsString(journalMode, 'wal'));
        checks.walMode = true;
        requireDriverContract(recovered.rowCount === 1 && recovered.baselinePresent);
        checks.baselinePresent = true;
        requireDriverContract(
          recovered.uncommittedCount === 0 &&
            recovered.uncommittedCanariesExact &&
            !recovered.recoveryPresent,
        );
        checks.uncommittedAbsent = true;
      } finally {
        readOnly.close();
      }
    }

    phase = 'recovered-state';
    onReadOnlyVerified();

    {
      const reopened = open({
        name: DB_ACTIVE_WAL_WRITE_DEATH_SELF_TEST_NAME,
        encryptionKey: DB_ACTIVE_WAL_WRITE_DEATH_SELF_TEST_KEY,
      });
      try {
        await reopened.execute('PRAGMA foreign_keys = ON');

        phase = 'integrity';
        const integrity = extractRows(await reopened.execute('PRAGMA integrity_check'));
        requireDriverContract(integrity.length === 1 && integrity[0]?.integrity_check === 'ok');
        checks.integrity = true;

        phase = 'foreign-keys';
        const foreignKeys = extractRows(await reopened.execute('PRAGMA foreign_keys'));
        const foreignKeyViolations = extractRows(
          await reopened.execute('PRAGMA foreign_key_check'),
        );
        requireDriverContract(
          foreignKeys.length === 1 &&
            foreignKeys[0]?.foreign_keys === 1 &&
            foreignKeyViolations.length === 0,
        );
        checks.foreignKeys = true;

        phase = 'recovery-commit';
        await reopened.execute('BEGIN IMMEDIATE');
        try {
          await reopened.execute(
            `INSERT INTO driver_wal_write_death_contract (id, state, payload)
             VALUES (2, ?, zeroblob(?))`,
            [DB_ACTIVE_WAL_WRITE_DEATH_RECOVERY, DB_ACTIVE_WAL_WRITE_DEATH_CANARY_BYTES],
          );
          await reopened.execute('COMMIT');
        } catch (error) {
          try {
            await reopened.execute('ROLLBACK');
          } catch {
            // Preserve the primary bounded failure.
          }
          throw error;
        }
        checks.recoveryCommit = true;
      } finally {
        reopened.close();
      }
    }

    phase = 'reopen-persistence';
    {
      const persisted = open({
        name: DB_ACTIVE_WAL_WRITE_DEATH_SELF_TEST_NAME,
        encryptionKey: DB_ACTIVE_WAL_WRITE_DEATH_SELF_TEST_KEY,
        readOnly: true,
      });
      try {
        const state = await inspectDbActiveWalWriteDeathState(persisted);
        requireDriverContract(
          state.rowCount === 2 &&
            state.baselinePresent &&
            state.uncommittedCount === 0 &&
            state.uncommittedCanariesExact &&
            state.recoveryPresent,
        );
        checks.reopenPersistence = true;
      } finally {
        persisted.close();
      }
    }
  } catch {
    failureCode = phase;
  } finally {
    checks.databaseCleanup = checks.reopenPersistence
      ? retireDbActiveWalWriteDeathSelfTestDatabase()
      : cleanupDbActiveWalWriteDeathSelfTestDatabase();
    if (!checks.databaseCleanup) failureCode = 'database-cleanup';
  }

  if (!failureCode && Object.values(checks).every(Boolean)) {
    return { status: 'pass', checks };
  }
  return {
    status: 'fail',
    checks,
    failureCode: failureCode ?? 'internal',
  };
}

const DB_ACTIVE_MIGRATION_DEATH_SELF_TEST_NAME = 'driver-active-migration-death-selftest.db';
// This public DEV-only key protects no user data and opens only the fixed disposable file above.
const DB_ACTIVE_MIGRATION_DEATH_SELF_TEST_KEY = 'db-03b2b2-public-throwaway-key-v1';
const DB_ACTIVE_MIGRATION_DEATH_PREFIX_COUNT = 37;
const DB_ACTIVE_MIGRATION_DEATH_PREFIX_HEAD = '0037_purge_legacy_redacted_mode_setting' as const;
const DB_ACTIVE_MIGRATION_DEATH_TARGET = '0038_scrub_reaction_selected_message_text' as const;
const DB_ACTIVE_MIGRATION_DEATH_HEAD = '0040_chats_pin_order' as const;
const DB_ACTIVE_MIGRATION_DEATH_MIGRATION_COUNT = 40 as const;
const DB_ACTIVE_MIGRATION_DEATH_TARGET_COUNT = 128;
const DB_ACTIVE_MIGRATION_DEATH_SELECTED_TEXT_LENGTH = 8_192;
const DB_ACTIVE_MIGRATION_DEATH_TARGET_SQL = `UPDATE outgoing_queue
          SET payload = json_remove(payload, '$.selectedMessageText')
        WHERE kind = 'reaction'
          AND CASE
                WHEN json_valid(payload)
                  THEN json_type(payload, '$.selectedMessageText') IS NOT NULL
                ELSE 0
              END`;
const DB_ACTIVE_MIGRATION_PREFIX_STOP = Object.freeze({
  kind: 'db-active-migration-prefix-ready',
});

export interface DbActiveMigrationDeathPrepareChecks {
  preCleanup: boolean;
  encryptedOpen: boolean;
  walMode: boolean;
  migrationPrefixPrepared: boolean;
  baselineCommitted: boolean;
  walCheckpointTruncated: boolean;
  migrationTransactionOpen: boolean;
  migrationWriteApplied: boolean;
  migrationLedgerPending: boolean;
}

export type DbActiveMigrationDeathPrepareFailureCode =
  | 'pre-cleanup'
  | 'encrypted-open'
  | 'wal-mode'
  | 'migration-prefix'
  | 'baseline-commit'
  | 'wal-checkpoint'
  | 'migration-transaction'
  | 'database-cleanup'
  | 'internal';

export interface DbActiveMigrationDeathPrepareFailure {
  status: 'fail';
  checks: DbActiveMigrationDeathPrepareChecks;
  failureCode: DbActiveMigrationDeathPrepareFailureCode;
  databaseCleanup: boolean;
}

export interface DbActiveMigrationDeathResumeChecks {
  readOnlyRecoveryOpen: boolean;
  walMode: boolean;
  migrationPrefixPreserved: boolean;
  uncommittedMigrationAbsent: boolean;
  integrity: boolean;
  foreignKeys: boolean;
  migrationRetry: boolean;
  migrationLedger: boolean;
  migrationData: boolean;
  idempotent: boolean;
  reopenPersistence: boolean;
  databaseCleanup: boolean;
}

export type DbActiveMigrationDeathResumeFailureCode =
  | 'read-only-recovery-open'
  | 'wal-mode'
  | 'migration-prefix-preserved'
  | 'uncommitted-migration-absent'
  | 'integrity'
  | 'foreign-keys'
  | 'migration-retry'
  | 'migration-ledger'
  | 'migration-data'
  | 'idempotent'
  | 'reopen-persistence'
  | 'database-cleanup'
  | 'internal';

export type DbActiveMigrationDeathResumeResult =
  | {
      status: 'pass';
      migrationCount: typeof DB_ACTIVE_MIGRATION_DEATH_MIGRATION_COUNT;
      migrationHead: typeof DB_ACTIVE_MIGRATION_DEATH_HEAD;
      checks: DbActiveMigrationDeathResumeChecks;
    }
  | {
      status: 'fail';
      migrationCount: typeof DB_ACTIVE_MIGRATION_DEATH_MIGRATION_COUNT;
      migrationHead: typeof DB_ACTIVE_MIGRATION_DEATH_HEAD;
      checks: DbActiveMigrationDeathResumeChecks;
      failureCode: DbActiveMigrationDeathResumeFailureCode;
    };

function emptyDbActiveMigrationDeathPrepareChecks(): DbActiveMigrationDeathPrepareChecks {
  return {
    preCleanup: false,
    encryptedOpen: false,
    walMode: false,
    migrationPrefixPrepared: false,
    baselineCommitted: false,
    walCheckpointTruncated: false,
    migrationTransactionOpen: false,
    migrationWriteApplied: false,
    migrationLedgerPending: false,
  };
}

function emptyDbActiveMigrationDeathResumeChecks(): DbActiveMigrationDeathResumeChecks {
  return {
    readOnlyRecoveryOpen: false,
    walMode: false,
    migrationPrefixPreserved: false,
    uncommittedMigrationAbsent: false,
    integrity: false,
    foreignKeys: false,
    migrationRetry: false,
    migrationLedger: false,
    migrationData: false,
    idempotent: false,
    reopenPersistence: false,
    databaseCleanup: false,
  };
}

interface DbActiveMigrationFixtureRow {
  temp_guid: string;
  kind: string;
  payload: string;
}

interface DbActiveMigrationState {
  prefixLedger: boolean;
  fullLedger: boolean;
  originalFixture: boolean;
  migratedFixture: boolean;
}

function dbActiveMigrationNames(): string[] {
  const names = MIGRATIONS.map((migration) => migration.name);
  const target = MIGRATIONS[DB_ACTIVE_MIGRATION_DEATH_PREFIX_COUNT];
  requireDriverContract(
    names.length === DB_ACTIVE_MIGRATION_DEATH_MIGRATION_COUNT &&
      new Set(names).size === DB_ACTIVE_MIGRATION_DEATH_MIGRATION_COUNT &&
      names[0] === '0001_init' &&
      names[DB_ACTIVE_MIGRATION_DEATH_PREFIX_COUNT - 1] === DB_ACTIVE_MIGRATION_DEATH_PREFIX_HEAD &&
      names[DB_ACTIVE_MIGRATION_DEATH_PREFIX_COUNT] === DB_ACTIVE_MIGRATION_DEATH_TARGET &&
      names[DB_ACTIVE_MIGRATION_DEATH_MIGRATION_COUNT - 1] === DB_ACTIVE_MIGRATION_DEATH_HEAD &&
      target?.statements.length === 1 &&
      target.statements[0] === DB_ACTIVE_MIGRATION_DEATH_TARGET_SQL,
  );
  return names;
}

function dbActiveMigrationFixtureRows(migrated: boolean): DbActiveMigrationFixtureRow[] {
  const selectedMessageText = 'x'.repeat(DB_ACTIVE_MIGRATION_DEATH_SELECTED_TEXT_LENGTH);
  const rows: DbActiveMigrationFixtureRow[] = [];
  for (let index = 0; index < DB_ACTIVE_MIGRATION_DEATH_TARGET_COUNT; index += 1) {
    const suffix = index.toString().padStart(3, '0');
    const payload: Record<string, unknown> = {
      targetGuid: `driver-active-migration-target-${suffix}`,
      reaction: 2000,
    };
    if (!migrated) payload.selectedMessageText = selectedMessageText;
    payload.nested = { keep: `preserved-${suffix}` };
    rows.push({
      temp_guid: `driver-active-migration-death-target-${suffix}`,
      kind: 'reaction',
      payload: JSON.stringify(payload),
    });
  }

  rows.push(
    {
      temp_guid: 'driver-active-migration-death-control-no-field',
      kind: 'reaction',
      payload: JSON.stringify({
        targetGuid: 'driver-active-migration-no-field',
        reaction: 2000,
        nested: { keep: 'no-field' },
      }),
    },
    {
      temp_guid: 'driver-active-migration-death-control-nonreaction',
      kind: 'message',
      payload: JSON.stringify({ selectedMessageText: 'preserve', body: 'message-control' }),
    },
    {
      temp_guid: 'driver-active-migration-death-control-malformed',
      kind: 'reaction',
      payload: '{"selectedMessageText":',
    },
    {
      temp_guid: 'driver-active-migration-death-control-null',
      kind: 'reaction',
      payload: JSON.stringify(
        migrated
          ? { targetGuid: 'driver-active-migration-null', reaction: 2000, nested: { keep: 'null' } }
          : {
              targetGuid: 'driver-active-migration-null',
              reaction: 2000,
              selectedMessageText: null,
              nested: { keep: 'null' },
            },
      ),
    },
    {
      temp_guid: 'driver-active-migration-death-control-empty',
      kind: 'reaction',
      payload: JSON.stringify(
        migrated
          ? {
              targetGuid: 'driver-active-migration-empty',
              reaction: 2000,
              nested: { keep: 'empty' },
            }
          : {
              targetGuid: 'driver-active-migration-empty',
              reaction: 2000,
              selectedMessageText: '',
              nested: { keep: 'empty' },
            },
      ),
    },
  );
  return rows.sort((left, right) => left.temp_guid.localeCompare(right.temp_guid));
}

function hasExactDbActiveMigrationFixture(
  rows: Array<Record<string, unknown>>,
  migrated: boolean,
): boolean {
  const expected = dbActiveMigrationFixtureRows(migrated);
  return (
    rows.length === expected.length &&
    rows.every((row, index) => {
      const expectedRow = expected[index];
      return (
        expectedRow !== undefined &&
        row.temp_guid === expectedRow.temp_guid &&
        row.kind === expectedRow.kind &&
        row.payload === expectedRow.payload
      );
    })
  );
}

function evaluateDbActiveMigrationState(
  ledger: Array<Record<string, unknown>>,
  fixture: Array<Record<string, unknown>>,
): DbActiveMigrationState {
  const migrationNames = dbActiveMigrationNames();
  return {
    prefixLedger: hasExactStringColumn(
      ledger,
      'name',
      migrationNames.slice(0, DB_ACTIVE_MIGRATION_DEATH_PREFIX_COUNT),
    ),
    fullLedger: hasExactStringColumn(ledger, 'name', migrationNames),
    originalFixture: hasExactDbActiveMigrationFixture(fixture, false),
    migratedFixture: hasExactDbActiveMigrationFixture(fixture, true),
  };
}

async function inspectDbActiveMigrationState(handle: RawDb): Promise<DbActiveMigrationState> {
  const ledger = extractRows(await handle.execute('SELECT name FROM _migrations ORDER BY name'));
  const fixture = extractRows(
    await handle.execute(
      `SELECT temp_guid, kind, payload FROM outgoing_queue
        ORDER BY temp_guid`,
    ),
  );
  return evaluateDbActiveMigrationState(ledger, fixture);
}

async function inspectDbActiveMigrationRunnerState(
  runner: SqlRunner,
): Promise<DbActiveMigrationState> {
  const ledger = await runner.query('SELECT name FROM _migrations ORDER BY name');
  const fixture = await runner.query(
    `SELECT temp_guid, kind, payload FROM outgoing_queue
      ORDER BY temp_guid`,
  );
  return evaluateDbActiveMigrationState(ledger, fixture);
}

function dbActiveMigrationPrefixRunner(base: SqlRunner): SqlRunner {
  let committedMigrations = 0;
  return {
    async exec(statement, params) {
      if (statement === 'BEGIN' && committedMigrations === DB_ACTIVE_MIGRATION_DEATH_PREFIX_COUNT) {
        throw DB_ACTIVE_MIGRATION_PREFIX_STOP;
      }
      requireDriverContract(committedMigrations <= DB_ACTIVE_MIGRATION_DEATH_PREFIX_COUNT);
      await base.exec(statement, params);
      if (statement === 'COMMIT') committedMigrations += 1;
    },
    async query(statement, params) {
      return base.query(statement, params);
    },
  };
}

function dbActiveMigrationCrashRunner(
  base: SqlRunner,
  onMigrationActive: () => Promise<never>,
): SqlRunner {
  let transactionOpen = false;
  let migrationWriteApplied = false;
  return {
    async exec(statement, params) {
      if (statement === 'BEGIN') {
        requireDriverContract(!transactionOpen && !migrationWriteApplied);
        await base.exec(statement, params);
        transactionOpen = true;
        return;
      }
      if (statement === DB_ACTIVE_MIGRATION_DEATH_TARGET_SQL) {
        requireDriverContract(transactionOpen && !migrationWriteApplied);
        await base.exec(statement, params);
        migrationWriteApplied = true;
        const activeState = await inspectDbActiveMigrationRunnerState(base);
        requireDriverContract(
          activeState.prefixLedger &&
            !activeState.fullLedger &&
            !activeState.originalFixture &&
            activeState.migratedFixture,
        );
        await onMigrationActive();
        throw new Error('active migration READY callback returned unexpectedly');
      }
      if (statement === 'ROLLBACK' && transactionOpen) {
        await base.exec(statement, params);
        transactionOpen = false;
        return;
      }
      if (transactionOpen) requireDriverContract(false);
      await base.exec(statement, params);
    },
    async query(statement, params) {
      return base.query(statement, params);
    },
  };
}

async function seedDbActiveMigrationFixture(handle: RawDb): Promise<void> {
  const rows = dbActiveMigrationFixtureRows(false);
  await handle.execute('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      await handle.execute(
        `INSERT INTO outgoing_queue (temp_guid, chat_guid, kind, payload)
         VALUES (?, 'driver-active-migration-death-chat', ?, ?)`,
        [row.temp_guid, row.kind, row.payload],
      );
    }
    await handle.execute('COMMIT');
  } catch (error) {
    try {
      await handle.execute('ROLLBACK');
    } catch {
      // Preserve the primary bounded seed failure.
    }
    throw error;
  }
}

/** Delete only the fixed DB-03B2B2 disposable main file. */
export function cleanupDbActiveMigrationDeathSelfTestDatabase(): boolean {
  let cleanup: RawDb | undefined;
  try {
    cleanup = open({ name: DB_ACTIVE_MIGRATION_DEATH_SELF_TEST_NAME });
    cleanup.delete();
    return true;
  } catch {
    try {
      cleanup?.close();
    } catch {
      // The finite false result is authoritative; never replace it with a close error.
    }
    return false;
  }
}

function retireDbActiveMigrationDeathSelfTestDatabase(): boolean {
  let retirement: RawDb | undefined;
  let retirementSucceeded = false;
  try {
    retirement = open({
      name: DB_ACTIVE_MIGRATION_DEATH_SELF_TEST_NAME,
      encryptionKey: DB_ACTIVE_MIGRATION_DEATH_SELF_TEST_KEY,
    });
    const checkpoint = extractRows(retirement.executeSync('PRAGMA wal_checkpoint(TRUNCATE)'));
    requireDriverContract(isSuccessfulTruncateCheckpoint(checkpoint));
    const selectedDeleteMode = extractRows(retirement.executeSync('PRAGMA journal_mode = DELETE'));
    requireDriverContract(pragmaContainsString(selectedDeleteMode, 'delete'));
    const confirmedDeleteMode = extractRows(retirement.executeSync('PRAGMA journal_mode'));
    requireDriverContract(pragmaContainsString(confirmedDeleteMode, 'delete'));
    retirement.close();
    retirement = undefined;
    retirementSucceeded = true;
  } catch {
    try {
      retirement?.close();
    } catch {
      // Main-file deletion below is still attempted; the finite false result remains authoritative.
    }
  }
  const mainFileDeleted = cleanupDbActiveMigrationDeathSelfTestDatabase();
  return retirementSucceeded && mainFileDeleted;
}

/**
 * Prepare exact head 0037, apply the real 0038 statement inside its still-open transaction, and
 * retain the fixed encrypted handle until the host terminates this process.
 */
export async function prepareDbActiveMigrationDeathSelfTest(
  onPrepared: (checks: Readonly<DbActiveMigrationDeathPrepareChecks>) => Promise<never>,
): Promise<DbActiveMigrationDeathPrepareFailure> {
  const checks = emptyDbActiveMigrationDeathPrepareChecks();
  let phase: DbActiveMigrationDeathPrepareFailureCode = 'internal';
  let failureCode: DbActiveMigrationDeathPrepareFailureCode | undefined;
  let handle: RawDb | undefined;
  let readyCallbackStarted = false;
  let readyCallbackFailure: unknown;

  try {
    phase = 'pre-cleanup';
    requireDriverContract(cleanupDbActiveMigrationDeathSelfTestDatabase());
    checks.preCleanup = true;

    phase = 'encrypted-open';
    handle = open({
      name: DB_ACTIVE_MIGRATION_DEATH_SELF_TEST_NAME,
      encryptionKey: DB_ACTIVE_MIGRATION_DEATH_SELF_TEST_KEY,
    });
    await handle.execute('SELECT count(*) FROM sqlite_master');
    checks.encryptedOpen = true;

    phase = 'wal-mode';
    await handle.execute('PRAGMA foreign_keys = ON');
    const enabledWal = extractRows(await handle.execute('PRAGMA journal_mode = WAL'));
    const confirmedWal = extractRows(await handle.execute('PRAGMA journal_mode'));
    requireDriverContract(
      pragmaContainsString(enabledWal, 'wal') && pragmaContainsString(confirmedWal, 'wal'),
    );
    await handle.execute('PRAGMA wal_autocheckpoint = 0');
    checks.walMode = true;

    phase = 'migration-prefix';
    dbActiveMigrationNames();
    let prefixStopped = false;
    try {
      await runMigrations(dbActiveMigrationPrefixRunner(opRunner(handle)));
    } catch (error) {
      prefixStopped = error === DB_ACTIVE_MIGRATION_PREFIX_STOP;
      if (!prefixStopped) throw error;
    }
    const prefixState = await inspectDbActiveMigrationState(handle);
    requireDriverContract(
      prefixStopped &&
        prefixState.prefixLedger &&
        !prefixState.fullLedger &&
        !prefixState.originalFixture &&
        !prefixState.migratedFixture,
    );
    checks.migrationPrefixPrepared = true;

    phase = 'baseline-commit';
    await seedDbActiveMigrationFixture(handle);
    const baselineState = await inspectDbActiveMigrationState(handle);
    requireDriverContract(
      baselineState.prefixLedger &&
        !baselineState.fullLedger &&
        baselineState.originalFixture &&
        !baselineState.migratedFixture,
    );
    checks.baselineCommitted = true;

    phase = 'wal-checkpoint';
    const checkpoint = extractRows(await handle.execute('PRAGMA wal_checkpoint(TRUNCATE)'));
    requireDriverContract(isSuccessfulTruncateCheckpoint(checkpoint));
    checks.walCheckpointTruncated = true;

    phase = 'migration-transaction';
    await handle.execute('PRAGMA cache_size = 8');
    await handle.execute('PRAGMA cache_spill = ON');
    await runMigrations(
      dbActiveMigrationCrashRunner(opRunner(handle), async (): Promise<never> => {
        checks.migrationTransactionOpen = true;
        checks.migrationWriteApplied = true;
        checks.migrationLedgerPending = true;
        readyCallbackStarted = true;
        return onPrepared(Object.freeze({ ...checks }));
      }),
    );
    requireDriverContract(false);
  } catch (error) {
    if (readyCallbackStarted) readyCallbackFailure = error;
    else failureCode = phase;
  }

  if (readyCallbackStarted) {
    try {
      handle?.close();
    } finally {
      cleanupDbActiveMigrationDeathSelfTestDatabase();
    }
    throw readyCallbackFailure;
  }

  try {
    handle?.close();
  } catch {
    // Fixed-file cleanup below is authoritative.
  }
  const databaseCleanup = cleanupDbActiveMigrationDeathSelfTestDatabase();
  return {
    status: 'fail',
    checks,
    failureCode: databaseCleanup ? (failureCode ?? 'internal') : 'database-cleanup',
    databaseCleanup,
  };
}

export async function resumeDbActiveMigrationDeathSelfTest(
  onReadOnlyVerified: () => void,
): Promise<DbActiveMigrationDeathResumeResult> {
  const checks = emptyDbActiveMigrationDeathResumeChecks();
  let phase: DbActiveMigrationDeathResumeFailureCode = 'internal';
  let failureCode: DbActiveMigrationDeathResumeFailureCode | undefined;

  try {
    phase = 'read-only-recovery-open';
    {
      const readOnly = open({
        name: DB_ACTIVE_MIGRATION_DEATH_SELF_TEST_NAME,
        encryptionKey: DB_ACTIVE_MIGRATION_DEATH_SELF_TEST_KEY,
        readOnly: true,
      });
      try {
        const recoveredState = await inspectDbActiveMigrationState(readOnly);
        checks.readOnlyRecoveryOpen = true;

        phase = 'wal-mode';
        const journalMode = extractRows(await readOnly.execute('PRAGMA journal_mode'));
        requireDriverContract(pragmaContainsString(journalMode, 'wal'));
        checks.walMode = true;

        phase = 'migration-prefix-preserved';
        requireDriverContract(recoveredState.prefixLedger && !recoveredState.fullLedger);
        checks.migrationPrefixPreserved = true;

        phase = 'uncommitted-migration-absent';
        requireDriverContract(recoveredState.originalFixture && !recoveredState.migratedFixture);
        checks.uncommittedMigrationAbsent = true;

        phase = 'integrity';
        const integrity = extractRows(await readOnly.execute('PRAGMA integrity_check'));
        requireDriverContract(integrity.length === 1 && integrity[0]?.integrity_check === 'ok');
        checks.integrity = true;
      } finally {
        readOnly.close();
      }
    }

    phase = 'uncommitted-migration-absent';
    onReadOnlyVerified();

    {
      const reopened = open({
        name: DB_ACTIVE_MIGRATION_DEATH_SELF_TEST_NAME,
        encryptionKey: DB_ACTIVE_MIGRATION_DEATH_SELF_TEST_KEY,
      });
      try {
        await reopened.execute('PRAGMA foreign_keys = ON');
        phase = 'foreign-keys';
        const foreignKeys = extractRows(await reopened.execute('PRAGMA foreign_keys'));
        const foreignKeyViolations = extractRows(
          await reopened.execute('PRAGMA foreign_key_check'),
        );
        requireDriverContract(
          foreignKeys.length === 1 &&
            foreignKeys[0]?.foreign_keys === 1 &&
            foreignKeyViolations.length === 0,
        );
        checks.foreignKeys = true;

        phase = 'migration-retry';
        const expectedTailNames = dbActiveMigrationNames().slice(
          DB_ACTIVE_MIGRATION_DEATH_PREFIX_COUNT,
        );
        const retriedMigrations = await runMigrations(opRunner(reopened));
        requireDriverContract(
          retriedMigrations.length === expectedTailNames.length &&
            retriedMigrations.every((name, index) => name === expectedTailNames[index]),
        );
        checks.migrationRetry = true;

        const migratedState = await inspectDbActiveMigrationState(reopened);
        phase = 'migration-ledger';
        requireDriverContract(migratedState.fullLedger && !migratedState.prefixLedger);
        checks.migrationLedger = true;

        phase = 'migration-data';
        requireDriverContract(migratedState.migratedFixture && !migratedState.originalFixture);
        checks.migrationData = true;

        phase = 'integrity';
        const integrity = extractRows(await reopened.execute('PRAGMA integrity_check'));
        const postMigrationForeignKeyViolations = extractRows(
          await reopened.execute('PRAGMA foreign_key_check'),
        );
        requireDriverContract(
          integrity.length === 1 &&
            integrity[0]?.integrity_check === 'ok' &&
            postMigrationForeignKeyViolations.length === 0,
        );

        phase = 'idempotent';
        const idempotentMigrations = await runMigrations(opRunner(reopened));
        requireDriverContract(idempotentMigrations.length === 0);
        checks.idempotent = true;
      } finally {
        reopened.close();
      }
    }

    phase = 'reopen-persistence';
    {
      const persisted = open({
        name: DB_ACTIVE_MIGRATION_DEATH_SELF_TEST_NAME,
        encryptionKey: DB_ACTIVE_MIGRATION_DEATH_SELF_TEST_KEY,
        readOnly: true,
      });
      try {
        const persistedState = await inspectDbActiveMigrationState(persisted);
        const persistedIntegrity = extractRows(await persisted.execute('PRAGMA integrity_check'));
        requireDriverContract(
          persistedState.fullLedger &&
            !persistedState.prefixLedger &&
            persistedState.migratedFixture &&
            !persistedState.originalFixture &&
            persistedIntegrity.length === 1 &&
            persistedIntegrity[0]?.integrity_check === 'ok',
        );
        checks.reopenPersistence = true;
      } finally {
        persisted.close();
      }
    }
  } catch {
    failureCode = phase;
  } finally {
    checks.databaseCleanup = checks.reopenPersistence
      ? retireDbActiveMigrationDeathSelfTestDatabase()
      : cleanupDbActiveMigrationDeathSelfTestDatabase();
    if (!checks.databaseCleanup) failureCode = 'database-cleanup';
  }

  if (!failureCode && Object.values(checks).every(Boolean)) {
    return {
      status: 'pass',
      migrationCount: DB_ACTIVE_MIGRATION_DEATH_MIGRATION_COUNT,
      migrationHead: DB_ACTIVE_MIGRATION_DEATH_HEAD,
      checks,
    };
  }
  return {
    status: 'fail',
    migrationCount: DB_ACTIVE_MIGRATION_DEATH_MIGRATION_COUNT,
    migrationHead: DB_ACTIVE_MIGRATION_DEATH_HEAD,
    checks,
    failureCode: failureCode ?? 'internal',
  };
}
