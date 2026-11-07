import { inArray, sql } from 'drizzle-orm';
import { kv } from '../schema';
import { runInTransactionContext, type DbTransactionContext } from '../transaction';
import type { Queryable } from '../types';

// ---- Key-value prefs (non-secret) ----

export const THEME_PREF_KEY = 'theme.preset';
/** Active custom-theme id (stringified) when a user theme overrides the preset; '' = none. */
export const THEME_CUSTOM_KEY = 'theme.custom';
/**
 * The highest server `rcs_identity_version` whose one-time RCS history refresh finished on this
 * phone (stringified integer). Account-scoped: `clearLocalCache` deletes it with the other account
 * kv state, and `localCacheDirty` reports it as a leftover. It is deliberately not a backup key,
 * so a restored phone runs the refresh again.
 */
export const RCS_IDENTITY_APPLIED_KEY = 'rcs.identityVersionApplied';
/**
 * The unfinished RCS identity refresh: `{"version":N,"done":[chat guid, …]}`, the conversations
 * already re-read for that version, so a later sync re-reads only the rest. Account-scoped and not
 * a backup key, like {@link RCS_IDENTITY_APPLIED_KEY}.
 */
export const RCS_IDENTITY_PROGRESS_KEY = 'rcs.identityRefreshProgress';

export async function kvGet(db: Queryable, key: string): Promise<string | null> {
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

/** Transaction-scoped delete of the given keys; a key that is absent is simply skipped. */
export async function kvDeleteWithinTransaction(
  context: DbTransactionContext,
  keys: readonly string[],
): Promise<void> {
  return runInTransactionContext(context, async (db) => {
    if (keys.length > 0) await db.delete(kv).where(inArray(kv.key, [...keys]));
  });
}
