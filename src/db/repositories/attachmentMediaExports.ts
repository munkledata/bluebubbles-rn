import { sql } from 'drizzle-orm';
import { AUTO_IMAGE_MAX_BYTES } from '@utils/attachment';
import { utf8Encode } from '@utils/bytes';
import type { AppDatabase } from '../types';
import {
  runInTransactionContext,
  withDbTransaction,
  type DbCommitGuard,
  type DbTransactionContext,
} from '../transaction';
import { attachmentIsUserFileSql, messageHasVisibleContentSql } from './chatVisibility';

/** One automatic image export must not pin its app-cache source forever. */
export const ATTACHMENT_MEDIA_EXPORT_MAX_PENDING_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Keep a bounded completed/terminal receipt long enough to suppress ordinary replay. */
export const ATTACHMENT_MEDIA_EXPORT_TERMINAL_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Do not evict a fresh receipt solely to make room for more work. */
export const ATTACHMENT_MEDIA_EXPORT_TERMINAL_MIN_AGE_MS = 24 * 60 * 60 * 1000;
/** Pending copies are separately bounded from retained completion receipts. */
export const ATTACHMENT_MEDIA_EXPORT_PENDING_CAPACITY = 512;
/** Absolute encrypted receipt-table bound. */
export const ATTACHMENT_MEDIA_EXPORT_RECEIPT_CAPACITY = 2_000;
/** Attempts increment on claim, so process death consumes one of the three attempts. */
export const ATTACHMENT_MEDIA_EXPORT_MAX_ATTEMPTS = 3;
/** A crashed foreground owner becomes reclaimable without leaving an unbounded lease. */
export const ATTACHMENT_MEDIA_EXPORT_LEASE_MS = 2 * 60 * 1000;
/** One foreground activation performs only a small sequential amount of native work. */
export const ATTACHMENT_MEDIA_EXPORT_MAX_DRAIN = 8;

const ATTACHMENT_GUID_MAX_BYTES = 512;
const LEASE_TOKEN_MAX_BYTES = 128;

export type AttachmentMediaExportDestination = 'gallery' | 'album';
export type AttachmentMediaExportState = 'pending' | 'completed' | 'terminal';
export type AttachmentMediaExportClock = () => number;
export type AttachmentMediaExportFailureCode =
  'permission-denied' | 'source-missing' | 'native-error';

export type EnqueueAttachmentMediaExportResult =
  | { readonly status: 'enqueued'; readonly id: number }
  | {
      readonly status: 'duplicate';
      readonly id: number;
      readonly state: AttachmentMediaExportState;
      readonly destination: AttachmentMediaExportDestination;
    }
  | { readonly status: 'ineligible' }
  | { readonly status: 'capacity-rejected' };

export interface ClaimedAttachmentMediaExport {
  readonly id: number;
  readonly attachmentGuid: string;
  readonly destination: AttachmentMediaExportDestination;
  readonly localPath: string;
  readonly attempts: number;
  readonly claimVersion: number;
  readonly leaseToken: string;
  readonly leaseExpiresAt: number;
}

export interface AttachmentMediaExportClaimIdentity {
  readonly id: number;
  readonly claimVersion: number;
  readonly leaseToken: string;
}

export type FailAttachmentMediaExportResult =
  | { readonly status: 'stale' }
  | {
      readonly status: 'retry-scheduled';
      readonly attempts: number;
      readonly nextAttemptAt: number;
    }
  | { readonly status: 'terminal'; readonly attempts: number };

function utf8Bytes(value: string): number {
  return utf8Encode(value).byteLength;
}

function assertBoundedText(value: string, label: string, maxBytes: number): void {
  const bytes = utf8Bytes(value);
  if (bytes === 0 || bytes > maxBytes) {
    throw new RangeError(`${label} must be 1..${maxBytes} UTF-8 bytes`);
  }
}

function assertTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function sampleClock(clock: AttachmentMediaExportClock): number {
  const now = clock();
  assertTimestamp(now, 'attachment-media-export clock');
  return now;
}

function validateDestination(value: string): asserts value is AttachmentMediaExportDestination {
  if (value !== 'gallery' && value !== 'album') {
    throw new TypeError('attachment media export destination must be gallery or album');
  }
}

function validateLeaseToken(value: string): void {
  assertBoundedText(value, 'attachment media export lease token', LEASE_TOKEN_MAX_BYTES);
}

function validateClaimIdentity(claim: AttachmentMediaExportClaimIdentity): void {
  if (!Number.isSafeInteger(claim.id) || claim.id < 1) {
    throw new RangeError('attachment media export claim id must be a positive safe integer');
  }
  if (!Number.isSafeInteger(claim.claimVersion) || claim.claimVersion < 1) {
    throw new RangeError('attachment media export claim version must be a positive safe integer');
  }
  validateLeaseToken(claim.leaseToken);
}

/** 30s, 60s, 120s for the three bounded native attempts. */
export function attachmentMediaExportBackoffMs(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new RangeError('attachment media export attempt must be a positive safe integer');
  }
  return 30_000 * 2 ** Math.min(2, attempt - 1);
}

/**
 * Shared SQL predicate for both queue claims and cache-retirement protection.
 *
 * Aliases are fixed internal literals at every caller. Keeping this in the DB layer makes the
 * second retirement check byte-for-byte equivalent to the worker's owner eligibility without
 * exposing an arbitrary string-to-SQL identifier boundary.
 */
export function attachmentMediaExportOwnerEligibleSql() {
  return sql`a.hide_attachment = 0
    AND a.is_retracted = 0
    AND a.is_sticker = 0
    AND substr(a.mime_type, 1, 6) = 'image/'
    AND typeof(a.total_bytes) = 'integer'
    AND a.total_bytes BETWEEN 1 AND ${AUTO_IMAGE_MAX_BYTES}
    AND m.is_from_me = 0
    AND m.date_deleted IS NULL
    AND m.associated_message_type IS NULL
    AND ${attachmentIsUserFileSql('a', 'm')}
    AND ${messageHasVisibleContentSql('m')}
    AND (c.deleted_at IS NULL OR m.date_created > c.deleted_at)`;
}

/**
 * True while a valid pending receipt still owns its source, or while an already-admitted native
 * attempt retains an unexpired lease. SQLite's own wall clock keeps read-only cache snapshots from
 * needing a separate transaction merely to sample JavaScript time.
 */
export function attachmentMediaExportProtectsCacheSql() {
  const sqliteNowMs = sql`(CAST(strftime('%s', 'now') AS INTEGER) * 1000)`;
  return sql`ame.state = 'pending'
    AND (
      (ame.expires_at > ${sqliteNowMs}
       AND ame.attempts < ${ATTACHMENT_MEDIA_EXPORT_MAX_ATTEMPTS})
      OR ame.lease_expires_at > ${sqliteNowMs}
    )`;
}

function maintainAttachmentMediaExportsWithinTransaction(
  context: DbTransactionContext,
  now: number,
): Promise<void> {
  return runInTransactionContext(context, async (db) => {
    await db.run(sql`
      UPDATE attachment_media_exports
         SET state = 'terminal',
             next_attempt_at = 0,
             lease_token = NULL,
             lease_expires_at = 0,
             terminal_at = ${now},
             last_error_code = CASE
               WHEN expires_at <= ${now} THEN 'expired'
               ELSE 'attempt-cap'
             END
       WHERE state = 'pending'
         AND lease_expires_at <= ${now}
         AND (expires_at <= ${now} OR attempts >= ${ATTACHMENT_MEDIA_EXPORT_MAX_ATTEMPTS})`);

    await db.run(sql`
      UPDATE attachment_media_exports
         SET state = 'terminal',
             next_attempt_at = 0,
             lease_token = NULL,
             lease_expires_at = 0,
             terminal_at = ${now},
             last_error_code = 'ineligible'
       WHERE state = 'pending'
         AND lease_expires_at <= ${now}
         AND NOT EXISTS (
           SELECT 1
             FROM attachments a
             JOIN messages m ON m.id = a.message_id
             JOIN chats c ON c.id = m.chat_id
            WHERE a.guid = attachment_media_exports.attachment_guid
              AND ${attachmentMediaExportOwnerEligibleSql()}
         )`);

    const oldestAllowed = Math.max(0, now - ATTACHMENT_MEDIA_EXPORT_TERMINAL_MAX_AGE_MS);
    await db.run(sql`
      DELETE FROM attachment_media_exports
       WHERE state IN ('completed', 'terminal')
         AND terminal_at < ${oldestAllowed}`);

    const counts = await db.all<{ rows: number }>(
      sql`SELECT COUNT(*) AS rows FROM attachment_media_exports`,
    );
    const overflow = Math.max(0, (counts[0]?.rows ?? 0) - ATTACHMENT_MEDIA_EXPORT_RECEIPT_CAPACITY);
    if (overflow > 0) {
      await db.run(sql`
        DELETE FROM attachment_media_exports
         WHERE id IN (
           SELECT id
             FROM attachment_media_exports
            WHERE state IN ('completed', 'terminal')
              AND terminal_at <= ${Math.max(0, now - ATTACHMENT_MEDIA_EXPORT_TERMINAL_MIN_AGE_MS)}
            ORDER BY terminal_at ASC, id ASC
            LIMIT ${overflow}
         )`);
    }
  });
}

/**
 * Bounded foreground maintenance that does not require Photos permission or claim native work.
 * This keeps expired/ineligible rows from pinning app-cache files when permission remains denied.
 */
export function maintainAttachmentMediaExports(
  db: AppDatabase,
  guard: DbCommitGuard,
  clock: AttachmentMediaExportClock = Date.now,
): Promise<void> {
  return withDbTransaction(
    db,
    (context) => maintainAttachmentMediaExportsWithinTransaction(context, sampleClock(clock)),
    guard,
  );
}

function ensureReceiptSlotWithinTransaction(
  context: DbTransactionContext,
  now: number,
): Promise<boolean> {
  return runInTransactionContext(context, async (db) => {
    const counts = await db.all<{ rows: number }>(
      sql`SELECT COUNT(*) AS rows FROM attachment_media_exports`,
    );
    const occupied = counts[0]?.rows ?? 0;
    if (occupied < ATTACHMENT_MEDIA_EXPORT_RECEIPT_CAPACITY) return true;

    const slotsNeeded = occupied - ATTACHMENT_MEDIA_EXPORT_RECEIPT_CAPACITY + 1;
    await db.run(sql`
      DELETE FROM attachment_media_exports
       WHERE id IN (
         SELECT id
           FROM attachment_media_exports
          WHERE state IN ('completed', 'terminal')
            AND terminal_at <= ${Math.max(0, now - ATTACHMENT_MEDIA_EXPORT_TERMINAL_MIN_AGE_MS)}
          ORDER BY terminal_at ASC, id ASC
          LIMIT ${slotsNeeded}
       )`);
    const after = await db.all<{ rows: number }>(
      sql`SELECT COUNT(*) AS rows FROM attachment_media_exports`,
    );
    return (after[0]?.rows ?? 0) < ATTACHMENT_MEDIA_EXPORT_RECEIPT_CAPACITY;
  });
}

/**
 * Persist the destination-bound intent before an automatic native download begins.
 *
 * Existing terminal/completed rows are receipts, not work to rearm. A destination mismatch is
 * returned as a duplicate; settings changes delete pending rows transactionally before new work.
 */
export async function enqueueAttachmentMediaExport(
  db: AppDatabase,
  input: {
    readonly attachmentGuid: string;
    readonly destination: AttachmentMediaExportDestination;
  },
  guard: DbCommitGuard,
  clock: AttachmentMediaExportClock = Date.now,
): Promise<EnqueueAttachmentMediaExportResult> {
  assertBoundedText(
    input.attachmentGuid,
    'attachment media export attachmentGuid',
    ATTACHMENT_GUID_MAX_BYTES,
  );
  validateDestination(input.destination);

  return withDbTransaction(
    db,
    async (context) => {
      const now = sampleClock(clock);
      await maintainAttachmentMediaExportsWithinTransaction(context, now);
      const preliminary = await runInTransactionContext<EnqueueAttachmentMediaExportResult | null>(
        context,
        async (transactionDb) => {
          const existing = await transactionDb.all<{
            id: number;
            state: AttachmentMediaExportState;
            destination: AttachmentMediaExportDestination;
          }>(sql`
        SELECT id, state, destination
          FROM attachment_media_exports
         WHERE attachment_guid = ${input.attachmentGuid}
         LIMIT 1`);
          if (existing[0]) {
            return { status: 'duplicate', ...existing[0] };
          }

          const pending = await transactionDb.all<{ rows: number }>(sql`
        SELECT COUNT(*) AS rows
          FROM attachment_media_exports
         WHERE state = 'pending'`);
          if ((pending[0]?.rows ?? 0) >= ATTACHMENT_MEDIA_EXPORT_PENDING_CAPACITY) {
            return { status: 'capacity-rejected' };
          }
          return null;
        },
      );
      if (preliminary) return preliminary;
      if (!(await ensureReceiptSlotWithinTransaction(context, now))) {
        return { status: 'capacity-rejected' };
      }

      return runInTransactionContext(context, async (transactionDb) => {
        const expiresAt = now + ATTACHMENT_MEDIA_EXPORT_MAX_PENDING_AGE_MS;
        assertTimestamp(expiresAt, 'attachment media export expiry');
        const inserted = await transactionDb.all<{ id: number }>(sql`
        INSERT INTO attachment_media_exports (
          attachment_guid, destination, created_at, expires_at
        )
        SELECT a.guid, ${input.destination}, ${now}, ${expiresAt}
          FROM attachments a
          JOIN messages m ON m.id = a.message_id
          JOIN chats c ON c.id = m.chat_id
         WHERE a.guid = ${input.attachmentGuid}
           AND ${attachmentMediaExportOwnerEligibleSql()}
        ON CONFLICT(attachment_guid) DO NOTHING
        RETURNING id`);
        if (inserted[0]) return { status: 'enqueued', id: inserted[0].id };

        const raced = await transactionDb.all<{
          id: number;
          state: AttachmentMediaExportState;
          destination: AttachmentMediaExportDestination;
        }>(sql`
        SELECT id, state, destination
          FROM attachment_media_exports
         WHERE attachment_guid = ${input.attachmentGuid}
         LIMIT 1`);
        return raced[0] ? { status: 'duplicate', ...raced[0] } : { status: 'ineligible' };
      });
    },
    guard,
  );
}

/**
 * Claim one due receipt. Passing attachmentGuid targets the just-downloaded image; omitting it
 * drains the oldest eligible foreground work.
 */
export async function claimNextAttachmentMediaExport(
  db: AppDatabase,
  options: {
    readonly leaseToken: string;
    readonly attachmentGuid?: string;
    readonly destination?: AttachmentMediaExportDestination;
    readonly clock?: AttachmentMediaExportClock;
  },
  guard: DbCommitGuard,
): Promise<ClaimedAttachmentMediaExport | null> {
  validateLeaseToken(options.leaseToken);
  if (options.attachmentGuid !== undefined) {
    assertBoundedText(
      options.attachmentGuid,
      'attachment media export attachmentGuid',
      ATTACHMENT_GUID_MAX_BYTES,
    );
  }
  if (options.destination !== undefined) validateDestination(options.destination);
  const clock = options.clock ?? Date.now;
  return withDbTransaction(
    db,
    async (context) => {
      const now = sampleClock(clock);
      const leaseExpiresAt = now + ATTACHMENT_MEDIA_EXPORT_LEASE_MS;
      assertTimestamp(leaseExpiresAt, 'attachment media export lease expiry');
      await maintainAttachmentMediaExportsWithinTransaction(context, now);
      return runInTransactionContext(context, async (transactionDb) => {
        const guidFilter =
          options.attachmentGuid === undefined
            ? sql``
            : sql`AND q.attachment_guid = ${options.attachmentGuid}`;
        const destinationFilter =
          options.destination === undefined
            ? sql``
            : sql`AND q.destination = ${options.destination}`;
        const claimedRows = await transactionDb.all<{ id: number }>(sql`
        WITH due AS (
          SELECT q.id
            FROM attachment_media_exports q
            JOIN attachments a ON a.guid = q.attachment_guid
            JOIN messages m ON m.id = a.message_id
            JOIN chats c ON c.id = m.chat_id
            JOIN attachment_cache_entries e ON e.path = a.local_path AND e.state = 'active'
           WHERE q.state = 'pending'
             AND q.attempts < ${ATTACHMENT_MEDIA_EXPORT_MAX_ATTEMPTS}
             AND q.expires_at > ${now}
             AND q.next_attempt_at <= ${now}
             AND q.lease_expires_at <= ${now}
             AND a.local_path IS NOT NULL
             AND ${attachmentMediaExportOwnerEligibleSql()}
             ${guidFilter}
             ${destinationFilter}
           ORDER BY q.created_at ASC, q.id ASC
           LIMIT 1
        )
        UPDATE attachment_media_exports
           SET attempts = attempts + 1,
               claim_version = claim_version + 1,
               lease_token = ${options.leaseToken},
               lease_expires_at = ${leaseExpiresAt}
         WHERE id = (SELECT id FROM due)
        RETURNING id`);
        const id = claimedRows[0]?.id;
        if (id == null) return null;
        const claimed = await transactionDb.all<ClaimedAttachmentMediaExport>(sql`
        SELECT q.id,
               q.attachment_guid AS attachmentGuid,
               q.destination,
               a.local_path AS localPath,
               q.attempts,
               q.claim_version AS claimVersion,
               q.lease_token AS leaseToken,
               q.lease_expires_at AS leaseExpiresAt
          FROM attachment_media_exports q
          JOIN attachments a ON a.guid = q.attachment_guid
         WHERE q.id = ${id}
           AND q.state = 'pending'
           AND q.lease_token = ${options.leaseToken}
         LIMIT 1`);
        if (!claimed[0]) {
          throw new Error('attachment media export claim disappeared inside its transaction');
        }
        return claimed[0];
      });
    },
    guard,
  );
}

/** Mark the exact leased receipt complete after MediaStore reports success. */
export async function completeAttachmentMediaExport(
  db: AppDatabase,
  claim: AttachmentMediaExportClaimIdentity,
  guard: DbCommitGuard,
  clock: AttachmentMediaExportClock = Date.now,
): Promise<boolean> {
  validateClaimIdentity(claim);
  return withDbTransaction(
    db,
    (context) =>
      runInTransactionContext(context, async (transactionDb) => {
        const now = sampleClock(clock);
        const rows = await transactionDb.all<{ id: number }>(sql`
        UPDATE attachment_media_exports
           SET state = 'completed',
               next_attempt_at = 0,
               lease_token = NULL,
               lease_expires_at = 0,
               terminal_at = ${now},
               last_error_code = NULL
         WHERE id = ${claim.id}
           AND state = 'pending'
           AND claim_version = ${claim.claimVersion}
           AND lease_token = ${claim.leaseToken}
        RETURNING id`);
        return rows.length === 1;
      }),
    guard,
  );
}

/** Schedule or terminalize one exact failed native attempt. */
export async function failAttachmentMediaExport(
  db: AppDatabase,
  claim: AttachmentMediaExportClaimIdentity,
  failureCode: AttachmentMediaExportFailureCode,
  guard: DbCommitGuard,
  clock: AttachmentMediaExportClock = Date.now,
): Promise<FailAttachmentMediaExportResult> {
  validateClaimIdentity(claim);
  return withDbTransaction(
    db,
    (context) =>
      runInTransactionContext(context, async (transactionDb) => {
        const now = sampleClock(clock);
        const rows = await transactionDb.all<{ attempts: number; expiresAt: number }>(sql`
        SELECT attempts, expires_at AS expiresAt
          FROM attachment_media_exports
         WHERE id = ${claim.id}
           AND state = 'pending'
           AND claim_version = ${claim.claimVersion}
           AND lease_token = ${claim.leaseToken}
         LIMIT 1`);
        const row = rows[0];
        if (!row) return { status: 'stale' };
        const terminal =
          row.attempts >= ATTACHMENT_MEDIA_EXPORT_MAX_ATTEMPTS || row.expiresAt <= now;
        const nextAttemptAt = terminal ? 0 : now + attachmentMediaExportBackoffMs(row.attempts);
        assertTimestamp(nextAttemptAt, 'attachment media export next attempt');
        const updated = await transactionDb.all<{ id: number }>(sql`
        UPDATE attachment_media_exports
           SET state = ${terminal ? 'terminal' : 'pending'},
               next_attempt_at = ${nextAttemptAt},
               lease_token = NULL,
               lease_expires_at = 0,
               terminal_at = ${terminal ? now : null},
               last_error_code = ${failureCode}
         WHERE id = ${claim.id}
           AND state = 'pending'
           AND claim_version = ${claim.claimVersion}
           AND lease_token = ${claim.leaseToken}
        RETURNING id`);
        if (updated.length !== 1) return { status: 'stale' };
        return terminal
          ? { status: 'terminal', attempts: row.attempts }
          : { status: 'retry-scheduled', attempts: row.attempts, nextAttemptAt };
      }),
    guard,
  );
}

/** Explicit policy revocation: old pending work must not revive after a value round-trip. */
export function cancelPendingAttachmentMediaExportsWithinTransaction(
  context: DbTransactionContext,
): Promise<number> {
  return runInTransactionContext(context, async (db) => {
    const rows = await db.all<{ id: number }>(
      sql`DELETE FROM attachment_media_exports WHERE state = 'pending' RETURNING id`,
    );
    return rows.length;
  });
}
