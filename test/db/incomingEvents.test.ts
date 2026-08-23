import type Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import {
  INCOMING_EVENT_LEASE_MS,
  INCOMING_EVENT_MAX_CLAIM_PAYLOAD_BYTES,
  INCOMING_EVENT_MAX_ATTEMPTS,
  INCOMING_EVENT_MAX_PAYLOAD_BYTES,
  INCOMING_EVENT_PENDING_BYTE_BUDGET,
  INCOMING_EVENT_PENDING_CAPACITY,
  INCOMING_EVENT_TERMINAL_CAPACITY,
  INCOMING_EVENT_TERMINAL_MAX_AGE_MS,
  claimIncomingEvents,
  completeIncomingEvent as completeIncomingEventWithClock,
  enqueueAndClaimIncomingEventIfQueueEmpty,
  enqueueIncomingEvent as enqueueIncomingEventWithClock,
  failIncomingEvent as failIncomingEventWithClock,
  getIncomingEventQueueHealth,
  getNextIncomingEventWakeAt,
  incomingEventBackoffMs,
  maintainIncomingEvents as maintainIncomingEventsWithClock,
  markIncomingEventDbAppliedWithinTransaction,
  poisonIncomingEvent as poisonIncomingEventWithClock,
  type ClaimedIncomingEvent,
  type EnqueueAndClaimIncomingEventResult,
  type NewIncomingEvent,
} from '@db/repositories';
import {
  DbCommitGuardRejectedError,
  DbTransactionContextRejectedError,
  withDbTransaction,
  type DbCommitGuard,
  type DbTransactionContext,
} from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

const BASE = 1_000;
const NOW = 10_000;
const EXPIRY = 1_200_000;
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const ALLOW: DbCommitGuard = () => true;
const TERMINAL_MATRIX_ERROR = 'matrix-failure';
const TERMINAL_OPERATIONS = ['complete', 'poison', 'fail'] as const;

const clockAt =
  (now: number): (() => number) =>
  () =>
    now;

type TerminalOperation = (typeof TERMINAL_OPERATIONS)[number];

interface TerminalQueueRow {
  state: 'pending' | 'completed' | 'poisoned';
  payload: string | null;
  attempts: number;
  leaseToken: string | null;
  nextAttemptAt: number;
  terminalAt: number | null;
  lastErrorCode: string | null;
}

interface ClaimQueueRow {
  state: 'pending' | 'poisoned';
  payload: string | null;
  attempts: number;
  claimVersion: number;
  leaseToken: string | null;
  leaseExpiresAt: number;
  terminalAt: number | null;
  lastErrorCode: string | null;
}

const nextEventLoopTurn = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

function incoming(eventKey: string, overrides: Partial<NewIncomingEvent> = {}): NewIncomingEvent {
  return {
    eventKey,
    payloadDigest: DIGEST_A,
    orderingKey: `ordering:${eventKey}`,
    schemaVersion: 1,
    eventName: 'new-message',
    source: 'fcm',
    payload: '{}',
    receivedAt: BASE,
    expiresAt: EXPIRY,
    ...overrides,
  };
}

function onlyClaim(rows: ClaimedIncomingEvent[]): ClaimedIncomingEvent {
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (!row) throw new Error('expected one claimed incoming event');
  return row;
}

function claimAt(rows: ClaimedIncomingEvent[], index: number): ClaimedIncomingEvent {
  const row = rows[index];
  if (!row) throw new Error(`expected a claimed incoming event at index ${index}`);
  return row;
}

function exactClaim(claim: ClaimedIncomingEvent): {
  id: number;
  leaseToken: string;
  claimVersion: number;
} {
  return {
    id: claim.id,
    leaseToken: claim.leaseToken,
    claimVersion: claim.claimVersion,
  };
}

function enqueueIncomingEvent(
  db: AppDatabase,
  event: NewIncomingEvent,
  guard: DbCommitGuard,
  now: number,
) {
  return enqueueIncomingEventWithClock(db, event, guard, clockAt(now));
}

function completeIncomingEvent(
  db: AppDatabase,
  claim: ReturnType<typeof exactClaim> & { now: number },
  guard: DbCommitGuard,
) {
  const { now, ...identity } = claim;
  return completeIncomingEventWithClock(db, identity, guard, clockAt(now));
}

function poisonIncomingEvent(
  db: AppDatabase,
  claim: ReturnType<typeof exactClaim> & { now: number; errorCode: string },
  guard: DbCommitGuard,
) {
  const { now, ...identity } = claim;
  return poisonIncomingEventWithClock(db, identity, guard, clockAt(now));
}

function failIncomingEvent(
  db: AppDatabase,
  claim: ReturnType<typeof exactClaim> & { now: number; errorCode: string },
  guard: DbCommitGuard,
) {
  const { now, ...identity } = claim;
  return failIncomingEventWithClock(db, identity, guard, clockAt(now));
}

function maintainIncomingEvents(db: AppDatabase, now: number, guard: DbCommitGuard) {
  return maintainIncomingEventsWithClock(db, clockAt(now), guard);
}

async function prepareTerminalClaim(
  db: AppDatabase,
  raw: Database.Database,
  operation: TerminalOperation,
  eventKey: string,
  intakeNow: number,
  terminalFail: boolean,
): Promise<ClaimedIncomingEvent> {
  await enqueueIncomingEvent(
    db,
    incoming(eventKey, { receivedAt: intakeNow, expiresAt: intakeNow + 60_000 }),
    ALLOW,
    intakeNow,
  );
  if (operation === 'fail' && terminalFail) {
    raw.prepare('UPDATE incoming_event_queue SET attempts = 4 WHERE event_key = ?').run(eventKey);
  }
  return onlyClaim(
    await claimIncomingEvents(
      db,
      { clock: () => intakeNow + 1, leaseToken: `${eventKey}-lease` },
      ALLOW,
    ),
  );
}

async function invokeTerminalOperation(
  operation: TerminalOperation,
  db: AppDatabase,
  claim: ClaimedIncomingEvent,
  now: number,
  guard: DbCommitGuard,
): Promise<unknown> {
  if (operation === 'complete') {
    return completeIncomingEvent(db, { ...exactClaim(claim), now }, guard);
  }
  if (operation === 'poison') {
    return poisonIncomingEvent(
      db,
      { ...exactClaim(claim), now, errorCode: TERMINAL_MATRIX_ERROR },
      guard,
    );
  }
  return failIncomingEvent(
    db,
    { ...exactClaim(claim), now, errorCode: TERMINAL_MATRIX_ERROR },
    guard,
  );
}

function expectedTerminalResult(
  operation: TerminalOperation,
  claim: ClaimedIncomingEvent,
  now: number,
  terminalFail: boolean,
): unknown {
  if (operation !== 'fail') return true;
  if (terminalFail) return { status: 'poisoned', attempts: claim.attempts };
  return {
    status: 'retry-scheduled',
    attempts: claim.attempts,
    nextAttemptAt: now + incomingEventBackoffMs(claim.attempts),
  };
}

function expectedTerminalRow(
  operation: TerminalOperation,
  claim: ClaimedIncomingEvent,
  now: number,
  terminalFail: boolean,
): TerminalQueueRow {
  if (operation === 'complete') {
    return {
      state: 'completed',
      payload: null,
      attempts: claim.attempts,
      leaseToken: null,
      nextAttemptAt: 0,
      terminalAt: now,
      lastErrorCode: null,
    };
  }
  if (operation === 'poison' || terminalFail) {
    return {
      state: 'poisoned',
      payload: null,
      attempts: claim.attempts,
      leaseToken: null,
      nextAttemptAt: 0,
      terminalAt: now,
      lastErrorCode: TERMINAL_MATRIX_ERROR,
    };
  }
  return {
    state: 'pending',
    payload: '{}',
    attempts: claim.attempts,
    leaseToken: null,
    nextAttemptAt: now + incomingEventBackoffMs(claim.attempts),
    terminalAt: null,
    lastErrorCode: TERMINAL_MATRIX_ERROR,
  };
}

function expectedClaimedRow(claim: ClaimedIncomingEvent): TerminalQueueRow {
  return {
    state: 'pending',
    payload: '{}',
    attempts: claim.attempts,
    leaseToken: claim.leaseToken,
    nextAttemptAt: 0,
    terminalAt: null,
    lastErrorCode: null,
  };
}

function readTerminalRow(raw: Database.Database, id: number): TerminalQueueRow | undefined {
  return raw
    .prepare(
      `SELECT state, payload, attempts, lease_token AS leaseToken,
              next_attempt_at AS nextAttemptAt, terminal_at AS terminalAt,
              last_error_code AS lastErrorCode
         FROM incoming_event_queue WHERE id = ?`,
    )
    .get(id) as TerminalQueueRow | undefined;
}

function seedOldTerminalReceipt(
  raw: Database.Database,
  eventKey: string,
  terminalAt: number,
): void {
  raw
    .prepare(
      `INSERT INTO incoming_event_queue (
         event_key, payload_digest, ordering_key, event_name, source, payload,
         received_at, expires_at, state, terminal_at
       ) VALUES (?, ?, ?, 'new-message', 'fcm', NULL, ?, ?, 'completed', ?)`,
    )
    .run(eventKey, DIGEST_A, `ordering:${eventKey}`, BASE, EXPIRY, terminalAt);
}

function seedPendingIncomingEvent(
  raw: Database.Database,
  eventKey: string,
  receivedAt: number,
  expiresAt: number,
): void {
  raw
    .prepare(
      `INSERT INTO incoming_event_queue (
         event_key, payload_digest, ordering_key, event_name, source, payload,
         received_at, expires_at
       ) VALUES (?, ?, ?, 'new-message', 'fcm', '{}', ?, ?)`,
    )
    .run(eventKey, DIGEST_A, `ordering:${eventKey}`, receivedAt, expiresAt);
}

function readClaimQueueRow(raw: Database.Database, eventKey: string): ClaimQueueRow | undefined {
  return raw
    .prepare(
      `SELECT state, payload, attempts, claim_version AS claimVersion,
              lease_token AS leaseToken, lease_expires_at AS leaseExpiresAt,
              terminal_at AS terminalAt, last_error_code AS lastErrorCode
         FROM incoming_event_queue WHERE event_key = ?`,
    )
    .get(eventKey) as ClaimQueueRow | undefined;
}

function unclaimedQueueRow(): ClaimQueueRow {
  return {
    state: 'pending',
    payload: '{}',
    attempts: 0,
    claimVersion: 0,
    leaseToken: null,
    leaseExpiresAt: 0,
    terminalAt: null,
    lastErrorCode: null,
  };
}

function claimedQueueRow(now: number, leaseToken: string): ClaimQueueRow {
  return {
    ...unclaimedQueueRow(),
    attempts: 1,
    claimVersion: 1,
    leaseToken,
    leaseExpiresAt: now + INCOMING_EVENT_LEASE_MS,
  };
}

function errorMessageChain(error: unknown): unknown[] {
  const messages: unknown[] = [];
  let current = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current != null; depth += 1) {
    const record = current as { message?: unknown; cause?: unknown };
    messages.push(record.message);
    current = record.cause;
  }
  return messages;
}

function queueCount(raw: Database.Database): number {
  return (
    raw.prepare('SELECT COUNT(*) AS count FROM incoming_event_queue').get() as { count: number }
  ).count;
}

function seedRawPending(
  raw: Database.Database,
  count: number,
  payload: string,
  prefix: string,
): void {
  const insert = raw.prepare(`
    INSERT INTO incoming_event_queue (
      event_key, payload_digest, ordering_key, event_name, source, payload,
      received_at, expires_at
    ) VALUES (?, ?, ?, 'new-message', 'fcm', ?, ?, ?)`);
  const insertMany = raw.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      insert.run(
        `${prefix}:event:${index}`,
        DIGEST_A,
        `${prefix}:ordering:${index}`,
        payload,
        BASE,
        EXPIRY,
      );
    }
  });
  insertMany();
}

describe('incoming event queue repository', () => {
  it('queues public intake maintenance and insertion behind a rolling-back neighbour', async () => {
    const { db, raw } = await createTestDb();
    const maintenanceNow = INCOMING_EVENT_TERMINAL_MAX_AGE_MS + 100_000;
    const staleTerminalAt = maintenanceNow - INCOMING_EVENT_TERMINAL_MAX_AGE_MS - 1;
    raw
      .prepare(
        `INSERT INTO incoming_event_queue (
           event_key, payload_digest, ordering_key, event_name, source, payload,
           received_at, expires_at, state, terminal_at
         ) VALUES (?, ?, ?, 'new-message', 'fcm', NULL, ?, ?, 'completed', ?)`,
      )
      .run(
        'rolling-neighbour-stale',
        DIGEST_A,
        'ordering:rolling-neighbour-stale',
        BASE,
        EXPIRY,
        staleTerminalAt,
      );

    let markNeighbourStarted!: () => void;
    let releaseNeighbour!: () => void;
    const neighbourStarted = new Promise<void>((resolve) => {
      markNeighbourStarted = resolve;
    });
    const holdNeighbour = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const neighbourError = new Error('incoming intake neighbour rollback');
    const neighbour = withDbTransaction(db, async () => {
      raw.prepare(`INSERT INTO kv (key, value) VALUES ('incoming.neighbour', 'phantom')`).run();
      markNeighbourStarted();
      await holdNeighbour;
      throw neighbourError;
    }).catch((error: unknown) => error);
    await neighbourStarted;

    let enqueueSettled = false;
    const enqueueOutcome = enqueueIncomingEvent(
      db,
      incoming('rolling-neighbour-fresh', {
        receivedAt: maintenanceNow,
        expiresAt: maintenanceNow + 60_000,
      }),
      ALLOW,
      maintenanceNow,
    )
      .then(
        (result) => ({ status: 'resolved' as const, result }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      )
      .finally(() => {
        enqueueSettled = true;
      });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const settledWhileHeld = enqueueSettled;
    const rowsWhileHeld = raw
      .prepare(`SELECT event_key AS eventKey FROM incoming_event_queue ORDER BY id`)
      .all();
    const phantomWhileHeld = raw
      .prepare(`SELECT value FROM kv WHERE key = 'incoming.neighbour'`)
      .get();

    releaseNeighbour();
    const [rolledBack, outcome] = await Promise.all([neighbour, enqueueOutcome]);

    expect(settledWhileHeld).toBe(false);
    expect(rowsWhileHeld).toEqual([{ eventKey: 'rolling-neighbour-stale' }]);
    expect(phantomWhileHeld).toEqual({ value: 'phantom' });
    expect(rolledBack).toBe(neighbourError);
    expect(outcome).toEqual({
      status: 'resolved',
      result: { status: 'enqueued', id: expect.any(Number) },
    });
    expect(
      raw.prepare(`SELECT value FROM kv WHERE key = 'incoming.neighbour'`).get(),
    ).toBeUndefined();
    expect(
      raw
        .prepare(
          `SELECT id, event_key AS eventKey, state, payload,
                  received_at AS receivedAt, expires_at AS expiresAt
             FROM incoming_event_queue ORDER BY id`,
        )
        .all(),
    ).toEqual([
      {
        id: outcome.status === 'resolved' ? outcome.result.id : expect.any(Number),
        eventKey: 'rolling-neighbour-fresh',
        state: 'pending',
        payload: '{}',
        receivedAt: maintenanceNow,
        expiresAt: maintenanceNow + 60_000,
      },
    ]);
  });

  it('poisons normal intake that expires while waiting for the writer lock', async () => {
    const { db, raw } = await createTestDb();
    const receivedAt = NOW;
    const expiredAtLockAcquisition = receivedAt + 11;
    let releaseNeighbour!: () => void;
    let markNeighbourStarted!: () => void;
    const neighbourStarted = new Promise<void>((resolve) => {
      markNeighbourStarted = resolve;
    });
    const neighbourHeld = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const neighbour = withDbTransaction(db, async () => {
      markNeighbourStarted();
      await neighbourHeld;
    });
    await neighbourStarted;

    let clockNow = receivedAt;
    const clock = jest.fn(() => clockNow);
    const outcome = enqueueIncomingEventWithClock(
      db,
      incoming('expires-behind-writer', {
        receivedAt,
        expiresAt: receivedAt + 10,
      }),
      ALLOW,
      clock,
    );

    await nextEventLoopTurn();
    expect(clock).toHaveBeenCalledTimes(1);
    clockNow = expiredAtLockAcquisition;
    releaseNeighbour();
    await neighbour;

    await expect(outcome).resolves.toEqual({
      status: 'poisoned',
      id: expect.any(Number),
      reason: 'expired',
    });
    expect(clock.mock.results.map((result) => result.value)).toEqual([
      receivedAt,
      expiredAtLockAcquisition,
    ]);
    expect(
      raw
        .prepare(
          `SELECT state, payload, terminal_at AS terminalAt, last_error_code AS lastErrorCode
             FROM incoming_event_queue WHERE event_key = ?`,
        )
        .get('expires-behind-writer'),
    ).toEqual({
      state: 'poisoned',
      payload: null,
      terminalAt: expiredAtLockAcquisition,
      lastErrorCode: 'expired',
    });
  });

  it('rolls public intake maintenance back when the fresh insertion fails', async () => {
    const { db, raw } = await createTestDb();
    const maintenanceNow = INCOMING_EVENT_TERMINAL_MAX_AGE_MS + 200_000;
    const staleTerminalAt = maintenanceNow - INCOMING_EVENT_TERMINAL_MAX_AGE_MS - 1;
    raw
      .prepare(
        `INSERT INTO incoming_event_queue (
           event_key, payload_digest, ordering_key, event_name, source, payload,
           received_at, expires_at, state, terminal_at
         ) VALUES (?, ?, ?, 'new-message', 'fcm', NULL, ?, ?, 'completed', ?)`,
      )
      .run(
        'failed-intake-stale',
        DIGEST_A,
        'ordering:failed-intake-stale',
        BASE,
        EXPIRY,
        staleTerminalAt,
      );
    raw.exec(`
      CREATE TRIGGER reject_exact_fresh_incoming
      BEFORE INSERT ON incoming_event_queue
      WHEN NEW.event_key = 'failed-intake-fresh'
      BEGIN
        SELECT RAISE(ABORT, 'INCOMING_ENQUEUE_RAW_CANARY');
      END
    `);

    await expect(
      enqueueIncomingEvent(
        db,
        incoming('failed-intake-fresh', {
          receivedAt: maintenanceNow,
          expiresAt: maintenanceNow + 60_000,
        }),
        ALLOW,
        maintenanceNow,
      ),
    ).rejects.toMatchObject({ message: 'INCOMING_ENQUEUE_RAW_CANARY' });

    expect(
      raw
        .prepare(
          `SELECT event_key AS eventKey, state, terminal_at AS terminalAt
             FROM incoming_event_queue ORDER BY id`,
        )
        .all(),
    ).toEqual([
      {
        eventKey: 'failed-intake-stale',
        state: 'completed',
        terminalAt: staleTerminalAt,
      },
    ]);
  });

  it('awaits delayed driver maintenance before inserting or resolving public intake', async () => {
    const { db, raw } = await createTestDb();
    seedRawPending(raw, 1, '{}', 'delayed-maintenance');
    const maintenanceNow = EXPIRY + 1;

    type Run = (query: unknown) => unknown;
    const realRun = db.run.bind(db) as Run;
    let maintenanceDelayed = false;
    let markMaintenanceStarted!: () => void;
    let releaseMaintenance!: () => void;
    const maintenanceStarted = new Promise<void>((resolve) => {
      markMaintenanceStarted = resolve;
    });
    const maintenanceGate = new Promise<void>((resolve) => {
      releaseMaintenance = resolve;
    });
    (db as unknown as { run: Run }).run = (query) => {
      const sqlShape = JSON.stringify(query);
      if (
        !maintenanceDelayed &&
        sqlShape.includes('incoming_event_queue') &&
        sqlShape.includes('attempt-cap')
      ) {
        maintenanceDelayed = true;
        markMaintenanceStarted();
        return maintenanceGate.then(() => realRun(query));
      }
      return realRun(query);
    };

    let enqueueSettled = false;
    const enqueueOutcome = enqueueIncomingEvent(
      db,
      incoming('delayed-maintenance-fresh', {
        receivedAt: maintenanceNow,
        expiresAt: maintenanceNow + 60_000,
      }),
      ALLOW,
      maintenanceNow,
    )
      .then(
        (result) => ({ status: 'resolved' as const, result }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      )
      .finally(() => {
        enqueueSettled = true;
      });
    await maintenanceStarted;
    const settledWhileMaintenanceHeld = enqueueSettled;
    const rowsWhileMaintenanceHeld = raw
      .prepare(
        `SELECT event_key AS eventKey, state, payload
           FROM incoming_event_queue ORDER BY id`,
      )
      .all();

    releaseMaintenance();
    const outcome = await enqueueOutcome;

    expect(settledWhileMaintenanceHeld).toBe(false);
    expect(rowsWhileMaintenanceHeld).toEqual([
      {
        eventKey: 'delayed-maintenance:event:0',
        state: 'pending',
        payload: '{}',
      },
    ]);
    expect(outcome).toEqual({
      status: 'resolved',
      result: { status: 'enqueued', id: expect.any(Number) },
    });
    expect(
      raw
        .prepare(
          `SELECT event_key AS eventKey, state, payload, last_error_code AS lastErrorCode
             FROM incoming_event_queue ORDER BY id`,
        )
        .all(),
    ).toEqual([
      {
        eventKey: 'delayed-maintenance:event:0',
        state: 'poisoned',
        payload: null,
        lastErrorCode: 'expired',
      },
      {
        eventKey: 'delayed-maintenance-fresh',
        state: 'pending',
        payload: '{}',
        lastErrorCode: null,
      },
    ]);
  });

  it('deduplicates the same digest and reports a conflicting digest for the same event key', async () => {
    const { db, raw } = await createTestDb();
    const first = await enqueueIncomingEvent(db, incoming('duplicate'), ALLOW, NOW);
    expect(first).toEqual({ status: 'enqueued', id: expect.any(Number) });

    const duplicate = await enqueueIncomingEvent(
      db,
      incoming('duplicate', { source: 'socket' }),
      ALLOW,
      NOW + 1,
    );
    expect(duplicate).toEqual({ status: 'duplicate', id: first.id, state: 'pending' });

    const conflict = await enqueueIncomingEvent(
      db,
      incoming('duplicate', { payloadDigest: DIGEST_B }),
      ALLOW,
      NOW + 2,
    );
    expect(conflict).toEqual({
      status: 'key-conflict',
      id: first.id,
      existingSource: 'fcm',
      existingState: 'pending',
    });
    await expect(
      enqueueIncomingEvent(
        db,
        incoming('duplicate', { eventName: 'updated-message' }),
        ALLOW,
        NOW + 3,
      ),
    ).resolves.toEqual({
      status: 'key-conflict',
      id: first.id,
      existingSource: 'fcm',
      existingState: 'pending',
    });
    expect(queueCount(raw)).toBe(1);
  });

  it('turns expired and oversized intake into payload-scrubbed poison receipts', async () => {
    const { db, raw } = await createTestDb();
    const oversizedPayload = JSON.stringify({ body: 'x'.repeat(INCOMING_EVENT_MAX_PAYLOAD_BYTES) });

    await expect(
      enqueueIncomingEvent(db, incoming('oversized', { payload: oversizedPayload }), ALLOW, NOW),
    ).resolves.toEqual({ status: 'poisoned', id: expect.any(Number), reason: 'payload-too-large' });
    await expect(
      enqueueIncomingEvent(
        db,
        incoming('expired', { receivedAt: BASE, expiresAt: BASE + 1 }),
        ALLOW,
        NOW,
      ),
    ).resolves.toEqual({ status: 'poisoned', id: expect.any(Number), reason: 'expired' });

    expect(
      raw
        .prepare(
          `SELECT event_key AS eventKey, state, payload, last_error_code AS lastErrorCode
             FROM incoming_event_queue ORDER BY id`,
        )
        .all(),
    ).toEqual([
      {
        eventKey: 'oversized',
        state: 'poisoned',
        payload: null,
        lastErrorCode: 'payload-too-large',
      },
      { eventKey: 'expired', state: 'poisoned', payload: null, lastErrorCode: 'expired' },
    ]);
  });

  it('measures text bounds in UTF-8 bytes and rejects malformed in-budget JSON', async () => {
    const { db } = await createTestDb();
    const exactly256Bytes = '🐊'.repeat(64);

    await expect(
      enqueueIncomingEvent(
        db,
        incoming(exactly256Bytes, { orderingKey: 'utf8-boundary' }),
        ALLOW,
        NOW,
      ),
    ).resolves.toEqual({ status: 'enqueued', id: expect.any(Number) });
    await expect(
      enqueueIncomingEvent(
        db,
        incoming('🐊'.repeat(65), { orderingKey: 'utf8-overflow' }),
        ALLOW,
        NOW,
      ),
    ).rejects.toThrow('eventKey must be 1..256 UTF-8 bytes');
    await expect(
      enqueueIncomingEvent(db, incoming('malformed-json', { payload: '{' }), ALLOW, NOW),
    ).rejects.toThrow('payload must be valid canonical JSON');
    await expect(
      enqueueIncomingEvent(
        db,
        incoming('future-receipt', { receivedAt: NOW + 1, expiresAt: NOW + 60_000 }),
        ALLOW,
        NOW,
      ),
    ).rejects.toThrow('receivedAt must use the local intake time');
  });

  it('rejects non-finite claim limits and malformed claim fences before touching SQLite', async () => {
    const { db, raw } = await createTestDb();
    await enqueueIncomingEvent(db, incoming('runtime-validation'), ALLOW, NOW);
    const invalidLimitClock = jest.fn(() => NOW);

    await expect(
      claimIncomingEvents(
        db,
        { clock: invalidLimitClock, limit: Number.NaN, leaseToken: 'bad-limit' },
        ALLOW,
      ),
    ).rejects.toThrow('claim limit must be a non-negative safe integer');
    expect(invalidLimitClock).not.toHaveBeenCalled();
    expect(
      raw
        .prepare(`SELECT attempts FROM incoming_event_queue WHERE event_key = ?`)
        .get('runtime-validation'),
    ).toEqual({ attempts: 0 });

    const claim = onlyClaim(
      await claimIncomingEvents(db, { clock: () => NOW, leaseToken: 'valid-claim' }, ALLOW),
    );
    await expect(
      completeIncomingEvent(db, { ...exactClaim(claim), id: 0, now: NOW + 1 }, ALLOW),
    ).rejects.toThrow('claim id must be a positive safe integer');
    await expect(
      failIncomingEvent(
        db,
        { ...exactClaim(claim), claimVersion: 0, now: NOW + 1, errorCode: 'bad-fence' },
        ALLOW,
      ),
    ).rejects.toThrow('claim version must be a positive safe integer');
  });

  it('claims oldest-first while allowing one event per independent ordering key', async () => {
    const { db } = await createTestDb();
    await enqueueIncomingEvent(
      db,
      incoming('a-1', { orderingKey: 'message:a', receivedAt: BASE }),
      ALLOW,
      NOW,
    );
    await enqueueIncomingEvent(
      db,
      incoming('a-2', { orderingKey: 'message:a', receivedAt: BASE + 2 }),
      ALLOW,
      NOW,
    );
    await enqueueIncomingEvent(
      db,
      incoming('b-1', { orderingKey: 'message:b', receivedAt: BASE + 1 }),
      ALLOW,
      NOW,
    );

    const firstBatch = await claimIncomingEvents(
      db,
      { clock: () => NOW, limit: 3, leaseToken: 'fifo-first' },
      ALLOW,
    );
    expect(firstBatch.map((row) => row.eventKey)).toEqual(['a-1', 'b-1']);

    const firstA = claimAt(firstBatch, 0);
    await completeIncomingEvent(db, { ...exactClaim(firstA), now: NOW + 1 }, ALLOW);
    const next = await claimIncomingEvents(
      db,
      { clock: () => NOW + 2, limit: 3, leaseToken: 'fifo-next' },
      ALLOW,
    );
    expect(next.map((row) => row.eventKey)).toEqual(['a-2']);
  });

  it.each([
    { revoke: false, ownership: 'current' },
    { revoke: true, ownership: 'revoked while queued' },
  ])('keeps a claim behind a rolling-back neighbour when $ownership', async ({ revoke }) => {
    const { db, raw } = await createTestDb();
    const eventKey = `claim-neighbour:${revoke ? 'revoked' : 'current'}`;
    const leaseToken = `claim-neighbour-lease:${revoke ? 'revoked' : 'current'}`;
    seedPendingIncomingEvent(raw, eventKey, BASE, EXPIRY);

    let markNeighbourStarted!: () => void;
    let releaseNeighbour!: () => void;
    const neighbourStarted = new Promise<void>((resolve) => {
      markNeighbourStarted = resolve;
    });
    const neighbourHeld = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const neighbourKey = `claim.neighbour.${revoke ? 'revoked' : 'current'}`;
    const neighbourError = new Error('claim neighbour rollback');
    const neighbour = withDbTransaction(db, async () => {
      raw.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run(neighbourKey, 'phantom');
      markNeighbourStarted();
      await neighbourHeld;
      throw neighbourError;
    }).catch((error: unknown) => error);
    await neighbourStarted;

    let current = true;
    let claimSettled = false;
    const claimOutcome = claimIncomingEvents(db, { clock: () => NOW, leaseToken }, () => current)
      .then(
        (value) => ({ kind: 'resolved' as const, value }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      )
      .finally(() => {
        claimSettled = true;
      });

    let observationError: unknown;
    try {
      await nextEventLoopTurn();
      expect(claimSettled).toBe(false);
      expect(readClaimQueueRow(raw, eventKey)).toEqual(unclaimedQueueRow());
      expect(raw.prepare('SELECT value FROM kv WHERE key = ?').get(neighbourKey)).toEqual({
        value: 'phantom',
      });
      if (revoke) current = false;
    } catch (error) {
      observationError = error;
    } finally {
      releaseNeighbour();
    }

    const [rolledBack, outcome] = await Promise.all([neighbour, claimOutcome]);
    if (observationError) throw observationError;
    expect(rolledBack).toBe(neighbourError);
    expect(raw.prepare('SELECT value FROM kv WHERE key = ?').get(neighbourKey)).toBeUndefined();
    if (revoke) {
      expect(outcome.kind).toBe('rejected');
      if (outcome.kind === 'rejected') {
        expect(outcome.error).toBeInstanceOf(DbCommitGuardRejectedError);
      }
      expect(readClaimQueueRow(raw, eventKey)).toEqual(unclaimedQueueRow());

      const freshLeaseToken = `${leaseToken}:fresh`;
      await expect(
        claimIncomingEvents(db, { clock: () => NOW, leaseToken: freshLeaseToken }, ALLOW),
      ).resolves.toEqual([
        expect.objectContaining({
          eventKey,
          attempts: 1,
          claimVersion: 1,
          leaseToken: freshLeaseToken,
          leaseExpiresAt: NOW + INCOMING_EVENT_LEASE_MS,
        }),
      ]);
      expect(readClaimQueueRow(raw, eventKey)).toEqual(claimedQueueRow(NOW, freshLeaseToken));
    } else {
      expect(outcome).toEqual({
        kind: 'resolved',
        value: [
          expect.objectContaining({
            eventKey,
            attempts: 1,
            claimVersion: 1,
            leaseToken,
            leaseExpiresAt: NOW + INCOMING_EVENT_LEASE_MS,
          }),
        ],
      });
      expect(readClaimQueueRow(raw, eventKey)).toEqual(claimedQueueRow(NOW, leaseToken));
    }
  });

  it('starts a queued claim lease from its post-lock clock and keeps it exclusive to the boundary', async () => {
    const { db, raw } = await createTestDb();
    const eventKey = 'claim-post-lock-clock';
    const leaseToken = 'claim-post-lock-clock:first';
    const competingLeaseToken = 'claim-post-lock-clock:competing';
    const t0 = NOW;
    const t1 = t0 + INCOMING_EVENT_LEASE_MS + 1;
    const firstLeaseBoundary = t1 + INCOMING_EVENT_LEASE_MS;
    const expiresAt = firstLeaseBoundary + INCOMING_EVENT_LEASE_MS;
    seedPendingIncomingEvent(raw, eventKey, t0, expiresAt);
    const seeded = raw
      .prepare('SELECT id FROM incoming_event_queue WHERE event_key = ?')
      .get(eventKey) as { id: number };

    let markNeighbourStarted!: () => void;
    let releaseNeighbour!: () => void;
    const neighbourStarted = new Promise<void>((resolve) => {
      markNeighbourStarted = resolve;
    });
    const neighbourHeld = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const neighbourKey = 'claim.post-lock-clock.neighbour';
    const neighbourError = new Error('post-lock clock neighbour rollback');
    const neighbourOutcome = withDbTransaction(db, async () => {
      raw.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run(neighbourKey, 'phantom');
      markNeighbourStarted();
      await neighbourHeld;
      throw neighbourError;
    }).then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
    await neighbourStarted;

    let clockNow = t0;
    const clock = jest.fn(() => clockNow);
    const claimAtCurrentTime = (token: string): Promise<ClaimedIncomingEvent[]> =>
      claimIncomingEvents(db, { clock, leaseToken: token }, ALLOW);
    let claimSettled = false;
    const queuedClaimOutcome = claimAtCurrentTime(leaseToken)
      .then(
        (value) => ({ kind: 'resolved' as const, value }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      )
      .finally(() => {
        claimSettled = true;
      });

    try {
      await nextEventLoopTurn();
      expect(clock).not.toHaveBeenCalled();
      expect(claimSettled).toBe(false);
      expect(raw.inTransaction).toBe(true);
      expect(readClaimQueueRow(raw, eventKey)).toEqual(unclaimedQueueRow());
      expect(raw.prepare('SELECT value FROM kv WHERE key = ?').get(neighbourKey)).toEqual({
        value: 'phantom',
      });

      clockNow = t1;
      releaseNeighbour();
      const [rolledBack, outcome] = await Promise.all([neighbourOutcome, queuedClaimOutcome]);
      expect(rolledBack).toEqual({ kind: 'rejected', error: neighbourError });
      expect(raw.prepare('SELECT value FROM kv WHERE key = ?').get(neighbourKey)).toBeUndefined();
      expect(clock).toHaveBeenCalledTimes(1);
      expect(outcome.kind).toBe('resolved');
      if (outcome.kind !== 'resolved') throw outcome.error;
      const firstClaim = onlyClaim(outcome.value);
      expect(firstClaim).toEqual({
        id: seeded.id,
        eventKey,
        payloadDigest: DIGEST_A,
        orderingKey: `ordering:${eventKey}`,
        schemaVersion: 1,
        eventName: 'new-message',
        source: 'fcm',
        payload: '{}',
        receivedAt: t0,
        expiresAt,
        attempts: 1,
        claimVersion: 1,
        leaseToken,
        leaseExpiresAt: firstLeaseBoundary,
        dbAppliedAt: null,
      });
      expect(readClaimQueueRow(raw, eventKey)).toEqual(claimedQueueRow(t1, leaseToken));

      await expect(claimAtCurrentTime(competingLeaseToken)).resolves.toEqual([]);
      clockNow = firstLeaseBoundary - 1;
      await expect(claimAtCurrentTime(competingLeaseToken)).resolves.toEqual([]);
      clockNow = firstLeaseBoundary;
      const reclaimed = onlyClaim(await claimAtCurrentTime(competingLeaseToken));
      expect(reclaimed).toEqual({
        ...firstClaim,
        attempts: 2,
        claimVersion: 2,
        leaseToken: competingLeaseToken,
        leaseExpiresAt: firstLeaseBoundary + INCOMING_EVENT_LEASE_MS,
      });
      expect(readClaimQueueRow(raw, eventKey)).toEqual({
        ...unclaimedQueueRow(),
        attempts: 2,
        claimVersion: 2,
        leaseToken: competingLeaseToken,
        leaseExpiresAt: firstLeaseBoundary + INCOMING_EVENT_LEASE_MS,
      });
      expect(clock).toHaveBeenCalledTimes(4);
    } finally {
      releaseNeighbour();
      await Promise.allSettled([neighbourOutcome, queuedClaimOutcome]);
    }
  });

  it('rolls maintenance and the exact claim back when its lease update fails, then retries', async () => {
    const { db, raw } = await createTestDb();
    const maintenanceNow = INCOMING_EVENT_TERMINAL_MAX_AGE_MS + 500_000;
    const dueKey = 'claim-atomic-due';
    const expiredKey = 'claim-atomic-expired';
    const staleTerminalKey = 'claim-atomic-stale-terminal';
    const staleTerminalAt = maintenanceNow - INCOMING_EVENT_TERMINAL_MAX_AGE_MS - 1;
    const leaseToken = 'claim-atomic-lease';
    const canary = 'CLAIM_UPDATE_RAW_CANARY';
    seedPendingIncomingEvent(raw, dueKey, maintenanceNow - 2, maintenanceNow + 60_000);
    seedPendingIncomingEvent(raw, expiredKey, maintenanceNow - 2, maintenanceNow - 1);
    seedOldTerminalReceipt(raw, staleTerminalKey, staleTerminalAt);
    raw.exec(`
      CREATE TRIGGER reject_exact_claim_update
      BEFORE UPDATE OF lease_token ON incoming_event_queue
      WHEN OLD.event_key = '${dueKey}' AND NEW.lease_token = '${leaseToken}'
      BEGIN
        SELECT RAISE(ABORT, '${canary}');
      END
    `);

    const failure = await claimIncomingEvents(
      db,
      { clock: () => maintenanceNow, leaseToken },
      ALLOW,
    ).then(
      (value) => ({ kind: 'resolved' as const, value }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
    expect(failure.kind).toBe('rejected');
    if (failure.kind === 'rejected') {
      expect(errorMessageChain(failure.error)).toContain(canary);
    }
    expect(readClaimQueueRow(raw, dueKey)).toEqual(unclaimedQueueRow());
    expect(readClaimQueueRow(raw, expiredKey)).toEqual(unclaimedQueueRow());
    expect(
      raw
        .prepare(
          'SELECT state, terminal_at AS terminalAt FROM incoming_event_queue WHERE event_key = ?',
        )
        .get(staleTerminalKey),
    ).toEqual({ state: 'completed', terminalAt: staleTerminalAt });

    raw.exec('DROP TRIGGER reject_exact_claim_update');
    await expect(
      claimIncomingEvents(db, { clock: () => maintenanceNow, leaseToken }, ALLOW),
    ).resolves.toEqual([
      expect.objectContaining({
        eventKey: dueKey,
        attempts: 1,
        claimVersion: 1,
        leaseToken,
        leaseExpiresAt: maintenanceNow + INCOMING_EVENT_LEASE_MS,
      }),
    ]);
    expect(readClaimQueueRow(raw, dueKey)).toEqual(claimedQueueRow(maintenanceNow, leaseToken));
    expect(readClaimQueueRow(raw, expiredKey)).toEqual({
      ...unclaimedQueueRow(),
      state: 'poisoned',
      payload: null,
      terminalAt: maintenanceNow,
      lastErrorCode: 'expired',
    });
    expect(
      raw.prepare('SELECT id FROM incoming_event_queue WHERE event_key = ?').get(staleTerminalKey),
    ).toBeUndefined();
  });

  it('awaits maintenance and the exact claim driver operations before committing or returning', async () => {
    const { db, raw } = await createTestDb();
    const maintenanceNow = INCOMING_EVENT_TERMINAL_MAX_AGE_MS + 600_000;
    const dueKey = 'claim-delayed-due';
    const expiredKey = 'claim-delayed-expired';
    const leaseToken = 'claim-delayed-lease';
    seedPendingIncomingEvent(raw, dueKey, maintenanceNow - 2, maintenanceNow + 60_000);
    seedPendingIncomingEvent(raw, expiredKey, maintenanceNow - 2, maintenanceNow - 1);

    type Run = (query: unknown) => unknown;
    type All = (query: unknown) => unknown;
    const originalRun = db.run as Run;
    const originalAll = db.all as All;
    const realRun = db.run.bind(db) as Run;
    const realAll = db.all.bind(db) as All;
    let maintenanceDidStart = false;
    let claimUpdateDidStart = false;
    let releaseMaintenance!: () => void;
    let releaseClaimUpdate!: () => void;
    let markMaintenanceFinished!: () => void;
    let markClaimUpdateFinished!: () => void;
    const maintenanceHeld = new Promise<void>((resolve) => {
      releaseMaintenance = resolve;
    });
    const claimUpdateHeld = new Promise<void>((resolve) => {
      releaseClaimUpdate = resolve;
    });
    const maintenanceFinished = new Promise<void>((resolve) => {
      markMaintenanceFinished = resolve;
    });
    const claimUpdateFinished = new Promise<void>((resolve) => {
      markClaimUpdateFinished = resolve;
    });
    (db as unknown as { run: Run }).run = (query) => {
      const sqlShape = JSON.stringify(query);
      if (
        !maintenanceDidStart &&
        sqlShape.includes('incoming_event_queue') &&
        sqlShape.includes('attempt-cap')
      ) {
        maintenanceDidStart = true;
        return maintenanceHeld.then(() => realRun(query)).finally(markMaintenanceFinished);
      }
      return realRun(query);
    };
    (db as unknown as { all: All }).all = (query) => {
      const sqlShape = JSON.stringify(query);
      if (
        !claimUpdateDidStart &&
        sqlShape.includes('WITH eligible AS') &&
        sqlShape.includes('UPDATE incoming_event_queue') &&
        sqlShape.includes('RETURNING id')
      ) {
        claimUpdateDidStart = true;
        return claimUpdateHeld.then(() => realAll(query)).finally(markClaimUpdateFinished);
      }
      return realAll(query);
    };

    let claimSettled = false;
    const claimOutcome = claimIncomingEvents(db, { clock: () => maintenanceNow, leaseToken }, ALLOW)
      .then(
        (value) => ({ kind: 'resolved' as const, value }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      )
      .finally(() => {
        claimSettled = true;
      });

    try {
      for (let turn = 0; turn < 20 && !maintenanceDidStart; turn += 1) {
        await nextEventLoopTurn();
      }
      if (!maintenanceDidStart) {
        throw new Error('claim maintenance did not start within 20 event-loop turns');
      }
      expect(claimUpdateDidStart).toBe(false);
      expect(claimSettled).toBe(false);
      expect(raw.inTransaction).toBe(true);
      expect(readClaimQueueRow(raw, expiredKey)).toEqual(unclaimedQueueRow());
      expect(readClaimQueueRow(raw, dueKey)).toEqual(unclaimedQueueRow());

      releaseMaintenance();
      for (let turn = 0; turn < 20 && !claimUpdateDidStart; turn += 1) {
        await nextEventLoopTurn();
      }
      if (!claimUpdateDidStart) {
        throw new Error('exact claim update did not start within 20 event-loop turns');
      }
      await maintenanceFinished;
      expect(claimSettled).toBe(false);
      expect(raw.inTransaction).toBe(true);
      expect(readClaimQueueRow(raw, expiredKey)).toEqual({
        ...unclaimedQueueRow(),
        state: 'poisoned',
        payload: null,
        terminalAt: maintenanceNow,
        lastErrorCode: 'expired',
      });
      expect(readClaimQueueRow(raw, dueKey)).toEqual(unclaimedQueueRow());

      releaseClaimUpdate();
      const [outcome] = await Promise.all([claimOutcome, claimUpdateFinished]);
      expect(outcome).toEqual({
        kind: 'resolved',
        value: [
          expect.objectContaining({
            eventKey: dueKey,
            attempts: 1,
            claimVersion: 1,
            leaseToken,
            leaseExpiresAt: maintenanceNow + INCOMING_EVENT_LEASE_MS,
          }),
        ],
      });
      expect(raw.inTransaction).toBe(false);
      expect(readClaimQueueRow(raw, dueKey)).toEqual(claimedQueueRow(maintenanceNow, leaseToken));
    } finally {
      releaseMaintenance();
      releaseClaimUpdate();
      try {
        const drains: Promise<unknown>[] = [claimOutcome];
        if (maintenanceDidStart) drains.push(maintenanceFinished);
        if (claimUpdateDidStart) drains.push(claimUpdateFinished);
        await Promise.allSettled(drains);
      } finally {
        (db as unknown as { all: All }).all = originalAll;
        (db as unknown as { run: Run }).run = originalRun;
      }
    }
  });

  it('atomically claims only its newly inserted row and refuses a nonempty pending queue', async () => {
    const { db, raw } = await createTestDb();
    const unrelated = await enqueueIncomingEvent(db, incoming('unrelated-pending'), ALLOW, NOW);
    expect(unrelated.status).toBe('enqueued');

    await expect(
      enqueueAndClaimIncomingEventIfQueueEmpty(
        db,
        incoming('proof-refused'),
        { now: NOW + 1, clock: () => NOW + 1, leaseToken: 'proof-refused-lease' },
        ALLOW,
      ),
    ).resolves.toEqual({ status: 'queue-not-empty' });
    expect(
      raw
        .prepare(
          `SELECT attempts, lease_token AS leaseToken, lease_expires_at AS leaseExpiresAt
             FROM incoming_event_queue WHERE event_key = ?`,
        )
        .get('unrelated-pending'),
    ).toEqual({ attempts: 0, leaseToken: null, leaseExpiresAt: 0 });
    expect(
      raw
        .prepare(`SELECT COUNT(*) AS count FROM incoming_event_queue WHERE event_key = ?`)
        .get('proof-refused'),
    ).toEqual({ count: 0 });

    const unrelatedClaim = onlyClaim(
      await claimIncomingEvents(db, { clock: () => NOW + 2, leaseToken: 'clear-unrelated' }, ALLOW),
    );
    await completeIncomingEvent(db, { ...exactClaim(unrelatedClaim), now: NOW + 3 }, ALLOW);

    const staged = await enqueueAndClaimIncomingEventIfQueueEmpty(
      db,
      incoming('proof-exact'),
      { now: NOW + 4, clock: () => NOW + 4, leaseToken: 'proof-exact-lease' },
      ALLOW,
    );
    expect(staged).toMatchObject({
      status: 'claimed',
      result: { status: 'enqueued', id: expect.any(Number) },
      claim: {
        id: expect.any(Number),
        eventKey: 'proof-exact',
        attempts: 1,
        leaseToken: 'proof-exact-lease',
        leaseExpiresAt: NOW + 4 + INCOMING_EVENT_LEASE_MS,
      },
    });
    if (staged.status !== 'claimed') throw new Error('expected exact proof claim');
    expect(staged.claim.id).toBe(staged.result.id);
  });

  it('uses fresh post-lock time for queued DEV expiry and an exclusive exact claim lease', async () => {
    const { db, raw } = await createTestDb();
    const t0 = INCOMING_EVENT_TERMINAL_MAX_AGE_MS + 200_000;
    const t1 = t0 + INCOMING_EVENT_LEASE_MS + 1;
    const firstLeaseBoundary = t1 + INCOMING_EVENT_LEASE_MS;
    const expiringKey = 'dev-proof-post-lock-expired';
    const liveKey = 'dev-proof-post-lock-live';
    const expiringLeaseToken = 'dev-proof-post-lock-expired-lease';
    const liveLeaseToken = 'dev-proof-post-lock-live-lease';
    const competingLeaseToken = 'dev-proof-post-lock-competing-lease';
    const expiringEvent = incoming(expiringKey, {
      receivedAt: t0,
      expiresAt: t0 + INCOMING_EVENT_LEASE_MS,
    });
    const liveExpiresAt = firstLeaseBoundary + INCOMING_EVENT_LEASE_MS;
    const liveEvent = incoming(liveKey, { receivedAt: t0, expiresAt: liveExpiresAt });
    const staleTerminalKey = 'dev-proof-post-lock-stale-terminal';
    const staleTerminalAt = t1 - INCOMING_EVENT_TERMINAL_MAX_AGE_MS - 1;
    seedOldTerminalReceipt(raw, staleTerminalKey, staleTerminalAt);

    let markNeighbourStarted!: () => void;
    let releaseNeighbour!: () => void;
    const neighbourStarted = new Promise<void>((resolve) => {
      markNeighbourStarted = resolve;
    });
    const neighbourHeld = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const neighbourKey = 'dev-proof.post-lock.neighbour';
    const neighbourError = new Error('DEV proof clock neighbour rollback');
    const neighbourOutcome = withDbTransaction(db, async () => {
      raw.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run(neighbourKey, 'phantom');
      markNeighbourStarted();
      await neighbourHeld;
      throw neighbourError;
    }).then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
    await neighbourStarted;

    let clockNow = t0;
    const clock = jest.fn(() => clockNow);
    const stageForDevProof = (
      event: NewIncomingEvent,
      leaseToken: string,
    ): Promise<EnqueueAndClaimIncomingEventResult> =>
      enqueueAndClaimIncomingEventIfQueueEmpty(db, event, { now: t0, clock, leaseToken }, ALLOW);
    let expiringSettled = false;
    let liveSettled = false;
    const expiringOutcome = stageForDevProof(expiringEvent, expiringLeaseToken)
      .then(
        (value) => ({ kind: 'resolved' as const, value }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      )
      .finally(() => {
        expiringSettled = true;
      });
    const liveOutcome = stageForDevProof(liveEvent, liveLeaseToken)
      .then(
        (value) => ({ kind: 'resolved' as const, value }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      )
      .finally(() => {
        liveSettled = true;
      });

    try {
      await nextEventLoopTurn();
      expect(clock).not.toHaveBeenCalled();
      expect(expiringSettled).toBe(false);
      expect(liveSettled).toBe(false);
      expect(raw.inTransaction).toBe(true);
      expect(readClaimQueueRow(raw, expiringKey)).toBeUndefined();
      expect(readClaimQueueRow(raw, liveKey)).toBeUndefined();
      expect(
        raw
          .prepare('SELECT terminal_at AS terminalAt FROM incoming_event_queue WHERE event_key = ?')
          .get(staleTerminalKey),
      ).toEqual({ terminalAt: staleTerminalAt });
      expect(raw.prepare('SELECT value FROM kv WHERE key = ?').get(neighbourKey)).toEqual({
        value: 'phantom',
      });

      clockNow = t1;
      releaseNeighbour();
      const [rolledBack, expired, live] = await Promise.all([
        neighbourOutcome,
        expiringOutcome,
        liveOutcome,
      ]);
      expect(rolledBack).toEqual({ kind: 'rejected', error: neighbourError });
      expect(raw.prepare('SELECT value FROM kv WHERE key = ?').get(neighbourKey)).toBeUndefined();
      expect(clock.mock.results.map((result) => result.value)).toEqual([t1, t1]);
      expect(expired.kind).toBe('resolved');
      if (expired.kind !== 'resolved') throw expired.error;
      expect(expired.value).toEqual({
        status: 'not-enqueued',
        result: { status: 'poisoned', id: expect.any(Number), reason: 'expired' },
      });
      expect(readClaimQueueRow(raw, expiringKey)).toEqual({
        ...unclaimedQueueRow(),
        state: 'poisoned',
        payload: null,
        terminalAt: t1,
        lastErrorCode: 'expired',
      });
      expect(
        raw
          .prepare('SELECT id FROM incoming_event_queue WHERE event_key = ?')
          .get(staleTerminalKey),
      ).toBeUndefined();

      expect(live.kind).toBe('resolved');
      if (live.kind !== 'resolved') throw live.error;
      expect(live.value.status).toBe('claimed');
      if (live.value.status !== 'claimed') throw new Error('expected queued DEV proof claim');
      expect(live.value.result).toEqual({ status: 'enqueued', id: expect.any(Number) });
      expect(live.value.claim).toEqual({
        id: live.value.result.id,
        eventKey: liveKey,
        payloadDigest: DIGEST_A,
        orderingKey: `ordering:${liveKey}`,
        schemaVersion: 1,
        eventName: 'new-message',
        source: 'fcm',
        payload: '{}',
        receivedAt: t0,
        expiresAt: liveExpiresAt,
        attempts: 1,
        claimVersion: 1,
        leaseToken: liveLeaseToken,
        leaseExpiresAt: firstLeaseBoundary,
        dbAppliedAt: null,
      });
      expect(readClaimQueueRow(raw, liveKey)).toEqual(claimedQueueRow(t1, liveLeaseToken));

      let competingNow = t1;
      const claimCompeting = (): Promise<ClaimedIncomingEvent[]> =>
        claimIncomingEvents(
          db,
          { clock: () => competingNow, leaseToken: competingLeaseToken },
          ALLOW,
        );
      await expect(claimCompeting()).resolves.toEqual([]);
      competingNow = firstLeaseBoundary - 1;
      await expect(claimCompeting()).resolves.toEqual([]);
      competingNow = firstLeaseBoundary;
      const reclaimed = onlyClaim(await claimCompeting());
      expect(reclaimed).toEqual({
        ...live.value.claim,
        attempts: 2,
        claimVersion: 2,
        leaseToken: competingLeaseToken,
        leaseExpiresAt: firstLeaseBoundary + INCOMING_EVENT_LEASE_MS,
      });
    } finally {
      releaseNeighbour();
      await Promise.allSettled([neighbourOutcome, expiringOutcome, liveOutcome]);
    }
  });

  it('rolls back insertion if ownership is revoked between insert and exact claim', async () => {
    const { db, raw } = await createTestDb();
    let guardChecks = 0;
    const revokeBeforeClaim = (): boolean => {
      guardChecks += 1;
      return guardChecks < 3;
    };

    await expect(
      enqueueAndClaimIncomingEventIfQueueEmpty(
        db,
        incoming('proof-revoked-before-claim'),
        { now: NOW, clock: () => NOW, leaseToken: 'proof-revoked-lease' },
        revokeBeforeClaim,
      ),
    ).rejects.toBeInstanceOf(DbCommitGuardRejectedError);
    expect(queueCount(raw)).toBe(0);
  });

  it('rolls back the inserted and leased row if ownership is revoked immediately before commit', async () => {
    const { db, raw } = await createTestDb();
    let guardChecks = 0;
    const revokeAtFinalCommitGuard = (): boolean => {
      guardChecks += 1;
      return guardChecks < 5;
    };

    await expect(
      enqueueAndClaimIncomingEventIfQueueEmpty(
        db,
        incoming('proof-revoked-after-claim'),
        { now: NOW, clock: () => NOW, leaseToken: 'proof-revoked-after-claim-lease' },
        revokeAtFinalCommitGuard,
      ),
    ).rejects.toBeInstanceOf(DbCommitGuardRejectedError);
    expect(guardChecks).toBe(5);
    expect(queueCount(raw)).toBe(0);
  });

  it('converges a newer DB mutation before retrying an older presentation phase', async () => {
    const { db } = await createTestDb();
    const orderingKey = 'message:phase-order';
    await enqueueIncomingEvent(
      db,
      incoming('phase-old', { orderingKey, receivedAt: BASE }),
      ALLOW,
      NOW,
    );
    const old = onlyClaim(
      await claimIncomingEvents(db, { clock: () => NOW, leaseToken: 'phase-old-claim' }, ALLOW),
    );
    await withDbTransaction(db, (context) =>
      markIncomingEventDbAppliedWithinTransaction(context, { ...exactClaim(old), now: NOW }, ALLOW),
    );
    const oldFailure = await failIncomingEvent(
      db,
      { ...exactClaim(old), now: NOW + 1, errorCode: 'presentation-failed' },
      ALLOW,
    );
    if (oldFailure.status !== 'retry-scheduled') throw new Error('expected retry scheduling');

    await enqueueIncomingEvent(
      db,
      incoming('phase-new', { orderingKey, receivedAt: BASE + 1 }),
      ALLOW,
      NOW + 2,
    );

    // Even when BOTH rows are due, the newer unapplied DB mutation wins over the stale
    // presentation retry. Once it completes, the older presentation row becomes claimable.
    const successor = onlyClaim(
      await claimIncomingEvents(
        db,
        { clock: () => oldFailure.nextAttemptAt, leaseToken: 'phase-new-claim' },
        ALLOW,
      ),
    );
    expect(successor.eventKey).toBe('phase-new');
    await completeIncomingEvent(
      db,
      { ...exactClaim(successor), now: oldFailure.nextAttemptAt + 1 },
      ALLOW,
    );
    const presentationRetry = onlyClaim(
      await claimIncomingEvents(
        db,
        { clock: () => oldFailure.nextAttemptAt + 2, leaseToken: 'phase-old-retry' },
        ALLOW,
      ),
    );
    expect(presentationRetry.eventKey).toBe('phase-old');
    expect(presentationRetry.dbAppliedAt).toBe(NOW);
  });

  it('does not let a later unapplied row pass an older unapplied row in backoff', async () => {
    const { db } = await createTestDb();
    const orderingKey = 'message:db-fifo';
    await enqueueIncomingEvent(
      db,
      incoming('db-fifo-old', { orderingKey, receivedAt: BASE }),
      ALLOW,
      NOW,
    );
    await enqueueIncomingEvent(
      db,
      incoming('db-fifo-new', { orderingKey, receivedAt: BASE + 1 }),
      ALLOW,
      NOW,
    );
    const old = onlyClaim(
      await claimIncomingEvents(db, { clock: () => NOW, leaseToken: 'db-fifo-old' }, ALLOW),
    );
    await failIncomingEvent(
      db,
      { ...exactClaim(old), now: NOW + 1, errorCode: 'db-failed' },
      ALLOW,
    );

    await expect(
      claimIncomingEvents(db, { clock: () => NOW + 2, leaseToken: 'db-fifo-new' }, ALLOW),
    ).resolves.toEqual([]);
  });

  it('wakes for the newer DB phase instead of spinning on a blocked presentation retry', async () => {
    const { db } = await createTestDb();
    const orderingKey = 'message:phase-wake';
    await enqueueIncomingEvent(
      db,
      incoming('wake-old', { orderingKey, receivedAt: BASE }),
      ALLOW,
      NOW,
    );
    const old = onlyClaim(
      await claimIncomingEvents(db, { clock: () => NOW, leaseToken: 'wake-old' }, ALLOW),
    );
    await withDbTransaction(db, (context) =>
      markIncomingEventDbAppliedWithinTransaction(context, { ...exactClaim(old), now: NOW }, ALLOW),
    );
    const oldFailure = await failIncomingEvent(
      db,
      { ...exactClaim(old), now: NOW + 1, errorCode: 'presentation-failed' },
      ALLOW,
    );
    if (oldFailure.status !== 'retry-scheduled') throw new Error('expected retry scheduling');
    await enqueueIncomingEvent(
      db,
      incoming('wake-new', { orderingKey, receivedAt: BASE + 1 }),
      ALLOW,
      NOW + 2,
    );
    const newer = onlyClaim(
      await claimIncomingEvents(db, { clock: () => NOW + 2, leaseToken: 'wake-new' }, ALLOW),
    );
    const newerFailure = await failIncomingEvent(
      db,
      { ...exactClaim(newer), now: NOW + 1_000, errorCode: 'db-failed' },
      ALLOW,
    );
    if (newerFailure.status !== 'retry-scheduled') throw new Error('expected retry scheduling');

    expect(newerFailure.nextAttemptAt).toBeGreaterThan(oldFailure.nextAttemptAt);
    await expect(getNextIncomingEventWakeAt(db, oldFailure.nextAttemptAt)).resolves.toBe(
      newerFailure.nextAttemptAt,
    );
  });

  it('keeps a lease exclusive, reclaims it after expiry, and rejects stale fences', async () => {
    const { db } = await createTestDb();
    await enqueueIncomingEvent(db, incoming('lease'), ALLOW, NOW);
    const first = onlyClaim(
      await claimIncomingEvents(db, { clock: () => NOW, leaseToken: 'worker-old' }, ALLOW),
    );
    expect(first).toEqual(
      expect.objectContaining({
        attempts: 1,
        claimVersion: 1,
        leaseExpiresAt: NOW + INCOMING_EVENT_LEASE_MS,
      }),
    );

    await expect(
      claimIncomingEvents(db, { clock: () => NOW + 1, leaseToken: 'worker-other' }, ALLOW),
    ).resolves.toEqual([]);

    const reclaimed = onlyClaim(
      await claimIncomingEvents(
        db,
        { clock: () => first.leaseExpiresAt, leaseToken: 'worker-new' },
        ALLOW,
      ),
    );
    expect(reclaimed).toEqual(
      expect.objectContaining({ id: first.id, attempts: 2, claimVersion: 2 }),
    );

    await expect(
      completeIncomingEvent(
        db,
        {
          id: reclaimed.id,
          leaseToken: first.leaseToken,
          claimVersion: reclaimed.claimVersion,
          now: reclaimed.leaseExpiresAt - 1,
        },
        ALLOW,
      ),
    ).resolves.toBe(false);
    await expect(
      failIncomingEvent(
        db,
        {
          id: reclaimed.id,
          leaseToken: reclaimed.leaseToken,
          claimVersion: first.claimVersion,
          now: reclaimed.leaseExpiresAt - 1,
          errorCode: 'stale-worker',
        },
        ALLOW,
      ),
    ).resolves.toEqual({ status: 'stale' });
    await expect(
      completeIncomingEvent(
        db,
        { ...exactClaim(reclaimed), now: reclaimed.leaseExpiresAt - 1 },
        ALLOW,
      ),
    ).resolves.toBe(true);
  });

  it('allows the exact owner to settle after the soft lease deadline until another owner reclaims it', async () => {
    const { db } = await createTestDb();
    await enqueueIncomingEvent(db, incoming('soft-lease-settlement'), ALLOW, NOW);
    const claim = onlyClaim(
      await claimIncomingEvents(db, { clock: () => NOW, leaseToken: 'soft-lease-owner' }, ALLOW),
    );

    await expect(
      completeIncomingEventWithClock(
        db,
        exactClaim(claim),
        ALLOW,
        clockAt(claim.leaseExpiresAt + 1),
      ),
    ).resolves.toBe(true);
  });

  it('waits for an active lease before waking to terminalize an expired row', async () => {
    const { db } = await createTestDb();
    await enqueueIncomingEvent(db, incoming('leased-expiry', { expiresAt: NOW + 10 }), ALLOW, NOW);
    const claim = onlyClaim(
      await claimIncomingEvents(db, { clock: () => NOW, leaseToken: 'lease-before-expiry' }, ALLOW),
    );

    expect(claim.leaseExpiresAt).toBe(NOW + INCOMING_EVENT_LEASE_MS);
    await expect(getNextIncomingEventWakeAt(db, NOW + 5)).resolves.toBe(claim.leaseExpiresAt);
    await expect(getNextIncomingEventWakeAt(db, NOW + 20)).resolves.toBe(claim.leaseExpiresAt);
  });

  it('backs off failed work and does not make it claimable early', async () => {
    const { db } = await createTestDb();
    expect([1, 2, 3, 4, 5].map(incomingEventBackoffMs)).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000,
    ]);
    await enqueueIncomingEvent(db, incoming('backoff'), ALLOW, NOW);
    const first = onlyClaim(
      await claimIncomingEvents(db, { clock: () => NOW, leaseToken: 'backoff-1' }, ALLOW),
    );
    const failedAt = NOW + 1;
    const failure = await failIncomingEvent(
      db,
      { ...exactClaim(first), now: failedAt, errorCode: 'sink-failed' },
      ALLOW,
    );
    expect(failure).toEqual({
      status: 'retry-scheduled',
      attempts: 1,
      nextAttemptAt: failedAt + incomingEventBackoffMs(1),
    });
    if (failure.status !== 'retry-scheduled') throw new Error('expected retry scheduling');

    await expect(
      claimIncomingEvents(
        db,
        { clock: () => failure.nextAttemptAt - 1, leaseToken: 'backoff-early' },
        ALLOW,
      ),
    ).resolves.toEqual([]);
    const second = onlyClaim(
      await claimIncomingEvents(
        db,
        { clock: () => failure.nextAttemptAt, leaseToken: 'backoff-2' },
        ALLOW,
      ),
    );
    expect(second.attempts).toBe(2);
  });

  it('poisons and scrubs a fifth claimed attempt after its worker dies', async () => {
    const { db, raw } = await createTestDb();
    await enqueueIncomingEvent(db, incoming('attempt-cap'), ALLOW, NOW);
    let claimNow = NOW;
    let fifth: ClaimedIncomingEvent | undefined;

    for (let attempt = 1; attempt <= INCOMING_EVENT_MAX_ATTEMPTS; attempt += 1) {
      const claim = onlyClaim(
        await claimIncomingEvents(
          db,
          { clock: () => claimNow, leaseToken: `attempt-${attempt}` },
          ALLOW,
        ),
      );
      expect(claim.attempts).toBe(attempt);
      if (attempt === INCOMING_EVENT_MAX_ATTEMPTS) {
        fifth = claim;
        break;
      }

      const failure = await failIncomingEvent(
        db,
        { ...exactClaim(claim), now: claimNow + 1, errorCode: 'sink-failed' },
        ALLOW,
      );
      if (failure.status !== 'retry-scheduled') throw new Error('expected retry scheduling');
      expect(failure.nextAttemptAt).toBe(claimNow + 1 + incomingEventBackoffMs(attempt));
      claimNow = failure.nextAttemptAt;
    }

    if (!fifth) throw new Error('expected a fifth claim');
    await maintainIncomingEvents(db, fifth.leaseExpiresAt - 1, ALLOW);
    expect(
      raw.prepare(`SELECT state FROM incoming_event_queue WHERE id = ?`).get(fifth.id),
    ).toEqual({ state: 'pending' });

    await maintainIncomingEvents(db, fifth.leaseExpiresAt, ALLOW);
    expect(
      raw
        .prepare(
          `SELECT state, attempts, payload, lease_token AS leaseToken,
                  last_error_code AS lastErrorCode
             FROM incoming_event_queue WHERE id = ?`,
        )
        .get(fifth.id),
    ).toEqual({
      state: 'poisoned',
      attempts: INCOMING_EVENT_MAX_ATTEMPTS,
      payload: null,
      leaseToken: null,
      lastErrorCode: 'attempt-cap',
    });
  });

  it('scrubs a completed payload while retaining a receipt that suppresses redelivery', async () => {
    const { db, raw } = await createTestDb();
    const event = incoming('completed-receipt', {
      payload: JSON.stringify({ private: 'message' }),
    });
    const inserted = await enqueueIncomingEvent(db, event, ALLOW, NOW);
    const claim = onlyClaim(
      await claimIncomingEvents(db, { clock: () => NOW, leaseToken: 'complete-worker' }, ALLOW),
    );
    await expect(
      completeIncomingEvent(db, { ...exactClaim(claim), now: NOW + 1 }, ALLOW),
    ).resolves.toBe(true);

    expect(
      raw
        .prepare(`SELECT state, payload, terminal_at AS terminalAt FROM incoming_event_queue`)
        .get(),
    ).toEqual({ state: 'completed', payload: null, terminalAt: NOW + 1 });
    await expect(enqueueIncomingEvent(db, event, ALLOW, NOW + 2)).resolves.toEqual({
      status: 'duplicate',
      id: inserted.id,
      state: 'completed',
    });
    expect(queueCount(raw)).toBe(1);
  });

  it('immediately poisons and scrubs a claimed envelope after a permanent codec failure', async () => {
    const { db, raw } = await createTestDb();
    const event = incoming('permanent-poison', {
      payload: JSON.stringify({ private: 'corrupt message' }),
    });
    const inserted = await enqueueIncomingEvent(db, event, ALLOW, NOW);
    const claim = onlyClaim(
      await claimIncomingEvents(db, { clock: () => NOW, leaseToken: 'poison-worker' }, ALLOW),
    );

    await expect(
      poisonIncomingEvent(
        db,
        { ...exactClaim(claim), now: NOW + 1, errorCode: 'DIGEST_MISMATCH' },
        ALLOW,
      ),
    ).resolves.toBe(true);
    expect(
      raw
        .prepare(
          `SELECT state, payload, lease_token AS leaseToken,
                  terminal_at AS terminalAt, last_error_code AS lastErrorCode
             FROM incoming_event_queue WHERE id = ?`,
        )
        .get(claim.id),
    ).toEqual({
      state: 'poisoned',
      payload: null,
      leaseToken: null,
      terminalAt: NOW + 1,
      lastErrorCode: 'digest_mismatch',
    });
    await expect(enqueueIncomingEvent(db, event, ALLOW, NOW + 2)).resolves.toEqual({
      status: 'duplicate',
      id: inserted.id,
      state: 'poisoned',
    });
    await expect(
      poisonIncomingEvent(
        db,
        { ...exactClaim(claim), now: NOW + 2, errorCode: 'digest-mismatch' },
        ALLOW,
      ),
    ).resolves.toBe(false);
  });

  it.each(
    TERMINAL_OPERATIONS.flatMap((operation) => [
      { operation, revoke: false, ownership: 'current' },
      { operation, revoke: true, ownership: 'revoked while queued' },
    ]),
  )(
    'keeps $operation owned behind a rolling-back neighbour when $ownership',
    async ({ operation, revoke }) => {
      const { db, raw } = await createTestDb();
      const eventKey = `terminal-neighbour:${operation}:${revoke ? 'revoked' : 'current'}`;
      const claim = await prepareTerminalClaim(db, raw, operation, eventKey, NOW, false);
      const operationNow = NOW + 2;

      let markNeighbourStarted!: () => void;
      let releaseNeighbour!: () => void;
      const neighbourStarted = new Promise<void>((resolve) => {
        markNeighbourStarted = resolve;
      });
      const neighbourHeld = new Promise<void>((resolve) => {
        releaseNeighbour = resolve;
      });
      const neighbourKey = `terminal.neighbour.${operation}.${revoke ? 'revoked' : 'current'}`;
      const neighbourError = new Error('terminal helper neighbour rollback');
      const neighbour = withDbTransaction(db, async () => {
        raw.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run(neighbourKey, 'phantom');
        markNeighbourStarted();
        await neighbourHeld;
        throw neighbourError;
      }).catch((error: unknown) => error);
      await neighbourStarted;

      let current = true;
      let helperSettled = false;
      const helperOutcome = invokeTerminalOperation(
        operation,
        db,
        claim,
        operationNow,
        () => current,
      )
        .then(
          (value) => ({ kind: 'resolved' as const, value }),
          (error: unknown) => ({ kind: 'rejected' as const, error }),
        )
        .finally(() => {
          helperSettled = true;
        });

      let observationError: unknown;
      try {
        await nextEventLoopTurn();
        expect(helperSettled).toBe(false);
        expect(readTerminalRow(raw, claim.id)).toEqual(expectedClaimedRow(claim));
        expect(raw.prepare('SELECT value FROM kv WHERE key = ?').get(neighbourKey)).toEqual({
          value: 'phantom',
        });
        if (revoke) current = false;
      } catch (error) {
        observationError = error;
      } finally {
        releaseNeighbour();
      }

      const [rolledBack, outcome] = await Promise.all([neighbour, helperOutcome]);
      if (observationError) throw observationError;
      expect(rolledBack).toBe(neighbourError);
      expect(raw.prepare('SELECT value FROM kv WHERE key = ?').get(neighbourKey)).toBeUndefined();
      if (revoke) {
        expect(outcome.kind).toBe('rejected');
        if (outcome.kind === 'rejected') {
          expect(outcome.error).toBeInstanceOf(DbCommitGuardRejectedError);
        }
        expect(readTerminalRow(raw, claim.id)).toEqual(expectedClaimedRow(claim));
      } else {
        expect(outcome).toEqual({
          kind: 'resolved',
          value: expectedTerminalResult(operation, claim, operationNow, false),
        });
        expect(readTerminalRow(raw, claim.id)).toEqual(
          expectedTerminalRow(operation, claim, operationNow, false),
        );
      }
    },
  );

  it('uses the post-lock clock when a failed delivery expires while settlement is queued', async () => {
    const { db, raw } = await createTestDb();
    const claim = await prepareTerminalClaim(
      db,
      raw,
      'fail',
      'failure-expires-behind-writer',
      NOW,
      false,
    );
    raw
      .prepare(`UPDATE incoming_event_queue SET expires_at = ? WHERE id = ?`)
      .run(NOW + 10, claim.id);

    let releaseNeighbour!: () => void;
    let markNeighbourStarted!: () => void;
    const neighbourStarted = new Promise<void>((resolve) => {
      markNeighbourStarted = resolve;
    });
    const neighbourHeld = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const neighbour = withDbTransaction(db, async () => {
      markNeighbourStarted();
      await neighbourHeld;
    });
    await neighbourStarted;

    let clockNow = NOW + 1;
    const clock = jest.fn(() => clockNow);
    const failure = failIncomingEventWithClock(
      db,
      { ...exactClaim(claim), errorCode: 'delivery-failed' },
      ALLOW,
      clock,
    );
    await nextEventLoopTurn();
    expect(clock).not.toHaveBeenCalled();

    clockNow = NOW + 11;
    releaseNeighbour();
    await neighbour;

    await expect(failure).resolves.toEqual({ status: 'poisoned', attempts: 1 });
    expect(clock).toHaveBeenCalledTimes(1);
    expect(readTerminalRow(raw, claim.id)).toEqual({
      state: 'poisoned',
      payload: null,
      attempts: 1,
      leaseToken: null,
      nextAttemptAt: 0,
      terminalAt: NOW + 11,
      lastErrorCode: 'expired',
    });
  });

  it.each(TERMINAL_OPERATIONS)(
    'rolls %s back when terminal receipt trimming fails, then releases retry',
    async (operation) => {
      const { db, raw } = await createTestDb();
      const operationNow = INCOMING_EVENT_TERMINAL_MAX_AGE_MS + 300_000;
      const eventKey = `terminal-trim-failure:${operation}`;
      const claim = await prepareTerminalClaim(
        db,
        raw,
        operation,
        eventKey,
        operationNow - 2,
        true,
      );
      const sentinel = `terminal-trim-sentinel:${operation}`;
      seedOldTerminalReceipt(raw, sentinel, operationNow - INCOMING_EVENT_TERMINAL_MAX_AGE_MS - 1);
      const triggerName = `reject_${operation}_terminal_trim`;
      const canary = `TERMINAL_TRIM_${operation.toUpperCase()}_RAW_CANARY`;
      raw.exec(`
        CREATE TRIGGER ${triggerName}
        BEFORE DELETE ON incoming_event_queue
        WHEN OLD.event_key = '${sentinel}'
        BEGIN
          SELECT RAISE(ABORT, '${canary}');
        END
      `);

      await expect(
        invokeTerminalOperation(operation, db, claim, operationNow, ALLOW),
      ).rejects.toMatchObject({ cause: { message: canary } });
      expect(readTerminalRow(raw, claim.id)).toEqual(expectedClaimedRow(claim));
      expect(
        raw
          .prepare('SELECT COUNT(*) AS count FROM incoming_event_queue WHERE event_key = ?')
          .get(sentinel),
      ).toEqual({ count: 1 });

      raw.exec(`DROP TRIGGER ${triggerName}`);
      await expect(
        invokeTerminalOperation(operation, db, claim, operationNow, ALLOW),
      ).resolves.toEqual(expectedTerminalResult(operation, claim, operationNow, true));
      expect(readTerminalRow(raw, claim.id)).toEqual(
        expectedTerminalRow(operation, claim, operationNow, true),
      );
      expect(
        raw
          .prepare('SELECT COUNT(*) AS count FROM incoming_event_queue WHERE event_key = ?')
          .get(sentinel),
      ).toEqual({ count: 0 });
    },
  );

  it.each(TERMINAL_OPERATIONS)(
    'awaits %s terminal receipt trimming before committing or returning',
    async (operation) => {
      const { db, raw } = await createTestDb();
      const operationNow = INCOMING_EVENT_TERMINAL_MAX_AGE_MS + 400_000;
      const eventKey = `terminal-delayed-trim:${operation}`;
      const claim = await prepareTerminalClaim(
        db,
        raw,
        operation,
        eventKey,
        operationNow - 2,
        true,
      );
      const sentinel = `terminal-delayed-sentinel:${operation}`;
      seedOldTerminalReceipt(raw, sentinel, operationNow - INCOMING_EVENT_TERMINAL_MAX_AGE_MS - 1);

      type Run = (query: unknown) => unknown;
      const originalRun = db.run as Run;
      const realRun = db.run.bind(db) as Run;
      let trimDidStart = false;
      let releaseTrim!: () => void;
      let markTrimFinished!: () => void;
      const trimHeld = new Promise<void>((resolve) => {
        releaseTrim = resolve;
      });
      const trimFinished = new Promise<void>((resolve) => {
        markTrimFinished = resolve;
      });
      (db as unknown as { run: Run }).run = (query) => {
        const sqlShape = JSON.stringify(query);
        if (
          !trimDidStart &&
          sqlShape.includes('ranked_terminal') &&
          sqlShape.includes('retained_terminal')
        ) {
          trimDidStart = true;
          return trimHeld.then(() => realRun(query)).finally(markTrimFinished);
        }
        return realRun(query);
      };

      let helperSettled = false;
      const helperOutcome = invokeTerminalOperation(operation, db, claim, operationNow, ALLOW)
        .then(
          (value) => ({ kind: 'resolved' as const, value }),
          (error: unknown) => ({ kind: 'rejected' as const, error }),
        )
        .finally(() => {
          helperSettled = true;
        });

      try {
        for (let turn = 0; turn < 20 && !trimDidStart; turn += 1) {
          await nextEventLoopTurn();
        }
        if (!trimDidStart) {
          throw new Error(`${operation} terminal trim did not start within 20 event-loop turns`);
        }

        let observationError: unknown;
        try {
          await nextEventLoopTurn();
          expect(helperSettled).toBe(false);
          expect(raw.inTransaction).toBe(true);
          expect(readTerminalRow(raw, claim.id)).toEqual(
            expectedTerminalRow(operation, claim, operationNow, true),
          );
          expect(
            raw
              .prepare('SELECT COUNT(*) AS count FROM incoming_event_queue WHERE event_key = ?')
              .get(sentinel),
          ).toEqual({ count: 1 });
        } catch (error) {
          observationError = error;
        } finally {
          releaseTrim();
        }

        const [outcome] = await Promise.all([helperOutcome, trimFinished]);
        if (observationError) throw observationError;
        expect(outcome).toEqual({
          kind: 'resolved',
          value: expectedTerminalResult(operation, claim, operationNow, true),
        });
        expect(raw.inTransaction).toBe(false);
        expect(readTerminalRow(raw, claim.id)).toEqual(
          expectedTerminalRow(operation, claim, operationNow, true),
        );
        expect(
          raw
            .prepare('SELECT COUNT(*) AS count FROM incoming_event_queue WHERE event_key = ?')
            .get(sentinel),
        ).toEqual({ count: 0 });
      } finally {
        releaseTrim();
        try {
          if (trimDidStart) {
            await Promise.allSettled([helperOutcome, trimFinished]);
          }
        } finally {
          (db as unknown as { run: Run }).run = originalRun;
        }
      }
    },
  );

  it('checkpoints domain writes atomically and rolls them back when the claim fence is wrong', async () => {
    const { db, raw } = await createTestDb();
    await enqueueIncomingEvent(db, incoming('checkpoint'), ALLOW, NOW);
    const claim = onlyClaim(
      await claimIncomingEvents(db, { clock: () => NOW, leaseToken: 'checkpoint-worker' }, ALLOW),
    );

    await expect(
      withDbTransaction(db, async (context) => {
        await db.run(sql`INSERT INTO kv (key, value) VALUES ('checkpoint-bad', 'must-roll-back')`);
        await markIncomingEventDbAppliedWithinTransaction(
          context,
          { ...exactClaim(claim), claimVersion: claim.claimVersion + 1, now: NOW + 1 },
          ALLOW,
        );
      }),
    ).rejects.toMatchObject({ name: 'IncomingEventClaimLostError' });
    expect(raw.prepare(`SELECT value FROM kv WHERE key = 'checkpoint-bad'`).get()).toBeUndefined();
    expect(
      raw.prepare(`SELECT db_applied_at AS dbAppliedAt FROM incoming_event_queue`).get(),
    ).toEqual({ dbAppliedAt: null });

    await withDbTransaction(db, async (context) => {
      await db.run(sql`INSERT INTO kv (key, value) VALUES ('checkpoint-good', 'committed')`);
      await markIncomingEventDbAppliedWithinTransaction(
        context,
        { ...exactClaim(claim), now: NOW + 2 },
        ALLOW,
      );
    });
    expect(raw.prepare(`SELECT value FROM kv WHERE key = 'checkpoint-good'`).get()).toEqual({
      value: 'committed',
    });
    expect(
      raw.prepare(`SELECT db_applied_at AS dbAppliedAt FROM incoming_event_queue`).get(),
    ).toEqual({ dbAppliedAt: NOW + 2 });
  });

  it('rejects a checkpoint token after its owner closes and rolls back a later owner', async () => {
    const { db, raw } = await createTestDb();
    await enqueueIncomingEvent(db, incoming('checkpoint-stale-context'), ALLOW, NOW);
    const claim = onlyClaim(
      await claimIncomingEvents(
        db,
        { clock: () => NOW, leaseToken: 'checkpoint-stale-context-worker' },
        ALLOW,
      ),
    );
    let staleContext!: DbTransactionContext;
    await withDbTransaction(db, async (context) => {
      staleContext = context;
    });

    await expect(
      markIncomingEventDbAppliedWithinTransaction(
        staleContext,
        { ...exactClaim(claim), now: NOW + 1 },
        ALLOW,
      ),
    ).rejects.toBeInstanceOf(DbTransactionContextRejectedError);

    await expect(
      withDbTransaction(db, async () => {
        await db.run(
          sql`INSERT INTO kv (key, value) VALUES ('checkpoint-stale-owner', 'must-roll-back')`,
        );
        await markIncomingEventDbAppliedWithinTransaction(
          staleContext,
          { ...exactClaim(claim), now: NOW + 2 },
          ALLOW,
        );
      }),
    ).rejects.toBeInstanceOf(DbTransactionContextRejectedError);

    expect(
      raw.prepare(`SELECT value FROM kv WHERE key = 'checkpoint-stale-owner'`).get(),
    ).toBeUndefined();
    expect(
      raw.prepare(`SELECT db_applied_at AS dbAppliedAt FROM incoming_event_queue`).get(),
    ).toEqual({ dbAppliedAt: null });
  });

  it('rolls intake back when its account commit guard is revoked before COMMIT', async () => {
    const { db, raw } = await createTestDb();
    let checks = 0;

    await expect(
      enqueueIncomingEvent(
        db,
        incoming('guarded'),
        () => {
          checks += 1;
          return checks < 3;
        },
        NOW,
      ),
    ).rejects.toBeInstanceOf(DbCommitGuardRejectedError);

    expect(checks).toBe(3);
    expect(queueCount(raw)).toBe(0);
  });

  it('refuses a newcomer instead of evicting work at the pending row cap', async () => {
    const { db, raw } = await createTestDb();
    seedRawPending(raw, INCOMING_EVENT_PENDING_CAPACITY, '{}', 'count-cap');

    await expect(enqueueIncomingEvent(db, incoming('count-overflow'), ALLOW, NOW)).resolves.toEqual(
      { status: 'poisoned', id: expect.any(Number), reason: 'queue-full' },
    );
    expect(
      raw
        .prepare(
          `SELECT
             SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending,
             SUM(CASE WHEN state = 'poisoned' THEN 1 ELSE 0 END) AS poisoned,
             SUM(CASE WHEN state = 'poisoned' AND payload IS NULL THEN 1 ELSE 0 END) AS scrubbed
           FROM incoming_event_queue`,
        )
        .get(),
    ).toEqual({ pending: INCOMING_EVENT_PENDING_CAPACITY, poisoned: 1, scrubbed: 1 });
  });

  it('refuses a newcomer when pending payloads already fill the aggregate byte budget', async () => {
    const { db, raw } = await createTestDb();
    const maxPayload = JSON.stringify('x'.repeat(INCOMING_EVENT_MAX_PAYLOAD_BYTES - 2));
    const rowsAtBudget = INCOMING_EVENT_PENDING_BYTE_BUDGET / INCOMING_EVENT_MAX_PAYLOAD_BYTES;
    seedRawPending(raw, rowsAtBudget, maxPayload, 'byte-cap');

    expect(
      (
        raw
          .prepare(
            `SELECT SUM(length(CAST(payload AS BLOB))) AS bytes
               FROM incoming_event_queue WHERE state = 'pending'`,
          )
          .get() as { bytes: number }
      ).bytes,
    ).toBe(INCOMING_EVENT_PENDING_BYTE_BUDGET);
    const boundedClaim = await claimIncomingEvents(
      db,
      {
        clock: () => NOW,
        limit: INCOMING_EVENT_PENDING_CAPACITY,
        leaseToken: 'byte-budget-worker',
      },
      ALLOW,
    );
    expect(boundedClaim).toHaveLength(
      INCOMING_EVENT_MAX_CLAIM_PAYLOAD_BYTES / INCOMING_EVENT_MAX_PAYLOAD_BYTES,
    );
    expect(boundedClaim.reduce((bytes, row) => bytes + row.payload.length, 0)).toBe(
      INCOMING_EVENT_MAX_CLAIM_PAYLOAD_BYTES,
    );
    await expect(enqueueIncomingEvent(db, incoming('byte-overflow'), ALLOW, NOW)).resolves.toEqual({
      status: 'poisoned',
      id: expect.any(Number),
      reason: 'queue-full',
    });

    expect(await getIncomingEventQueueHealth(db, NOW)).toEqual(
      expect.objectContaining({
        pending: rowsAtBudget,
        poisoned: 1,
        pendingPayloadBytes: INCOMING_EVENT_PENDING_BYTE_BUDGET,
      }),
    );
  });

  it('prunes terminal receipts by age and keeps only the newest bounded set', async () => {
    const { db, raw } = await createTestDb();
    const maintenanceNow = INCOMING_EVENT_TERMINAL_MAX_AGE_MS + 100_000;
    const insert = raw.prepare(`
      INSERT INTO incoming_event_queue (
        event_key, payload_digest, ordering_key, event_name, source, payload,
        received_at, expires_at, state, terminal_at
      ) VALUES (?, ?, ?, 'new-message', 'fcm', NULL, ?, ?, 'completed', ?)`);
    const seedReceipts = raw.transaction(() => {
      insert.run(
        'terminal:too-old',
        DIGEST_A,
        'terminal:too-old',
        BASE,
        EXPIRY,
        maintenanceNow - INCOMING_EVENT_TERMINAL_MAX_AGE_MS - 1,
      );
      for (let index = 0; index <= INCOMING_EVENT_TERMINAL_CAPACITY; index += 1) {
        insert.run(
          `terminal:recent:${index}`,
          DIGEST_A,
          `terminal:recent:${index}`,
          BASE,
          EXPIRY,
          maintenanceNow - index,
        );
      }
    });
    seedReceipts();
    await enqueueIncomingEvent(
      db,
      incoming('pending-survivor', {
        receivedAt: maintenanceNow,
        expiresAt: maintenanceNow + 60_000,
      }),
      ALLOW,
      maintenanceNow,
    );

    await maintainIncomingEvents(db, maintenanceNow, ALLOW);

    expect(queueCount(raw)).toBe(INCOMING_EVENT_TERMINAL_CAPACITY + 1);
    expect(
      raw
        .prepare(
          `SELECT COUNT(*) AS count FROM incoming_event_queue
            WHERE event_key IN ('terminal:too-old', ?)`,
        )
        .get(`terminal:recent:${INCOMING_EVENT_TERMINAL_CAPACITY}`),
    ).toEqual({ count: 0 });
    expect(
      raw
        .prepare(`SELECT state, payload FROM incoming_event_queue WHERE event_key = ?`)
        .get('terminal:recent:0'),
    ).toEqual({ state: 'completed', payload: null });
    expect(
      raw
        .prepare(`SELECT state, payload FROM incoming_event_queue WHERE event_key = ?`)
        .get('pending-survivor'),
    ).toEqual({ state: 'pending', payload: '{}' });
    await expect(
      enqueueIncomingEvent(
        db,
        incoming('terminal:too-old', {
          receivedAt: maintenanceNow,
          expiresAt: maintenanceNow + 60_000,
        }),
        ALLOW,
        maintenanceNow,
      ),
    ).resolves.toEqual({ status: 'enqueued', id: expect.any(Number) });
    await expect(
      enqueueIncomingEvent(
        db,
        incoming('terminal:recent:0', {
          orderingKey: 'terminal:recent:0',
          receivedAt: maintenanceNow,
          expiresAt: maintenanceNow + 60_000,
        }),
        ALLOW,
        maintenanceNow,
      ),
    ).resolves.toEqual({ status: 'duplicate', id: expect.any(Number), state: 'completed' });
  });

  it('reports bounded queue health without exposing event keys or payloads', async () => {
    const { db } = await createTestDb();
    for (let index = 0; index < 4; index += 1) {
      await enqueueIncomingEvent(
        db,
        incoming(`health-${index}`, { receivedAt: BASE + index }),
        ALLOW,
        NOW,
      );
    }
    const claims = await claimIncomingEvents(
      db,
      { clock: () => NOW, limit: 4, leaseToken: 'health-worker' },
      ALLOW,
    );
    expect(claims).toHaveLength(4);
    const applied = claimAt(claims, 0);
    const completedOne = claimAt(claims, 1);
    const retrying = claimAt(claims, 2);
    const completedTwo = claimAt(claims, 3);

    await withDbTransaction(db, (context) =>
      markIncomingEventDbAppliedWithinTransaction(
        context,
        { ...exactClaim(applied), now: NOW + 1 },
        ALLOW,
      ),
    );
    await completeIncomingEvent(db, { ...exactClaim(completedOne), now: NOW + 1 }, ALLOW);
    await failIncomingEvent(
      db,
      { ...exactClaim(retrying), now: NOW + 1, errorCode: 'health-retry' },
      ALLOW,
    );
    await completeIncomingEvent(db, { ...exactClaim(completedTwo), now: NOW + 1 }, ALLOW);
    await enqueueIncomingEvent(
      db,
      incoming('health-due', { receivedAt: BASE + 4 }),
      ALLOW,
      NOW + 2,
    );
    await enqueueIncomingEvent(
      db,
      incoming('health-poison', { receivedAt: BASE, expiresAt: BASE + 1 }),
      ALLOW,
      NOW + 2,
    );

    expect(await getIncomingEventQueueHealth(db, NOW + 2)).toEqual({
      pending: 3,
      due: 1,
      leased: 1,
      dbAppliedPending: 1,
      completed: 2,
      poisoned: 1,
      pendingPayloadBytes: 6,
      oldestPendingAt: BASE,
    });
  });
});
