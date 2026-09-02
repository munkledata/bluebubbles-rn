import {
  DELETED_MESSAGE_PAGE_LIMIT,
  type DeletedMessage,
  type DeletedMessagePage,
} from '@core/api/endpoints/messages';
import {
  kvGetWithinTransaction,
  kvSetWithinTransaction,
  markMessageDeletedWithinTransaction,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import type { SyncApi } from './types';

/** Deleted-message catch-up is isolated from full, targeted, and incremental sync flows. */

/** Account-scoped deletion continuation state. Account cleanup deletes this key. */
export const DELETIONS_SYNCED_AT_KEY = 'sync.deletionsSyncedAt';
/** Server page cap for GET /message/deleted. */
export const DELETION_SYNC_PAGE_SIZE = DELETED_MESSAGE_PAGE_LIMIT;
/** Bounded catch-up: at most this many committed pages per sync. */
export const DELETION_SYNC_MAX_PAGES = 5;

const DELETION_SYNC_STATE_VERSION = 1;
const MAX_DELETION_CURSOR_LENGTH = 512;

type DeletionSyncState =
  | { v: 1; mode: 'legacy'; afterMs: number }
  | { v: 1; mode: 'cursor'; afterMs: number; cursor: string };

export type DeletionSyncProtocolErrorCode =
  | 'page-over-cap'
  | 'invalid-guid'
  | 'invalid-timestamp'
  | 'timestamp-before-watermark'
  | 'timestamp-out-of-order'
  | 'cursor-not-advanced'
  | 'cursor-restart-loop';

/**
 * A server response violated the deletion cursor contract. The message and code deliberately name
 * only the rule: never include a message guid, timestamp, or cursor payload in logs.
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

function parseState(raw: string | null): DeletionSyncState | null {
  if (raw == null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value == null) return null;
    const candidate = value as Record<string, unknown>;
    if (
      candidate.v !== DELETION_SYNC_STATE_VERSION ||
      typeof candidate.afterMs !== 'number' ||
      !Number.isFinite(candidate.afterMs) ||
      (candidate.afterMs as number) < 0
    ) {
      return null;
    }
    if (candidate.mode === 'legacy') {
      return { v: 1, mode: 'legacy', afterMs: candidate.afterMs as number };
    }
    if (
      candidate.mode === 'cursor' &&
      typeof candidate.cursor === 'string' &&
      candidate.cursor.length > 0 &&
      candidate.cursor.length <= MAX_DELETION_CURSOR_LENGTH
    ) {
      return {
        v: 1,
        mode: 'cursor',
        afterMs: candidate.afterMs as number,
        cursor: candidate.cursor,
      };
    }
  } catch {
    // Old values were bare numeric timestamps. Treat those, and malformed JSON, as uninitialized
    // so this release performs one conservative zero-origin sweep instead of trusting a value that
    // may have been seeded from a clock-ahead device.
  }
  return null;
}

function serializeState(state: DeletionSyncState): string {
  return JSON.stringify(state);
}

/** Validate the COMPLETE response before its first tombstone or continuation-state write. */
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
  /** The server's `supports_message_deleted` capability. */
  supported: boolean;
  /** Injectable clock used only when a deletion has no server timestamp. */
  now?: () => number;
  /** Page cap per sync (default {@link DELETION_SYNC_MAX_PAGES}). */
  maxPages?: number;
  /** Full-page threshold (default {@link DELETION_SYNC_PAGE_SIZE}; tests may lower it). */
  pageSize?: number;
  /** Stop before the next request/write when this account no longer owns the run. */
  shouldAbort?: () => boolean;
  /** Cancel the active deletion request/retry wait. */
  signal?: AbortSignal;
}

async function fetchDeletionPage(
  api: SyncApi,
  afterMs: number,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<DeletedMessagePage> {
  if (api.fetchDeletedPage) return api.fetchDeletedPage(afterMs, cursor, signal);
  if (!api.fetchDeletedAfter) {
    throw new Error('Deletion sync API has no deletion page reader');
  }
  return {
    protocol: 'legacy',
    deleted: await api.fetchDeletedAfter(afterMs, signal),
  };
}

/**
 * Catch up `message-deleted` events missed while the app was stopped or locked.
 *
 * State in `sync.deletionsSyncedAt` is versioned JSON. Cursor-capable servers supply the opaque
 * continuation and `hasMore`; the numeric `afterMs` travels beside it only as an older-server
 * fallback. Missing, malformed, and old bare-timestamp state starts at zero. This is deliberately
 * more conservative than the former `Date.now()` seed: deletion history runs after message history,
 * and the durable deletion ledger safely hides both current rows and future backfills.
 *
 * Every complete response is validated before writing. Its tombstones and next state then commit
 * in one account-guarded transaction, so a crash, row failure, or ownership change cannot advance
 * the cursor separately from the page it represents. Network work always stays outside that
 * transaction. The server cursor is still keyset continuation rather than a cross-request SQLite
 * snapshot; a late server row inserted behind an already-issued cursor remains a server-side gap.
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
  if (!shouldContinue() || maxPages === 0 || pageSize === 0) return 0;

  // The read takes the same global owner as writes. It cannot observe a neighbouring transaction's
  // uncommitted state, and the commit guard rejects a queued old-account read after revocation.
  const rawState = await withDbTransaction(
    db,
    (transactionContext) => kvGetWithinTransaction(transactionContext, DELETIONS_SYNCED_AT_KEY),
    commitGuard,
  );
  let state = parseState(rawState);
  const seenCursors = new Set<string>();
  if (state?.mode === 'cursor') seenCursors.add(state.cursor);

  let applied = 0;
  let committedPages = 0;
  let restartedCursorFromZero = false;
  while (committedPages < maxPages) {
    if (!shouldContinue()) break;
    const requestedAfterMs = state?.afterMs ?? 0;
    const requestedCursor = state?.mode === 'cursor' ? state.cursor : null;
    const response = await fetchDeletionPage(api, requestedAfterMs, requestedCursor, opts.signal);

    // HttpClient keeps an immutable request snapshot through retries. Reject an old-account result
    // before it can enter a transaction after Disconnect changed ownership.
    if (!shouldContinue()) break;

    // A timestamp-only run cannot be converted safely at a non-zero watermark: rows tied at that
    // timestamp may sit on the other side of the new composite cursor. Discard the one probe and
    // establish the new protocol from zero. Old servers keep returning the legacy shape and never
    // take this branch.
    if (response.protocol === 'continuation' && state?.mode === 'legacy' && state.afterMs > 0) {
      if (restartedCursorFromZero) {
        throw new DeletionSyncProtocolError('cursor-restart-loop');
      }
      restartedCursorFromZero = true;
      state = null;
      continue;
    }

    const rows = response.deleted;
    const validated = validateDeletionPage(rows, requestedAfterMs, pageSize);
    const preparedRows = rows.map((row) => ({
      guid: row.guid,
      dateDeleted: row.dateDeleted ?? now(),
    }));
    const nextAfterMs = Math.max(requestedAfterMs, validated.maxTimestamp);

    let nextState: DeletionSyncState;
    let shouldFetchAnotherPage: boolean;
    if (response.protocol === 'continuation') {
      if ((response.hasMore || rows.length > 0) && seenCursors.has(response.cursor)) {
        throw new DeletionSyncProtocolError('cursor-not-advanced');
      }
      nextState = {
        v: 1,
        mode: 'cursor',
        afterMs: nextAfterMs,
        cursor: response.cursor,
      };
      shouldFetchAnotherPage = response.hasMore;
    } else {
      const isFullPage = rows.length === pageSize;
      const advanced =
        !(isFullPage && validated.hasNullTimestamp) && nextAfterMs > requestedAfterMs;
      nextState = {
        v: 1,
        mode: 'legacy',
        afterMs: advanced ? nextAfterMs : requestedAfterMs,
      };
      // A scalar cursor can continue only when a full page moved it. Equal-timestamp and null
      // full pages stop safely rather than refetching forever.
      shouldFetchAnotherPage = isFullPage && advanced;
    }

    const serializedNextState = serializeState(nextState);
    await withDbTransaction(
      db,
      async (transactionContext) => {
        for (const row of preparedRows) {
          await markMessageDeletedWithinTransaction(transactionContext, row.guid, row.dateDeleted);
        }
        await kvSetWithinTransaction(
          transactionContext,
          DELETIONS_SYNCED_AT_KEY,
          serializedNextState,
        );
      },
      commitGuard,
    );

    // Advertise progress only after the page and its continuation committed together.
    applied += rows.length;
    committedPages++;
    state = nextState;
    if (response.protocol === 'continuation') seenCursors.add(response.cursor);
    if (!shouldFetchAnotherPage) break;
  }
  return applied;
}
