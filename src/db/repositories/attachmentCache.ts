import { sql } from 'drizzle-orm';
import { runInTransactionContext, type DbTransactionContext } from '../transaction';
import type { AppDatabase } from '../types';

/**
 * Transaction-only mutations and read-only queries for the encrypted attachment-cache ledger.
 *
 * Mutation helpers accept a runtime-checked `DbTransactionContext` and join their caller's short
 * outer transaction. They never open another writer owner, which would wedge the shared DB mutex.
 */

export type AttachmentCacheState = 'active' | 'reserved' | 'retiring';

export interface AttachmentCacheEntry {
  path: string;
  bytes: number;
  lastUsedAt: number;
  state: AttachmentCacheState;
  attempts: number;
  nextRetryAt: number;
}

export interface AttachmentCacheUsage {
  files: number;
  bytes: number;
}

export interface AttachmentCacheEvictionCandidate {
  path: string;
  bytes: number;
  lastUsedAt: number;
}

export interface AttachmentCacheQuotaSnapshot {
  /** Active and retiring rows both remain charged until native deletion is confirmed. */
  usage: AttachmentCacheUsage;
  /** Active rows only, in deterministic least-recently-used order. */
  candidates: AttachmentCacheEvictionCandidate[];
  /** True when omitted active rows exist; fail closed or retire this page and take a fresh snapshot. */
  hasMoreActive: boolean;
}

export type AttachmentCacheRetirementRefusal =
  'not_active' | 'outgoing_protected' | 'outgoing_scan_incomplete' | 'too_many_references';

export type AttachmentCacheRetirementClaim =
  | {
      status: 'claimed';
      paths: string[];
      clearedReferences: number;
    }
  | {
      status: 'refused';
      reason: AttachmentCacheRetirementRefusal;
      paths: string[];
    };

export interface AttachmentCacheRetirementRetry {
  attempts: number;
  nextRetryAt: number;
}

export type AttachmentCacheAccessRecord = 'touched' | 'coalesced' | 'not_active';

export interface MissingAttachmentCacheRepair {
  clearedReferences: number;
}

export interface AttachmentCacheScanObservation {
  path: string;
  bytes: number;
  lastUsedAt: number;
}

export interface AttachmentCacheScanAdoption {
  /** Newly inserted or already-active paths whose exact byte accounting is now current. */
  activePaths: string[];
  /** Zero-byte completed files staged for exact deletion; ordinary references were cleared. */
  retiringPaths: string[];
  /** Durable reservations/retirements are deliberately sticky and must drain instead. */
  deferredPaths: string[];
}

/**
 * Persist the conservative maximum before native work can create the final file.
 *
 * Transaction-only: the coordinator passes the active context from its account-aware outer DB
 * transaction. A duplicate path is a clean refusal, never an overwrite.
 */
export async function createAttachmentCacheReservation(
  context: DbTransactionContext,
  input: { path: string; maxBytes: number; createdAt: number },
): Promise<boolean> {
  return runInTransactionContext(context, async (db) => {
    requirePath(input.path);
    requireNonnegativeSafeInteger(input.maxBytes, 'Attachment cache reservation bytes');
    requireNonnegativeSafeInteger(input.createdAt, 'Attachment cache reservation time');
    if (input.maxBytes === 0) {
      throw new RangeError('Attachment cache reservation bytes must be positive.');
    }
    const rows = await db.all<{ path: string }>(sql`
      INSERT INTO attachment_cache_entries (path, bytes, last_used_at, state, attempts, next_retry_at)
      VALUES (${input.path}, ${input.maxBytes}, ${input.createdAt}, 'reserved', 0, 0)
      ON CONFLICT(path) DO NOTHING
      RETURNING path
    `);
    return rows.length === 1;
  });
}

/** Atomically turn the exact durable reservation into a completed active ledger row. */
export async function commitAttachmentCacheReservation(
  context: DbTransactionContext,
  input: { path: string; bytes: number; lastUsedAt: number },
): Promise<boolean> {
  return runInTransactionContext(context, async (db) => {
    requirePath(input.path);
    requireNonnegativeSafeInteger(input.bytes, 'Attachment cache bytes');
    requireNonnegativeSafeInteger(input.lastUsedAt, 'Attachment cache lastUsedAt');
    if (input.bytes === 0) throw new RangeError('Attachment cache bytes must be positive.');
    const rows = await db.all<{ path: string }>(sql`
      UPDATE attachment_cache_entries
      SET bytes = ${input.bytes}, last_used_at = ${input.lastUsedAt}, state = 'active',
          attempts = 0, next_retry_at = 0
      WHERE path = ${input.path} AND state = 'reserved' AND bytes >= ${input.bytes}
      RETURNING path
    `);
    return rows.length === 1;
  });
}

interface AttachmentCacheQuotaSnapshotRow {
  usageFiles: number;
  usageBytes: number;
  path: string | null;
  bytes: number | null;
  lastUsedAt: number | null;
}

interface OutgoingAttachmentQueueRow {
  id: number;
  payload: string | null;
  payloadChars: number;
}

interface ParsedOutgoingAttachment {
  attachmentGuid: string;
  localPath: string;
}

const MAX_RETIREMENT_BATCH = 100;
const MAX_SNAPSHOT_CANDIDATES = 4096;
// Recovery permits one bounded policy overage so an upgraded pre-ledger cache can be brought back
// under the ordinary 4,096-file ceiling instead of failing permanently at file 4,097.
export const ATTACHMENT_CACHE_RECOVERY_MAX_FILES = 8192;
export const ATTACHMENT_CACHE_RECOVERY_BATCH_FILES = 100;
const MAX_ATTACHMENT_CACHE_REFERENCES_PER_TRANSACTION = 1000;
const MAX_OUTGOING_ATTACHMENT_ROWS = 1000;
const MAX_OUTGOING_PAYLOAD_CHARS = 8192;
const MAX_ATTACHMENT_GUID_CHARS = 512;
const MAX_PATH_CHARS = 4096;
const MAX_PERSISTED_ATTEMPTS = 1_000_000;

export const ATTACHMENT_CACHE_RETIREMENT_RETRY_BASE_MS = 5_000;
export const ATTACHMENT_CACHE_RETIREMENT_RETRY_MAX_MS = 6 * 60 * 60 * 1000;

/**
 * Active paths with no attachment on a live, visible message.
 *
 * The message/chat predicate intentionally matches `updateAttachmentLocalPath`: deleted,
 * retracted, and pre-chat-tombstone messages do not keep a cache file alive. Rows without a message
 * owner stay conservative because they may be local/outgoing handoffs. The coordinator reads this
 * inside the SAME outer transaction as the exact retirement claim, while its in-memory gate
 * excludes mounted/current paths.
 */
export async function listInactiveAttachmentCachePaths(
  db: AppDatabase,
  limit = MAX_RETIREMENT_BATCH,
): Promise<string[]> {
  requireNonnegativeSafeInteger(limit, 'Attachment cache inactive-path limit');
  const boundedLimit = Math.min(limit, MAX_RETIREMENT_BATCH);
  if (boundedLimit === 0) return [];
  const rows = await db.all<{ path: string }>(sql`
    SELECT e.path
    FROM attachment_cache_entries e
    WHERE e.state = 'active'
      AND NOT EXISTS (
        SELECT 1
        FROM attachments a
        LEFT JOIN messages m ON m.id = a.message_id
        LEFT JOIN chats c ON c.id = m.chat_id
        WHERE a.local_path = e.path
          AND (
            a.message_id IS NULL
            OR m.id IS NULL
            OR (
              c.id IS NOT NULL
              AND m.date_deleted IS NULL
              AND m.date_retracted IS NULL
              AND (
                c.deleted_at IS NULL
                OR (m.date_created IS NOT NULL AND m.date_created > c.deleted_at)
              )
            )
          )
      )
    ORDER BY e.last_used_at ASC, e.path ASC
    LIMIT ${boundedLimit}
  `);
  return rows.map((row: { path: string }) => row.path);
}

function requirePath(path: string): void {
  if (path.length === 0) throw new RangeError('Attachment cache path must not be empty.');
  if (path.length > MAX_PATH_CHARS) {
    throw new RangeError(`Attachment cache path must not exceed ${MAX_PATH_CHARS} characters.`);
  }
}

function requireNonnegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer.`);
  }
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireExactPathBatch(paths: readonly string[]): string[] {
  if (paths.length > MAX_RETIREMENT_BATCH) {
    throw new RangeError(
      `Attachment cache retirement batch must not exceed ${MAX_RETIREMENT_BATCH} paths.`,
    );
  }
  const seen = new Set<string>();
  for (const path of paths) {
    requirePath(path);
    if (seen.has(path)) {
      throw new RangeError('Attachment cache retirement paths must be unique.');
    }
    seen.add(path);
  }
  return [...paths].sort(comparePaths);
}

function pathSqlList(paths: readonly string[]) {
  return sql.join(
    paths.map((path) => sql`${path}`),
    sql`, `,
  );
}

/**
 * Count only far enough to prove that one reference-clearing transaction stays inside its hard
 * bound. The partial local-path index makes this an indexed probe; the nested LIMIT prevents a
 * corrupt/hostile duplicate set from making COUNT scan the rest of an unbounded attachments table.
 */
async function boundedAttachmentReferenceCount(
  db: AppDatabase,
  paths: readonly string[],
): Promise<number> {
  if (paths.length === 0) return 0;
  const inList = pathSqlList(paths);
  const rows = await db.all<{ count: number }>(sql`
    SELECT COUNT(*) AS count
    FROM (
      SELECT 1
      FROM attachments
      WHERE local_path IN (${inList})
      LIMIT ${MAX_ATTACHMENT_CACHE_REFERENCES_PER_TRANSACTION + 1}
    )
  `);
  const count = rows[0]?.count;
  if (count === undefined) {
    throw new Error('Attachment cache reference count query returned no row.');
  }
  requireNonnegativeSafeInteger(count, 'Attachment cache reference count');
  if (count > MAX_ATTACHMENT_CACHE_REFERENCES_PER_TRANSACTION) {
    throw new RangeError(
      `Attachment cache reference clear must not exceed ${MAX_ATTACHMENT_CACHE_REFERENCES_PER_TRANSACTION} rows per transaction.`,
    );
  }
  return count;
}

function parseOutgoingAttachment(payload: string): ParsedOutgoingAttachment | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const { attachmentGuid, localPath } = parsed as {
      attachmentGuid?: unknown;
      localPath?: unknown;
    };
    if (
      typeof attachmentGuid !== 'string' ||
      attachmentGuid.length === 0 ||
      attachmentGuid.length > MAX_ATTACHMENT_GUID_CHARS ||
      typeof localPath !== 'string' ||
      localPath.length === 0 ||
      localPath.length > MAX_PATH_CHARS
    ) {
      return null;
    }
    return { attachmentGuid, localPath };
  } catch {
    return null;
  }
}

/** Delay for the persisted failure count (attempt one waits five seconds). */
export function attachmentCacheRetirementBackoffMs(attempts: number): number {
  if (!Number.isSafeInteger(attempts) || attempts <= 0) {
    throw new RangeError('Attachment cache retirement attempts must be a positive safe integer.');
  }
  const exponent = Math.min(30, attempts - 1);
  return Math.min(
    ATTACHMENT_CACHE_RETIREMENT_RETRY_MAX_MS,
    ATTACHMENT_CACHE_RETIREMENT_RETRY_BASE_MS * 2 ** exponent,
  );
}

/**
 * Record a file only after the native download has completed and been re-statted.
 *
 * Returns false when this path is already retiring. That state is intentionally sticky: a late
 * completion from an older operation must not resurrect a file while a delete is in flight. For an
 * active duplicate, the newest observation wins and last-used time can only move forward.
 */
export async function recordAttachmentCacheEntry(
  context: DbTransactionContext,
  input: { path: string; bytes: number; lastUsedAt: number },
): Promise<boolean> {
  return runInTransactionContext(context, async (db) => {
    requirePath(input.path);
    requireNonnegativeSafeInteger(input.bytes, 'Attachment cache bytes');
    requireNonnegativeSafeInteger(input.lastUsedAt, 'Attachment cache lastUsedAt');

    const rows = await db.all<{ state: AttachmentCacheState }>(sql`
      INSERT INTO attachment_cache_entries (path, bytes, last_used_at, state, attempts, next_retry_at)
      VALUES (${input.path}, ${input.bytes}, ${input.lastUsedAt}, 'active', 0, 0)
      ON CONFLICT(path) DO UPDATE SET
        bytes = CASE
          WHEN excluded.last_used_at >= attachment_cache_entries.last_used_at THEN excluded.bytes
          ELSE attachment_cache_entries.bytes
        END,
        last_used_at = MAX(attachment_cache_entries.last_used_at, excluded.last_used_at)
      WHERE attachment_cache_entries.state = 'active'
      RETURNING state
    `);
    return rows[0]?.state === 'active';
  });
}

/**
 * Account one bounded page from a fully collected native startup manifest.
 *
 * Transaction-only: startup passes each page the context from one short account-guarded owner.
 * Positive untracked files become active temporarily so the ordinary outgoing/reference-aware
 * retirement path can classify them. Zero-byte "completed" files are unusable and become retiring
 * while their references are cleared in the same outer transaction. Existing active rows get the
 * exact scanned byte size; their access time never moves backward or beyond the caller's recovery
 * clock. `reserved`/`retiring` ownership stays sticky.
 */
export async function adoptAttachmentCacheScanBatch(
  context: DbTransactionContext,
  observations: readonly AttachmentCacheScanObservation[],
  maxLastUsedAt = Number.MAX_SAFE_INTEGER,
): Promise<AttachmentCacheScanAdoption> {
  return runInTransactionContext(context, async (db) => {
    if (observations.length > ATTACHMENT_CACHE_RECOVERY_BATCH_FILES) {
      throw new RangeError(
        `Attachment cache recovery batch must not exceed ${ATTACHMENT_CACHE_RECOVERY_BATCH_FILES} files.`,
      );
    }
    requireNonnegativeSafeInteger(maxLastUsedAt, 'Attachment cache recovery time ceiling');
    if (observations.length === 0) {
      return { activePaths: [], retiringPaths: [], deferredPaths: [] };
    }

    const seen = new Set<string>();
    for (const observation of observations) {
      requirePath(observation.path);
      requireNonnegativeSafeInteger(observation.bytes, 'Attachment cache recovery bytes');
      requireNonnegativeSafeInteger(
        observation.lastUsedAt,
        'Attachment cache recovery access time',
      );
      if (seen.has(observation.path)) {
        throw new RangeError('Attachment cache recovery paths must be unique within a batch.');
      }
      seen.add(observation.path);
    }

    // Probe before the ledger UPSERT: an over-limit corrupt duplicate set must leave both the
    // existing ledger and every attachment reference untouched when this outer transaction aborts.
    const zeroPaths = observations.filter((item) => item.bytes === 0).map((item) => item.path);
    const zeroReferenceCount = await boundedAttachmentReferenceCount(db, zeroPaths);

    const values = sql.join(
      observations.map(
        (observation) =>
          sql`(${observation.path}, ${observation.bytes}, ${observation.lastUsedAt}, ${
            observation.bytes === 0 ? 'retiring' : 'active'
          }, 0, 0)`,
      ),
      sql`, `,
    );
    const rows = await db.all<{ path: string; state: AttachmentCacheState }>(sql`
    INSERT INTO attachment_cache_entries (path, bytes, last_used_at, state, attempts, next_retry_at)
    VALUES ${values}
    ON CONFLICT(path) DO UPDATE SET
      bytes = excluded.bytes,
      last_used_at = MIN(
        MAX(attachment_cache_entries.last_used_at, excluded.last_used_at),
        ${maxLastUsedAt}
      ),
      state = CASE WHEN excluded.bytes = 0 THEN 'retiring' ELSE 'active' END,
      attempts = CASE WHEN excluded.bytes = 0 THEN 0 ELSE attachment_cache_entries.attempts END,
      next_retry_at = CASE
        WHEN excluded.bytes = 0 THEN 0
        ELSE attachment_cache_entries.next_retry_at
      END
    WHERE attachment_cache_entries.state = 'active'
    RETURNING path, state
  `);
    const active = new Set(
      rows
        .filter((row: { path: string; state: AttachmentCacheState }) => row.state === 'active')
        .map((row: { path: string; state: AttachmentCacheState }) => row.path),
    );
    const retiring = new Set(
      rows
        .filter((row: { path: string; state: AttachmentCacheState }) => row.state === 'retiring')
        .map((row: { path: string; state: AttachmentCacheState }) => row.path),
    );
    if (zeroPaths.length > 0) {
      const cleared = await db.all<{ id: number }>(sql`
      UPDATE attachments SET local_path = NULL
      WHERE local_path IN (${pathSqlList(zeroPaths)})
      RETURNING id
    `);
      const surviving = await db.all<{ id: number }>(sql`
      SELECT id FROM attachments
      WHERE local_path IN (${pathSqlList(zeroPaths)})
      LIMIT 1
    `);
      if (cleared.length !== zeroReferenceCount || surviving.length > 0) {
        throw new Error(
          'Attachment cache zero-byte references survived recovery; roll back the outer transaction.',
        );
      }
    }
    return {
      activePaths: observations.filter((item) => active.has(item.path)).map((item) => item.path),
      retiringPaths: observations
        .filter((item) => retiring.has(item.path))
        .map((item) => item.path),
      deferredPaths: observations
        .filter((item) => !active.has(item.path) && !retiring.has(item.path))
        .map((item) => item.path),
    };
  });
}

/**
 * Read every durable cache owner with one extra row so startup can reject over-limit corruption.
 */
export async function listAttachmentCacheEntriesForRecovery(
  db: AppDatabase,
  limit = ATTACHMENT_CACHE_RECOVERY_MAX_FILES + 1,
): Promise<AttachmentCacheEntry[]> {
  requireNonnegativeSafeInteger(limit, 'Attachment cache recovery entry limit');
  const boundedLimit = Math.min(ATTACHMENT_CACHE_RECOVERY_MAX_FILES + 1, limit);
  if (boundedLimit === 0) return [];
  return db.all<AttachmentCacheEntry>(sql`
    SELECT path, bytes, last_used_at AS lastUsedAt, state, attempts,
           next_retry_at AS nextRetryAt
    FROM attachment_cache_entries
    ORDER BY path ASC
    LIMIT ${boundedLimit}
  `);
}

export async function getAttachmentCacheEntry(
  db: AppDatabase,
  path: string,
): Promise<AttachmentCacheEntry | null> {
  requirePath(path);
  const rows = await db.all<AttachmentCacheEntry>(sql`
    SELECT path, bytes, last_used_at AS lastUsedAt, state, attempts,
           next_retry_at AS nextRetryAt
    FROM attachment_cache_entries
    WHERE path = ${path}
    LIMIT 1
  `);
  return rows[0] ?? null;
}

/**
 * Record an exact native observation of one reusable active file.
 *
 * Transaction-only: callers that use this result to hand the path to native/UI code must hold the
 * coordinator path protection and pass their active outer-transaction context. Repeated access
 * inside the supplied interval returns `coalesced` without issuing a write; an exact byte-size
 * change is always written immediately so quota accounting cannot drift.
 */
export async function recordAttachmentCacheAccess(
  context: DbTransactionContext,
  input: {
    path: string;
    bytes: number;
    observedAt: number;
    touchIntervalMs: number;
  },
): Promise<AttachmentCacheAccessRecord> {
  return runInTransactionContext(context, async (db) => {
    requirePath(input.path);
    requireNonnegativeSafeInteger(input.bytes, 'Attachment cache observed bytes');
    requireNonnegativeSafeInteger(input.observedAt, 'Attachment cache access time');
    requireNonnegativeSafeInteger(input.touchIntervalMs, 'Attachment cache touch interval');

    const rows = await db.all<{
      bytes: number;
      lastUsedAt: number;
    }>(sql`
    SELECT bytes, last_used_at AS lastUsedAt
    FROM attachment_cache_entries
    WHERE path = ${input.path} AND state = 'active'
    LIMIT 1
  `);
    const current = rows[0];
    if (!current) return 'not_active';
    requireNonnegativeSafeInteger(current.bytes, 'Attachment cache stored bytes');
    requireNonnegativeSafeInteger(current.lastUsedAt, 'Attachment cache stored lastUsedAt');

    const touchDue =
      input.observedAt >= current.lastUsedAt &&
      input.observedAt - current.lastUsedAt >= input.touchIntervalMs;
    if (!touchDue && current.bytes === input.bytes) return 'coalesced';

    const updated = await db.all<{ path: string }>(sql`
    UPDATE attachment_cache_entries
    SET bytes = ${input.bytes},
        last_used_at = CASE
          WHEN ${touchDue ? 1 : 0} = 1 THEN MAX(last_used_at, ${input.observedAt})
          ELSE last_used_at
        END
    WHERE path = ${input.path} AND state = 'active'
    RETURNING path
  `);
    return updated.length === 1 ? 'touched' : 'not_active';
  });
}

/**
 * Remove an active ledger row whose exact native stat proved the file is absent, clearing every
 * ordinary attachment reference first.
 *
 * Joins one short outer transaction through its runtime-checked context. Returning null means the
 * path is untracked or no longer active; no write is made. The state-qualified delete prevents a
 * stale missing-file observation from removing a reservation/retirement that won first.
 */
export async function repairMissingActiveAttachmentCacheEntry(
  context: DbTransactionContext,
  path: string,
): Promise<MissingAttachmentCacheRepair | null> {
  return runInTransactionContext(context, async (db) => {
    requirePath(path);
    const active = await db.all<{ path: string }>(sql`
    SELECT path FROM attachment_cache_entries
    WHERE path = ${path} AND state = 'active'
    LIMIT 1
  `);
    if (active.length === 0) return null;

    const referenceCount = await boundedAttachmentReferenceCount(db, [path]);

    const cleared = await db.all<{ id: number }>(sql`
    UPDATE attachments SET local_path = NULL
    WHERE local_path = ${path}
    RETURNING id
  `);
    const surviving = await db.all<{ id: number }>(sql`
    SELECT id FROM attachments
    WHERE local_path = ${path}
    LIMIT 1
  `);
    if (cleared.length !== referenceCount || surviving.length > 0) {
      throw new Error(
        'Attachment cache references survived missing-file repair; roll back the outer transaction.',
      );
    }
    const removed = await db.all<{ path: string }>(sql`
    DELETE FROM attachment_cache_entries
    WHERE path = ${path} AND state = 'active'
    RETURNING path
  `);
    if (removed.length !== 1) {
      throw new Error(
        'Attachment cache missing-file repair changed during its transaction; roll back the outer transaction.',
      );
    }
    return { clearedReferences: cleared.length };
  });
}

/** Both active and retiring files count until native deletion is confirmed. */
export async function getAttachmentCacheUsage(db: AppDatabase): Promise<AttachmentCacheUsage> {
  const rows = await db.all<AttachmentCacheUsage>(sql`
    SELECT COUNT(*) AS files, COALESCE(SUM(bytes), 0) AS bytes
    FROM attachment_cache_entries
  `);
  return rows[0] ?? { files: 0, bytes: 0 };
}

/**
 * Read charged usage and one bounded, deterministic active-candidate page in one SQL snapshot.
 *
 * The single statement matters even outside an explicit transaction: usage cannot come from one
 * ledger moment while the candidates come from another. Callers normally request the policy's
 * whole 4096-file ceiling, but the hard maximum keeps accidental recovery scans bounded. There is
 * deliberately no unbounded cursor: `hasMoreActive` means a plan needing omitted rows must refuse,
 * or retire a safe returned batch and then recompute from a fresh snapshot.
 */
export async function getAttachmentCacheQuotaSnapshot(
  db: AppDatabase,
  limit = MAX_SNAPSHOT_CANDIDATES,
): Promise<AttachmentCacheQuotaSnapshot> {
  requireNonnegativeSafeInteger(limit, 'Attachment cache snapshot limit');
  const boundedLimit = Math.min(limit, MAX_SNAPSHOT_CANDIDATES);
  const fetchLimit = boundedLimit + 1;
  const rows = await db.all<AttachmentCacheQuotaSnapshotRow>(sql`
    WITH totals AS (
      SELECT COUNT(*) AS usage_files, COALESCE(SUM(bytes), 0) AS usage_bytes
      FROM attachment_cache_entries
    ), candidate_page AS (
      SELECT path, bytes, last_used_at
      FROM attachment_cache_entries
      WHERE state = 'active'
      ORDER BY last_used_at ASC, path ASC
      LIMIT ${fetchLimit}
    )
    SELECT totals.usage_files AS usageFiles, totals.usage_bytes AS usageBytes,
           candidate_page.path, candidate_page.bytes,
           candidate_page.last_used_at AS lastUsedAt
    FROM totals LEFT JOIN candidate_page ON 1 = 1
    ORDER BY candidate_page.last_used_at ASC, candidate_page.path ASC
  `);
  const usage = {
    files: rows[0]?.usageFiles ?? 0,
    bytes: rows[0]?.usageBytes ?? 0,
  };
  requireNonnegativeSafeInteger(usage.files, 'Attachment cache usage files');
  requireNonnegativeSafeInteger(usage.bytes, 'Attachment cache usage bytes');
  const activeRows = rows.flatMap(
    (row: AttachmentCacheQuotaSnapshotRow): AttachmentCacheEvictionCandidate[] => {
      if (row.path === null || row.bytes === null || row.lastUsedAt === null) return [];
      requirePath(row.path);
      requireNonnegativeSafeInteger(row.bytes, 'Attachment cache candidate bytes');
      requireNonnegativeSafeInteger(row.lastUsedAt, 'Attachment cache candidate lastUsedAt');
      return [{ path: row.path, bytes: row.bytes, lastUsedAt: row.lastUsedAt }];
    },
  );
  return {
    usage,
    candidates: activeRows.slice(0, boundedLimit),
    hasMoreActive: activeRows.length > boundedLimit,
  };
}

/**
 * Atomically-in-the-caller claim exact active paths and clear all ordinary attachment references.
 *
 * IMPORTANT: this helper joins one short outer `withDbTransaction` callback through its checked
 * context. It deliberately performs no native work. Preflight refusals make no writes; any
 * post-write invariant error must escape the callback so the outer transaction rolls back.
 *
 * Outgoing protection is intentionally fail-closed without SQLite JSON functions. No op-sqlite
 * build feature is assumed: at most 1000 attachment queue rows of at most 8192 characters are
 * copied into JavaScript and parsed. An oversized/malformed row means the scan cannot prove a path
 * disposable, so the whole claim is refused. The message join separately protects the current
 * attachment path for queued sends and every live outgoing temp message: even a temp row already
 * marked `sent` can receive a delayed retryable server error and rebuild its queue entry. The
 * parsed payload protects the durable `localPath` fallback when that attachment row is absent or
 * was re-pointed.
 */
export async function claimAttachmentCachePathsForRetirement(
  context: DbTransactionContext,
  requestedPaths: readonly string[],
): Promise<AttachmentCacheRetirementClaim> {
  return runInTransactionContext(context, async (db) => {
    const paths = requireExactPathBatch(requestedPaths);
    if (paths.length === 0) return { status: 'claimed', paths: [], clearedReferences: 0 };
    const inList = pathSqlList(paths);

    const activeRows = await db.all<{ path: string }>(sql`
    SELECT path FROM attachment_cache_entries
    WHERE state = 'active' AND path IN (${inList})
    ORDER BY path ASC
  `);
    if (activeRows.length !== paths.length) {
      const active = new Set(activeRows.map((row: { path: string }) => row.path));
      return {
        status: 'refused',
        reason: 'not_active',
        paths: paths.filter((path) => !active.has(path)),
      };
    }

    const queueRows = await db.all<OutgoingAttachmentQueueRow>(sql`
    SELECT id,
           CASE WHEN length(payload) <= ${MAX_OUTGOING_PAYLOAD_CHARS} THEN payload ELSE NULL END AS payload,
           length(payload) AS payloadChars
    FROM outgoing_queue
    WHERE kind = 'attachment'
    ORDER BY id ASC
    LIMIT ${MAX_OUTGOING_ATTACHMENT_ROWS + 1}
  `);
    if (
      queueRows.length > MAX_OUTGOING_ATTACHMENT_ROWS ||
      queueRows.some(
        (row: OutgoingAttachmentQueueRow) =>
          row.payload === null ||
          row.payloadChars > MAX_OUTGOING_PAYLOAD_CHARS ||
          !Number.isSafeInteger(row.payloadChars) ||
          row.payloadChars < 0,
      )
    ) {
      return { status: 'refused', reason: 'outgoing_scan_incomplete', paths };
    }

    const requested = new Set(paths);
    const outgoingProtected = new Set<string>();
    const queuedAttachmentGuids = new Set<string>();
    for (const row of queueRows) {
      const queuedAttachment = parseOutgoingAttachment(row.payload ?? '');
      if (queuedAttachment === null) {
        return { status: 'refused', reason: 'outgoing_scan_incomplete', paths };
      }
      queuedAttachmentGuids.add(queuedAttachment.attachmentGuid);
      if (requested.has(queuedAttachment.localPath)) {
        outgoingProtected.add(queuedAttachment.localPath);
      }
    }

    const attachmentReferences = await db.all<{ guid: string; path: string }>(sql`
    SELECT guid, local_path AS path
    FROM attachments
    WHERE local_path IN (${inList})
    ORDER BY id ASC
    LIMIT ${MAX_ATTACHMENT_CACHE_REFERENCES_PER_TRANSACTION + 1}
  `);
    if (attachmentReferences.length > MAX_ATTACHMENT_CACHE_REFERENCES_PER_TRANSACTION) {
      return { status: 'refused', reason: 'too_many_references', paths };
    }
    for (const reference of attachmentReferences) {
      // The retry worker resolves the freshest attachment row by payload attachmentGuid and uses its
      // current local_path before falling back to payload.localPath. Protect both physical paths.
      if (queuedAttachmentGuids.has(reference.guid)) outgoingProtected.add(reference.path);
    }

    const retryCriticalRows = await db.all<{ path: string }>(sql`
    SELECT DISTINCT a.local_path AS path
    FROM attachments a
    JOIN messages m ON m.id = a.message_id
    WHERE a.local_path IN (${inList})
      AND (
        EXISTS (SELECT 1 FROM outgoing_queue q WHERE q.temp_guid = m.guid)
        OR (
          m.is_from_me = 1
          AND m.guid >= 'temp-' AND m.guid < 'temp.'
          AND m.date_deleted IS NULL
        )
      )
    ORDER BY a.local_path ASC
  `);
    for (const row of retryCriticalRows) outgoingProtected.add(row.path);
    if (outgoingProtected.size > 0) {
      return {
        status: 'refused',
        reason: 'outgoing_protected',
        paths: [...outgoingProtected].sort(comparePaths),
      };
    }

    const referenceCount = attachmentReferences.length;

    // The count predicate keeps this statement all-or-none if the active set changes. The checked
    // outer context binds the claim to the following reference clear and verification.
    const claimedRows = await db.all<{ path: string }>(sql`
    UPDATE attachment_cache_entries
    SET state = 'retiring', attempts = 0, next_retry_at = 0
    WHERE state = 'active'
      AND path IN (${inList})
      AND (
        SELECT COUNT(*) FROM attachment_cache_entries
        WHERE state = 'active' AND path IN (${inList})
      ) = ${paths.length}
    RETURNING path
  `);
    if (claimedRows.length !== paths.length) {
      throw new Error(
        'Attachment cache retirement claim changed during its transaction; roll back the outer transaction.',
      );
    }

    const clearedRows = await db.all<{ id: number }>(sql`
    UPDATE attachments SET local_path = NULL
    WHERE local_path IN (${inList})
    RETURNING id
  `);
    const survivingRows = await db.all<{ path: string }>(sql`
    SELECT local_path AS path FROM attachments
    WHERE local_path IN (${inList})
    LIMIT 1
  `);
    if (survivingRows.length > 0 || clearedRows.length !== referenceCount) {
      throw new Error(
        'Attachment cache references survived retirement; roll back the outer transaction.',
      );
    }
    return { status: 'claimed', paths, clearedReferences: clearedRows.length };
  });
}

/**
 * Claim the ledger-managed files attached to one message after that message was tombstoned.
 *
 * Transaction-only: callers compose this with the tombstone by passing the existing owner's
 * context. More than one hundred physical paths is treated as unprovable/bounded-work overflow and
 * left active for ordinary quota eviction; no partial claim is made.
 */
export async function claimAttachmentCachePathsForDeletedMessage(
  context: DbTransactionContext,
  messageGuid: string,
): Promise<AttachmentCacheRetirementClaim> {
  return runInTransactionContext(context, async (db) => {
    if (messageGuid.length === 0) {
      throw new RangeError('Attachment cache message guid must not be empty.');
    }
    const rows: Array<{ path: string }> = await db.all(sql`
      SELECT DISTINCT e.path
      FROM attachment_cache_entries e
      JOIN attachments a ON a.local_path = e.path
      JOIN messages m ON m.id = a.message_id
      WHERE m.guid = ${messageGuid} AND m.date_deleted IS NOT NULL AND e.state = 'active'
      ORDER BY e.path ASC
      LIMIT ${MAX_RETIREMENT_BATCH + 1}
    `);
    if (rows.length > MAX_RETIREMENT_BATCH) {
      return {
        status: 'refused',
        reason: 'too_many_references',
        paths: rows.slice(0, MAX_RETIREMENT_BATCH).map((row) => row.path),
      };
    }
    return claimAttachmentCachePathsForRetirement(
      context,
      rows.map((row) => row.path),
    );
  });
}

/** Persist a failed native-delete attempt so startup recovery can retry it later. */
export async function scheduleAttachmentCacheRetirementRetry(
  context: DbTransactionContext,
  path: string,
  now: number,
): Promise<AttachmentCacheRetirementRetry | null> {
  return runInTransactionContext(context, async (db) => {
    requirePath(path);
    requireNonnegativeSafeInteger(now, 'Attachment cache retry time');
    if (now > Number.MAX_SAFE_INTEGER - ATTACHMENT_CACHE_RETIREMENT_RETRY_MAX_MS) {
      throw new RangeError('Attachment cache retry time is too large to schedule safely.');
    }
    const rows = await db.all<AttachmentCacheRetirementRetry>(sql`
    UPDATE attachment_cache_entries
    SET state = 'retiring',
        attempts = MIN(attempts + 1, ${MAX_PERSISTED_ATTEMPTS}),
        next_retry_at = ${now} + CASE
          WHEN attempts >= 13 THEN ${ATTACHMENT_CACHE_RETIREMENT_RETRY_MAX_MS}
          ELSE MIN(
            ${ATTACHMENT_CACHE_RETIREMENT_RETRY_MAX_MS},
            ${ATTACHMENT_CACHE_RETIREMENT_RETRY_BASE_MS} * (1 << attempts)
          )
        END
    WHERE path = ${path} AND state IN ('reserved', 'retiring')
    RETURNING attempts, next_retry_at AS nextRetryAt
  `);
    return rows[0] ?? null;
  });
}

/** Bounded recovery query for deletion work that survived a crash or process restart. */
export async function listDueAttachmentCacheRetirements(
  db: AppDatabase,
  now: number,
  limit = MAX_RETIREMENT_BATCH,
): Promise<AttachmentCacheEntry[]> {
  requireNonnegativeSafeInteger(now, 'Attachment cache retirement time');
  requireNonnegativeSafeInteger(limit, 'Attachment cache retirement limit');
  const boundedLimit = Math.min(MAX_RETIREMENT_BATCH, limit);
  if (boundedLimit === 0) return [];
  return db.all<AttachmentCacheEntry>(sql`
    SELECT path, bytes, last_used_at AS lastUsedAt, state, attempts,
           next_retry_at AS nextRetryAt
    FROM attachment_cache_entries
    WHERE state IN ('reserved', 'retiring') AND next_retry_at <= ${now}
    ORDER BY next_retry_at ASC, last_used_at ASC, path ASC
    LIMIT ${boundedLimit}
  `);
}

/**
 * Remove accounting only after native code confirms the path is absent. The slice-2 coordinator
 * must also retain its per-path reservation until this statement finishes, preventing an older
 * download completion from recreating an active row for a file that was just deleted.
 */
export async function confirmAttachmentCacheEntryDeleted(
  context: DbTransactionContext,
  path: string,
): Promise<boolean> {
  return runInTransactionContext(context, async (db) => {
    requirePath(path);
    const rows = await db.all<{ path: string }>(sql`
      DELETE FROM attachment_cache_entries
      WHERE path = ${path} AND state IN ('reserved', 'retiring')
      RETURNING path
    `);
    return rows.length > 0;
  });
}
