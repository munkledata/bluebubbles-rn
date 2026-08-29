import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  encodeIncomingEvent,
  EventRouter,
  normalizeRealtimeEvent,
  type DigestBackend,
  type EventDeliveryContext,
  type NormalizedEvent,
} from '@core/realtime';
import { INCOMING_EVENT_LEASE_MS, enqueueIncomingEvent } from '@db/repositories';
import { DbCommitGuardRejectedError, withDbTransaction } from '@db/transaction';
import { buildMessageIntents } from '@/services/notifications/intents';
import { IncomingEventDrain } from '@/services/realtime/incomingEventDrain';
import { effectivelyLocked } from '@/services/notifications/lockGate';
import { DbEventSink } from '@/services/realtime/dbEventSink';
import { NotifyingEventSink } from '@/services/realtime/notifyingEventSink';
import { createTestDb } from '../support/testDb';

const digest: DigestBackend = {
  async sha256(input) {
    return new Uint8Array(createHash('sha256').update(input).digest());
  },
};

const START = 1_800_000_000_000;
const ALLOW = () => true;

function message(guid: string): NormalizedEvent {
  const event = normalizeRealtimeEvent('new-message', {
    guid,
    text: 'hello',
    dateCreated: START - 1,
    chats: [{ guid: 'drain-chat' }],
  });
  if (!event) throw new Error('message fixture failed');
  return event;
}

function deletion(guid: string): NormalizedEvent {
  const event = normalizeRealtimeEvent('message-deleted', {
    guid,
    chatGuid: 'drain-chat',
    dateDeleted: START + 2,
  });
  if (!event) throw new Error('deletion fixture failed');
  return event;
}

function edit(guid: string): NormalizedEvent {
  const event = normalizeRealtimeEvent('updated-message', {
    guid,
    text: 'hello (edited)',
    dateCreated: START - 1,
    dateEdited: START + 3,
  });
  if (!event) throw new Error('edit fixture failed');
  return event;
}

async function enqueue(
  db: Awaited<ReturnType<typeof createTestDb>>['db'],
  event: NormalizedEvent,
  now = START,
): Promise<void> {
  const encoded = await encodeIncomingEvent(
    event,
    { source: 'fcm', receivedAt: now, transportOccurrenceId: `fcm:${now}` },
    digest,
  );
  await enqueueIncomingEvent(db, encoded.envelope, ALLOW, () => now);
}

function lease(): EventDeliveryContext {
  return { generation: 7, isCurrent: () => true };
}

async function waitForCondition(label: string, condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 20 && !condition(); turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (!condition()) throw new Error(`${label} did not start within 20 event-loop turns`);
}

describe('incoming event drain', () => {
  it('claims, verifies, checkpoints the domain write, and scrubs a completed payload', async () => {
    const { db, raw } = await createTestDb();
    await enqueue(db, message('drain-success'));
    let clock = START;
    let deliveredContext: EventDeliveryContext | undefined;
    const handler = {
      handleNormalized: jest.fn(async (_event, _source, context?: EventDeliveryContext) => {
        deliveredContext = context;
        await withDbTransaction(db, async (transactionContext) => {
          await db.run(sql`INSERT INTO kv (key, value) VALUES ('drain-domain', 'committed')`);
          await context?.durableEvent?.markDbAppliedWithinTransaction(transactionContext);
        });
        return 'processed' as const;
      }),
    };
    const drain = new IncomingEventDrain(db, handler, digest, {
      now: () => clock++,
      makeLeaseToken: () => 'success-lease',
      scheduleContinuation: jest.fn(),
    });

    await drain.kick(lease());

    expect(handler.handleNormalized).toHaveBeenCalledTimes(1);
    expect(raw.prepare(`SELECT value FROM kv WHERE key = 'drain-domain'`).get()).toEqual({
      value: 'committed',
    });
    expect(
      raw
        .prepare(
          `SELECT state, payload, db_applied_at AS dbAppliedAt, lease_token AS leaseToken
             FROM incoming_event_queue`,
        )
        .get(),
    ).toEqual({
      state: 'completed',
      payload: null,
      dbAppliedAt: expect.any(Number),
      leaseToken: null,
    });
    const retainedContext = deliveredContext;
    if (!retainedContext?.durableEvent) throw new Error('durable context was not delivered');
    expect(retainedContext.isCurrent()).toBe(false);
    await expect(
      withDbTransaction(db, async (transactionContext) => {
        await db.run(sql`INSERT INTO kv (key, value) VALUES ('late-success', 'bad')`);
        await retainedContext.durableEvent?.markDbAppliedWithinTransaction(transactionContext);
      }),
    ).rejects.toBeInstanceOf(DbCommitGuardRejectedError);
    expect(raw.prepare(`SELECT value FROM kv WHERE key = 'late-success'`).get()).toBeUndefined();
  });

  it('retries presentation without repeating an already-checkpointed DB mutation', async () => {
    const { db, raw } = await createTestDb();
    await enqueue(db, message('drain-retry'));
    let clock = START;
    let dbWrites = 0;
    let presentations = 0;
    let leaseCounter = 0;
    const handler = {
      async handleNormalized(
        _event: NormalizedEvent,
        _source: 'socket' | 'fcm' | 'dev',
        context?: EventDeliveryContext,
      ) {
        if (context?.durableEvent?.dbAppliedAt == null) {
          await withDbTransaction(db, async (transactionContext) => {
            dbWrites += 1;
            await db.run(
              sql`INSERT INTO kv (key, value) VALUES ('retry-domain', ${String(dbWrites)})
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            );
            await context?.durableEvent?.markDbAppliedWithinTransaction(transactionContext);
          });
        }
        presentations += 1;
        if (presentations === 1) throw new Error('native notification unavailable');
        return 'processed' as const;
      },
    };
    const drain = new IncomingEventDrain(db, handler, digest, {
      now: () => clock,
      makeLeaseToken: () => `retry-lease-${++leaseCounter}`,
      scheduleContinuation: jest.fn(),
      scheduleWake: jest.fn(() => 1 as unknown as ReturnType<typeof setTimeout>),
      cancelWake: jest.fn(),
    });

    await drain.kick(lease());
    const failed = raw
      .prepare(
        `SELECT state, attempts, next_attempt_at AS nextAttemptAt,
                db_applied_at AS dbAppliedAt, last_error_code AS lastErrorCode
           FROM incoming_event_queue`,
      )
      .get() as {
      state: string;
      attempts: number;
      nextAttemptAt: number;
      dbAppliedAt: number | null;
      lastErrorCode: string;
    };
    expect(failed).toEqual({
      state: 'pending',
      attempts: 1,
      nextAttemptAt: START + 30_000,
      dbAppliedAt: START,
      lastErrorCode: 'delivery-failed',
    });

    clock = failed.nextAttemptAt;
    await drain.kick(lease());

    expect(dbWrites).toBe(1);
    expect(presentations).toBe(2);
    expect(raw.prepare(`SELECT state, payload FROM incoming_event_queue`).get()).toEqual({
      state: 'completed',
      payload: null,
    });
  });

  it('applies a queued deletion before retrying an older failed notification', async () => {
    const { db, raw } = await createTestDb();
    const guid = 'notification-then-delete';
    await enqueue(db, message(guid));
    let clock = START;
    let leaseCounter = 0;
    let messageNotificationAttempts = 0;
    const notify = jest.fn(async (intent: { kind: string }) => {
      if (intent.kind !== 'message') return;
      messageNotificationAttempts += 1;
      if (messageNotificationAttempts === 1) {
        throw new Error('native notification unavailable');
      }
    });
    const router = new EventRouter(
      new NotifyingEventSink(new DbEventSink(db), db, buildMessageIntents, notify),
    );
    const drain = new IncomingEventDrain(db, router, digest, {
      now: () => clock,
      makeLeaseToken: () => `phase-lease-${++leaseCounter}`,
      scheduleContinuation: jest.fn(),
      scheduleWake: jest.fn(() => 1 as unknown as ReturnType<typeof setTimeout>),
      cancelWake: jest.fn(),
    });

    // The message DB write commits, but its first native notification attempt fails and backs off.
    await drain.kick(lease());
    expect(messageNotificationAttempts).toBe(1);
    expect(
      raw
        .prepare(
          `SELECT state, db_applied_at AS dbAppliedAt, next_attempt_at AS nextAttemptAt
             FROM incoming_event_queue WHERE event_name = 'new-message'`,
        )
        .get(),
    ).toEqual({ state: 'pending', dbAppliedAt: START, nextAttemptAt: START + 30_000 });

    // A later deletion for the same message must pass the presentation-only row and converge now.
    clock = START + 1;
    await enqueue(db, deletion(guid), clock);
    await drain.kick(lease());
    expect(
      raw.prepare('SELECT date_deleted AS dateDeleted FROM messages WHERE guid = ?').get(guid),
    ).toEqual({ dateDeleted: START + 2 });

    // When the old row retries, notification projection reads CURRENT DB truth and stays silent.
    clock = START + 30_000;
    await drain.kick(lease());
    expect(messageNotificationAttempts).toBe(1);
    expect(notify.mock.calls.map(([intent]) => intent.kind)).toEqual([
      'message',
      'message-withdraw',
    ]);
    expect(
      raw
        .prepare(
          `SELECT event_name AS eventName, state, payload
             FROM incoming_event_queue ORDER BY id`,
        )
        .all(),
    ).toEqual([
      { eventName: 'new-message', state: 'completed', payload: null },
      { eventName: 'message-deleted', state: 'completed', payload: null },
    ]);
  });

  it('completes an unknown queued deletion after durably recording its ledger marker', async () => {
    const { db, raw } = await createTestDb();
    const guid = 'delete-before-message-backfill';
    await enqueue(db, deletion(guid));
    const requestRecovery = jest.fn(async () => undefined);
    const retirement = jest.fn(async () => undefined);
    const permanentFailure = jest.fn();
    const router = new EventRouter(new DbEventSink(db, undefined, retirement, requestRecovery));
    const drain = new IncomingEventDrain(db, router, digest, {
      now: () => START,
      makeLeaseToken: () => 'unknown-deletion-lease',
      scheduleContinuation: jest.fn(),
      onPermanentFailure: permanentFailure,
    });

    await drain.kick(lease());

    expect(
      raw
        .prepare(
          `SELECT state, payload, attempts, db_applied_at AS dbAppliedAt,
                  last_error_code AS lastErrorCode
             FROM incoming_event_queue`,
        )
        .get(),
    ).toEqual({
      state: 'completed',
      payload: null,
      attempts: 1,
      dbAppliedAt: expect.any(Number),
      lastErrorCode: null,
    });
    expect(
      raw
        .prepare(
          `SELECT guid, date_deleted AS dateDeleted
             FROM message_deletion_ledger WHERE guid = ?`,
        )
        .get(guid),
    ).toEqual({ guid, dateDeleted: START + 2 });
    expect(raw.prepare('SELECT id FROM messages WHERE guid = ?').get(guid)).toBeUndefined();
    expect(requestRecovery).not.toHaveBeenCalled();
    expect(retirement).not.toHaveBeenCalled();
    expect(permanentFailure).not.toHaveBeenCalled();
  });

  it('projects an older notification retry from the newer edited DB row', async () => {
    const { db, raw } = await createTestDb();
    const guid = 'notification-then-edit';
    await enqueue(db, message(guid));
    let clock = START;
    let leaseCounter = 0;
    const messageBodies: string[] = [];
    const notify = jest.fn(async (intent: { kind: string; body?: string }) => {
      if (intent.kind !== 'message') return;
      messageBodies.push(intent.body ?? '');
      if (messageBodies.length === 1) throw new Error('native notification unavailable');
    });
    const router = new EventRouter(
      new NotifyingEventSink(new DbEventSink(db), db, buildMessageIntents, notify),
    );
    const drain = new IncomingEventDrain(db, router, digest, {
      now: () => clock,
      makeLeaseToken: () => `edit-phase-lease-${++leaseCounter}`,
      scheduleContinuation: jest.fn(),
      scheduleWake: jest.fn(() => 1 as unknown as ReturnType<typeof setTimeout>),
      cancelWake: jest.fn(),
    });

    await drain.kick(lease());
    expect(messageBodies).toEqual(['hello']);

    clock = START + 1;
    await enqueue(db, edit(guid), clock);
    await drain.kick(lease());
    expect(
      raw.prepare('SELECT text, date_edited AS dateEdited FROM messages WHERE guid = ?').get(guid),
    ).toEqual({ text: 'hello (edited)', dateEdited: START + 3 });

    clock = START + 30_000;
    await drain.kick(lease());
    expect(messageBodies).toEqual(['hello', 'hello (edited)']);
    expect(
      raw.prepare(`SELECT state, payload FROM incoming_event_queue ORDER BY id`).all(),
    ).toEqual([
      { state: 'completed', payload: null },
      { state: 'completed', payload: null },
    ]);
  });

  it('poisons a digest-mismatched row immediately without calling the event handler', async () => {
    const { db, raw } = await createTestDb();
    await enqueue(db, message('drain-corrupt'));
    raw.prepare(`UPDATE incoming_event_queue SET payload = '{"guid":"tampered"}'`).run();
    const handler = { handleNormalized: jest.fn() };
    const permanentFailure = jest.fn();
    let canDrain = true;
    const drain = new IncomingEventDrain(db, handler, digest, {
      now: () => START,
      makeLeaseToken: () => 'corrupt-lease',
      scheduleContinuation: jest.fn(),
      canDrain: () => canDrain,
      onPermanentFailure: permanentFailure,
    });

    await drain.kick(lease());

    expect(handler.handleNormalized).not.toHaveBeenCalled();
    expect(permanentFailure).toHaveBeenCalledWith('new-message', expect.any(Object));
    const recoveryContext = permanentFailure.mock.calls[0]?.[1] as EventDeliveryContext;
    expect(recoveryContext.isCurrent()).toBe(true);
    canDrain = false;
    expect(recoveryContext.isCurrent()).toBe(false);
    expect(
      raw
        .prepare(
          `SELECT state, payload, attempts, last_error_code AS lastErrorCode
             FROM incoming_event_queue`,
        )
        .get(),
    ).toEqual({
      state: 'poisoned',
      payload: null,
      attempts: 1,
      lastErrorCode: 'codec-digest-mismatch',
    });
  });

  it('bounds a hung handler before the lease expires and schedules a retry', async () => {
    const { db, raw } = await createTestDb();
    await enqueue(db, message('drain-timeout'));
    let deadline!: () => void;
    let releaseHandler!: () => void;
    let markLateHandlerDone!: () => void;
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const lateHandlerDone = new Promise<void>((resolve) => {
      markLateHandlerDone = resolve;
    });
    let deliveredContext: EventDeliveryContext | undefined;
    let lateCommitSucceeded = false;
    const cancelDeadline = jest.fn();
    const scheduleWake = jest.fn(() => 2 as unknown as ReturnType<typeof setTimeout>);
    const handler = {
      handleNormalized: jest.fn(async (_event, _source, context?: EventDeliveryContext) => {
        deliveredContext = context;
        await handlerGate;
        try {
          await withDbTransaction(db, async (transactionContext) => {
            await db.run(sql`INSERT INTO kv (key, value) VALUES ('late-timeout', 'bad')`);
            await context?.durableEvent?.markDbAppliedWithinTransaction(transactionContext);
          });
          lateCommitSucceeded = true;
        } catch {
          // Expected: the timeout revoked this attempt before its late continuation resumed.
        } finally {
          markLateHandlerDone();
        }
        return 'processed' as const;
      }),
    };
    const drain = new IncomingEventDrain(db, handler, digest, {
      now: () => START,
      makeLeaseToken: () => 'timeout-lease',
      deliveryTimeoutMs: 100,
      scheduleDeliveryTimeout: (task, delayMs) => {
        expect(delayMs).toBe(100);
        deadline = task;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      cancelDeliveryTimeout: cancelDeadline,
      scheduleContinuation: jest.fn(),
      scheduleWake,
      cancelWake: jest.fn(),
    });

    const flight = drain.kick(lease());
    await waitForCondition('delivery deadline', () => deadline != null);
    expect(deadline).toEqual(expect.any(Function));
    deadline();
    await flight;

    expect(deliveredContext?.isCurrent()).toBe(false);
    expect(cancelDeadline).toHaveBeenCalledTimes(1);
    expect(scheduleWake).toHaveBeenCalledWith(expect.any(Function), 30_000);
    expect(
      raw
        .prepare(
          `SELECT state, attempts, next_attempt_at AS nextAttemptAt,
                  last_error_code AS lastErrorCode
             FROM incoming_event_queue`,
        )
        .get(),
    ).toEqual({
      state: 'pending',
      attempts: 1,
      nextAttemptAt: START + 30_000,
      lastErrorCode: 'delivery-timeout',
    });

    releaseHandler();
    await lateHandlerDone;
    expect(lateCommitSucceeded).toBe(false);
    expect(raw.prepare(`SELECT value FROM kv WHERE key = 'late-timeout'`).get()).toBeUndefined();
  });

  it('revokes an active delivery when the drain gate closes and preserves it for retry', async () => {
    const { db, raw } = await createTestDb();
    await enqueue(db, message('drain-lock-race'));
    let clock = START;
    let canDrain = true;
    let releaseFirstDelivery!: () => void;
    let markFirstDeliveryStarted!: () => void;
    const firstDeliveryGate = new Promise<void>((resolve) => {
      releaseFirstDelivery = resolve;
    });
    const firstDeliveryStarted = new Promise<void>((resolve) => {
      markFirstDeliveryStarted = resolve;
    });
    let attempts = 0;
    let deliveredContext: EventDeliveryContext | undefined;
    let blockedCommitSucceeded = false;
    let nativeContinuations = 0;
    const handler = {
      handleNormalized: jest.fn(async (_event, _source, context?: EventDeliveryContext) => {
        attempts += 1;
        if (attempts === 1) {
          deliveredContext = context;
          markFirstDeliveryStarted();
          await firstDeliveryGate;
          try {
            await withDbTransaction(db, async (transactionContext) => {
              await db.run(sql`INSERT INTO kv (key, value) VALUES ('lock-race-blocked', 'bad')`);
              await context?.durableEvent?.markDbAppliedWithinTransaction(transactionContext);
            });
            blockedCommitSucceeded = true;
          } catch {
            // Expected: the dynamic drain gate revoked this attempt while the handler was paused.
          }
          if (context?.isCurrent()) nativeContinuations += 1;
          return context?.isCurrent() ? ('processed' as const) : ('stale' as const);
        }

        await withDbTransaction(db, async (transactionContext) => {
          await db.run(sql`INSERT INTO kv (key, value) VALUES ('lock-race-retry', 'committed')`);
          await context?.durableEvent?.markDbAppliedWithinTransaction(transactionContext);
        });
        if (context?.isCurrent()) nativeContinuations += 1;
        return 'processed' as const;
      }),
    };
    let leaseTokens = 0;
    const drain = new IncomingEventDrain(db, handler, digest, {
      now: () => clock,
      makeLeaseToken: () => `lock-race-lease-${++leaseTokens}`,
      canDrain: () => canDrain,
      scheduleContinuation: jest.fn(),
    });

    const firstFlight = drain.kick(lease());
    await firstDeliveryStarted;
    canDrain = false;
    expect(deliveredContext?.isCurrent()).toBe(false);
    releaseFirstDelivery();
    await firstFlight;

    expect(blockedCommitSucceeded).toBe(false);
    expect(nativeContinuations).toBe(0);
    expect(
      raw.prepare(`SELECT value FROM kv WHERE key = 'lock-race-blocked'`).get(),
    ).toBeUndefined();
    expect(
      raw
        .prepare(
          `SELECT state, payload IS NOT NULL AS payloadAvailable, attempts,
                  db_applied_at AS dbAppliedAt, lease_expires_at AS leaseExpiresAt
             FROM incoming_event_queue`,
        )
        .get(),
    ).toEqual({
      state: 'pending',
      payloadAvailable: 1,
      attempts: 1,
      dbAppliedAt: null,
      leaseExpiresAt: START + INCOMING_EVENT_LEASE_MS,
    });

    // Unlock/resume owns a fresh flight. Once the abandoned lease expires, it can safely retry.
    canDrain = true;
    clock = START + INCOMING_EVENT_LEASE_MS;
    await drain.kick(lease());

    expect(handler.handleNormalized).toHaveBeenCalledTimes(2);
    expect(nativeContinuations).toBe(1);
    expect(raw.prepare(`SELECT value FROM kv WHERE key = 'lock-race-retry'`).get()).toEqual({
      value: 'committed',
    });
    expect(raw.prepare(`SELECT state, payload, attempts FROM incoming_event_queue`).get()).toEqual({
      state: 'completed',
      payload: null,
      attempts: 2,
    });
  });

  it('reports recovery when the fifth delivery failure poisons the envelope', async () => {
    const { db, raw } = await createTestDb();
    await enqueue(db, message('drain-attempt-cap'));
    raw.prepare(`UPDATE incoming_event_queue SET attempts = 4`).run();
    const permanentFailure = jest.fn();
    const handler = {
      handleNormalized: jest.fn(async () => {
        throw new Error('still unavailable');
      }),
    };
    const drain = new IncomingEventDrain(db, handler, digest, {
      now: () => START,
      makeLeaseToken: () => 'attempt-cap-lease',
      scheduleContinuation: jest.fn(),
      onPermanentFailure: permanentFailure,
    });

    await drain.kick(lease());

    expect(permanentFailure).toHaveBeenCalledWith('new-message', expect.any(Object));
    expect(
      raw
        .prepare(
          `SELECT state, payload, attempts, last_error_code AS lastErrorCode
             FROM incoming_event_queue`,
        )
        .get(),
    ).toEqual({
      state: 'poisoned',
      payload: null,
      attempts: 5,
      lastErrorCode: 'delivery-failed',
    });
  });

  it('coalesces concurrent kicks into one claim flight', async () => {
    const { db } = await createTestDb();
    await enqueue(db, message('drain-single-flight'));
    let release!: () => void;
    const handler = {
      handleNormalized: jest.fn(
        () =>
          new Promise<'processed'>((resolve) => {
            release = () => resolve('processed');
          }),
      ),
    };
    let leases = 0;
    const drain = new IncomingEventDrain(db, handler, digest, {
      now: () => START,
      makeLeaseToken: () => `single-flight-${++leases}`,
      scheduleContinuation: jest.fn(),
    });

    const first = drain.kick(lease());
    const second = drain.kick(lease());
    await waitForCondition('single-flight handler', () => release != null);
    expect(handler.handleNormalized).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(handler.handleNormalized).toHaveBeenCalledTimes(1);
  });

  it('stops before the next private claim when the background lock grace expires', async () => {
    const { db, raw } = await createTestDb();
    await enqueue(db, message('before-lock-timeout'), START);
    await enqueue(db, message('after-lock-timeout'), START + 1);
    let clock = START;
    const lock = {
      enabled: true,
      hydrated: true,
      locked: false,
      lastBackgrounded: START,
      timeoutMs: 100,
    };
    const handler = {
      handleNormalized: jest.fn(async () => {
        clock = START + 101;
        return 'processed' as const;
      }),
    };
    const drain = new IncomingEventDrain(db, handler, digest, {
      now: () => clock,
      makeLeaseToken: () => 'lock-timeout-lease',
      canDrain: () => !effectivelyLocked(lock, false, clock),
      scheduleContinuation: jest.fn(),
    });

    await drain.kick(lease());

    expect(handler.handleNormalized).toHaveBeenCalledTimes(1);
    expect(
      raw.prepare(`SELECT state, attempts FROM incoming_event_queue ORDER BY id`).all(),
    ).toEqual([
      { state: 'pending', attempts: 1 },
      { state: 'pending', attempts: 0 },
    ]);
  });
});
