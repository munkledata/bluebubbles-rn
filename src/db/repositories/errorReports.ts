import { sql } from 'drizzle-orm';
import { errorReports } from '../schema';
import type { AppDatabase } from '../types';

/**
 * Durable buffer for captured error reports awaiting upload to the server.
 *
 * Mirrors the outgoing-queue lease pattern (see `outgoing.ts`): rows are inserted by the capture
 * sink, atomically LEASED for an upload attempt (so two concurrent runners never double-upload),
 * DELETED on success, and marked with an exponential backoff on failure — retired once they hit
 * the attempt cap so a permanently un-uploadable report can't lease forever. Pure SQL (no RN),
 * so it runs in Node tests against better-sqlite3.
 */

/** Max upload attempts before a report is dropped (a server that never accepts it, etc.). */
export const ERROR_REPORT_MAX_ATTEMPTS = 5;
/** Keep the table bounded — the newest N rows survive a trim. */
const ERROR_REPORT_CAPACITY = 500;
/** Lease pushed onto a row while an upload attempt is in flight (prevents concurrent runners). */
const ERROR_REPORT_LEASE_MS = 120_000;

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

/** Insert a captured report, then trim the table back to its cap (oldest dropped). */
export async function insertErrorReport(db: AppDatabase, r: NewErrorReport): Promise<void> {
  await db.insert(errorReports).values({
    level: r.level,
    message: r.message,
    stack: r.stack ?? null,
    tag: r.tag ?? null,
    meta: r.meta ?? null,
    createdAt: r.createdAt,
  });
  await trimErrorReports(db);
}

/** Drop the oldest rows past the capacity cap (best-effort bound on table growth). */
export async function trimErrorReports(
  db: AppDatabase,
  capacity = ERROR_REPORT_CAPACITY,
): Promise<void> {
  await db.run(sql`
    DELETE FROM error_reports WHERE id NOT IN (
      SELECT id FROM error_reports ORDER BY id DESC LIMIT ${capacity}
    )`);
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

/** Reports eligible for an upload attempt: under the attempt cap and past their backoff. */
export async function listRetryableErrorReports(
  db: AppDatabase,
  now: number,
  limit = 100,
): Promise<RetryableErrorReport[]> {
  return db.all<RetryableErrorReport>(sql`
    SELECT id, level, message, stack, tag, meta, created_at AS createdAt, attempts
    FROM error_reports
    WHERE attempts < ${ERROR_REPORT_MAX_ATTEMPTS} AND next_retry_at <= ${now}
    ORDER BY created_at ASC
    LIMIT ${limit}`);
}

/**
 * Atomically lease rows for an upload attempt by pushing next_retry_at into the future. Exactly one
 * caller wins each row (the `next_retry_at <= now` guard); the rest skip. Returns the ids actually
 * claimed. Leases per-id (like `claimOutgoing`) so the proven single-row RETURNING pattern is reused
 * and an empty/oversized IN-list is never a concern.
 */
export async function claimErrorReports(
  db: AppDatabase,
  ids: number[],
  now: number,
): Promise<number[]> {
  const claimed: number[] = [];
  for (const id of ids) {
    const rows = await db.all<{ id: number }>(sql`
      UPDATE error_reports SET next_retry_at = ${now + ERROR_REPORT_LEASE_MS}
      WHERE id = ${id} AND next_retry_at <= ${now} RETURNING id`);
    if (rows.length > 0) claimed.push(id);
  }
  return claimed;
}

/** Bump attempts + schedule a backoff on the given rows; drop any that hit the attempt cap. */
export async function markErrorReportsFailed(
  db: AppDatabase,
  ids: number[],
  now: number,
): Promise<void> {
  for (const id of ids) {
    const cur = await db.all<{ attempts: number }>(
      sql`SELECT attempts FROM error_reports WHERE id = ${id} LIMIT 1`,
    );
    const attempts = (cur[0]?.attempts ?? 0) + 1;
    if (attempts >= ERROR_REPORT_MAX_ATTEMPTS) {
      await db.run(sql`DELETE FROM error_reports WHERE id = ${id}`);
    } else {
      await db.run(sql`
        UPDATE error_reports SET attempts = ${attempts}, next_retry_at = ${now + errorReportBackoffMs(attempts)}
        WHERE id = ${id}`);
    }
  }
}

/** Delete the given rows (after a successful upload). */
export async function deleteErrorReports(db: AppDatabase, ids: number[]): Promise<void> {
  for (const id of ids) {
    await db.run(sql`DELETE FROM error_reports WHERE id = ${id}`);
  }
}
