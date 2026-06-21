import { sql } from 'drizzle-orm';
import { kv } from '../schema';
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

export async function kvSet(db: AppDatabase, key: string, value: string): Promise<void> {
  await db
    .insert(kv)
    .values({ key, value })
    .onConflictDoUpdate({ target: kv.key, set: { value: sql`excluded.value` } });
}
