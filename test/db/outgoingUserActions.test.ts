/**
 * The two user-initiated writes on a not-delivered bubble — "Try Again" and "Delete" — versus the
 * automatic retry drain that runs every 20 s on the same rows.
 *
 * Both used to be a bare `deleteMessageByGuid`, which checks nothing. That is the app's worst
 * write race: the drain leases the row, flips it to 'sending' and starts a POST that can run for
 * seconds (an attachment upload has no timeout at all) while the sheet the user is tapping still
 * shows the state from when it opened. Deleting around that lease and re-sending under a fresh
 * temp id defeats the server's temp-id-keyed idempotency — the recipient gets the message twice —
 * and on the guid-less ack paths (RCS bridge / AppleScript, where a SUCCESSFUL send keeps the temp
 * guid and only flips the state) the same tap deletes and re-sends a message already delivered.
 *
 * Everything below therefore asserts on what the WRITE matched, not on what a prior read saw.
 */
import type Database from 'better-sqlite3';
import { Chat } from '@core/models';
import {
  cancelOutgoing,
  claimFailedOutgoingForRetry,
  claimOutgoingForSend,
  countOutgoingQueueHealth,
  discardOutgoingMessage,
  insertOutgoingContact,
  insertOutgoingText,
  listMessagesWithSenders,
  reconcileEchoByContent,
  reconcileOutgoingError,
  upsertChats,
  upsertHandles,
} from '@db/repositories';
import { DbCommitGuardRejectedError, withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

const OUTGOING_RETRY_LEASE_MS = 120_000;

const nextEventLoopTurn = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

async function seedChat(db: AppDatabase, guid: string): Promise<number> {
  const handles = await upsertHandles(db, [{ address: 'a@x.com' }]);
  const map = await upsertChats(
    db,
    [Chat.parse({ guid, participants: [{ address: 'a@x.com' }] })],
    handles,
  );
  return map.get(guid)!;
}

function count(raw: Database.Database, table: string, where: string, ...args: unknown[]): number {
  return (
    raw.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${where}`).get(...args) as { c: number }
  ).c;
}
/** date_deleted for a guid: undefined = no row, null = live, a number = tombstoned. */
const tombstone = (raw: Database.Database, guid: string): number | null | undefined =>
  (
    raw.prepare('SELECT date_deleted d FROM messages WHERE guid = ?').get(guid) as
      { d: number | null } | undefined
  )?.d;
const msgState = (
  raw: Database.Database,
  guid: string,
): { s: string | null; e: number | null } | undefined =>
  raw.prepare('SELECT send_state s, error e FROM messages WHERE guid = ?').get(guid) as
    { s: string | null; e: number | null } | undefined;

interface RetryQueueState {
  id: number;
  attempts: number;
  nextRetryAt: number;
}

function readRetryQueueState(raw: Database.Database, tempGuid: string): RetryQueueState {
  return raw
    .prepare(
      'SELECT id, attempts, next_retry_at AS nextRetryAt FROM outgoing_queue WHERE temp_guid = ?',
    )
    .get(tempGuid) as RetryQueueState;
}

function setSpentRetryLadder(
  raw: Database.Database,
  tempGuid: string,
  nextRetryAt: number,
): RetryQueueState {
  raw
    .prepare('UPDATE outgoing_queue SET attempts = 5, next_retry_at = ? WHERE temp_guid = ?')
    .run(nextRetryAt, tempGuid);
  return readRetryQueueState(raw, tempGuid);
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

/** Seed a failed optimistic text send (message 'error' + a queue row with a spent attempt). */
async function seedFailed(db: AppDatabase, chatId: number, tempGuid: string): Promise<void> {
  await insertOutgoingText(db, { tempGuid, chatId, chatGuid: 'c1', text: 'hi', now: 100 });
  await reconcileOutgoingError(db, tempGuid, 500, 1_000);
}

async function holdRollingBackTransaction(db: AppDatabase): Promise<{
  release(): void;
  failure: Promise<unknown>;
}> {
  let markStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const neighbour = withDbTransaction(db, async () => {
    markStarted();
    await held;
    throw new Error('neighbour rollback');
  });
  const failure = neighbour.then(
    () => null,
    (error: unknown) => error,
  );
  await started;
  return { release, failure };
}

async function finishAfterQueuedObservation<T>(
  neighbour: { release: () => void; failure: Promise<unknown> },
  pending: Promise<T>,
  observe: () => void | Promise<void>,
): Promise<T> {
  let observationError: unknown;
  try {
    await nextEventLoopTurn();
    await observe();
  } catch (error) {
    observationError = error;
  } finally {
    neighbour.release();
  }
  const [neighbourError, outcome] = await Promise.all([neighbour.failure, pending]);
  if (observationError) throw observationError;
  expect(String(neighbourError)).toContain('neighbour rollback');
  return outcome;
}

describe('claimOutgoingForSend — lease + visible ownership', () => {
  it('queues both writes behind a rolling-back neighbour', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await seedFailed(db, chatId, 'temp-queued-claim');
    const before = raw
      .prepare('SELECT id, next_retry_at AS nextRetryAt FROM outgoing_queue WHERE temp_guid = ?')
      .get('temp-queued-claim') as { id: number; nextRetryAt: number };
    const neighbour = await holdRollingBackTransaction(db);
    const claimResult = claimOutgoingForSend(db, before.id, () => 32_000).then(
      (claimed) => ({ claimed }),
      (error: unknown) => ({ error }),
    );
    let preReleaseError: unknown;
    let neighbourError: unknown;
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(msgState(raw, 'temp-queued-claim')).toEqual({ s: 'error', e: 500 });
      expect(
        raw
          .prepare('SELECT next_retry_at AS nextRetryAt FROM outgoing_queue WHERE id = ?')
          .get(before.id),
      ).toEqual({ nextRetryAt: before.nextRetryAt });
    } catch (error) {
      preReleaseError = error;
    } finally {
      neighbour.release();
      neighbourError = await neighbour.failure;
      await claimResult;
    }
    if (preReleaseError) throw preReleaseError;

    expect(String(neighbourError)).toContain('neighbour rollback');
    expect(await claimResult).toEqual({ claimed: true });
    expect(msgState(raw, 'temp-queued-claim')).toEqual({ s: 'sending', e: 0 });
    expect(
      (
        raw
          .prepare('SELECT next_retry_at AS nextRetryAt FROM outgoing_queue WHERE id = ?')
          .get(before.id) as { nextRetryAt: number }
      ).nextRetryAt,
    ).toBeGreaterThan(before.nextRetryAt);
  });

  it('starts the lease after waiting for the shared write lock', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await seedFailed(db, chatId, 'temp-fresh-lease');
    const queueRow = raw
      .prepare('SELECT id FROM outgoing_queue WHERE temp_guid = ?')
      .get('temp-fresh-lease') as { id: number };
    const neighbour = await holdRollingBackTransaction(db);
    let now = 32_000;
    const claimResult = claimOutgoingForSend(db, queueRow.id, () => now);

    // More than one full lease elapses while this claim is queued. Its lease must be measured
    // from lock acquisition, not from the instant the caller first asked to enter the queue.
    now = 250_000;
    neighbour.release();
    expect(String(await neighbour.failure)).toContain('neighbour rollback');
    await expect(claimResult).resolves.toBe(true);

    expect(
      (
        raw
          .prepare('SELECT next_retry_at AS nextRetryAt FROM outgoing_queue WHERE id = ?')
          .get(queueRow.id) as { nextRetryAt: number }
      ).nextRetryAt,
    ).toBe(370_000);
  });

  it('rolls the lease back when the visible state flip fails', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await seedFailed(db, chatId, 'temp-atomic-claim');
    const before = raw
      .prepare('SELECT id, next_retry_at AS nextRetryAt FROM outgoing_queue WHERE temp_guid = ?')
      .get('temp-atomic-claim') as { id: number; nextRetryAt: number };
    jest.spyOn(db, 'update').mockImplementation(() => {
      throw new Error('forced state-flip failure');
    });

    await expect(claimOutgoingForSend(db, before.id, () => 32_000)).rejects.toThrow(
      'forced state-flip failure',
    );

    expect(msgState(raw, 'temp-atomic-claim')).toEqual({ s: 'error', e: 500 });
    expect(
      raw
        .prepare('SELECT next_retry_at AS nextRetryAt FROM outgoing_queue WHERE id = ?')
        .get(before.id),
    ).toEqual({ nextRetryAt: before.nextRetryAt });
  });
});

describe('claimFailedOutgoingForRetry — "Try Again" vs the automatic drain', () => {
  it('reads its lease clock after a queued neighbour and blocks automatic claiming until that fresh lease expires', async () => {
    const { db, raw } = await createTestDb();
    const tempGuid = 'temp-manual-fresh-clock';
    const chatId = await seedChat(db, 'c1');
    await seedFailed(db, chatId, tempGuid);
    const before = setSpentRetryLadder(raw, tempGuid, 9_000);
    const neighbour = await holdRollingBackTransaction(db);
    const requestedAt = 1_000;
    const acquiredAt = requestedAt + OUTGOING_RETRY_LEASE_MS + 10_000;
    let now = requestedAt;
    const clock = jest.fn(() => now);
    let settled = false;
    const pending = claimFailedOutgoingForRetry(db, tempGuid, clock, () => true)
      .then(
        (value) => ({ kind: 'resolved' as const, value }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      )
      .finally(() => {
        settled = true;
      });

    const outcome = await finishAfterQueuedObservation(neighbour, pending, () => {
      expect(clock).not.toHaveBeenCalled();
      expect(settled).toBe(false);
      expect(msgState(raw, tempGuid)).toEqual({ s: 'error', e: 500 });
      expect(readRetryQueueState(raw, tempGuid)).toEqual(before);
      now = acquiredAt;
    });

    expect(outcome).toEqual({
      kind: 'resolved',
      value: expect.objectContaining({
        claim: 'claimed',
        row: expect.objectContaining({ id: before.id, tempGuid, attempts: 0 }),
      }),
    });
    expect(clock).toHaveBeenCalledTimes(1);
    expect(msgState(raw, tempGuid)).toEqual({ s: 'sending', e: 0 });
    expect(readRetryQueueState(raw, tempGuid)).toEqual({
      id: before.id,
      attempts: 0,
      nextRetryAt: acquiredAt + OUTGOING_RETRY_LEASE_MS,
    });

    await expect(claimOutgoingForSend(db, before.id, () => acquiredAt)).resolves.toBe(false);
    await expect(
      claimOutgoingForSend(db, before.id, () => acquiredAt + OUTGOING_RETRY_LEASE_MS - 1),
    ).resolves.toBe(false);
    await expect(
      claimOutgoingForSend(db, before.id, () => acquiredAt + OUTGOING_RETRY_LEASE_MS),
    ).resolves.toBe(true);
  });

  it('rejects a manual claim revoked while queued and releases the slot for a fresh retry', async () => {
    const { db, raw } = await createTestDb();
    const tempGuid = 'temp-manual-revoked';
    const chatId = await seedChat(db, 'c1');
    await seedFailed(db, chatId, tempGuid);
    const before = setSpentRetryLadder(raw, tempGuid, 11_000);
    const neighbour = await holdRollingBackTransaction(db);
    let current = true;
    const clock = jest.fn(() => 300_000);
    let settled = false;
    const pending = claimFailedOutgoingForRetry(db, tempGuid, clock, () => current)
      .then(
        (value) => ({ kind: 'resolved' as const, value }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      )
      .finally(() => {
        settled = true;
      });

    const outcome = await finishAfterQueuedObservation(neighbour, pending, () => {
      expect(clock).not.toHaveBeenCalled();
      expect(settled).toBe(false);
      expect(msgState(raw, tempGuid)).toEqual({ s: 'error', e: 500 });
      expect(readRetryQueueState(raw, tempGuid)).toEqual(before);
      // withDbTransaction claimed this queue slot synchronously when `pending` was created.
      current = false;
    });

    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') {
      expect(outcome.error).toBeInstanceOf(DbCommitGuardRejectedError);
    }
    expect(clock).not.toHaveBeenCalled();
    expect(msgState(raw, tempGuid)).toEqual({ s: 'error', e: 500 });
    expect(readRetryQueueState(raw, tempGuid)).toEqual(before);

    const freshNow = 400_000;
    const freshClock = jest.fn(() => freshNow);
    await expect(
      claimFailedOutgoingForRetry(db, tempGuid, freshClock, () => true),
    ).resolves.toEqual(
      expect.objectContaining({
        claim: 'claimed',
        row: expect.objectContaining({ id: before.id, tempGuid, attempts: 0 }),
      }),
    );
    expect(freshClock).toHaveBeenCalledTimes(1);
    expect(msgState(raw, tempGuid)).toEqual({ s: 'sending', e: 0 });
    expect(readRetryQueueState(raw, tempGuid)).toEqual({
      id: before.id,
      attempts: 0,
      nextRetryAt: freshNow + OUTGOING_RETRY_LEASE_MS,
    });
  });

  it('rolls the bubble claim back when re-arming its exact queue row fails, then retries', async () => {
    const { db, raw } = await createTestDb();
    const tempGuid = 'temp-manual-atomic';
    const chatId = await seedChat(db, 'c1');
    await seedFailed(db, chatId, tempGuid);
    const before = setSpentRetryLadder(raw, tempGuid, 13_000);
    const canary = 'MANUAL_RETRY_REARM_RAW_CANARY';
    raw.exec(`
      CREATE TRIGGER reject_manual_retry_rearm
      BEFORE UPDATE OF attempts, next_retry_at ON outgoing_queue
      WHEN OLD.temp_guid = '${tempGuid}' AND NEW.attempts = 0
      BEGIN
        SELECT RAISE(ABORT, '${canary}');
      END
    `);

    const failure = await claimFailedOutgoingForRetry(
      db,
      tempGuid,
      () => 500_000,
      () => true,
    ).then(
      (value) => ({ kind: 'resolved' as const, value }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
    expect(failure.kind).toBe('rejected');
    if (failure.kind === 'rejected') {
      expect(errorMessageChain(failure.error)).toContain(canary);
    }
    expect(msgState(raw, tempGuid)).toEqual({ s: 'error', e: 500 });
    expect(readRetryQueueState(raw, tempGuid)).toEqual(before);

    raw.exec('DROP TRIGGER reject_manual_retry_rearm');
    await expect(
      claimFailedOutgoingForRetry(
        db,
        tempGuid,
        () => 600_000,
        () => true,
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        claim: 'claimed',
        row: expect.objectContaining({ id: before.id, tempGuid, attempts: 0 }),
      }),
    );
    expect(msgState(raw, tempGuid)).toEqual({ s: 'sending', e: 0 });
    expect(readRetryQueueState(raw, tempGuid)).toEqual({
      id: before.id,
      attempts: 0,
      nextRetryAt: 600_000 + OUTGOING_RETRY_LEASE_MS,
    });
  });

  it('awaits the exact queue re-arm driver operation before committing or returning', async () => {
    const { db, raw } = await createTestDb();
    const tempGuid = 'temp-manual-delayed-rearm';
    const chatId = await seedChat(db, 'c1');
    await seedFailed(db, chatId, tempGuid);
    const before = setSpentRetryLadder(raw, tempGuid, 15_000);
    const retryNow = 700_000;

    type Run = (query: unknown) => unknown;
    const originalRun = db.run as Run;
    const realRun = db.run.bind(db) as Run;
    let rearmDidStart = false;
    let releaseRearm!: () => void;
    let markRearmFinished!: () => void;
    const rearmHeld = new Promise<void>((resolve) => {
      releaseRearm = resolve;
    });
    const rearmFinished = new Promise<void>((resolve) => {
      markRearmFinished = resolve;
    });
    (db as unknown as { run: Run }).run = (query) => {
      const sqlShape = JSON.stringify(query);
      if (
        !rearmDidStart &&
        sqlShape.includes('outgoing_queue') &&
        sqlShape.includes('attempts = 0') &&
        sqlShape.includes('next_retry_at') &&
        sqlShape.includes('temp_guid')
      ) {
        rearmDidStart = true;
        return rearmHeld.then(() => realRun(query)).finally(markRearmFinished);
      }
      return realRun(query);
    };

    const clock = jest.fn(() => retryNow);
    let settled = false;
    let outcomePromise:
      | Promise<
          | { kind: 'resolved'; value: Awaited<ReturnType<typeof claimFailedOutgoingForRetry>> }
          | { kind: 'rejected'; error: unknown }
        >
      | undefined;
    try {
      outcomePromise = claimFailedOutgoingForRetry(db, tempGuid, clock, () => true)
        .then(
          (value) => ({ kind: 'resolved' as const, value }),
          (error: unknown) => ({ kind: 'rejected' as const, error }),
        )
        .finally(() => {
          settled = true;
        });
      for (let turn = 0; turn < 20 && !rearmDidStart; turn += 1) {
        await nextEventLoopTurn();
      }
      if (!rearmDidStart) {
        throw new Error('manual retry queue re-arm did not start within 20 event-loop turns');
      }

      expect(clock).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      expect(raw.inTransaction).toBe(true);
      expect(msgState(raw, tempGuid)).toEqual({ s: 'sending', e: 0 });
      expect(readRetryQueueState(raw, tempGuid)).toEqual(before);

      releaseRearm();
      const [outcome] = await Promise.all([outcomePromise, rearmFinished]);
      expect(outcome).toEqual({
        kind: 'resolved',
        value: expect.objectContaining({
          claim: 'claimed',
          row: expect.objectContaining({ id: before.id, tempGuid, attempts: 0 }),
        }),
      });
      expect(raw.inTransaction).toBe(false);
      expect(readRetryQueueState(raw, tempGuid)).toEqual({
        id: before.id,
        attempts: 0,
        nextRetryAt: retryNow + OUTGOING_RETRY_LEASE_MS,
      });
    } finally {
      releaseRearm();
      try {
        const drains: Promise<unknown>[] = [];
        if (outcomePromise) drains.push(outcomePromise);
        if (rearmDidStart) drains.push(rearmFinished);
        await Promise.allSettled(drains);
      } finally {
        (db as unknown as { run: Run }).run = originalRun;
      }
    }
  });

  /**
   * The claim KEEPS the message and the queue row. Deleting them and letting the caller re-send
   * from scratch was two bugs in one: the fresh temp guid is a second idempotency key at the
   * server (an ack-lost send is then delivered twice), and the caller could only rebuild the send
   * from the BUBBLE — so a failed contact card went out as a plain message reading the contact's
   * name. The payload is handed back instead, and the row stays put under its original id.
   */
  it('claims a genuinely errored row: same temp guid, same payload, ladder re-armed', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await seedFailed(db, chatId, 'temp-fail');
    raw
      .prepare("UPDATE outgoing_queue SET attempts=5 WHERE temp_guid='temp-fail'") // retired at the cap
      .run();

    const res = await claimFailedOutgoingForRetry(db, 'temp-fail', () => 1_000);

    expect(res.claim).toBe('claimed');
    expect(res.row?.tempGuid).toBe('temp-fail');
    expect(res.row?.kind).toBe('text');
    expect(JSON.parse(res.row!.payload)).toMatchObject({ message: 'hi' });
    // The bubble is now visibly in flight, and its ladder is reset (the button is the ONLY
    // recourse for a row already retired at the cap) and leased against a concurrent drain.
    expect(count(raw, 'messages', "guid = ? AND send_state = 'sending'", 'temp-fail')).toBe(1);
    const q = raw
      .prepare("SELECT attempts a, next_retry_at n FROM outgoing_queue WHERE temp_guid='temp-fail'")
      .get() as { a: number; n: number };
    expect(q.a).toBe(0);
    expect(q.n).toBeGreaterThan(1_000);
  });

  it('carries a CONTACT card back as a contact payload, never as the bubble text', async () => {
    const { db } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingContact(db, {
      tempGuid: 'temp-card',
      chatId,
      chatGuid: 'c1',
      text: 'Craig Federighi',
      contact: { firstName: 'Craig', lastName: 'Federighi' },
      now: 100,
    });
    await reconcileOutgoingError(db, 'temp-card', 500, 1_000);

    const res = await claimFailedOutgoingForRetry(db, 'temp-card', () => 2_000);

    expect(res.claim).toBe('claimed');
    expect(res.row?.kind).toBe('contact'); // 'text' here delivers "Craig Federighi" as a message
    expect(JSON.parse(res.row!.payload)).toMatchObject({
      firstName: 'Craig',
      lastName: 'Federighi',
    });
  });

  /**
   * THE duplicate-delivery guard. The drain's `claimOutgoingForSend` makes an in-flight attempt
   * visible on the message row, so 'sending' is the signal that someone else's POST owns this
   * send. Claiming here would re-POST alongside a live attempt.
   */
  it('REFUSES a row the drain has already taken over, leaving the lease intact', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await seedFailed(db, chatId, 'temp-inflight');
    const queueRow = raw
      .prepare("SELECT id FROM outgoing_queue WHERE temp_guid='temp-inflight'")
      .get() as { id: number };
    await expect(claimOutgoingForSend(db, queueRow.id, () => 32_000)).resolves.toBe(true);
    const leaseBefore = (
      raw
        .prepare("SELECT next_retry_at n FROM outgoing_queue WHERE temp_guid='temp-inflight'")
        .get() as { n: number }
    ).n;

    expect((await claimFailedOutgoingForRetry(db, 'temp-inflight')).claim).toBe('sending');
    // Nothing written at all: the in-flight attempt still owns its bubble AND its retry ladder.
    expect(count(raw, 'messages', 'guid = ?', 'temp-inflight')).toBe(1);
    expect(count(raw, 'outgoing_queue', 'temp_guid = ?', 'temp-inflight')).toBe(1);
    expect(
      (
        raw
          .prepare("SELECT next_retry_at n FROM outgoing_queue WHERE temp_guid='temp-inflight'")
          .get() as { n: number }
      ).n,
    ).toBe(leaseBefore);
  });

  it('REFUSES a row that already reconciled to sent under its own temp guid (RCS / AppleScript)', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await seedFailed(db, chatId, 'temp-sent');
    // The guid-less ack paths keep the temp guid and only flip the state.
    raw.prepare("UPDATE messages SET send_state='sent', error=0 WHERE guid='temp-sent'").run();

    expect((await claimFailedOutgoingForRetry(db, 'temp-sent')).claim).toBe('settled');
    expect(count(raw, 'messages', "guid = ? AND send_state = 'sent'", 'temp-sent')).toBe(1);
  });

  it('REFUSES a temp guid whose row was promoted to its real identity (nothing left to retry)', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await seedFailed(db, chatId, 'temp-promoted');
    // The drain's retry landed and the ack promoted the row; the sheet still holds the old guid.
    raw
      .prepare("UPDATE messages SET guid='real-7', send_state='sent' WHERE guid='temp-promoted'")
      .run();

    expect((await claimFailedOutgoingForRetry(db, 'temp-promoted')).claim).toBe('settled');
    expect(count(raw, 'messages', 'guid = ?', 'real-7')).toBe(1);
  });

  /**
   * No queue row = no payload, so there is nothing to re-POST and no honest way to rebuild one.
   * The old code hit this case too — and "rebuilt" it from the bubble, which for a REAL server
   * guid meant deleting a delivered message and sending a fresh copy of its text.
   */
  it('REFUSES an errored row with no ladder, and writes nothing', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    raw
      .prepare(
        "INSERT INTO messages (guid, chat_id, text, is_from_me, date_created, send_state, error) VALUES ('rcs-51', ?, 'delivered then failed', 1, 100, 'error', 1)",
      )
      .run(chatId);

    expect((await claimFailedOutgoingForRetry(db, 'rcs-51')).claim).toBe('unsendable');
    expect(count(raw, 'messages', "guid = ? AND send_state = 'error'", 'rcs-51')).toBe(1);
  });
});

describe('discardOutgoingMessage — "Delete" on a not-delivered bubble', () => {
  it('TOMBSTONES a still-sending send (the POST already left the device) and drops its ladder', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-live',
      chatId,
      chatGuid: 'c1',
      text: 'too late',
      now: 100,
    });

    expect(await discardOutgoingMessage(db, 'temp-live', 9_000)).toBe(true);
    expect(tombstone(raw, 'temp-live')).toBe(9_000);
    expect(await listMessagesWithSenders(db, chatId)).toHaveLength(0);
    expect(count(raw, 'outgoing_queue', 'temp_guid = ?', 'temp-live')).toBe(0);
    // The row survives precisely so the server's echo is promoted ONTO it — hard-deleting it left
    // the echo nothing to attach the deletion to, and the message came back as a sent bubble.
    await withDbTransaction(db, (context) =>
      reconcileEchoByContent(
        context,
        { guid: 'real-live', isFromMe: true, text: 'too late', dateCreated: 100 },
        chatId,
      ),
    );
    expect(tombstone(raw, 'real-live')).toBe(9_000);
    expect(await listMessagesWithSenders(db, chatId)).toHaveLength(0);
  });

  /**
   * The case the old queue-row-gated cancel could not reach: the RCS immediate-ack consumed the
   * queue row (or a crash landed between the two inserts), so the bubble is optimistic but
   * queue-less. Requiring a queue row meant "Cancel Sending" silently returned false and the
   * bubble was stuck on 'sending' with no way to remove it — which is why the guard now reads the
   * MESSAGE's send state instead. Both names are the same write, so both must handle it.
   */
  it('removes an optimistic row that no longer owns a queue row', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-noqueue',
      chatId,
      chatGuid: 'c1',
      text: 'stuck',
      now: 100,
    });
    raw.prepare("DELETE FROM outgoing_queue WHERE temp_guid='temp-noqueue'").run();

    expect(await discardOutgoingMessage(db, 'temp-noqueue', 9_000)).toBe(true);
    expect(tombstone(raw, 'temp-noqueue')).toBe(9_000);
    expect(await listMessagesWithSenders(db, chatId)).toHaveLength(0);
  });

  // "Cancel Sending" and "Delete" are the same guarded write under two names — a queue-less
  // optimistic row must be removable from either, or the affordance the user actually sees
  // decides whether their message can be cancelled.
  it('behaves identically under the "Cancel Sending" name', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-cancelname',
      chatId,
      chatGuid: 'c1',
      text: 'stuck',
      now: 100,
    });
    raw.prepare("DELETE FROM outgoing_queue WHERE temp_guid='temp-cancelname'").run();

    expect(await cancelOutgoing(db, 'temp-cancelname', 9_000)).toBe(true);
    expect(tombstone(raw, 'temp-cancelname')).toBe(9_000);
    expect(await listMessagesWithSenders(db, chatId)).toHaveLength(0);
  });

  it('leaves a DELIVERED message alone and reports it did not own it', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-done',
      chatId,
      chatGuid: 'c1',
      text: 'delivered',
      now: 100,
    });
    raw.prepare("UPDATE messages SET send_state='sent' WHERE guid='temp-done'").run();
    raw.prepare("DELETE FROM outgoing_queue WHERE temp_guid='temp-done'").run();

    expect(await discardOutgoingMessage(db, 'temp-done')).toBe(false);
    expect(count(raw, 'messages', 'guid = ?', 'temp-done')).toBe(1);
    expect(tombstone(raw, 'temp-done')).toBeNull(); // untouched — the caller owns it
  });

  /**
   * A hard delete of a message the SERVER still has is undone by the next chat open (ensureChatSynced
   * re-pages the thread), so a real guid must fall through to the caller's tombstone path instead.
   */
  it('does not touch a real (server-issued) guid, even when it is errored', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    raw
      .prepare(
        "INSERT INTO messages (guid, chat_id, text, is_from_me, date_created, send_state, error) VALUES ('rcs-99', ?, 'server said no', 1, 100, 'error', 1)",
      )
      .run(chatId);

    expect(await discardOutgoingMessage(db, 'rcs-99')).toBe(false);
    expect(count(raw, 'messages', 'guid = ?', 'rcs-99')).toBe(1);
    expect(tombstone(raw, 'rcs-99')).toBeNull(); // the caller's tombstone path owns it
  });
});

describe('countOutgoingQueueHealth — the boot diagnostic for the two crash gaps', () => {
  it('is clean for a normal optimistic send', async () => {
    const { db } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-ok',
      chatId,
      chatGuid: 'c1',
      text: 'hi',
      now: 100,
    });
    expect(await countOutgoingQueueHealth(db)).toEqual({
      strandedSending: 0,
      orphanQueueRows: 0,
    });
  });

  it('does NOT count a CANCELLED send, which stays "sending" on purpose with no ladder', async () => {
    const { db } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-cancelled',
      chatId,
      chatGuid: 'c1',
      text: 'nope',
      now: 100,
    });
    await discardOutgoingMessage(db, 'temp-cancelled', 9_000);
    // Both halves of the pattern are present (sending + no queue row) but they are deliberate, so
    // counting it would warn about a permanent, self-inflicted "stranded send" on every launch.
    expect(await countOutgoingQueueHealth(db)).toEqual({
      strandedSending: 0,
      orphanQueueRows: 0,
    });
  });

  it('counts a bubble stuck on sending with no queue row, and a queue row with no bubble', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-stranded',
      chatId,
      chatGuid: 'c1',
      text: 'never sent',
      now: 100,
    });
    raw.prepare("DELETE FROM outgoing_queue WHERE temp_guid='temp-stranded'").run();
    await insertOutgoingText(db, {
      tempGuid: 'temp-orphan',
      chatId,
      chatGuid: 'c1',
      text: 'no bubble',
      now: 100,
    });
    raw.prepare("DELETE FROM messages WHERE guid='temp-orphan'").run();

    expect(await countOutgoingQueueHealth(db)).toEqual({
      strandedSending: 1,
      orphanQueueRows: 1,
    });
  });
});
