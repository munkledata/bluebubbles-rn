import { sql } from 'drizzle-orm';
import { errorReports } from '../schema';
import {
  runInTransactionContext,
  withDbTransaction,
  type DbCommitGuard,
  type DbTransactionContext,
} from '../transaction';
import type { AppDatabase } from '../types';

/**
 * Durable buffer for captured error reports awaiting upload to the server.
 *
 * Mirrors the outgoing-queue lease pattern (see `outgoingRetry.ts`): rows are inserted by the capture
 * sink, atomically LEASED for an upload attempt (so two concurrent runners never double-upload),
 * DELETED on success, and marked with an exponential backoff on failure — retired once they hit
 * the attempt cap so a permanently un-uploadable report can't lease forever. Pure SQL (no RN),
 * so it runs in Node tests against better-sqlite3.
 */

/** Max upload attempts before a report is dropped (a server that never accepts it, etc.). */
export const ERROR_REPORT_MAX_ATTEMPTS = 5;
/** Keep the table bounded — the newest N rows survive a trim. */
export const ERROR_REPORT_CAPACITY = 500;
/** Maximum unique rows in one upload outcome; keeps every statement below SQLite's bind limit. */
export const ERROR_REPORT_UPLOAD_BATCH_SIZE = 100;
/** Diagnostics older than seven days are no longer actionable and are deleted locally. */
export const ERROR_REPORT_MAX_DURABLE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Maximum conservative serialized size of the encrypted durable queue (2 MiB).
 *
 * SQLite counts persisted UTF-8 bytes without materializing rows in JS. Each text byte is charged
 * at six bytes (the worst JSON escape expansion, e.g. a control character -> `\u0000`) plus fixed
 * per-object syntax, so the real JSON upload representation cannot exceed this budget.
 */
export const ERROR_REPORT_QUEUE_BYTE_BUDGET = 2 * 1024 * 1024;
export const ERROR_REPORT_SERIALIZED_ROW_OVERHEAD_BYTES = 256;
export const ERROR_REPORT_TEXT_ESCAPE_MULTIPLIER = 6;
/** 100 rows × 6 bound columns stays below Android SQLite's conservative 999-variable limit. */
const ERROR_REPORT_INSERT_BATCH_SIZE = 100;
/** Lease pushed onto a row while an upload attempt is in flight (prevents concurrent runners). */
const ERROR_REPORT_LEASE_MS = 120_000;

export type ErrorReportClock = () => number;

function sampleErrorReportClock(clock: ErrorReportClock): number {
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new RangeError('error-report clock must return a non-negative safe integer');
  }
  return now;
}

function boundedErrorReportIds(ids: number[]): number[] {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length > ERROR_REPORT_UPLOAD_BATCH_SIZE) {
    throw new RangeError(
      `error-report outcome batch exceeds ${ERROR_REPORT_UPLOAD_BATCH_SIZE} unique ids`,
    );
  }
  return uniqueIds;
}

/** Exponential backoff for attempt N (1-based): 30s, 60s, 120s, 240s, 480s — capped at 1h. */
export function errorReportBackoffMs(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 3_600_000);
}

export interface NewErrorReport {
  level: string;
  message: string;
  stack?: string | null;
  tag?: string | null;
  meta?: string | null;
  createdAt: number;
}

/**
 * Insert a bounded batch, then enforce the queue's item, age, attempt, and byte limits.
 *
 * TRANSACTION-ONLY: the error sink calls this inside its generation-guarded batch transaction.
 * Ordinary repository callers must use {@link insertErrorReports}, which owns the shared lock.
 */
export async function insertErrorReportsWithinTransaction(
  context: DbTransactionContext,
  reports: NewErrorReport[],
  now = Date.now(),
): Promise<void> {
  await runInTransactionContext(context, async (db) => {
    if (reports.length === 0) return;
    // Earlier entries in an oversized caller batch cannot survive the item cap. Skip them without
    // copying the array, bounding one invocation to five <=100-row INSERTs plus one trim.
    const firstRetainableIndex = Math.max(0, reports.length - ERROR_REPORT_CAPACITY);
    for (
      let offset = firstRetainableIndex;
      offset < reports.length;
      offset += ERROR_REPORT_INSERT_BATCH_SIZE
    ) {
      const chunk = reports.slice(offset, offset + ERROR_REPORT_INSERT_BATCH_SIZE);
      await db.insert(errorReports).values(
        chunk.map((r) => ({
          level: r.level,
          message: r.message,
          stack: r.stack ?? null,
          tag: r.tag ?? null,
          meta: r.meta ?? null,
          createdAt: r.createdAt,
        })),
      );
    }
    await trimErrorReportsWithinTransaction(context, ERROR_REPORT_CAPACITY, now);
  });
}

/** Insert a bounded batch in one owned transaction. Never wrap this public helper in another one. */
export async function insertErrorReports(
  db: AppDatabase,
  reports: NewErrorReport[],
  now = Date.now(),
): Promise<void> {
  if (reports.length === 0) return;
  await withDbTransaction(db, (context) =>
    insertErrorReportsWithinTransaction(context, reports, now),
  );
}

/** Insert one captured report. Kept for repository callers that do not already hold a batch. */
export async function insertErrorReport(
  db: AppDatabase,
  r: NewErrorReport,
  now = Date.now(),
): Promise<void> {
  await insertErrorReports(db, [r], now);
}

/**
 * Retain only the newest rows that satisfy all three durable bounds: item count, maximum age, and
 * aggregate conservative serialized bytes.
 *
 * One windowed DELETE performs the accounting inside SQLite. The queue is normally <=500 rows and
 * no report bodies cross the JS boundary, including when cleaning an oversized legacy table.
 * `now` is optional only for item-cap maintenance callers; production writes/reads always supply it.
 */
async function trimErrorReportsWithinTransaction(
  context: DbTransactionContext,
  capacity = ERROR_REPORT_CAPACITY,
  now?: number,
  byteBudget = ERROR_REPORT_QUEUE_BYTE_BUDGET,
): Promise<void> {
  await runInTransactionContext(context, async (db) => {
    const boundedCapacity = Math.max(0, Math.floor(capacity));
    const boundedByteBudget = Math.max(0, Math.floor(byteBudget));
    const oldestAllowed =
      now == null ? Number.MIN_SAFE_INTEGER : Math.floor(now) - ERROR_REPORT_MAX_DURABLE_AGE_MS;
    await db.run(sql`
      WITH ranked_reports AS (
        SELECT
          id,
          ROW_NUMBER() OVER (ORDER BY id DESC) AS newest_rank,
          SUM(
            ${ERROR_REPORT_SERIALIZED_ROW_OVERHEAD_BYTES} +
            ${ERROR_REPORT_TEXT_ESCAPE_MULTIPLIER} * (
              length(CAST(level AS BLOB)) +
              length(CAST(message AS BLOB)) +
              COALESCE(length(CAST(stack AS BLOB)), 0) +
              COALESCE(length(CAST(tag AS BLOB)), 0) +
              COALESCE(length(CAST(meta AS BLOB)), 0)
            )
          ) OVER (
            ORDER BY id DESC
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) AS cumulative_serialized_bytes
        FROM error_reports
        WHERE created_at >= ${oldestAllowed}
          AND attempts < ${ERROR_REPORT_MAX_ATTEMPTS}
      ), retained_reports AS (
        SELECT id
        FROM ranked_reports
        WHERE newest_rank <= ${boundedCapacity}
          AND cumulative_serialized_bytes <= ${boundedByteBudget}
      )
      DELETE FROM error_reports
      WHERE id NOT IN (SELECT id FROM retained_reports)`);
  });
}

/** Enforce all durable queue bounds in one owned transaction. Never call from another transaction. */
export async function trimErrorReports(
  db: AppDatabase,
  capacity = ERROR_REPORT_CAPACITY,
  now?: number,
  byteBudget = ERROR_REPORT_QUEUE_BYTE_BUDGET,
): Promise<void> {
  await withDbTransaction(db, (context) =>
    trimErrorReportsWithinTransaction(context, capacity, now, byteBudget),
  );
}

/**
 * Purge every queued diagnostic after consent is withdrawn.
 *
 * Own the shared write lock for this single bounded statement so it cannot silently join and be
 * resurrected by another writer's rollback. The uploader re-checks consent before every outcome
 * mutation, so no aborted request can recreate or advance a row after this returns.
 */
export async function clearErrorReports(
  db: AppDatabase,
  commitGuard?: DbCommitGuard,
): Promise<void> {
  await withDbTransaction(
    db,
    (context) => clearErrorReportsWithinTransaction(context),
    commitGuard,
  );
}

/** Delete the queue inside the caller's exact consent/revocation transaction. */
export async function clearErrorReportsWithinTransaction(
  context: DbTransactionContext,
): Promise<void> {
  await runInTransactionContext(context, async (db) => {
    await db.run(sql`DELETE FROM error_reports`);
  });
}

export interface RetryableErrorReport {
  id: number;
  level: string;
  message: string;
  stack: string | null;
  tag: string | null;
  meta: string | null;
  createdAt: number;
  attempts: number;
}

/** Transaction-only cleanup plus selection of reports eligible for one upload attempt. */
export function listRetryableErrorReportsWithinTransaction(
  context: DbTransactionContext,
  clock: ErrorReportClock = Date.now,
  limit = ERROR_REPORT_UPLOAD_BATCH_SIZE,
): Promise<RetryableErrorReport[]> {
  return runInTransactionContext(context, async (db) => {
    const now = sampleErrorReportClock(clock);
    await trimErrorReportsWithinTransaction(context, ERROR_REPORT_CAPACITY, now);
    return db.all<RetryableErrorReport>(sql`
      SELECT id, level, message, stack, tag, meta, created_at AS createdAt, attempts
      FROM error_reports
      WHERE attempts < ${ERROR_REPORT_MAX_ATTEMPTS}
        AND created_at >= ${now - ERROR_REPORT_MAX_DURABLE_AGE_MS}
        AND next_retry_at <= ${now}
      ORDER BY created_at ASC
      LIMIT ${limit}`);
  });
}

/** Reports eligible for an upload attempt: under the attempt cap and past their backoff. */
export async function listRetryableErrorReports(
  db: AppDatabase,
  clock: ErrorReportClock = Date.now,
  limit = ERROR_REPORT_UPLOAD_BATCH_SIZE,
  commitGuard?: DbCommitGuard,
): Promise<RetryableErrorReport[]> {
  // Reads are also a cleanup boundary, so a quiet app with no newly captured errors still retires
  // old/legacy rows before any upload claim is assembled. Own a short transaction here: a naked
  // DELETE could silently join an error-sink transaction already open on the shared connection and
  // be undone by its rollback. Callers must therefore never invoke this helper inside a transaction.
  return withDbTransaction(
    db,
    (context) => listRetryableErrorReportsWithinTransaction(context, clock, limit),
    commitGuard,
  );
}

/** Transaction-only lease claim for one bounded upload batch. */
export function claimErrorReportsWithinTransaction(
  context: DbTransactionContext,
  ids: number[],
  clock: ErrorReportClock = Date.now,
): Promise<number[]> {
  return runInTransactionContext(context, async (db) => {
    const uniqueIds = boundedErrorReportIds(ids);
    if (uniqueIds.length === 0) return [];
    const inList = sql.join(
      uniqueIds.map((id) => sql`${id}`),
      sql`, `,
    );
    // Sample only after this writer owns the shared connection. A value captured before a long
    // queue wait can make the two-minute lease already expired at the instant it commits.
    const now = clock();
    const rows = await db.all<{ id: number }>(sql`
      UPDATE error_reports SET next_retry_at = ${now + ERROR_REPORT_LEASE_MS}
      WHERE id IN (${inList}) AND next_retry_at <= ${now} RETURNING id`);
    return rows.map((row: { id: number }) => row.id);
  });
}

/**
 * Atomically lease rows for an upload attempt by pushing next_retry_at into the future. Exactly one
 * caller wins each row (the `next_retry_at <= now` guard); the rest skip. Returns the ids actually
 * claimed. The uploader supplies at most 100 ids and claims them with one bounded
 * `IN (...) RETURNING` statement, keeping the transaction short. The optional guard revokes an
 * account-scoped commit; it never decides whether this public writer takes the shared DB queue.
 */
export async function claimErrorReports(
  db: AppDatabase,
  ids: number[],
  clock: ErrorReportClock = Date.now,
  commitGuard?: DbCommitGuard,
): Promise<number[]> {
  const uniqueIds = boundedErrorReportIds(ids);
  if (uniqueIds.length === 0) return [];
  return withDbTransaction(
    db,
    (context) => claimErrorReportsWithinTransaction(context, uniqueIds, clock),
    commitGuard,
  );
}

/** Transaction-only failed-attempt settlement for one bounded upload batch. */
export function markErrorReportsFailedWithinTransaction(
  context: DbTransactionContext,
  ids: number[],
  clock: ErrorReportClock = Date.now,
): Promise<void> {
  return runInTransactionContext(context, async (db) => {
    const uniqueIds = boundedErrorReportIds(ids);
    if (uniqueIds.length === 0) return;
    const inList = sql.join(
      uniqueIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const now = sampleErrorReportClock(clock);
    // The uploader batch is <=100 ids. Advance it in one bounded UPDATE and retire capped rows
    // in one DELETE, keeping the process-wide mutex to two statements rather than up to 200
    // encrypted round-trips.
    await db.run(sql`
      UPDATE error_reports
      SET attempts = attempts + 1,
          next_retry_at = ${now} + CASE attempts + 1
            WHEN 1 THEN 30000
            WHEN 2 THEN 60000
            WHEN 3 THEN 120000
            WHEN 4 THEN 240000
            ELSE 480000
          END
      WHERE id IN (${inList})`);
    await db.run(sql`
      DELETE FROM error_reports
      WHERE id IN (${inList}) AND attempts >= ${ERROR_REPORT_MAX_ATTEMPTS}`);
  });
}

/**
 * Bump attempts + schedule a backoff on the given rows; drop any that hit the attempt cap.
 * IDs are set-like: duplicates still represent one failed upload attempt, and missing rows are
 * ignored.
 */
export async function markErrorReportsFailed(
  db: AppDatabase,
  ids: number[],
  clock: ErrorReportClock = Date.now,
  commitGuard?: DbCommitGuard,
): Promise<void> {
  const uniqueIds = boundedErrorReportIds(ids);
  if (uniqueIds.length === 0) return;
  await withDbTransaction(
    db,
    (context) => markErrorReportsFailedWithinTransaction(context, uniqueIds, clock),
    commitGuard,
  );
}

/** Transaction-only successful deletion for one bounded upload batch. */
export function deleteErrorReportsWithinTransaction(
  context: DbTransactionContext,
  ids: number[],
): Promise<void> {
  return runInTransactionContext(context, async (db) => {
    const uniqueIds = boundedErrorReportIds(ids);
    if (uniqueIds.length === 0) return;
    const inList = sql.join(
      uniqueIds.map((id) => sql`${id}`),
      sql`, `,
    );
    await db.run(sql`DELETE FROM error_reports WHERE id IN (${inList})`);
  });
}

/** Delete the given rows (after a successful upload). */
export async function deleteErrorReports(
  db: AppDatabase,
  ids: number[],
  commitGuard?: DbCommitGuard,
): Promise<void> {
  const uniqueIds = boundedErrorReportIds(ids);
  if (uniqueIds.length === 0) return;
  await withDbTransaction(
    db,
    (context) => deleteErrorReportsWithinTransaction(context, uniqueIds),
    commitGuard,
  );
}
