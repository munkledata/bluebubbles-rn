import { logger } from '@core/secure';
import { plainTextFromAttributedBody } from '@core/richtext';
import { getDatabase, getRawDatabase, initDatabase } from '@db/database';
import { resolveDbKey, rotateDbKey } from '@db/key';
import { kvGet, kvSet } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { vault } from './clients';

/**
 * The in-flight FIRST open, shared by every concurrent caller (single-flight).
 *
 * Without it, two callers that both miss the `getDatabase()` fast path each `await resolveDbKey`
 * — a genuine suspension point (two native Keystore reads) — and both then reach `initDatabase`,
 * whose `if (dbInstance)` guard is only set AFTER `await runMigrations`. So both open a SECOND
 * connection to the same file and both run migrations, which issue their own raw BEGIN/COMMIT
 * outside the `withDbTransaction` queue: on a release that adds a migration that collides
 * ("database is locked" / "table already exists"), and even when it doesn't, the loser's handle is
 * leaked while holding file locks and any consumer that memoized it (`realtimeSinkInstance`) is
 * left wrapping a connection nothing else uses. The race is reachable on a killed-app wake with
 * two back-to-back FCM pushes, and on boot racing the first push.
 */
let openInFlight: Promise<AppDatabase> | null = null;

function startDatabaseOpen(): Promise<AppDatabase> {
  const attempt = (async (): Promise<AppDatabase> => {
    // resolveDbKey (not getOrCreateDbKey) so a key rotation interrupted by a crash is finished
    // here before the DB is opened. Only runs on the true first open.
    const key = await resolveDbKey(vault);
    return initDatabase(key);
  })();
  // Clear the memo once it settles, either way: on success the getDatabase() fast path takes over,
  // and on FAILURE (vault unavailable, corrupt file, a migration throw) the next caller must get a
  // fresh attempt rather than re-awaiting a permanently rejected promise forever. Both handlers are
  // attached, so this derived chain never becomes an unhandled rejection of its own; the real
  // rejection is still delivered to whoever awaited ensureDatabase(). The identity check keeps a
  // late settle from clearing a newer attempt.
  const clear = (): void => {
    if (openInFlight === attempt) openInFlight = null;
  };
  attempt.then(clear, clear);
  return attempt;
}

/** Open the encrypted DB (once), generating the SQLCipher key on first run. */
export async function ensureDatabase(): Promise<AppDatabase> {
  // Fast path: if the DB is already open, return the cached handle without touching the vault.
  // getDatabase() throws when the DB isn't open yet, so falling through is the genuine first-open
  // path. This matters because ensureDatabase runs on EVERY FCM event, and resolveDbKey does two
  // native Keystore reads that are pure waste once the connection exists.
  try {
    return getDatabase();
  } catch {
    // Not open yet — fall through to the single-flight open. Nothing awaits between here and the
    // memo assignment below, so two callers can never both decide to start one.
  }
  openInFlight ??= startDatabaseOpen();
  return openInFlight;
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

/**
 * Did every row this pass claims to have written actually end up with text? Chunked so a large
 * history can't build a statement with more bound parameters than SQLite accepts.
 *
 * Deliberately checks THE IDS WE WROTE, not "is the selecting query now empty" — rows whose
 * attributedBody decodes to nothing stay in that result set forever, so the empty-set version could
 * never be satisfied and every launch would repeat the full table scan.
 */
async function backfillWritesLanded(
  raw: ReturnType<typeof getRawDatabase>,
  ids: number[],
): Promise<boolean> {
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const res = await raw.execute(
      `SELECT COUNT(*) AS c FROM messages WHERE id IN (${chunk.map(() => '?').join(',')})
         AND text IS NOT NULL AND text != ''`,
      chunk,
    );
    const row = (res.rows ?? [])[0] as { c?: number } | undefined;
    if ((row?.c ?? 0) !== chunk.length) return false;
  }
  return true;
}

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
    const fixedIds: number[] = [];
    for (const r of rows) {
      const text = plainTextFromAttributedBody(r.ab);
      if (!text) continue;
      await raw.execute(`UPDATE messages SET text = ? WHERE id = ?`, [text, r.id]);
      fixedIds.push(r.id);
    }
    if (fixedIds.length > 0) raw.flushPendingReactiveQueries();
    // Set the "done" flag from EVIDENCE, never from having reached this line. This pass runs on the
    // ONE shared connection, so its plain UPDATEs join whatever transaction happens to be open (see
    // db/transaction.ts) — a rollback there erases everything the loop wrote, while the kvSet below
    // is its own autocommit and would still retire the only pass that would ever repair those rows.
    // A zero-write pass has nothing to verify and is legitimately done (it must NOT re-scan forever).
    if (fixedIds.length > 0 && !(await backfillWritesLanded(raw, fixedIds))) {
      logger.warn('[search] search-text backfill did not persist; retrying next launch', {
        attempted: fixedIds.length,
      });
      return;
    }
    await kvSet(db, SEARCH_BACKFILL_FLAG, 'done');
    if (fixedIds.length > 0) {
      logger.info('[search] backfilled searchable text', { fixed: fixedIds.length });
    }
  } catch (e) {
    logger.warn('[search] search-text backfill skipped', e);
  }
}
