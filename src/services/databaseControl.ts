import { sql } from 'drizzle-orm';
import { logger } from '@core/secure';
import { plainTextFromAttributedBody } from '@core/richtext';
import { getDatabase, getRawDatabase, initDatabase } from '@db/database';
import { resolveDbKey, rotateDbKey } from '@db/key';
import { kvGet, kvSetWithinTransaction } from '@db/repositories';
import {
  runInTransactionContext,
  withDbTransaction,
  type DbTransactionContext,
} from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { vault } from './clients';
import { runTrackedRealtimeWork, type RealtimeDeliveryLease } from './realtime/deliveryCoordinator';

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
const SEARCH_BACKFILL_BATCH_SIZE = 50;
let searchBackfillTail: Promise<void> = Promise.resolve();
const searchBackfillFlights = new Map<number, Promise<void>>();

interface SearchBackfillRow {
  readonly id: number;
  readonly ab: string;
}

function parseBackfillRows(value: unknown, afterId: number): SearchBackfillRow[] {
  if (!Array.isArray(value)) {
    throw new Error('search-text backfill returned a non-array page');
  }
  const rows: SearchBackfillRow[] = [];
  let previousId = afterId;
  for (const valueRow of value) {
    if (!valueRow || typeof valueRow !== 'object') {
      throw new Error('search-text backfill returned an invalid row');
    }
    const candidate = valueRow as Record<string, unknown>;
    const id = candidate.id;
    const ab = candidate.ab;
    if (!Number.isSafeInteger(id) || typeof id !== 'number' || id <= previousId) {
      throw new Error('search-text backfill returned an invalid or unordered id');
    }
    if (typeof ab !== 'string') {
      throw new Error('search-text backfill returned an invalid attributed body');
    }
    rows.push({ id, ab });
    previousId = id;
  }
  return rows;
}

async function readSearchTextBackfillPage(
  raw: ReturnType<typeof getRawDatabase>,
  afterId: number,
): Promise<SearchBackfillRow[]> {
  const result = await raw.execute(
    `SELECT id, attributed_body AS ab
       FROM messages
      WHERE id > ? AND (text IS NULL OR text = '') AND attributed_body IS NOT NULL
      ORDER BY id ASC
      LIMIT ?`,
    [afterId, SEARCH_BACKFILL_BATCH_SIZE],
  );
  return parseBackfillRows(result.rows ?? [], afterId);
}

function searchTextBackfillPagesMatch(
  prepared: ReadonlyArray<SearchBackfillRow>,
  current: ReadonlyArray<SearchBackfillRow>,
): boolean {
  return (
    prepared.length === current.length &&
    prepared.every((row, index) => row.id === current[index]?.id && row.ab === current[index]?.ab)
  );
}

async function updateSearchTextBatch(
  context: DbTransactionContext,
  rows: ReadonlyArray<{
    readonly id: number;
    readonly attributedBody: string;
    readonly text: string;
  }>,
): Promise<void> {
  return runInTransactionContext(context, async (db) => {
    const cases = sql.join(
      rows.map(
        (row) =>
          sql`WHEN id = ${row.id} AND attributed_body = ${row.attributedBody} THEN ${row.text}`,
      ),
      sql` `,
    );
    const matches = sql.join(
      rows.map((row) => sql`(id = ${row.id} AND attributed_body = ${row.attributedBody})`),
      sql` OR `,
    );
    const changed = await db.all<{ id: number }>(sql`
      UPDATE messages
         SET text = CASE ${cases} ELSE text END
       WHERE (${matches}) AND (text IS NULL OR text = '')
       RETURNING id
    `);
    // RETURNING belongs to this exact statement. Unlike connection-global `SELECT changes()`, a
    // neighbouring writer cannot replace the count between awaits.
    if (changed.length !== rows.length) {
      throw new Error('search-text source changed before its guarded update');
    }
  });
}

async function tryFinishSearchTextBackfill(
  db: AppDatabase,
  raw: ReturnType<typeof getRawDatabase>,
  lease: RealtimeDeliveryLease,
  afterId: number,
): Promise<'done' | 'more' | 'paused'> {
  let trailingRowsFound = false;
  let markedDone = false;
  const completion = await runTrackedRealtimeWork(lease, async (activeLease) => {
    await withDbTransaction(
      db,
      async (context) => {
        // Check and flag under the same short write lock. A sync page that appended an eligible
        // row after our last SELECT therefore wins either before this check or after the flag;
        // newly ingested rows compute text during upsert, so only the former needs another page.
        const trailing = await raw.execute(
          `SELECT id
             FROM messages
            WHERE id > ? AND (text IS NULL OR text = '') AND attributed_body IS NOT NULL
            ORDER BY id ASC
            LIMIT 1`,
          [afterId],
        );
        trailingRowsFound = (trailing.rows ?? []).length > 0;
        if (trailingRowsFound) return;
        await kvSetWithinTransaction(context, SEARCH_BACKFILL_FLAG, 'done');
        markedDone = true;
      },
      () => activeLease.isCurrent(),
    );
  });
  if (completion === 'paused') return 'paused';
  if (trailingRowsFound) return 'more';
  return markedDone ? 'done' : 'paused';
}

async function runSearchTextBackfillPass(lease: RealtimeDeliveryLease): Promise<void> {
  try {
    if (!lease.isCurrent()) return;
    const db = getDatabase();
    if (!lease.isCurrent()) return;
    if ((await kvGet(db, SEARCH_BACKFILL_FLAG)) === 'done') return;
    if (!lease.isCurrent()) return;

    // The raw handle permits one CASE update per page instead of one reactive write per row. The
    // preliminary read and decoding stay outside the mutex; the guarded exact re-read plus optional
    // update commit through it, so a dirty preliminary page can never advance the cursor.
    const raw = getRawDatabase();
    let afterId = 0;
    let fixed = 0;
    while (lease.isCurrent()) {
      const rows = await readSearchTextBackfillPage(raw, afterId);
      if (!lease.isCurrent()) return;
      if (rows.length === 0) {
        const completion = await tryFinishSearchTextBackfill(db, raw, lease, afterId);
        if (completion === 'more') continue;
        if (completion === 'done' && fixed > 0) {
          logger.info('[search] backfilled searchable text', { fixed });
        }
        return;
      }

      const last = rows.at(-1);
      if (!last) break;
      const updates = rows.flatMap((row) => {
        const text = plainTextFromAttributedBody(row.ab);
        return text ? [{ id: row.id, attributedBody: row.ab, text }] : [];
      });
      let pageMatched = false;
      const status = await runTrackedRealtimeWork(lease, async (activeLease) => {
        await withDbTransaction(
          db,
          async (transactionContext) => {
            // The prepared SELECT runs outside the mutex so decoding cannot hold the shared write
            // queue. Re-read the exact bounded page after acquiring it: an unrelated transaction
            // may have temporarily changed `text` on this shared connection and then rolled back.
            // Advancing from that dirty page would skip the restored row forever and let the
            // terminal check record a false completion marker.
            const currentRows = await readSearchTextBackfillPage(raw, afterId);
            pageMatched = searchTextBackfillPagesMatch(rows, currentRows);
            if (!pageMatched) return;
            if (updates.length > 0) {
              await updateSearchTextBatch(transactionContext, updates);
            }
          },
          () => activeLease.isCurrent(),
        );
      });
      if (status === 'paused') return;
      // A changed page committed no message writes. Retry from the same cursor against a fresh
      // committed view, including when every row in the prepared page was undecodable.
      if (!pageMatched) continue;
      fixed += updates.length;
      // Move past a page only after its conditional write commits. Undecodable rows deliberately
      // advance too; otherwise one historical corrupt body would make every launch loop forever.
      afterId = last.id;
      if (rows.length === SEARCH_BACKFILL_BATCH_SIZE) continue;

      const completion = await tryFinishSearchTextBackfill(db, raw, lease, afterId);
      if (completion === 'more') continue;
      if (completion === 'done' && fixed > 0) {
        logger.info('[search] backfilled searchable text', { fixed });
      }
      return;
    }
  } catch (e) {
    if (!lease.isCurrent()) return;
    logger.warn('[search] search-text backfill skipped', e);
  }
}

/**
 * Repair one account generation without racing another generation's use of the shared connection.
 * Same-generation callers share a Promise; a replacement account waits for the stale pass to stop.
 */
export function runSearchTextBackfillOnce(lease: RealtimeDeliveryLease): Promise<void> {
  const existing = searchBackfillFlights.get(lease.generation);
  if (existing) return existing;

  const attempt = searchBackfillTail.then(() => runSearchTextBackfillPass(lease));
  searchBackfillTail = attempt.catch(() => undefined);
  searchBackfillFlights.set(lease.generation, attempt);
  const clear = (): void => {
    if (searchBackfillFlights.get(lease.generation) === attempt) {
      searchBackfillFlights.delete(lease.generation);
    }
  };
  void attempt.then(clear, clear);
  return attempt;
}
