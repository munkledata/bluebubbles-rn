import { DELETED_MESSAGE_PAGE_LIMIT, type DeletedMessage } from '@core/api/endpoints/messages';
import {
  kvGet,
  kvSetWithinTransaction,
  markMessageDeletedWithinTransaction,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import type { SyncApi } from './types';

/** Deleted-message catch-up is isolated from full, targeted, and incremental sync flows. */

/** kv key holding the deletion-catch-up watermark: the max `dateDeleted` (Unix ms) already applied. */
export const DELETIONS_SYNCED_AT_KEY = 'sync.deletionsSyncedAt';
/** Server page cap for GET /message/deleted — a FULL page means more rows may remain. */
export const DELETION_SYNC_PAGE_SIZE = DELETED_MESSAGE_PAGE_LIMIT;
/** Bounded catch-up: at most this many pages per sync (any remainder catches up next sync). */
export const DELETION_SYNC_MAX_PAGES = 5;

export type DeletionSyncProtocolErrorCode =
  | 'page-over-cap'
  | 'invalid-guid'
  | 'invalid-timestamp'
  | 'timestamp-before-watermark'
  | 'timestamp-out-of-order';

/**
 * A server response violated the deletion cursor contract. The message and code deliberately name
 * only the rule: never include a message guid, timestamp, or other response payload in logs.
 */
export class DeletionSyncProtocolError extends Error {
  constructor(readonly code: DeletionSyncProtocolErrorCode) {
    super(`Deletion sync protocol violation: ${code}`);
    this.name = 'DeletionSyncProtocolError';
  }
}

interface ValidatedDeletionPage {
  hasNullTimestamp: boolean;
  maxTimestamp: number;
}

/** Validate the COMPLETE response before its first tombstone or watermark write. */
function validateDeletionPage(
  rows: readonly DeletedMessage[],
  requestedWatermark: number,
  pageSize: number,
): ValidatedDeletionPage {
  if (rows.length > pageSize) throw new DeletionSyncProtocolError('page-over-cap');

  let previousTimestamp = requestedWatermark;
  let maxTimestamp = requestedWatermark;
  let hasNullTimestamp = false;
  for (const row of rows) {
    if (typeof row.guid !== 'string' || row.guid.length === 0) {
      throw new DeletionSyncProtocolError('invalid-guid');
    }
    if (row.dateDeleted == null) {
      hasNullTimestamp = true;
      continue;
    }
    if (!Number.isFinite(row.dateDeleted)) {
      throw new DeletionSyncProtocolError('invalid-timestamp');
    }
    if (row.dateDeleted < requestedWatermark) {
      throw new DeletionSyncProtocolError('timestamp-before-watermark');
    }
    if (row.dateDeleted < previousTimestamp) {
      throw new DeletionSyncProtocolError('timestamp-out-of-order');
    }
    previousTimestamp = row.dateDeleted;
    maxTimestamp = row.dateDeleted;
  }
  return { hasNullTimestamp, maxTimestamp };
}

export interface DeletionSyncOptions {
  /** The server's `supports_message_deleted` capability (sessionAccessors.messageDeletedSupported()). */
  supported: boolean;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Page cap per sync (default {@link DELETION_SYNC_MAX_PAGES}). */
  maxPages?: number;
  /** Full-page threshold (default {@link DELETION_SYNC_PAGE_SIZE}; overridable so tests can page small). */
  pageSize?: number;
  /** Stop before the next request/write when this account no longer owns the run. */
  shouldAbort?: () => boolean;
  /** Cancel the active deletion request/retry wait. */
  signal?: AbortSignal;
}

/**
 * R1 deletion catch-up sync: apply `message-deleted` events the app MISSED while dead or
 * app-locked (the locked FCM path never touches the DB, so a live-only deletion is lost and the
 * deleted message lingers forever). Pages `GET /message/deleted?after=<watermark>` and re-applies
 * each row through the SAME transaction-only tombstone helper the live event uses (idempotent —
 * rows sharing the watermark's exact ms may legitimately re-emit).
 *
 * Watermark (`sync.deletionsSyncedAt`, kv): the max `dateDeleted` already applied. FIRST RUN seeds
 * it to now() WITHOUT fetching to avoid replaying unbounded deletion history for rows this install
 * never stored. That containment is not a consistent snapshot: normal history sync runs first and
 * can ingest a row the server already considers deleted, and device clock skew can move the seed.
 * A server-issued snapshot cursor (or deleted-row metadata/exclusion in the history response) is
 * still required. Every response is validated in full before its first write: over-cap,
 * pre-watermark, or decreasing timestamps fail closed. Equal timestamps are valid. A row with a
 * null `dateDeleted` is still tombstoned (now() fallback, same as the live sink), but a FULL page
 * containing one cannot advance safely and stops without moving the watermark.
 *
 * Returns the number of deletion rows applied. Callers gate on `supported` (older servers 404).
 */
export async function syncDeletedMessages(
  db: AppDatabase,
  api: SyncApi,
  opts: DeletionSyncOptions,
): Promise<number> {
  if (!opts.supported) return 0;
  const now = opts.now ?? Date.now;
  const maxPages =
    opts.maxPages == null
      ? DELETION_SYNC_MAX_PAGES
      : Number.isFinite(opts.maxPages) && opts.maxPages > 0
        ? Math.min(Math.floor(opts.maxPages), DELETION_SYNC_MAX_PAGES)
        : 0;
  const pageSize =
    opts.pageSize == null
      ? DELETION_SYNC_PAGE_SIZE
      : Number.isFinite(opts.pageSize) && opts.pageSize > 0
        ? Math.min(Math.floor(opts.pageSize), DELETION_SYNC_PAGE_SIZE)
        : 0;
  const shouldContinue = (): boolean => !(opts.shouldAbort?.() ?? false);
  const commitGuard = opts.shouldAbort ? shouldContinue : undefined;
  if (!shouldContinue()) return 0;

  // Read and conditionally seed under one short lock. A bare read on the shared connection can see
  // a neighbouring transaction's uncommitted watermark; seeding from that phantom state can skip
  // this account's deletion window. No network work runs in this callback.
  const initial = await withDbTransaction(
    db,
    async (transactionContext) => {
      const raw = await kvGet(db, DELETIONS_SYNCED_AT_KEY);
      const parsed = raw == null ? Number.NaN : Number(raw);
      if (Number.isFinite(parsed)) return { seeded: false, watermark: parsed };
      const watermark = now();
      await kvSetWithinTransaction(transactionContext, DELETIONS_SYNCED_AT_KEY, String(watermark));
      return { seeded: true, watermark };
    },
    commitGuard,
  );
  if (initial.seeded || maxPages === 0 || pageSize === 0) return 0;
  let watermark = initial.watermark;

  let applied = 0;
  for (let page = 0; page < maxPages; page++) {
    if (!shouldContinue()) break;
    const rows = await api.fetchDeletedAfter(watermark, opts.signal);
    // HttpClient keeps an immutable request snapshot through retries. A Disconnect cannot cancel
    // that already-running request, so reject its old-account result before any DB transaction.
    if (!shouldContinue()) break;
    if (rows.length === 0) break;
    const validated = validateDeletionPage(rows, watermark, pageSize);

    for (const row of rows) {
      if (!shouldContinue()) return applied;
      // Unknown / hard-gone rows still leave a durable ledger marker so later backfill is born
      // hidden. Keep that marker, the message tombstone, and chat sort-key recompute together.
      const dateDeleted = row.dateDeleted ?? now();
      await withDbTransaction(
        db,
        (transactionContext) =>
          markMessageDeletedWithinTransaction(transactionContext, row.guid, dateDeleted),
        commitGuard,
      );
      applied++;
    }

    const isFullPage = rows.length === pageSize;
    const cursorIsSafe = !(isFullPage && validated.hasNullTimestamp);
    const advanced = cursorIsSafe && validated.maxTimestamp > watermark;
    if (advanced) {
      if (!shouldContinue()) return applied;
      await withDbTransaction(
        db,
        (transactionContext) =>
          kvSetWithinTransaction(
            transactionContext,
            DELETIONS_SYNCED_AT_KEY,
            String(validated.maxTimestamp),
          ),
        commitGuard,
      );
      // Only advertise the cursor in memory after the durable commit succeeds.
      watermark = validated.maxTimestamp;
    }
    // Loop ONLY on a full page that moved the watermark; a stuck watermark would refetch the
    // identical page forever. A full page containing a null timestamp is also cursor-ambiguous:
    // apply its durable markers, but do not skip past it or request a continuation from bad state.
    if (!isFullPage || !advanced) break;
  }
  return applied;
}
