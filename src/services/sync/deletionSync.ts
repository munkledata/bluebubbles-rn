import {
  DELETED_MESSAGE_PAGE_LIMIT,
  type DeletedMessage,
  type DeletedMessagePage,
} from '@core/api/endpoints/messages';
import { ApiError } from '@core/api/errors';
import {
  currentRcsProviderEpoch,
  isCurrentRcsChatGuid,
  isCurrentRcsMessageGuid,
  looksLikeRcsChatGuid,
  looksLikeRcsMessageGuid,
  type RcsProviderServerInfo,
} from '@core/rcs';
import {
  kvGetWithinTransaction,
  kvSetWithinTransaction,
  markMessageDeletedWithinTransaction,
  getMessageStateAuthority,
  getMessageStateAuthorityWithinTransaction,
} from '@db/repositories';
import { withDbTransaction, type DbCommitGuard } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import type { SyncApi } from './types';

/** Deleted-message catch-up is isolated from full, targeted, and incremental sync flows. */

/** Account-scoped deletion continuation state. Account cleanup deletes this key. */
export const DELETIONS_SYNCED_AT_KEY = 'sync.deletionsSyncedAt';
/** Account-scoped proof that one stable, zero-origin deletion snapshot reached its terminal page. */
export const DELETION_SNAPSHOT_INITIALIZED_KEY = 'sync.deletionSnapshotInitialized';
/** Versioned so a future snapshot contract can deliberately require one new initialization pass. */
export const DELETION_SNAPSHOT_INITIALIZED_VALUE = JSON.stringify({ v: 1 });
/** Server page cap for GET /message/deleted. */
export const DELETION_SYNC_PAGE_SIZE = DELETED_MESSAGE_PAGE_LIMIT;
/** Bounded catch-up: at most this many committed pages per sync. */
export const DELETION_SYNC_MAX_PAGES = 5;
/** Hard fail-closed ceiling for a stable-snapshot deletion crawl (500,000 observations). */
export const DELETION_SYNC_EXHAUSTIVE_MAX_PAGES = 1_000;

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
  | 'cursor-restart-loop'
  | 'rcs-provider-epoch-mismatch';

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

export type DeletionSyncIncompleteReason =
  | 'aborted'
  | 'bounds'
  | 'legacy-cursor-stalled'
  | 'legacy-protocol'
  | 'non-ledger-protocol'
  | 'page-cap';

/**
 * An exhaustive crawl stopped without proving that it consumed the terminal deletion page.
 * Messages deliberately contain no server cursor or message identity.
 */
export class DeletionSyncIncompleteError extends Error {
  constructor(readonly reason: DeletionSyncIncompleteReason) {
    super(`Deletion sync did not reach its terminal page: ${reason}`);
    this.name = 'DeletionSyncIncompleteError';
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
  ledgerOrdered: boolean,
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
    if (!ledgerOrdered) {
      if (row.dateDeleted < requestedWatermark) {
        throw new DeletionSyncProtocolError('timestamp-before-watermark');
      }
      if (row.dateDeleted < previousTimestamp) {
        throw new DeletionSyncProtocolError('timestamp-out-of-order');
      }
      previousTimestamp = row.dateDeleted;
    }
    maxTimestamp = Math.max(maxTimestamp, row.dateDeleted);
  }
  return { hasNullTimestamp, maxTimestamp };
}

export interface DeletionSyncOptions {
  /** The server's `supports_message_deleted` capability. */
  supported: boolean;
  /** Injectable clock used only when a deletion has no server timestamp. */
  now?: () => number;
  /** Page cap per sync (bounded default 5; exhaustive default 1,000). */
  maxPages?: number;
  /** Replay from zero and require a durable v2 terminal page before resolving. */
  exhaustive?: boolean;
  /** Full-page threshold (default {@link DELETION_SYNC_PAGE_SIZE}; tests may lower it). */
  pageSize?: number;
  /** Stop before the next request/write when this account no longer owns the run. */
  shouldAbort?: () => boolean;
  /** Exact guarded DB owner when deletion catch-up participates in a full-repair fence. */
  commitGuard?: DbCommitGuard;
  /** Cancel the active deletion request/retry wait. */
  signal?: AbortSignal;
  /** Captured current Google pairing identity; absent drops legacy RCS while advancing compat cursors. */
  rcsProviderInfo?: RcsProviderServerInfo | null;
}

export interface DeletionSnapshotInitializationReadOptions {
  /** Stop/deny the read when this account no longer owns the run. */
  shouldAbort?: () => boolean;
  /** Optional stronger owner, such as an already-captured DB write fence. */
  commitGuard?: DbCommitGuard;
}

function normalizePositiveBound(
  value: number | undefined,
  fallback: number,
  ceiling: number,
): number {
  if (value == null) return fallback;
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), ceiling) : 0;
}

/** Read the one-time stable-deletion initialization proof under the global DB owner + account guard. */
export async function isDeletionSnapshotInitialized(
  db: AppDatabase,
  opts: DeletionSnapshotInitializationReadOptions = {},
): Promise<boolean> {
  const shouldContinue = (): boolean => !(opts.shouldAbort?.() ?? false);
  const commitGuard = opts.commitGuard ?? (opts.shouldAbort ? shouldContinue : undefined);
  const value = await withDbTransaction(
    db,
    (transactionContext) =>
      kvGetWithinTransaction(transactionContext, DELETION_SNAPSHOT_INITIALIZED_KEY),
    commitGuard,
  );
  return value === DELETION_SNAPSHOT_INITIALIZED_VALUE;
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

function isOldServerV2CursorRejection(error: unknown, cursor: string | null): boolean {
  return (
    cursor?.startsWith('v2.') === true &&
    error instanceof ApiError &&
    error.kind === 'bad_request' &&
    error.status === 400
  );
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
 * transaction. V1 continuation remains timestamp/keyset ordered. A returned v2 cursor instead
 * identifies ledger-observation order, so its rows may carry older or decreasing deletion dates;
 * the opaque cursor, not those dates, owns continuation progress.
 */
export async function syncDeletedMessages(
  db: AppDatabase,
  api: SyncApi,
  opts: DeletionSyncOptions,
): Promise<number> {
  // A legacy response cannot overwrite a versioned restore. Historical receipts remain local
  // protections, but new legacy observations have no authority after a successful scoped repair.
  if (opts.shouldAbort?.() || (await getMessageStateAuthority(db))) return 0;
  const exhaustive = opts.exhaustive === true;
  // A bound repair snapshot reads the retained v2 ledger even when the server cannot currently
  // discover new live deletions. Exhaustive mode therefore owns its own capability contract.
  if (!opts.supported && !exhaustive) return 0;
  const config = {
    maxPages: normalizePositiveBound(
      opts.maxPages,
      exhaustive ? DELETION_SYNC_EXHAUSTIVE_MAX_PAGES : DELETION_SYNC_MAX_PAGES,
      exhaustive ? DELETION_SYNC_EXHAUSTIVE_MAX_PAGES : DELETION_SYNC_MAX_PAGES,
    ),
    requireLedgerProtocol: exhaustive,
    startFromZero: exhaustive,
  };
  const now = opts.now ?? Date.now;
  const pageSize = normalizePositiveBound(
    opts.pageSize,
    DELETION_SYNC_PAGE_SIZE,
    DELETION_SYNC_PAGE_SIZE,
  );
  const shouldContinue = (): boolean => !(opts.shouldAbort?.() ?? false);
  const commitGuard = opts.commitGuard ?? (opts.shouldAbort ? shouldContinue : undefined);
  if (!shouldContinue()) {
    if (exhaustive) throw new DeletionSyncIncompleteError('aborted');
    return 0;
  }
  if (config.maxPages === 0 || pageSize === 0) {
    if (exhaustive) throw new DeletionSyncIncompleteError('bounds');
    return 0;
  }

  // A stable-snapshot crawl always replays from zero. Ordinary catch-up resumes its durable cursor;
  // that read takes the same global owner as writes so it cannot observe a neighbour's uncommitted
  // state, and its guard rejects a queued old-account read after revocation.
  let state: DeletionSyncState | null = null;
  if (!config.startFromZero) {
    const rawState = await withDbTransaction(
      db,
      (transactionContext) => kvGetWithinTransaction(transactionContext, DELETIONS_SYNCED_AT_KEY),
      commitGuard,
    );
    state = parseState(rawState);
  }
  const seenCursors = new Set<string>();
  if (state?.mode === 'cursor') seenCursors.add(state.cursor);

  let applied = 0;
  let committedPages = 0;
  let completed = false;
  let incompleteReason: DeletionSyncIncompleteReason | undefined;
  let restartedCursorFromZero = false;
  let restartedRejectedV2CursorFromZero = false;
  while (committedPages < config.maxPages) {
    if (!shouldContinue()) {
      incompleteReason = 'aborted';
      break;
    }
    const requestedAfterMs = state?.afterMs ?? 0;
    const requestedCursor = state?.mode === 'cursor' ? state.cursor : null;
    let response: DeletedMessagePage;
    try {
      response = await fetchDeletionPage(api, requestedAfterMs, requestedCursor, opts.signal);
    } catch (error) {
      // A pre-v2 server rejects an otherwise opaque persisted v2 cursor at input validation. Retry
      // that one endpoint-specific 400 once from zero; all other failures, and a second rejection,
      // escape unchanged. Do not write the reset itself: the recovered page and replacement state
      // must still commit atomically under the account guard.
      if (
        !restartedRejectedV2CursorFromZero &&
        isOldServerV2CursorRejection(error, requestedCursor)
      ) {
        if (!shouldContinue()) {
          incompleteReason = 'aborted';
          break;
        }
        restartedRejectedV2CursorFromZero = true;
        state = null;
        seenCursors.clear();
        continue;
      }
      throw error;
    }

    // HttpClient keeps an immutable request snapshot through retries. Reject an old-account result
    // before it can enter a transaction after Disconnect changed ownership.
    if (!shouldContinue()) {
      incompleteReason = 'aborted';
      break;
    }

    // A stable initialization is authorized only by the durable observation ledger. Reject an old
    // timestamp/v1 response before applying any tombstone or continuation state: those protocols
    // cannot prove that a late, older source row did not fall behind an already-issued cursor.
    if (
      config.requireLedgerProtocol &&
      (response.protocol !== 'continuation' || !response.cursor.startsWith('v2.'))
    ) {
      incompleteReason = response.protocol === 'legacy' ? 'legacy-protocol' : 'non-ledger-protocol';
      break;
    }

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
    const ledgerOrdered = response.protocol === 'continuation' && response.cursor.startsWith('v2.');
    const validated = validateDeletionPage(rows, requestedAfterMs, pageSize, ledgerOrdered);
    const expectedRcsProviderEpoch = currentRcsProviderEpoch(opts.rcsProviderInfo);
    const preparedRows = rows.flatMap((row) => {
      const rcsMessage = looksLikeRcsMessageGuid(row.guid);
      const rcsChat = looksLikeRcsChatGuid(row.chatGuid);
      if (!rcsMessage && !rcsChat) {
        return [{ guid: row.guid, chatGuid: row.chatGuid, dateDeleted: row.dateDeleted ?? now() }];
      }
      // Old/unqualified servers are compatibility-read-only: ignore their RCS rows but consume the
      // mixed page so Apple deletion catch-up keeps moving. Once an exact epoch was captured, any
      // mismatch signals rotation/protocol drift and the cursor must remain before this page.
      if (expectedRcsProviderEpoch == null) return [];
      if (
        !rcsMessage ||
        !rcsChat ||
        !isCurrentRcsMessageGuid(opts.rcsProviderInfo, row.guid) ||
        !isCurrentRcsChatGuid(opts.rcsProviderInfo, row.chatGuid)
      ) {
        throw new DeletionSyncProtocolError('rcs-provider-epoch-mismatch');
      }
      return [{ guid: row.guid, chatGuid: row.chatGuid, dateDeleted: row.dateDeleted ?? now() }];
    });
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
        if (await getMessageStateAuthorityWithinTransaction(transactionContext)) return;
        for (const row of preparedRows) {
          await markMessageDeletedWithinTransaction(
            transactionContext,
            row.guid,
            row.dateDeleted,
            row.chatGuid ?? undefined,
          );
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
    applied += preparedRows.length;
    committedPages++;
    state = nextState;
    if (response.protocol === 'continuation') seenCursors.add(response.cursor);
    if (!shouldFetchAnotherPage) {
      // Only continuation servers explicitly identify the terminal page. Ordinary catch-up keeps
      // its legacy short-page behavior, but a stable-snapshot crawl fails closed without an exact
      // `hasMore:false` proof.
      if (response.protocol === 'continuation') completed = true;
      else if (config.requireLedgerProtocol) incompleteReason = 'legacy-protocol';
      else if (rows.length < pageSize) completed = true;
      else incompleteReason = 'legacy-cursor-stalled';
      break;
    }
  }
  if (!completed && incompleteReason == null) {
    incompleteReason = shouldContinue() ? 'page-cap' : 'aborted';
  }
  if (exhaustive && !completed) {
    throw new DeletionSyncIncompleteError(incompleteReason ?? 'page-cap');
  }
  return applied;
}
