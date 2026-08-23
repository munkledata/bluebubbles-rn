import type { EventSource } from '@core/realtime';
import { sql } from 'drizzle-orm';
import { utf8Encode } from '@utils/bytes';
import type { AppDatabase } from '../types';
import {
  DbCommitGuardRejectedError,
  runInTransactionContext,
  withDbTransaction,
  type DbCommitGuard,
  type DbTransactionContext,
} from '../transaction';

/** Maximum canonical JSON payload accepted from one validated realtime event (1 MiB). */
export const INCOMING_EVENT_MAX_PAYLOAD_BYTES = 1024 * 1024;
/** Refuse new pending work after this many undrained envelopes. */
export const INCOMING_EVENT_PENDING_CAPACITY = 500;
/** Aggregate UTF-8 payload budget for pending envelopes (16 MiB). */
export const INCOMING_EVENT_PENDING_BYTE_BUDGET = 16 * 1024 * 1024;
/** Intake may choose a shorter event-specific expiry, but never a longer one. */
export const INCOMING_EVENT_MAX_PENDING_AGE_MS = 24 * 60 * 60 * 1000;
/** Payload-cleared success/poison receipts suppress duplicates for seven days. */
export const INCOMING_EVENT_TERMINAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Independent receipt count bound; pending rows have their own count bound above. */
export const INCOMING_EVENT_TERMINAL_CAPACITY = 2_000;
/** A claim increments attempts, so five process deaths also stop a poison envelope. */
export const INCOMING_EVENT_MAX_ATTEMPTS = 5;
/** One event delivery should finish quickly; a crashed owner becomes reclaimable after two minutes. */
export const INCOMING_EVENT_LEASE_MS = 120_000;
/** Keep one drain bounded even if a large backlog is already due. */
export const INCOMING_EVENT_MAX_CLAIM_BATCH = 25;
/** Prevent one synchronous SQLite result from materializing the full 16 MiB pending budget. */
export const INCOMING_EVENT_MAX_CLAIM_PAYLOAD_BYTES = 2 * 1024 * 1024;

const EVENT_KEY_MAX_BYTES = 256;
const ORDERING_KEY_MAX_BYTES = 256;
const EVENT_NAME_MAX_BYTES = 64;
const LEASE_TOKEN_MAX_BYTES = 128;
const FAILURE_CODE_MAX_BYTES = 128;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const FAILURE_CODE = /^[a-z0-9][a-z0-9._-]*$/;

export type IncomingEventState = 'pending' | 'completed' | 'poisoned';

export interface NewIncomingEvent {
  /** Stable event-specific identity supplied by the validated-envelope codec. */
  readonly eventKey: string;
  /** SHA-256 hex of the canonical payload; used to detect a key collision after payload scrubbing. */
  readonly payloadDigest: string;
  /** Rows sharing this key drain oldest-first. Independent events may use their own event key. */
  readonly orderingKey: string;
  readonly schemaVersion?: number;
  readonly eventName: string;
  readonly source: EventSource;
  /** Canonical, already-validated JSON. Never a native RemoteMessage or encrypted FCM frame. */
  readonly payload: string;
  /** Local intake time. Transport/server timestamps must not be placed in this field. */
  readonly receivedAt: number;
  /** Event-specific expiry. Typing/call state should be much shorter than durable message state. */
  readonly expiresAt: number;
}

export type EnqueueIncomingEventResult =
  | { readonly status: 'enqueued'; readonly id: number }
  | {
      readonly status: 'duplicate';
      readonly id: number;
      readonly state: IncomingEventState;
    }
  | {
      readonly status: 'key-conflict';
      readonly id: number;
      readonly existingSource: EventSource;
      readonly existingState: IncomingEventState;
    }
  | {
      readonly status: 'poisoned';
      readonly id: number;
      readonly reason: 'expired' | 'payload-too-large' | 'queue-full';
    };

export type EnqueueAndClaimIncomingEventResult =
  | { readonly status: 'queue-not-empty' }
  | {
      readonly status: 'not-enqueued';
      readonly result: Exclude<EnqueueIncomingEventResult, { readonly status: 'enqueued' }>;
    }
  | {
      readonly status: 'claimed';
      readonly result: Extract<EnqueueIncomingEventResult, { readonly status: 'enqueued' }>;
      readonly claim: ClaimedIncomingEvent;
    };

export interface ClaimedIncomingEvent {
  readonly id: number;
  readonly eventKey: string;
  readonly payloadDigest: string;
  readonly orderingKey: string;
  readonly schemaVersion: number;
  readonly eventName: string;
  readonly source: EventSource;
  readonly payload: string;
  readonly receivedAt: number;
  readonly expiresAt: number;
  readonly attempts: number;
  readonly claimVersion: number;
  readonly leaseToken: string;
  readonly leaseExpiresAt: number;
  readonly dbAppliedAt: number | null;
}

export interface IncomingEventClaimIdentity {
  readonly id: number;
  readonly leaseToken: string;
  readonly claimVersion: number;
}

// Lease expiry makes a row eligible for takeover; token + version remain the settlement fence.
// Therefore the exact owner may finish after the nominal deadline until a reclaim changes either.

export type IncomingEventClock = () => number;

export type FailIncomingEventResult =
  | { readonly status: 'stale' }
  | {
      readonly status: 'retry-scheduled';
      readonly attempts: number;
      readonly nextAttemptAt: number;
    }
  | { readonly status: 'poisoned'; readonly attempts: number };

export interface IncomingEventQueueHealth {
  readonly pending: number;
  readonly due: number;
  readonly leased: number;
  readonly dbAppliedPending: number;
  readonly completed: number;
  readonly poisoned: number;
  readonly pendingPayloadBytes: number;
  readonly oldestPendingAt: number | null;
}

/** A claimed row changed owner; an enclosing domain transaction must roll back. */
export class IncomingEventClaimLostError extends Error {
  constructor() {
    super('incoming event claim is no longer current');
    this.name = 'IncomingEventClaimLostError';
  }
}

/** 30s, 60s, 120s, 240s, 480s; kept explicit in SQL by markIncomingEventFailed. */
export function incomingEventBackoffMs(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new RangeError('attempt must be a positive safe integer');
  }
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 3_600_000);
}

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

function sampleIncomingEventClock(clock: IncomingEventClock): number {
  const now = clock();
  assertTimestamp(now, 'incoming-event clock');
  return now;
}

function assertGuard(guard: DbCommitGuard): void {
  if (!guard()) throw new DbCommitGuardRejectedError();
}

function validateNewEvent(event: NewIncomingEvent, now: number): number {
  assertBoundedText(event.eventKey, 'eventKey', EVENT_KEY_MAX_BYTES);
  assertBoundedText(event.orderingKey, 'orderingKey', ORDERING_KEY_MAX_BYTES);
  assertBoundedText(event.eventName, 'eventName', EVENT_NAME_MAX_BYTES);
  if (!SHA256_HEX.test(event.payloadDigest)) {
    throw new TypeError('payloadDigest must be lowercase SHA-256 hex');
  }
  if (event.source !== 'socket' && event.source !== 'fcm' && event.source !== 'dev') {
    throw new TypeError('source must be socket, fcm, or dev');
  }
  const schemaVersion = event.schemaVersion ?? 1;
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
    throw new RangeError('schemaVersion must be a positive safe integer');
  }
  assertTimestamp(event.receivedAt, 'receivedAt');
  assertTimestamp(event.expiresAt, 'expiresAt');
  if (event.receivedAt > now) {
    throw new RangeError('receivedAt must use the local intake time and must not be in the future');
  }
  if (event.expiresAt <= event.receivedAt) {
    throw new RangeError('expiresAt must be later than receivedAt');
  }
  if (event.expiresAt - event.receivedAt > INCOMING_EVENT_MAX_PENDING_AGE_MS) {
    throw new RangeError('expiresAt exceeds the maximum durable event lifetime');
  }
  if (event.payload.length === 0) throw new RangeError('payload must not be empty');
  const payloadBytes = utf8Bytes(event.payload);
  // An oversized event is retained only as a payload-cleared poison receipt. Do not spend CPU
  // parsing attacker-controlled JSON that the queue is guaranteed to reject.
  if (payloadBytes > INCOMING_EVENT_MAX_PAYLOAD_BYTES) return payloadBytes;
  try {
    JSON.parse(event.payload);
  } catch {
    throw new TypeError('payload must be valid canonical JSON');
  }
  return payloadBytes;
}

function validateLeaseToken(leaseToken: string): void {
  assertBoundedText(leaseToken, 'leaseToken', LEASE_TOKEN_MAX_BYTES);
}

function validateClaimIdentity(claim: IncomingEventClaimIdentity): void {
  if (!Number.isSafeInteger(claim.id) || claim.id < 1) {
    throw new RangeError('claim id must be a positive safe integer');
  }
  if (!Number.isSafeInteger(claim.claimVersion) || claim.claimVersion < 1) {
    throw new RangeError('claim version must be a positive safe integer');
  }
  validateLeaseToken(claim.leaseToken);
}

function normalizeFailureCode(value: string): string {
  const normalized = value.toLowerCase();
  if (
    !FAILURE_CODE.test(normalized) ||
    utf8Bytes(normalized) === 0 ||
    utf8Bytes(normalized) > FAILURE_CODE_MAX_BYTES
  ) {
    return 'unknown';
  }
  return normalized;
}

/**
 * Scrub expired/exhausted pending payloads once no active lease can still finish them.
 * Attempts advance on CLAIM, so this also catches a process death during the fifth attempt.
 */
async function terminalizeExpiredOrExhausted(
  context: DbTransactionContext,
  now: number,
): Promise<void> {
  await runInTransactionContext(context, async (db) => {
    await db.run(sql`
      UPDATE incoming_event_queue
         SET state = 'poisoned',
             payload = NULL,
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
         AND (expires_at <= ${now} OR attempts >= ${INCOMING_EVENT_MAX_ATTEMPTS})`);
  });
}

/** Delete old/excess terminal receipts without ever evicting pending work. */
async function trimTerminalReceipts(context: DbTransactionContext, now: number): Promise<void> {
  await runInTransactionContext(context, async (db) => {
    const oldestAllowed = Math.max(0, now - INCOMING_EVENT_TERMINAL_MAX_AGE_MS);
    await db.run(sql`
      WITH ranked_terminal AS (
        SELECT id,
               ROW_NUMBER() OVER (ORDER BY terminal_at DESC, id DESC) AS newest_rank
          FROM incoming_event_queue
         WHERE state IN ('completed', 'poisoned')
           AND terminal_at >= ${oldestAllowed}
      ), retained_terminal AS (
        SELECT id FROM ranked_terminal
         WHERE newest_rank <= ${INCOMING_EVENT_TERMINAL_CAPACITY}
      )
      DELETE FROM incoming_event_queue
       WHERE state IN ('completed', 'poisoned')
         AND id NOT IN (SELECT id FROM retained_terminal)`);
  });
}

/** Transaction-only maintenance body; callers below own the one outer transaction. */
async function maintainRows(context: DbTransactionContext, now: number): Promise<void> {
  await runInTransactionContext(context, async () => {
    await terminalizeExpiredOrExhausted(context, now);
    await trimTerminalReceipts(context, now);
  });
}

interface PreparedIncomingEvent {
  readonly payloadBytes: number;
  readonly schemaVersion: number;
}

function prepareIncomingEvent(event: NewIncomingEvent, now: number): PreparedIncomingEvent {
  assertTimestamp(now, 'now');
  const payloadBytes = validateNewEvent(event, now);
  return {
    payloadBytes,
    schemaVersion: event.schemaVersion ?? 1,
  };
}

/** Transaction-only intake body. The caller must own the one outer transaction. */
async function enqueuePreparedIncomingEvent(
  context: DbTransactionContext,
  event: NewIncomingEvent,
  prepared: PreparedIncomingEvent,
  now: number,
): Promise<EnqueueIncomingEventResult> {
  return runInTransactionContext(context, async (db) => {
    const { payloadBytes, schemaVersion } = prepared;
    const intakePoison =
      payloadBytes > INCOMING_EVENT_MAX_PAYLOAD_BYTES
        ? 'payload-too-large'
        : event.expiresAt <= now
          ? 'expired'
          : null;
    const inserted = await db.all<{ id: number }>(sql`
      INSERT INTO incoming_event_queue (
        event_key, payload_digest, ordering_key, schema_version, event_name, source, payload,
        received_at, expires_at, state, terminal_at, last_error_code
      ) VALUES (
        ${event.eventKey}, ${event.payloadDigest}, ${event.orderingKey}, ${schemaVersion},
        ${event.eventName}, ${event.source}, ${intakePoison ? null : event.payload},
        ${event.receivedAt}, ${event.expiresAt},
        ${intakePoison ? 'poisoned' : 'pending'},
        ${intakePoison ? now : null}, ${intakePoison}
      )
      ON CONFLICT(event_key) DO NOTHING
      RETURNING id`);

    const insertedId = inserted[0]?.id;
    if (insertedId == null) {
      const existing = await db.all<{
        id: number;
        payloadDigest: string;
        orderingKey: string;
        schemaVersion: number;
        eventName: string;
        source: EventSource;
        state: IncomingEventState;
      }>(sql`
        SELECT id,
               payload_digest AS payloadDigest,
               ordering_key AS orderingKey,
               schema_version AS schemaVersion,
               event_name AS eventName,
               source,
               state
          FROM incoming_event_queue
         WHERE event_key = ${event.eventKey}
         LIMIT 1`);
      const row = existing[0];
      if (!row) throw new Error('incoming event conflict row disappeared');
      return row.payloadDigest === event.payloadDigest &&
        row.orderingKey === event.orderingKey &&
        row.schemaVersion === schemaVersion &&
        row.eventName === event.eventName
        ? { status: 'duplicate', id: row.id, state: row.state }
        : {
            status: 'key-conflict',
            id: row.id,
            existingSource: row.source,
            existingState: row.state,
          };
    }

    if (intakePoison) {
      await trimTerminalReceipts(context, now);
      return { status: 'poisoned', id: insertedId, reason: intakePoison };
    }

    const totals = await db.all<{ rows: number; bytes: number }>(sql`
      SELECT COUNT(*) AS rows,
             COALESCE(SUM(length(CAST(payload AS BLOB))), 0) AS bytes
        FROM incoming_event_queue
       WHERE state = 'pending'`);
    const total = totals[0] ?? { rows: 0, bytes: 0 };
    if (
      total.rows > INCOMING_EVENT_PENDING_CAPACITY ||
      total.bytes > INCOMING_EVENT_PENDING_BYTE_BUDGET
    ) {
      await db.run(sql`
        UPDATE incoming_event_queue
           SET state = 'poisoned', payload = NULL, terminal_at = ${now},
               last_error_code = 'queue-full'
         WHERE id = ${insertedId}`);
      await trimTerminalReceipts(context, now);
      return { status: 'poisoned', id: insertedId, reason: 'queue-full' };
    }

    return { status: 'enqueued', id: insertedId };
  });
}

/**
 * Persist one validated canonical envelope before any EventRouter/sink side effect.
 *
 * The transaction owns cleanup + insert + capacity admission, so a concurrent intake cannot push
 * the pending table over either bound. Existing pending work is never evicted to admit a newcomer;
 * the refused event becomes a payload-cleared poison receipt and normal sync remains recovery.
 */
export async function enqueueIncomingEvent(
  db: AppDatabase,
  event: NewIncomingEvent,
  guard: DbCommitGuard,
  clock: IncomingEventClock = Date.now,
): Promise<EnqueueIncomingEventResult> {
  // Validate and bound the payload before waiting for the writer queue. Admission/maintenance
  // still sample again after lock acquisition so a delayed event cannot enter as freshly pending.
  const prepared = prepareIncomingEvent(event, sampleIncomingEventClock(clock));

  return withDbTransaction(
    db,
    async (context) => {
      const now = sampleIncomingEventClock(clock);
      await maintainRows(context, now);
      return enqueuePreparedIncomingEvent(context, event, prepared, now);
    },
    guard,
  );
}

/**
 * DEV-proof primitive: while holding one transaction, require an empty pending queue, insert one
 * validated envelope, and lease that exact inserted id. It never composes the public transacting
 * enqueue/claim helpers, so it cannot nest the process-wide DB mutex.
 */
export async function enqueueAndClaimIncomingEventIfQueueEmpty(
  db: AppDatabase,
  event: NewIncomingEvent,
  options: { readonly now: number; readonly clock: () => number; readonly leaseToken: string },
  guard: DbCommitGuard,
): Promise<EnqueueAndClaimIncomingEventResult> {
  const prepared = prepareIncomingEvent(event, options.now);
  validateLeaseToken(options.leaseToken);

  return withDbTransaction(
    db,
    async (context) => {
      const now = options.clock();
      assertTimestamp(now, 'now');
      const leaseExpiresAt = now + INCOMING_EVENT_LEASE_MS;
      assertTimestamp(leaseExpiresAt, 'leaseExpiresAt');
      await maintainRows(context, now);
      const pending = await db.all<{ count: number }>(sql`
        SELECT COUNT(*) AS count
          FROM incoming_event_queue
         WHERE state = 'pending'`);
      if ((pending[0]?.count ?? 0) !== 0) return { status: 'queue-not-empty' };

      const result = await enqueuePreparedIncomingEvent(context, event, prepared, now);
      if (result.status !== 'enqueued') return { status: 'not-enqueued', result };

      assertGuard(guard);
      const claimed = await db.all<ClaimedIncomingEvent>(sql`
        UPDATE incoming_event_queue
           SET attempts = attempts + 1,
               claim_version = claim_version + 1,
               lease_token = ${options.leaseToken},
               lease_expires_at = ${leaseExpiresAt}
         WHERE id = ${result.id}
           AND state = 'pending'
           AND attempts = 0
           AND expires_at > ${now}
           AND next_attempt_at <= ${now}
           AND lease_expires_at <= ${now}
        RETURNING id,
                  event_key AS eventKey,
                  payload_digest AS payloadDigest,
                  ordering_key AS orderingKey,
                  schema_version AS schemaVersion,
                  event_name AS eventName,
                  source,
                  payload,
                  received_at AS receivedAt,
                  expires_at AS expiresAt,
                  attempts,
                  claim_version AS claimVersion,
                  lease_token AS leaseToken,
                  lease_expires_at AS leaseExpiresAt,
                  db_applied_at AS dbAppliedAt`);
      const claim = claimed[0];
      if (!claim || claimed.length !== 1) {
        throw new Error('new incoming event could not be claimed inside its intake transaction');
      }
      assertGuard(guard);
      return { status: 'claimed', result, claim };
    },
    guard,
  );
}

/**
 * Atomically lease the oldest due rows, while preserving FIFO for each ordering key.
 * Attempts increment here—not on failure—so a hard process death consumes an attempt too.
 */
export async function claimIncomingEvents(
  db: AppDatabase,
  options: { readonly clock: () => number; readonly limit?: number; readonly leaseToken: string },
  guard: DbCommitGuard,
): Promise<ClaimedIncomingEvent[]> {
  validateLeaseToken(options.leaseToken);
  const requestedLimit = options.limit ?? 1;
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 0) {
    throw new RangeError('claim limit must be a non-negative safe integer');
  }
  const limit = Math.min(INCOMING_EVENT_MAX_CLAIM_BATCH, requestedLimit);
  if (limit === 0) return [];

  const rows: ClaimedIncomingEvent[] = await withDbTransaction(
    db,
    async (context) => {
      const now = options.clock();
      assertTimestamp(now, 'now');
      const leaseExpiresAt = now + INCOMING_EVENT_LEASE_MS;
      assertTimestamp(leaseExpiresAt, 'leaseExpiresAt');
      await maintainRows(context, now);
      return db.all<ClaimedIncomingEvent>(sql`
        WITH eligible AS (
          SELECT q.id,
                 q.received_at,
                 length(CAST(q.payload AS BLOB)) AS payload_bytes
            FROM incoming_event_queue q
           WHERE q.state = 'pending'
             AND q.attempts < ${INCOMING_EVENT_MAX_ATTEMPTS}
             AND q.expires_at > ${now}
             AND q.next_attempt_at <= ${now}
             AND q.lease_expires_at <= ${now}
             AND NOT EXISTS (
               SELECT 1
                 FROM incoming_event_queue older
                WHERE older.state = 'pending'
                  AND older.ordering_key = q.ordering_key
                  AND older.id < q.id
                  AND (q.db_applied_at IS NOT NULL OR older.db_applied_at IS NULL)
             )
             AND (
               q.db_applied_at IS NULL
               OR NOT EXISTS (
                 SELECT 1
                   FROM incoming_event_queue newer
                  WHERE newer.state = 'pending'
                    AND newer.ordering_key = q.ordering_key
                    AND newer.id > q.id
                    AND newer.db_applied_at IS NULL
               )
             )
           ORDER BY q.received_at ASC, q.id ASC
           LIMIT ${limit}
        ), budgeted AS (
          SELECT id,
                 SUM(payload_bytes) OVER (
                   ORDER BY received_at ASC, id ASC
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                 ) AS cumulative_payload_bytes
            FROM eligible
        ), due AS (
          SELECT id
            FROM budgeted
           WHERE cumulative_payload_bytes <= ${INCOMING_EVENT_MAX_CLAIM_PAYLOAD_BYTES}
        )
        UPDATE incoming_event_queue
           SET attempts = attempts + 1,
               claim_version = claim_version + 1,
               lease_token = ${options.leaseToken},
               lease_expires_at = ${leaseExpiresAt}
         WHERE id IN (SELECT id FROM due)
        RETURNING id,
                  event_key AS eventKey,
                  payload_digest AS payloadDigest,
                  ordering_key AS orderingKey,
                  schema_version AS schemaVersion,
                  event_name AS eventName,
                  source,
                  payload,
                  received_at AS receivedAt,
                  expires_at AS expiresAt,
                  attempts,
                  claim_version AS claimVersion,
                  lease_token AS leaseToken,
                  lease_expires_at AS leaseExpiresAt,
                  db_applied_at AS dbAppliedAt`);
    },
    guard,
  );
  return rows.sort((a, b) => a.receivedAt - b.receivedAt || a.id - b.id);
}

/**
 * Record the authoritative DB phase inside the SAME outer transaction as the domain writes.
 * This helper deliberately does not open a transaction. A forged, stale, or outside-owner context
 * is rejected at runtime before the write can run.
 */
export async function markIncomingEventDbAppliedWithinTransaction(
  context: DbTransactionContext,
  claim: IncomingEventClaimIdentity & { readonly now: number },
  guard: DbCommitGuard,
): Promise<void> {
  await runInTransactionContext(context, async (db) => {
    assertTimestamp(claim.now, 'now');
    validateClaimIdentity(claim);
    assertGuard(guard);
    const rows = await db.all<{ id: number }>(sql`
      UPDATE incoming_event_queue
         SET db_applied_at = COALESCE(db_applied_at, ${claim.now})
       WHERE id = ${claim.id}
         AND state = 'pending'
         AND lease_token = ${claim.leaseToken}
         AND claim_version = ${claim.claimVersion}
      RETURNING id`);
    if (rows.length === 0) throw new IncomingEventClaimLostError();
    assertGuard(guard);
  });
}

/** Mark one exact leased row successful and scrub its private payload. */
export async function completeIncomingEvent(
  db: AppDatabase,
  claim: IncomingEventClaimIdentity,
  guard: DbCommitGuard,
  clock: IncomingEventClock = Date.now,
): Promise<boolean> {
  validateClaimIdentity(claim);
  return withDbTransaction(
    db,
    async (context) => {
      const now = sampleIncomingEventClock(clock);
      const rows = await db.all<{ id: number }>(sql`
        UPDATE incoming_event_queue
           SET state = 'completed', payload = NULL, next_attempt_at = 0,
               lease_token = NULL, lease_expires_at = 0, terminal_at = ${now},
               last_error_code = NULL
         WHERE id = ${claim.id}
           AND state = 'pending'
           AND lease_token = ${claim.leaseToken}
           AND claim_version = ${claim.claimVersion}
        RETURNING id`);
      await trimTerminalReceipts(context, now);
      return rows.length > 0;
    },
    guard,
  );
}

/**
 * Permanently reject one exact leased row after a non-retryable decode/schema/integrity failure.
 * The private payload is scrubbed immediately; only bounded receipt metadata and a machine code
 * remain for duplicate suppression and diagnostics.
 */
export async function poisonIncomingEvent(
  db: AppDatabase,
  claim: IncomingEventClaimIdentity & { readonly errorCode: string },
  guard: DbCommitGuard,
  clock: IncomingEventClock = Date.now,
): Promise<boolean> {
  validateClaimIdentity(claim);
  const errorCode = normalizeFailureCode(claim.errorCode);
  return withDbTransaction(
    db,
    async (context) => {
      const now = sampleIncomingEventClock(clock);
      const rows = await db.all<{ id: number }>(sql`
        UPDATE incoming_event_queue
           SET state = 'poisoned', payload = NULL, next_attempt_at = 0,
               lease_token = NULL, lease_expires_at = 0, terminal_at = ${now},
               last_error_code = ${errorCode}
         WHERE id = ${claim.id}
           AND state = 'pending'
           AND lease_token = ${claim.leaseToken}
           AND claim_version = ${claim.claimVersion}
        RETURNING id`);
      await trimTerminalReceipts(context, now);
      return rows.length > 0;
    },
    guard,
  );
}

/** Reschedule one exact lease, or poison/scrub it at expiry or the fifth claimed attempt. */
export async function failIncomingEvent(
  db: AppDatabase,
  claim: IncomingEventClaimIdentity & { readonly errorCode: string },
  guard: DbCommitGuard,
  clock: IncomingEventClock = Date.now,
): Promise<FailIncomingEventResult> {
  validateClaimIdentity(claim);
  const errorCode = normalizeFailureCode(claim.errorCode);
  return withDbTransaction(
    db,
    async (context) => {
      const now = sampleIncomingEventClock(clock);
      assertTimestamp(now + incomingEventBackoffMs(INCOMING_EVENT_MAX_ATTEMPTS), 'nextAttemptAt');
      const rows = await db.all<{
        state: IncomingEventState;
        attempts: number;
        nextAttemptAt: number;
      }>(sql`
        UPDATE incoming_event_queue
           SET state = CASE
                 WHEN attempts >= ${INCOMING_EVENT_MAX_ATTEMPTS} OR expires_at <= ${now}
                 THEN 'poisoned' ELSE 'pending' END,
               payload = CASE
                 WHEN attempts >= ${INCOMING_EVENT_MAX_ATTEMPTS} OR expires_at <= ${now}
                 THEN NULL ELSE payload END,
               next_attempt_at = CASE
                 WHEN attempts >= ${INCOMING_EVENT_MAX_ATTEMPTS} OR expires_at <= ${now}
                 THEN 0
                 ELSE ${now} + CASE attempts
                   WHEN 1 THEN 30000
                   WHEN 2 THEN 60000
                   WHEN 3 THEN 120000
                   WHEN 4 THEN 240000
                   ELSE 480000
                 END
               END,
               lease_token = NULL,
               lease_expires_at = 0,
               terminal_at = CASE
                 WHEN attempts >= ${INCOMING_EVENT_MAX_ATTEMPTS} OR expires_at <= ${now}
                 THEN ${now} ELSE NULL END,
               last_error_code = CASE
                 WHEN expires_at <= ${now} THEN 'expired' ELSE ${errorCode} END
         WHERE id = ${claim.id}
           AND state = 'pending'
           AND lease_token = ${claim.leaseToken}
           AND claim_version = ${claim.claimVersion}
        RETURNING state, attempts, next_attempt_at AS nextAttemptAt`);
      const row = rows[0];
      if (!row) return { status: 'stale' };
      if (row.state === 'poisoned') {
        await trimTerminalReceipts(context, now);
        return { status: 'poisoned', attempts: row.attempts };
      }
      return {
        status: 'retry-scheduled',
        attempts: row.attempts,
        nextAttemptAt: row.nextAttemptAt,
      };
    },
    guard,
  );
}

/** Expire exhausted work and trim receipts under the account's revocable write guard. */
export async function maintainIncomingEvents(
  db: AppDatabase,
  clock: IncomingEventClock,
  guard: DbCommitGuard,
): Promise<void> {
  await withDbTransaction(
    db,
    (context) => maintainRows(context, sampleIncomingEventClock(clock)),
    guard,
  );
}

/**
 * Earliest time a warm process should run queue maintenance or retry work.
 *
 * Authoritative DB mutations remain FIFO, but a successor may pass an older row whose DB phase is
 * already checkpointed and whose presentation phase is backing off. Presentation retries wait
 * until every newer authoritative mutation for that key converges, then resume oldest-first. The
 * result is metadata-only and does not materialize private payloads.
 */
export async function getNextIncomingEventWakeAt(
  db: AppDatabase,
  now: number,
): Promise<number | null> {
  assertTimestamp(now, 'now');
  const rows = await db.all<{ wakeAt: number | null }>(sql`
    WITH ordering_heads AS (
      SELECT q.attempts, q.next_attempt_at, q.lease_expires_at, q.expires_at
        FROM incoming_event_queue q
       WHERE q.state = 'pending'
         AND NOT EXISTS (
           SELECT 1
             FROM incoming_event_queue older
            WHERE older.state = 'pending'
              AND older.ordering_key = q.ordering_key
              AND older.id < q.id
              AND (q.db_applied_at IS NOT NULL OR older.db_applied_at IS NULL)
         )
         AND (
           q.db_applied_at IS NULL
           OR NOT EXISTS (
             SELECT 1
               FROM incoming_event_queue newer
              WHERE newer.state = 'pending'
                AND newer.ordering_key = q.ordering_key
                AND newer.id > q.id
                AND newer.db_applied_at IS NULL
           )
         )
    )
    SELECT MIN(
      CASE
        WHEN attempts >= ${INCOMING_EVENT_MAX_ATTEMPTS}
        THEN MAX(${now}, lease_expires_at)
        ELSE MAX(${now}, lease_expires_at, MIN(expires_at, next_attempt_at))
      END
    ) AS wakeAt
    FROM ordering_heads`);
  return rows[0]?.wakeAt ?? null;
}

/** Bounded aggregate for diagnostics; it never returns payloads or identifying keys. */
export async function getIncomingEventQueueHealth(
  db: AppDatabase,
  now: number,
): Promise<IncomingEventQueueHealth> {
  assertTimestamp(now, 'now');
  const rows = await db.all<IncomingEventQueueHealth>(sql`
    SELECT
      SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN state = 'pending' AND next_attempt_at <= ${now}
                    AND lease_expires_at <= ${now} AND expires_at > ${now}
                    AND attempts < ${INCOMING_EVENT_MAX_ATTEMPTS} THEN 1 ELSE 0 END) AS due,
      SUM(CASE WHEN state = 'pending' AND lease_expires_at > ${now} THEN 1 ELSE 0 END) AS leased,
      SUM(CASE WHEN state = 'pending' AND db_applied_at IS NOT NULL THEN 1 ELSE 0 END)
        AS dbAppliedPending,
      SUM(CASE WHEN state = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN state = 'poisoned' THEN 1 ELSE 0 END) AS poisoned,
      COALESCE(SUM(CASE WHEN state = 'pending'
                        THEN length(CAST(payload AS BLOB)) ELSE 0 END), 0) AS pendingPayloadBytes,
      MIN(CASE WHEN state = 'pending' THEN received_at END) AS oldestPendingAt
    FROM incoming_event_queue`);
  const row = rows[0];
  return {
    pending: row?.pending ?? 0,
    due: row?.due ?? 0,
    leased: row?.leased ?? 0,
    dbAppliedPending: row?.dbAppliedPending ?? 0,
    completed: row?.completed ?? 0,
    poisoned: row?.poisoned ?? 0,
    pendingPayloadBytes: row?.pendingPayloadBytes ?? 0,
    oldestPendingAt: row?.oldestPendingAt ?? null,
  };
}
