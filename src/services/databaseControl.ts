import { logger } from '@core/secure';
import { plainTextFromAttributedBody } from '@core/richtext';
import { getDatabase, getRawDatabase, initDatabase } from '@db/database';
import { resolveDbKey, rotateDbKey } from '@db/key';
import { kvGet, kvSet } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { vault } from './clients';

/** Open the encrypted DB (once), generating the SQLCipher key on first run. */
export async function ensureDatabase(): Promise<AppDatabase> {
  // Fast path: if the DB is already open, return the cached handle without touching the vault.
  // getDatabase() throws when the DB isn't open yet, so the catch is the genuine first-open path.
  // This matters because ensureDatabase runs on EVERY FCM event, and resolveDbKey below does two
  // native Keystore reads that are pure waste once the connection exists.
  try {
    return getDatabase();
  } catch {
    // resolveDbKey (not getOrCreateDbKey) so a key rotation interrupted by a crash is finished
    // here before the DB is opened. Only runs on the true first open.
    const key = await resolveDbKey(vault);
    return initDatabase(key);
  }
}

/** Rotate the SQLCipher database key (crash-safe). The open connection keeps working. */
export async function rotateDatabaseKey(): Promise<void> {
  await rotateDbKey(vault, getRawDatabase());
}

/**
 * One-time: make already-cached edited/SMS messages full-text searchable by decoding their
 * attributedBody into the empty `text` column (FTS indexes only `text`). Guarded by a kv flag so
 * it runs once; fire-and-forget so it never blocks boot, and a failure leaves the flag unset to
 * retry next launch. Newly synced messages get this at upsert time, so this only backfills history.
 */
const SEARCH_BACKFILL_FLAG = 'maintenance.searchTextBackfill.v1';
export async function runSearchTextBackfillOnce(): Promise<void> {
  try {
    const db = getDatabase();
    if ((await kvGet(db, SEARCH_BACKFILL_FLAG)) === 'done') return;
    // Use the RAW handle so this bulk pass doesn't trigger a reactive flush per row (FTS triggers
    // still fire on the UPDATE); flush once at the end. Only edited/SMS rows have empty text.
    const raw = getRawDatabase();
    const res = await raw.execute(
      `SELECT id, attributed_body AS ab FROM messages WHERE (text IS NULL OR text = '') AND attributed_body IS NOT NULL`,
    );
    const rows = (res.rows ?? []) as Array<{ id: number; ab: string | null }>;
    let fixed = 0;
    for (const r of rows) {
      const text = plainTextFromAttributedBody(r.ab);
      if (!text) continue;
      await raw.execute(`UPDATE messages SET text = ? WHERE id = ?`, [text, r.id]);
      fixed += 1;
    }
    if (fixed > 0) raw.flushPendingReactiveQueries();
    await kvSet(db, SEARCH_BACKFILL_FLAG, 'done');
    if (fixed > 0) logger.info('[search] backfilled searchable text', { fixed });
  } catch (e) {
    logger.warn('[search] search-text backfill skipped', e);
  }
}
