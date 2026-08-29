import { ApiError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';
import { sql } from 'drizzle-orm';
import {
  claimDueScheduled,
  claimScheduled,
  deleteScheduled,
  deleteScheduledHistory,
  deleteScheduledHistoryWithinTransaction,
  deleteScheduledWithinTransaction,
  getScheduledById,
  insertScheduled,
  listAllScheduled,
  listDueScheduled,
  listScheduledHistory,
  markScheduledFailed,
  markScheduledSent,
  rearmScheduled,
  reconcileServerScheduled,
  resetStuckScheduled,
  SCHED_MAX_ATTEMPTS,
  updateScheduled,
} from '@db/repositories';
import { DbCommitGuardRejectedError, withDbTransaction } from '@db/transaction';
import { nextOccurrence } from '@core/schedule';
import * as scheduledApi from '@core/api/endpoints/scheduled';
import { ScheduledItem } from '@core/api/endpoints/scheduled';
import { runDueScheduled, scheduleTextMessage } from '@/services/send/scheduleService';
import { createTestDb } from '../support/testDb';

const noHttp = {} as unknown as HttpClient;

describe('scheduled messages repo', () => {
  it('inserts, lists (parsed text + pending), and deletes', async () => {
    const { db } = await createTestDb();
    const id = await insertScheduled(db, { chatGuid: 'c1', text: 'later', scheduledFor: 5000 });
    const all = await listAllScheduled(db);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id, chatGuid: 'c1', text: 'later', status: 'pending' });
    await deleteScheduled(db, id);
    expect(await listAllScheduled(db)).toHaveLength(0);
  });

  it('round-trips a reply target and part through the payload', async () => {
    const { db } = await createTestDb();
    await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'threaded',
      scheduledFor: 1,
      selectedMessageGuid: 'orig-guid',
      selectedMessagePartIndex: 2,
    });
    const [row] = await listDueScheduled(db, 1000);
    expect(row?.selectedMessageGuid).toBe('orig-guid');
    expect(row?.selectedMessagePartIndex).toBe(2);
  });

  it('stores a uuid-STRING serverId verbatim (SQLite INTEGER affinity keeps non-numeric text)', async () => {
    const { db } = await createTestDb();
    const id = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'srv',
      scheduledFor: 1,
      serverId: '3f2b1a90-uuid-4c2d',
    });
    const row = await getScheduledById(db, id);
    expect(row?.serverId).toBe('3f2b1a90-uuid-4c2d');
  });

  it('listDueScheduled returns only past-due pending rows', async () => {
    const { db } = await createTestDb();
    const now = 1_000_000;
    const past = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'now',
      scheduledFor: now - 1000,
    });
    await insertScheduled(db, { chatGuid: 'c1', text: 'soon', scheduledFor: now + 60_000 });
    const due = await listDueScheduled(db, now);
    expect(due.map((d) => d.id)).toEqual([past]);
  });

  it('listScheduledHistory surfaces sent, errored, and uncertain rows and Clear removes them', async () => {
    const { db } = await createTestDb();
    const sent = await insertScheduled(db, { chatGuid: 'c1', text: 'went out', scheduledFor: 100 });
    await claimScheduled(db, sent);
    await markScheduledSent(db, sent);
    const failed = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'no luck',
      scheduledFor: 200,
    });
    // Exhaust attempts → retired to status='error' (the silently-vanishing case this fixes).
    for (let i = 0; i < SCHED_MAX_ATTEMPTS; i++) {
      await claimScheduled(db, failed);
      await markScheduledFailed(db, failed);
    }
    const uncertain = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'check the conversation',
      scheduledFor: 250,
    });
    await db.run(sql`UPDATE scheduled_messages SET status = 'uncertain' WHERE id = ${uncertain}`);
    await insertScheduled(db, { chatGuid: 'c1', text: 'still pending', scheduledFor: 300 });

    const history = await listScheduledHistory(db);
    expect(history.map((r) => r.status)).toEqual(['uncertain', 'error', 'sent']);
    expect(history.map((r) => r.text)).toEqual(['check the conversation', 'no luck', 'went out']);

    await deleteScheduledHistory(db, failed);
    await deleteScheduledHistory(db, uncertain);
    expect((await listScheduledHistory(db)).map((r) => r.id)).toEqual([sent]);
    // Clear never touches a pending row.
    const pendingRow = (await listAllScheduled(db))[0]!;
    await deleteScheduledHistory(db, pendingRow.id);
    expect(await listAllScheduled(db)).toHaveLength(1);
  });

  it('rolls back a history clear when its account guard is revoked during the delete', async () => {
    const { db, raw } = await createTestDb();
    const id = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'must survive revocation',
      scheduledFor: 100,
    });
    await claimScheduled(db, id);
    await markScheduledSent(db, id);

    let current = true;
    let triggerRan = false;
    raw.function('revoke_scheduled_history_guard', () => {
      triggerRan = true;
      current = false;
      return 1;
    });
    raw.exec(`
      CREATE TRIGGER revoke_guard_after_scheduled_history_delete
      AFTER DELETE ON scheduled_messages
      WHEN OLD.id = ${id}
      BEGIN
        SELECT revoke_scheduled_history_guard();
      END
    `);

    await expect(
      withDbTransaction(
        db,
        (context) => deleteScheduledHistoryWithinTransaction(context, id),
        () => current,
      ),
    ).rejects.toBeInstanceOf(DbCommitGuardRejectedError);

    expect(triggerRan).toBe(true);
    expect(await getScheduledById(db, id)).toMatchObject({ id, status: 'sent' });
  });

  it('rolls back a scheduled-row delete when its account guard is revoked mid-delete', async () => {
    const { db, raw } = await createTestDb();
    const id = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'keep after revocation',
      scheduledFor: 100,
      serverId: 'server-row',
    });

    let current = true;
    let triggerRan = false;
    raw.function('revoke_scheduled_delete_guard', () => {
      triggerRan = true;
      current = false;
      return 1;
    });
    raw.exec(`
      CREATE TRIGGER revoke_guard_after_scheduled_delete
      AFTER DELETE ON scheduled_messages
      WHEN OLD.id = ${id}
      BEGIN
        SELECT revoke_scheduled_delete_guard();
      END
    `);

    await expect(
      withDbTransaction(
        db,
        (context) => deleteScheduledWithinTransaction(context, id),
        () => current,
      ),
    ).rejects.toBeInstanceOf(DbCommitGuardRejectedError);

    expect(triggerRan).toBe(true);
    expect(await getScheduledById(db, id)).toMatchObject({ id, status: 'pending' });
  });

  it('markScheduledSent removes a row from pending + due lists', async () => {
    const { db } = await createTestDb();
    const id = await insertScheduled(db, { chatGuid: 'c1', text: 'x', scheduledFor: 1 });
    await claimScheduled(db, id);
    expect(await markScheduledSent(db, id)).toBe(true);
    expect(await listAllScheduled(db)).toHaveLength(0);
    expect(await listDueScheduled(db, 9999)).toHaveLength(0);
  });

  it('queues every delivery transition behind a rolling-back neighbour', async () => {
    const { db, raw } = await createTestDb();
    const claimId = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'claim',
      scheduledFor: 100,
    });
    const sentId = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'sent',
      scheduledFor: 200,
    });
    const rearmId = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'rearm',
      scheduledFor: 300,
    });
    const failedId = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'failed',
      scheduledFor: 400,
    });
    raw
      .prepare(
        "UPDATE scheduled_messages SET status = 'sending', attempts = CASE WHEN id = ? THEN 2 ELSE attempts END WHERE id IN (?, ?, ?)",
      )
      .run(failedId, sentId, rearmId, failedId);

    const readStates = () =>
      raw
        .prepare(
          'SELECT id, status, server_id, scheduled_for, attempts FROM scheduled_messages ORDER BY id',
        )
        .all();
    const initial = readStates();
    let neighbourStarted!: () => void;
    let releaseNeighbour!: () => void;
    const started = new Promise<void>((resolve) => {
      neighbourStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const neighbour = withDbTransaction(db, async () => {
      neighbourStarted();
      await release;
      throw new Error('neighbour rollback');
    });
    await started;

    let completed = 0;
    const track = <T>(operation: Promise<T>): Promise<T> =>
      operation.then((value) => {
        completed += 1;
        return value;
      });
    const operations = [
      track(claimScheduled(db, claimId)),
      track(markScheduledSent(db, sentId, 'server-terminal')),
      track(rearmScheduled(db, rearmId, 9_000)),
      track(markScheduledFailed(db, failedId)),
    ] as const;
    await Promise.resolve();
    const whileBlocked = readStates();
    const completedWhileBlocked = completed;

    releaseNeighbour();
    await expect(neighbour).rejects.toThrow('neighbour rollback');
    await expect(Promise.all(operations)).resolves.toEqual([true, true, true, 'pending']);

    expect(completedWhileBlocked).toBe(0);
    expect(whileBlocked).toEqual(initial);
    expect(readStates()).toEqual([
      expect.objectContaining({ id: claimId, status: 'sending', attempts: 0 }),
      expect.objectContaining({
        id: sentId,
        status: 'sent',
        server_id: 'server-terminal',
      }),
      expect.objectContaining({
        id: rearmId,
        status: 'pending',
        scheduled_for: 9_000,
        attempts: 0,
      }),
      expect.objectContaining({ id: failedId, status: 'pending', attempts: 3 }),
    ]);
  });

  it('rolls back every queued delivery transition when its account guard is revoked', async () => {
    const { db, raw } = await createTestDb();
    const claimId = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'claim',
      scheduledFor: 100,
    });
    const sentId = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'sent',
      scheduledFor: 200,
    });
    const rearmId = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'rearm',
      scheduledFor: 300,
    });
    const failedId = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'failed',
      scheduledFor: 400,
    });
    raw
      .prepare(
        "UPDATE scheduled_messages SET status = 'sending', attempts = CASE WHEN id = ? THEN 2 ELSE attempts END WHERE id IN (?, ?, ?)",
      )
      .run(failedId, sentId, rearmId, failedId);

    const readStates = () =>
      raw
        .prepare(
          'SELECT id, status, server_id, scheduled_for, attempts FROM scheduled_messages ORDER BY id',
        )
        .all();
    const initial = readStates();
    let neighbourStarted!: () => void;
    let releaseNeighbour!: () => void;
    const started = new Promise<void>((resolve) => {
      neighbourStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const neighbour = withDbTransaction(db, async () => {
      neighbourStarted();
      await release;
      throw new Error('neighbour rollback');
    });
    await started;

    let current = true;
    const guard = () => current;
    let completed = 0;
    const track = <T>(operation: Promise<T>): Promise<T> =>
      operation.finally(() => {
        completed += 1;
      });
    const operations = [
      track(claimScheduled(db, claimId, guard)),
      track(markScheduledSent(db, sentId, 'must-not-land', guard)),
      track(rearmScheduled(db, rearmId, 9_000, guard)),
      track(markScheduledFailed(db, failedId, guard)),
    ];
    const outcomesPromise = Promise.allSettled(operations);
    await Promise.resolve();
    const whileBlocked = readStates();
    const completedWhileBlocked = completed;
    current = false;

    releaseNeighbour();
    await expect(neighbour).rejects.toThrow('neighbour rollback');
    const outcomes = await outcomesPromise;

    expect(completedWhileBlocked).toBe(0);
    expect(whileBlocked).toEqual(initial);
    expect(outcomes).toHaveLength(4);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe('rejected');
      if (outcome.status === 'rejected') {
        expect(outcome.reason).toBeInstanceOf(DbCommitGuardRejectedError);
      }
    }
    expect(readStates()).toEqual(initial);
  });

  it('queues create, edit, delete, and history clearing behind a rolling-back neighbour', async () => {
    const { db } = await createTestDb();
    const editId = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'before edit',
      scheduledFor: 1000,
    });
    const deleteId = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'delete me',
      scheduledFor: 2000,
    });
    const historyId = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'clear me',
      scheduledFor: 3000,
    });
    await claimScheduled(db, historyId);
    await markScheduledSent(db, historyId);

    let neighbourStarted!: () => void;
    let releaseNeighbour!: () => void;
    const started = new Promise<void>((resolve) => {
      neighbourStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const neighbour = withDbTransaction(db, async () => {
      neighbourStarted();
      await release;
      throw new Error('neighbour rollback');
    });
    await started;

    const created = insertScheduled(db, {
      chatGuid: 'c1',
      text: 'created later',
      scheduledFor: 4000,
    });
    const edited = updateScheduled(db, editId, { text: 'after edit', scheduledFor: 5000 });
    const deleted = deleteScheduled(db, deleteId);
    const historyCleared = deleteScheduledHistory(db, historyId);
    await Promise.resolve();

    expect(await getScheduledById(db, editId)).toMatchObject({
      text: 'before edit',
      scheduledFor: 1000,
    });
    expect(await getScheduledById(db, deleteId)).not.toBeNull();
    expect(await listScheduledHistory(db)).toHaveLength(1);
    expect(await listAllScheduled(db)).toHaveLength(2);

    releaseNeighbour();
    await expect(neighbour).rejects.toThrow('neighbour rollback');
    await expect(created).resolves.toEqual(expect.any(Number));
    await Promise.all([edited, deleted, historyCleared]);

    expect(await getScheduledById(db, editId)).toMatchObject({
      text: 'after edit',
      scheduledFor: 5000,
    });
    expect(await getScheduledById(db, deleteId)).toBeNull();
    expect(await listScheduledHistory(db)).toHaveLength(0);
    expect((await listAllScheduled(db)).map((row) => row.text).sort()).toEqual([
      'after edit',
      'created later',
    ]);
  });

  describe('concurrency claim (no double-send)', () => {
    it('claims only a still-due local row and returns its authoritative payload', async () => {
      const { db } = await createTestDb();
      const dueId = await insertScheduled(db, {
        chatGuid: 'c1',
        text: 'before edit',
        scheduledFor: 100,
        selectedMessageGuid: 'reply-guid',
      });
      const futureId = await insertScheduled(db, {
        chatGuid: 'c1',
        text: 'future',
        scheduledFor: 2_000,
      });
      const serverId = await insertScheduled(db, {
        chatGuid: 'c1',
        text: 'server-owned',
        scheduledFor: 100,
        serverId: 'srv-claim',
      });
      await updateScheduled(db, dueId, { text: 'after edit' });

      await expect(claimDueScheduled(db, dueId, 1_000)).resolves.toMatchObject({
        id: dueId,
        status: 'sending',
        text: 'after edit',
        selectedMessageGuid: 'reply-guid',
      });
      await expect(claimDueScheduled(db, futureId, 1_000)).resolves.toBeNull();
      await expect(claimDueScheduled(db, serverId, 1_000)).resolves.toBeNull();
      expect((await getScheduledById(db, futureId))?.status).toBe('pending');
      expect((await getScheduledById(db, serverId))?.status).toBe('pending');
    });

    it('claimScheduled is a one-shot lock: first claim wins, second fails', async () => {
      const { db } = await createTestDb();
      const id = await insertScheduled(db, { chatGuid: 'c1', text: 'x', scheduledFor: 1 });
      expect(await claimScheduled(db, id)).toBe(true); // pending → sending
      expect(await claimScheduled(db, id)).toBe(false); // already sending
    });

    it("a claimed ('sending') row is excluded from the due list", async () => {
      const { db } = await createTestDb();
      const id = await insertScheduled(db, { chatGuid: 'c1', text: 'x', scheduledFor: 1 });
      await claimScheduled(db, id);
      expect(await listDueScheduled(db, 9999)).toHaveLength(0);
      expect(await listAllScheduled(db)).toHaveLength(0);
    });
  });

  describe('runDueScheduled', () => {
    it('fires due rows via the injected sender (with reply guid) then marks them sent', async () => {
      const { db } = await createTestDb();
      await insertScheduled(db, {
        chatGuid: 'c1',
        text: 'fire',
        scheduledFor: 1,
        selectedMessageGuid: 'r1',
        selectedMessagePartIndex: 2,
      });
      const calls: Array<[string, string, string | undefined, number | undefined]> = [];
      const fired = await runDueScheduled(db, noHttp, 1000, async (g, t, s, _settle, p) => {
        calls.push([g, t, s, p]);
      });
      expect(fired).toBe(1);
      expect(calls).toEqual([['c1', 'fire', 'r1', 2]]);
      expect(await listAllScheduled(db)).toHaveLength(0); // now 'sent'
    });

    it('does not double-send if invoked twice concurrently (claim guards it)', async () => {
      const { db } = await createTestDb();
      await insertScheduled(db, { chatGuid: 'c1', text: 'once', scheduledFor: 1 });
      let sends = 0;
      const slowSender = async (): Promise<void> => {
        await new Promise((r) => setTimeout(r, 5));
        sends += 1;
      };
      const [a, b] = await Promise.all([
        runDueScheduled(db, noHttp, 1000, slowSender),
        runDueScheduled(db, noHttp, 1000, slowSender),
      ]);
      expect(a + b).toBe(1); // exactly one runner sent it
      expect(sends).toBe(1);
    });

    it('skips server-backed rows — the SERVER fires them, not the local worker', async () => {
      const { db } = await createTestDb();
      await insertScheduled(db, {
        chatGuid: 'c1',
        text: 'srv',
        scheduledFor: 1,
        serverId: 'srv-1',
      });
      let sends = 0;
      const fired = await runDueScheduled(db, noHttp, 1000, async () => {
        sends += 1;
      });
      expect(fired).toBe(0); // not fired locally (no double-send)
      expect(sends).toBe(0);
      expect(await listAllScheduled(db)).toHaveLength(1); // still tracked
    });

    it('applies the headless cap after excluding server-backed rows (no local starvation)', async () => {
      const { db } = await createTestDb();
      for (let i = 0; i < 3; i += 1) {
        await insertScheduled(db, {
          chatGuid: 'c1',
          text: `server-${i}`,
          scheduledFor: i + 1,
          serverId: `srv-${i}`,
        });
      }
      await insertScheduled(db, {
        chatGuid: 'c1',
        text: 'local-due',
        scheduledFor: 10,
      });
      const sent: string[] = [];

      const fired = await runDueScheduled(
        db,
        noHttp,
        1000,
        async (_guid, text) => {
          sent.push(text);
        },
        undefined,
        1,
      );

      expect(fired).toBe(1);
      expect(sent).toEqual(['local-due']);
      expect(await listAllScheduled(db)).toHaveLength(3); // the server-owned rows remain tracked
    });

    it('rejects a queued claim when its account scope is revoked', async () => {
      const { db, raw } = await createTestDb();
      const id = await insertScheduled(db, { chatGuid: 'c1', text: 'once', scheduledFor: 1 });
      let entered!: () => void;
      const neighbourEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const neighbour = withDbTransaction(db, async () => {
        entered();
        await gate;
        throw new Error('neighbour rolled back');
      }).catch((error: unknown) => error);
      await neighbourEntered;
      let sends = 0;
      let current = true;
      let scopeChecks = 0;
      const accountScope = {
        isCurrent: () => {
          scopeChecks += 1;
          return current;
        },
      };

      const run = runDueScheduled(
        db,
        noHttp,
        1000,
        async () => {
          sends += 1;
        },
        accountScope,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      const sendsWhileBlocked = sends;
      const checksBeforeRevocation = scopeChecks;
      current = false;
      release();
      expect(await neighbour).toBeInstanceOf(Error);
      await expect(run).rejects.toBeInstanceOf(DbCommitGuardRejectedError);

      expect(checksBeforeRevocation).toBeGreaterThanOrEqual(3);
      expect(sendsWhileBlocked).toBe(0);
      expect(sends).toBe(0);
      expect(raw.prepare('SELECT status FROM scheduled_messages WHERE id = ?').get(id)).toEqual(
        expect.objectContaining({ status: 'pending' }),
      );
    });

    it('serializes a pre-handover failure write behind a neighbouring rollback', async () => {
      const { db, raw } = await createTestDb();
      const id = await insertScheduled(db, { chatGuid: 'c1', text: 'retry', scheduledFor: 1 });
      let entered!: () => void;
      const neighbourEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let neighbour: Promise<unknown> | undefined;
      const run = runDueScheduled(db, noHttp, 1000, async () => {
        neighbour = withDbTransaction(db, async () => {
          entered();
          await gate;
          throw new Error('neighbour rolled back');
        }).catch((error: unknown) => error);
        await neighbourEntered;
        throw new Error('send failed before handoff');
      });
      await neighbourEntered;
      await new Promise((resolve) => setTimeout(resolve, 0));

      // The failure UPDATE is waiting for its own transaction; it did not join the doomed one.
      expect((await getScheduledById(db, id))?.status).toBe('sending');
      release();
      expect(await neighbour).toBeInstanceOf(Error);
      await expect(run).resolves.toBe(0);
      expect((await getScheduledById(db, id))?.status).toBe('pending');
      expect(
        (
          raw.prepare('SELECT attempts FROM scheduled_messages WHERE id = ?').get(id) as {
            attempts: number;
          }
        ).attempts,
      ).toBe(1);
    });

    it('a failing send bumps attempts and releases back to pending for retry', async () => {
      const { db } = await createTestDb();
      const id = await insertScheduled(db, { chatGuid: 'c1', text: 'fail', scheduledFor: 1 });
      const fired = await runDueScheduled(db, noHttp, 1000, async () => {
        throw new ApiError('no_connection', 'offline', 0);
      });
      expect(fired).toBe(0);
      const all = await listAllScheduled(db);
      expect(all).toHaveLength(1); // still pending → retried later
      expect(all[0]?.id).toBe(id);
    });

    it('retires a permanently-failing row to error after the attempt cap (no infinite retry)', async () => {
      const { db } = await createTestDb();
      await insertScheduled(db, { chatGuid: 'gone', text: 'poison', scheduledFor: 1 });
      const thrower = async (): Promise<void> => {
        throw new ApiError('no_connection', 'unknown chat', 404);
      };
      for (let i = 0; i < SCHED_MAX_ATTEMPTS; i += 1) {
        await runDueScheduled(db, noHttp, 1000, thrower);
      }
      // After the cap it is 'error' — no longer pending/due, so it stops retrying.
      expect(await listAllScheduled(db)).toHaveLength(0);
      expect(await listDueScheduled(db, 9999)).toHaveLength(0);
    });
  });

  describe('recurrence (re-arm instead of mark-sent)', () => {
    const attemptsOf = (raw: import('better-sqlite3').Database, id: number): number =>
      (
        raw.prepare('SELECT attempts FROM scheduled_messages WHERE id = ?').get(id) as {
          attempts: number;
        }
      ).attempts;

    it('round-trips the recurrence column through insert + read', async () => {
      const { db } = await createTestDb();
      const id = await insertScheduled(db, {
        chatGuid: 'c1',
        text: 'every day',
        scheduledFor: 1000,
        recurrence: 'daily',
      });
      expect((await getScheduledById(db, id))?.recurrence).toBe('daily');
      // One-shot rows stay null.
      const one = await insertScheduled(db, { chatGuid: 'c1', text: 'once', scheduledFor: 1000 });
      expect((await getScheduledById(db, one))?.recurrence).toBeNull();
    });

    it('updateScheduled sets and clears recurrence', async () => {
      const { db } = await createTestDb();
      const id = await insertScheduled(db, { chatGuid: 'c1', text: 'x', scheduledFor: 1000 });
      await updateScheduled(db, id, { recurrence: 'weekly' });
      expect((await getScheduledById(db, id))?.recurrence).toBe('weekly');
      await updateScheduled(db, id, { recurrence: null }); // back to one-shot
      expect((await getScheduledById(db, id))?.recurrence).toBeNull();
    });

    it('a recurring row that sends is RE-ARMED: pending at the next occurrence, attempts reset', async () => {
      const { db, raw } = await createTestDb();
      const now = 1_750_000_000_000;
      const at = now - 60_000;
      const id = await insertScheduled(db, {
        chatGuid: 'c1',
        text: 'daily hi',
        scheduledFor: at,
        recurrence: 'daily',
      });
      // Prior failures left attempts > 0; a successful send must clear them.
      await claimScheduled(db, id);
      await markScheduledFailed(db, id);
      await claimScheduled(db, id);
      await markScheduledFailed(db, id);
      expect(attemptsOf(raw, id)).toBe(2);

      const fired = await runDueScheduled(db, noHttp, now, async () => {});
      expect(fired).toBe(1);
      const row = await getScheduledById(db, id);
      expect(row?.status).toBe('pending'); // NOT 'sent'
      expect(row?.scheduledFor).toBe(nextOccurrence(at, 'daily', now));
      expect(row?.scheduledFor).toBeGreaterThan(now); // no immediate re-fire
      expect(row?.recurrence).toBe('daily'); // cadence survives the re-arm
      expect(attemptsOf(raw, id)).toBe(0);
      // The re-armed row is no longer due this tick.
      expect(await listDueScheduled(db, now)).toHaveLength(0);
    });

    it('a one-shot row still marks sent (unchanged path)', async () => {
      const { db } = await createTestDb();
      const id = await insertScheduled(db, { chatGuid: 'c1', text: 'once', scheduledFor: 1 });
      expect(await runDueScheduled(db, noHttp, 1000, async () => {})).toBe(1);
      expect((await getScheduledById(db, id))?.status).toBe('sent');
    });

    it('a permanently-failing RECURRING row still retires to error at the attempt cap', async () => {
      const { db } = await createTestDb();
      const id = await insertScheduled(db, {
        chatGuid: 'gone',
        text: 'poison',
        scheduledFor: 1,
        recurrence: 'weekly',
      });
      const thrower = async (): Promise<void> => {
        throw new ApiError('no_connection', 'unknown chat', 404);
      };
      for (let i = 0; i < SCHED_MAX_ATTEMPTS; i += 1) {
        await runDueScheduled(db, noHttp, 1000, thrower);
      }
      expect((await getScheduledById(db, id))?.status).toBe('error');
      expect(await listDueScheduled(db, 9_999_999)).toHaveLength(0); // stopped retrying
    });

    it('scheduleTextMessage keeps a recurring message LOCAL-ONLY (no server create)', async () => {
      const { db } = await createTestDb();
      const spy = jest
        .spyOn(scheduledApi, 'createScheduled')
        .mockResolvedValue({ id: 'srv-uuid' } as never);
      try {
        const { serverId } = await scheduleTextMessage(db, noHttp, {
          chatGuid: 'c1',
          text: 'every week',
          scheduledFor: 1000,
          recurrence: 'weekly',
        });
        expect(spy).not.toHaveBeenCalled(); // server can't repeat — local ticker owns it
        expect(serverId).toBeNull();
        const row = (await listAllScheduled(db))[0];
        expect(row?.recurrence).toBe('weekly');
        expect(row?.serverId).toBeNull();
      } finally {
        spy.mockRestore();
      }
    });

    it('rearmScheduled only re-arms a CLAIMED row (preserves the claim contract)', async () => {
      const { db } = await createTestDb();
      const id = await insertScheduled(db, { chatGuid: 'c1', text: 'x', scheduledFor: 1 });
      expect(await rearmScheduled(db, id, 5000)).toBe(false); // pending, unclaimed → no-op
      expect((await getScheduledById(db, id))?.scheduledFor).toBe(1);
      await claimScheduled(db, id); // pending → sending
      expect(await rearmScheduled(db, id, 5000)).toBe(true);
      const row = await getScheduledById(db, id);
      expect(row).toMatchObject({ status: 'pending', scheduledFor: 5000 });
    });
  });

  describe('reconcileServerScheduled', () => {
    it('upserts by serverId, prunes vanished ones, leaves local-only rows alone', async () => {
      const { db } = await createTestDb();
      await insertScheduled(db, { chatGuid: 'local', text: 'keep-local', scheduledFor: 1 });
      await reconcileServerScheduled(
        db,
        [
          { serverId: 'uuid-1', chatGuid: 'c1', text: 'a', scheduledFor: 1000, status: 'pending' },
          { serverId: 'uuid-2', chatGuid: 'c2', text: 'b', scheduledFor: 2000, status: 'pending' },
        ],
        ['uuid-1', 'uuid-2'],
      );
      expect(await listAllScheduled(db)).toHaveLength(3); // local + 2 server-backed

      // Re-sync: the server now only reports uuid-2 (uuid-1 fired/deleted), with an edited text.
      await reconcileServerScheduled(
        db,
        [{ serverId: 'uuid-2', chatGuid: 'c2', text: 'b2', scheduledFor: 5000, status: 'pending' }],
        ['uuid-2'],
      );
      const texts = (await listAllScheduled(db)).map((r) => r.text).sort();
      expect(texts).toEqual(['b2', 'keep-local']); // uuid-1 pruned, uuid-2 updated, local kept
    });

    it('keeps a malformed-but-present row (id in the raw set but dropped from items)', async () => {
      const { db } = await createTestDb();
      await reconcileServerScheduled(
        db,
        [{ serverId: 'uuid-7', chatGuid: 'c', text: 'good', scheduledFor: 1, status: 'pending' }],
        ['uuid-7'],
      );
      // Next sync: uuid-7 still reported (raw set) but unparseable so absent from items → NOT pruned.
      await reconcileServerScheduled(db, [], ['uuid-7']);
      expect(await listAllScheduled(db)).toHaveLength(1);
    });

    it('never prunes when the server view is empty (transient/failed response)', async () => {
      const { db } = await createTestDb();
      await reconcileServerScheduled(
        db,
        [{ serverId: 'uuid-9', chatGuid: 'c', text: 'x', scheduledFor: 1, status: 'pending' }],
        ['uuid-9'],
      );
      await reconcileServerScheduled(db, [], []); // empty raw set → skip prune
      expect(await listAllScheduled(db)).toHaveLength(1);
    });
  });

  describe('markScheduledFailed', () => {
    it('counts up to the cap then flips to error', async () => {
      const { db } = await createTestDb();
      const id = await insertScheduled(db, { chatGuid: 'c1', text: 'x', scheduledFor: 1 });
      const statuses: string[] = [];
      for (let i = 0; i < SCHED_MAX_ATTEMPTS; i += 1) {
        await claimScheduled(db, id);
        statuses.push(await markScheduledFailed(db, id));
      }
      expect(statuses.slice(0, -1).every((s) => s === 'pending')).toBe(true);
      expect(statuses[statuses.length - 1]).toBe('error');
    });
  });

  describe('resetStuckScheduled', () => {
    it('recovers rows interrupted mid-send (sending → pending)', async () => {
      const { db } = await createTestDb();
      const id = await insertScheduled(db, { chatGuid: 'c1', text: 'x', scheduledFor: 1 });
      await claimScheduled(db, id); // simulate interrupted send: left 'sending'
      expect(await listAllScheduled(db)).toHaveLength(0);
      expect(await resetStuckScheduled(db)).toBe(1);
      const all = await listAllScheduled(db);
      expect(all).toHaveLength(1);
      expect(all[0]?.id).toBe(id);
    });

    it('queues behind a rolling-back neighbour instead of joining it', async () => {
      const { db } = await createTestDb();
      const id = await insertScheduled(db, { chatGuid: 'c1', text: 'x', scheduledFor: 1 });
      await claimScheduled(db, id);

      let neighbourStarted!: () => void;
      let releaseNeighbour!: () => void;
      const started = new Promise<void>((resolve) => {
        neighbourStarted = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseNeighbour = resolve;
      });
      const neighbour = withDbTransaction(db, async () => {
        neighbourStarted();
        await release;
        throw new Error('neighbour rollback');
      });
      await started;

      const reset = resetStuckScheduled(db);
      await Promise.resolve();
      expect((await getScheduledById(db, id))?.status).toBe('sending');

      releaseNeighbour();
      await expect(neighbour).rejects.toThrow('neighbour rollback');
      await expect(reset).resolves.toBe(1);
      expect((await getScheduledById(db, id))?.status).toBe('pending');
    });

    it('leaves the row untouched when its account commit guard is revoked', async () => {
      const { db } = await createTestDb();
      const id = await insertScheduled(db, { chatGuid: 'c1', text: 'x', scheduledFor: 1 });
      await claimScheduled(db, id);

      await expect(resetStuckScheduled(db, undefined, () => false)).rejects.toBeInstanceOf(
        DbCommitGuardRejectedError,
      );
      expect((await getScheduledById(db, id))?.status).toBe('sending');
    });

    it('recovers only local work and never takes a server-owned row away from the server', async () => {
      const { db } = await createTestDb();
      const localId = await insertScheduled(db, {
        chatGuid: 'c1',
        text: 'local interrupted',
        scheduledFor: 1,
      });
      const serverId = await insertScheduled(db, {
        chatGuid: 'c1',
        text: 'server interrupted',
        scheduledFor: 1,
        serverId: 'srv-reset',
      });
      await claimScheduled(db, localId);
      await claimScheduled(db, serverId);

      await expect(resetStuckScheduled(db)).resolves.toBe(1);
      expect((await getScheduledById(db, localId))?.status).toBe('pending');
      expect((await getScheduledById(db, serverId))?.status).toBe('sending');
    });
  });

  describe('updateScheduled', () => {
    it('updates the text while preserving the reply target', async () => {
      const { db } = await createTestDb();
      const id = await insertScheduled(db, {
        chatGuid: 'c1',
        text: 'old',
        scheduledFor: 1000,
        selectedMessageGuid: 'orig',
        selectedMessagePartIndex: 2,
      });
      await updateScheduled(db, id, { text: 'new' });
      const row = await getScheduledById(db, id);
      expect(row?.text).toBe('new');
      expect(row?.selectedMessageGuid).toBe('orig'); // JSON merge kept the reply target
      expect(row?.selectedMessagePartIndex).toBe(2);
    });

    it('updates the fire time', async () => {
      const { db } = await createTestDb();
      const id = await insertScheduled(db, { chatGuid: 'c1', text: 'hi', scheduledFor: 1000 });
      await updateScheduled(db, id, { scheduledFor: 9999 });
      expect((await getScheduledById(db, id))?.scheduledFor).toBe(9999);
    });

    it('is a no-op once the row is no longer pending (claimed/sending)', async () => {
      const { db } = await createTestDb();
      const id = await insertScheduled(db, { chatGuid: 'c1', text: 'hi', scheduledFor: 1000 });
      await claimScheduled(db, id); // pending → sending
      await updateScheduled(db, id, { text: 'changed' });
      expect((await getScheduledById(db, id))?.text).toBe('hi'); // unchanged
    });

    it('repoints serverId (the no-PUT re-create path repoints the local row at the new uuid)', async () => {
      const { db } = await createTestDb();
      const id = await insertScheduled(db, {
        chatGuid: 'c1',
        text: 'old',
        scheduledFor: 1000,
        serverId: 'old-uuid',
      });
      await updateScheduled(db, id, { text: 'new', scheduledFor: 2000, serverId: 'new-uuid' });
      const row = await getScheduledById(db, id);
      expect(row).toMatchObject({ text: 'new', scheduledFor: 2000, serverId: 'new-uuid' });
    });
  });

  describe('Gator contract', () => {
    it('parses a flat Gator scheduled-message item via the ScheduledItem zod', () => {
      const parsed = ScheduledItem.parse({
        id: '3f2b1a90-7c4d-4e2f-9a1b-0c2d4e6f8a01',
        chatGuid: 'iMessage;-;+15551234567',
        text: 'see you at 5',
        scheduledFor: 1_750_000_000_000,
        status: 'pending',
      });
      expect(parsed.id).toBe('3f2b1a90-7c4d-4e2f-9a1b-0c2d4e6f8a01');
      expect(parsed.scheduledFor).toBe(1_750_000_000_000);
      expect(parsed.status).toBe('pending');
    });

    it('accepts an item with no status (status is nullish on the wire)', () => {
      const parsed = ScheduledItem.parse({
        id: 'uuid-x',
        chatGuid: 'c1',
        text: 'hi',
        scheduledFor: 1,
      });
      expect(parsed.status).toBeUndefined();
    });

    it('rejects a numeric id (Gator ids are uuid STRINGS, never the old integer)', () => {
      expect(() =>
        ScheduledItem.parse({ id: 42, chatGuid: 'c1', text: 'hi', scheduledFor: 1 }),
      ).toThrow();
    });
  });
});
