import type { HttpClient } from '@core/api/http';
import { uploadErrorReports, type ErrorReportBatch } from '@core/api/endpoints/errorReports';
import { logger } from '@core/secure';
import {
  claimErrorReports,
  deleteErrorReports,
  listRetryableErrorReports,
  markErrorReportsFailed,
  type RetryableErrorReport,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';

/** This device's constant context, hoisted onto the batch envelope for server-side bucketing. */
export interface ClientContext {
  appVersion?: string;
  platform?: string;
  osVersion?: string;
  deviceModel?: string;
}

const UPLOAD_BATCH_SIZE = 100;

// Keep each field within the server's per-field Zod bounds so a legitimately huge stack/message is
// TRUNCATED here rather than bouncing the whole batch with a 400 (which would retry → retire → lose it).
const MAX_MESSAGE = 4000;
const MAX_STACK = 20000;
const MAX_META = 8000;
const cap = (s: string | null, n: number): string | undefined =>
  s == null ? undefined : s.length > n ? s.slice(0, n) : s;

function buildBatch(rows: RetryableErrorReport[], ctx: ClientContext): ErrorReportBatch {
  return {
    reports: rows.map((r) => ({
      level: r.level,
      message: r.message.length > MAX_MESSAGE ? r.message.slice(0, MAX_MESSAGE) : r.message,
      stack: cap(r.stack, MAX_STACK),
      tag: cap(r.tag, 200),
      timestamp: r.createdAt,
      meta: cap(r.meta, MAX_META),
    })),
    appVersion: ctx.appVersion,
    platform: ctx.platform,
    osVersion: ctx.osVersion,
    deviceModel: ctx.deviceModel,
  };
}

/**
 * Upload one batch of buffered error reports to the server. The durable queue owns retries (the POST
 * itself never retries): each eligible row is atomically LEASED (`claimErrorReports`) so two
 * concurrent runners never double-upload, then DELETED on success or marked with a backoff on
 * failure (retired at the attempt cap). Pure orchestration (no RN imports) → runs in Node tests.
 * Failures log at WARN with an `[errorReport]` tag, which the capture sink skips — so a failed
 * upload can never enqueue another report.
 */
export async function runErrorReportQueue(
  db: AppDatabase,
  http: HttpClient,
  now: number = Date.now(),
  ctx: ClientContext = {},
): Promise<{ eligible: number; uploaded: number }> {
  const rows = await listRetryableErrorReports(db, now, UPLOAD_BATCH_SIZE);
  if (rows.length === 0) return { eligible: 0, uploaded: 0 };
  const claimed = await claimErrorReports(
    db,
    rows.map((r) => r.id),
    now,
  );
  if (claimed.length === 0) return { eligible: rows.length, uploaded: 0 };
  const claimedSet = new Set(claimed);
  const claimedRows = rows.filter((r) => claimedSet.has(r.id));
  try {
    const ack = await uploadErrorReports(http, buildBatch(claimedRows, ctx));
    if (ack.disabled) {
      // Server ingestion is (now) off — leave the leased rows to expire and wait for the capability
      // to return, rather than burn attempts against a server that's rejecting everything.
      return { eligible: rows.length, uploaded: 0 };
    }
    await deleteErrorReports(db, claimed);
    return { eligible: rows.length, uploaded: claimedRows.length };
  } catch (e) {
    await markErrorReportsFailed(db, claimed, now);
    logger.warn('[errorReport] upload failed', e);
    return { eligible: rows.length, uploaded: 0 };
  }
}
