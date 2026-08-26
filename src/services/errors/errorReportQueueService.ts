import type { HttpClient } from '@core/api/http';
import { uploadErrorReports, type ErrorReportBatch } from '@core/api/endpoints/errorReports';
import {
  logger,
  projectErrorReportClientContext,
  projectErrorReportTimestamp,
  projectStoredErrorReport,
} from '@core/secure';
import {
  claimErrorReportsWithinTransaction,
  deleteErrorReportsWithinTransaction,
  listRetryableErrorReportsWithinTransaction,
  markErrorReportsFailedWithinTransaction,
  type RetryableErrorReport,
} from '@db/repositories';
import { DbCommitGuardRejectedError, withDbTransaction, type DbCommitGuard } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import {
  runTrackedRealtimeWork,
  type RealtimeDeliveryLease,
} from '../realtime/deliveryCoordinator';

/** This device's privacy-safe constant context, retained with the server's diagnostic sample. */
export interface ClientContext {
  appVersion?: string;
  platform?: string;
  osVersion?: string;
}

/** Live consent/cancellation policy supplied by the app-facing reporting coordinator. */
export interface ErrorReportRunPolicy {
  isUploadAllowed: () => boolean;
  signal?: AbortSignal;
}

const UPLOAD_BATCH_SIZE = 100;
const EMPTY_RESULT = { eligible: 0, uploaded: 0 } as const;

function buildBatch(
  rows: RetryableErrorReport[],
  ctx: ClientContext,
  now: number,
): ErrorReportBatch {
  const safeContext = projectErrorReportClientContext(ctx);
  const safeUploadTime = projectErrorReportTimestamp(now);
  return {
    reports: rows.map((r) => {
      // Rows can survive an app upgrade, so the durable queue may contain arbitrary fields written
      // under an older policy. Rebuild the allowlisted envelope rather than trusting/redacting it.
      const safe = projectStoredErrorReport(r);
      const capturedAt = projectErrorReportTimestamp(r.createdAt);
      // A corrupt/legacy timestamp must not create a misleading 1970 issue on the server. Prefer
      // its rounded capture minute, then fall back to this upload's rounded clock bucket.
      return { ...safe, timestamp: capturedAt || safeUploadTime };
    }),
    ...safeContext,
  };
}

const accountIsCurrent = (lease?: RealtimeDeliveryLease): boolean => !lease || lease.isCurrent();
const policyAllowsUpload = (policy?: ErrorReportRunPolicy): boolean =>
  !policy || (!policy.signal?.aborted && policy.isUploadAllowed());

/** Admit one bounded DB mutation and provide its repository transaction a last-moment guard. */
async function runAccountCommit(
  lease: RealtimeDeliveryLease | undefined,
  policy: ErrorReportRunPolicy | undefined,
  task: (commitGuard?: DbCommitGuard) => Promise<unknown>,
): Promise<boolean> {
  if (!lease && !policy) {
    await task();
    return true;
  }
  const commitStillAllowed = (): boolean => accountIsCurrent(lease) && policyAllowsUpload(policy);
  try {
    if (!lease) {
      if (!commitStillAllowed()) return false;
      await task(commitStillAllowed);
      return true;
    }
    return (await runTrackedRealtimeWork(lease, () => task(commitStillAllowed))) === 'delivered';
  } catch (error) {
    if (error instanceof DbCommitGuardRejectedError) return false;
    throw error;
  }
}

async function runQueueBody(
  db: AppDatabase,
  http: HttpClient,
  now: number,
  ctx: ClientContext,
  accountLease?: RealtimeDeliveryLease,
  policy?: ErrorReportRunPolicy,
): Promise<{ eligible: number; uploaded: number }> {
  if (!accountIsCurrent(accountLease) || !policyAllowsUpload(policy)) return EMPTY_RESULT;
  let rows: RetryableErrorReport[];
  try {
    rows = await withDbTransaction(
      db,
      (context) => listRetryableErrorReportsWithinTransaction(context, Date.now, UPLOAD_BATCH_SIZE),
      accountLease || policy
        ? () => accountIsCurrent(accountLease) && policyAllowsUpload(policy)
        : undefined,
    );
  } catch (error) {
    if (error instanceof DbCommitGuardRejectedError) return EMPTY_RESULT;
    throw error;
  }
  if (!accountIsCurrent(accountLease) || !policyAllowsUpload(policy)) {
    return { eligible: rows.length, uploaded: 0 };
  }
  if (rows.length === 0) return EMPTY_RESULT;
  let claimed: number[] = [];
  const claimCommitted = await runAccountCommit(accountLease, policy, async (guard) => {
    claimed = await withDbTransaction(
      db,
      (context) =>
        claimErrorReportsWithinTransaction(
          context,
          rows.map((r) => r.id),
          Date.now,
        ),
      guard,
    );
  });
  if (!claimCommitted || claimed.length === 0) return { eligible: rows.length, uploaded: 0 };
  const claimedSet = new Set(claimed);
  const claimedRows = rows.filter((r) => claimedSet.has(r.id));
  try {
    // Keep this check and call in the SAME synchronous turn. HttpClient snapshots origin, password,
    // auth mode, query, and headers before `post()` returns its promise, so an A-account operation
    // can never cross a pre-POST await and snapshot B after Disconnect + reconnect.
    if (!accountIsCurrent(accountLease) || !policyAllowsUpload(policy)) {
      return { eligible: rows.length, uploaded: 0 };
    }
    const upload = uploadErrorReports(http, buildBatch(claimedRows, ctx, now), policy?.signal);
    const ack = await upload;
    if (!accountIsCurrent(accountLease) || !policyAllowsUpload(policy)) {
      return { eligible: rows.length, uploaded: 0 };
    }
    if (ack.disabled) {
      // Server ingestion is (now) off — leave the leased rows to expire and wait for the capability
      // to return, rather than burn attempts against a server that's rejecting everything.
      return { eligible: rows.length, uploaded: 0 };
    }
    if (ack.ingested !== claimedRows.length) {
      // The server's store is best-effort and can acknowledge only part of a batch after an
      // internal file/per-report failure. It does not identify which rows won, so deleting any
      // local row would risk silent loss. Retry the whole bounded batch; duplicate aggregation is
      // safer than discarding an unacknowledged report.
      throw new Error('error report batch was not fully ingested');
    }
    const deleted = await runAccountCommit(accountLease, policy, (guard) =>
      withDbTransaction(
        db,
        (context) => deleteErrorReportsWithinTransaction(context, claimed),
        guard,
      ),
    );
    return {
      eligible: rows.length,
      uploaded: deleted ? claimedRows.length : 0,
    };
  } catch (e) {
    // A response/failure that returns after teardown belongs to A. Do not mutate B's newly opened
    // database or log an A transport failure into B's diagnostics ring.
    if (!accountIsCurrent(accountLease) || !policyAllowsUpload(policy)) {
      return { eligible: rows.length, uploaded: 0 };
    }
    const marked = await runAccountCommit(accountLease, policy, (guard) =>
      withDbTransaction(
        db,
        (context) => markErrorReportsFailedWithinTransaction(context, claimed, Date.now),
        guard,
      ),
    );
    if (marked) logger.warn('[errorReport] upload failed', e);
    return { eligible: rows.length, uploaded: 0 };
  }
}

/**
 * Upload one batch of buffered error reports to the server. The durable queue owns retries (the POST
 * itself never retries): each eligible row is atomically LEASED (`claimErrorReports`) so two
 * concurrent runners never double-upload, then DELETED on success or marked with a backoff on
 * failure (retired at the attempt cap). Pure orchestration (no RN imports) → runs in Node tests.
 * Failures log at WARN, while the report sink captures ERROR only, so a failed upload cannot
 * enqueue another report.
 */
export async function runErrorReportQueue(
  db: AppDatabase,
  http: HttpClient,
  now: number = Date.now(),
  ctx: ClientContext = {},
  accountLease?: RealtimeDeliveryLease,
  policy?: ErrorReportRunPolicy,
): Promise<{ eligible: number; uploaded: number }> {
  if (!accountLease) return runQueueBody(db, http, now, ctx, undefined, policy);
  let result: { eligible: number; uploaded: number } = EMPTY_RESULT;
  const status = await runTrackedRealtimeWork(accountLease, async () => {
    result = await runQueueBody(db, http, now, ctx, accountLease, policy);
  });
  return status === 'delivered' ? result : EMPTY_RESULT;
}
