import { open } from '@op-engineering/op-sqlite';
import { drizzle } from 'drizzle-orm/op-sqlite';
import { runMigrations, type SqlRunner } from './migrate';
import type { AppDatabase } from './types';

const DB_NAME = 'bluebubbles.db';

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
  const overrides: Record<string, unknown> = {
    execute: (sql: string, params?: unknown[]) =>
      wrap(db.executeSync(sql, (params as never[]) ?? [])),
    executeAsync: async (sql: string, params?: unknown[]) => {
      const r = await db.execute(sql, (params as never[]) ?? []);
      flush();
      return wrap(r);
    },
    executeRawAsync: async (sql: string, params?: unknown[]) => {
      const r = await db.executeRaw(sql, (params as never[]) ?? []);
      flush();
      return r.rawRows;
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
  rawDb = open({ name: DB_NAME, encryptionKey });
  await rawDb.execute('PRAGMA foreign_keys = ON');
  await runMigrations(opRunner(rawDb));
  dbInstance = drizzle(drizzleAdapter(rawDb)) as unknown as AppDatabase;
  return dbInstance;
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
