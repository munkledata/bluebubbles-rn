import { open } from '@op-engineering/op-sqlite';
import { drizzle } from 'drizzle-orm/op-sqlite';
import { runMigrations } from './migrate';
import type { AppDatabase, ReadDb, TestDb } from './types';
import { drizzleAdapter, opRunner, type RawDb } from './opSqliteAdapter';

const DB_NAME = 'gator.db';

let rawDb: RawDb | null = null;
let dbInstance: AppDatabase | null = null;

/**
 * Open the encrypted database (once), enable FK enforcement, run migrations, and
 * return the Drizzle handle. SQLCipher transparently AES-encrypts the file using
 * `encryptionKey` (op-sqlite is built with the sqlcipher flag in package.json).
 */
export async function initDatabase(encryptionKey: string): Promise<ReadDb> {
  if (dbInstance) return dbInstance as unknown as ReadDb;
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
    return database as unknown as ReadDb;
  } catch (error) {
    try {
      opened.close();
    } catch {
      // Preserve the initialization failure; close is best-effort cleanup of an unusable handle.
    }
    throw error;
  }
}

/**
 * The shared handle, as a {@link ReadDb}: reads anywhere, writes only inside a `withDbTransaction`
 * callback (which receives the same object as a WriteDb).
 */
export function getDatabase(): ReadDb {
  if (!dbInstance) throw new Error('Database not initialized — call initDatabase() first.');
  return dbInstance as unknown as ReadDb;
}

/** Raw op-sqlite handle, for low-level checks (e.g. the on-device SQLCipher test). */
export function getRawDatabase(): RawDb {
  if (!rawDb) throw new Error('Database not initialized — call initDatabase() first.');
  return rawDb;
}

/**
 * The throwaway-database doorway (P6.5): the only way a DEV harness outside this file opens,
 * migrates, queries, closes or deletes a database. It accepts only these fixed disposable names,
 * never the real account database, builds the native options itself, and hands out a narrowed
 * handle (no delete, rekey, attach or raw access) that only this doorway can migrate, wrap or close.
 */
const THROWAWAY_DATABASE_NAMES = [
  'perf01-cold-1000.db',
  'perf01-cold-10000.db',
  'perf02-inbox-benchmark.db',
] as const;

export type ThrowawayDatabaseName = (typeof THROWAWAY_DATABASE_NAMES)[number];

declare const throwawayDatabaseBrand: unique symbol;

export type ThrowawayDatabase = Pick<
  RawDb,
  'execute' | 'reactiveExecute' | 'flushPendingReactiveQueries'
> & { readonly [throwawayDatabaseBrand]: true };

const openThrowawayHandles = new WeakSet<object>();

function approvedThrowawayName(name: ThrowawayDatabaseName): ThrowawayDatabaseName {
  if (!__DEV__) throw new Error('Throwaway databases are development-only.');
  if ((name as string) === DB_NAME || !THROWAWAY_DATABASE_NAMES.includes(name)) {
    throw new Error('Throwaway database name is not approved.');
  }
  return name;
}

function openThrowawayHandle(db: ThrowawayDatabase): RawDb {
  if (!openThrowawayHandles.has(db)) throw new Error('Not an open throwaway database.');
  return db as unknown as RawDb;
}

export function openThrowawayDatabase(
  name: ThrowawayDatabaseName,
  encryptionKey: string,
  readOnly: boolean,
): ThrowawayDatabase {
  const approved = approvedThrowawayName(name);
  const opened = readOnly
    ? open({ name: approved, encryptionKey, readOnly: true })
    : open({ name: approved, encryptionKey });
  openThrowawayHandles.add(opened);
  return opened as unknown as ThrowawayDatabase;
}

export function closeThrowawayDatabase(db: ThrowawayDatabase): void {
  const handle = openThrowawayHandle(db);
  openThrowawayHandles.delete(db);
  handle.close();
}

export function deleteThrowawayDatabase(name: ThrowawayDatabaseName): void {
  const cleanup = open({ name: approvedThrowawayName(name) });
  cleanup.delete();
}

export async function migrateThrowawayDatabase(db: ThrowawayDatabase): Promise<void> {
  await runMigrations(opRunner(openThrowawayHandle(db)));
}

export function throwawayDrizzle(
  db: ThrowawayDatabase,
  queryLogger?: { logQuery(query: string, params: unknown[]): void },
): TestDb {
  // The harness owns this disposable file outright, so its handle satisfies reads, writes and
  // own-transaction helpers alike, exactly like a test database.
  return drizzle(drizzleAdapter(openThrowawayHandle(db)), {
    logger: queryLogger,
  }) as unknown as TestDb;
}
