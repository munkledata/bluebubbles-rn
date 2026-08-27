import { sql } from 'drizzle-orm';
import { kv } from '../schema';
import {
  runInTransactionContext,
  withDbTransaction,
  type DbTransactionContext,
} from '../transaction';
import type { AppDatabase } from '../types';

// ---- Key-value prefs (non-secret) ----

export const THEME_PREF_KEY = 'theme.preset';
/** Active custom-theme id (stringified) when a user theme overrides the preset; '' = none. */
export const THEME_CUSTOM_KEY = 'theme.custom';

export async function kvGet(db: AppDatabase, key: string): Promise<string | null> {
  const rows = await db.all<{ value: string | null }>(
    sql`SELECT value FROM kv WHERE key = ${key} LIMIT 1`,
  );
  return rows[0]?.value ?? null;
}

/** Read a key while the caller's existing transaction owns the database connection. */
export async function kvGetWithinTransaction(
  context: DbTransactionContext,
  key: string,
): Promise<string | null> {
  return runInTransactionContext(context, async (db) => {
    const rows = await db.all<{ value: string | null }>(
      sql`SELECT value FROM kv WHERE key = ${key} LIMIT 1`,
    );
    return rows[0]?.value ?? null;
  });
}

/**
 * Transaction-scoped key/value upsert. Use only when the caller already owns the process-wide DB
 * transaction and needs this setting to commit atomically with related rows.
 */
export async function kvSetWithinTransaction(
  context: DbTransactionContext,
  key: string,
  value: string,
): Promise<void> {
  return runInTransactionContext(context, async (db) => {
    await db
      .insert(kv)
      .values({ key, value })
      .onConflictDoUpdate({ target: kv.key, set: { value: sql`excluded.value` } });
  });
}

/** Standalone key/value upsert. Callers already inside a transaction must use the scoped form. */
export async function kvSet(db: AppDatabase, key: string, value: string): Promise<void> {
  await withDbTransaction(db, (context) => kvSetWithinTransaction(context, key, value));
}
