/**
 * Where ownership of a send changes hands, and what the clock says when it does.
 *
 *  1. SCHEDULED → OUTGOING QUEUE. The scheduled row used to stay 'sending' until the whole network
 *     round trip resolved, but the queue owns delivery from the moment its row commits — seconds
 *     earlier. Killed inside that window, the next launch found a live queue row AND a 'sending'
 *     scheduled row, and boot runs `resetStuckScheduled` (unconditional), then the queue drain,
 *     then the ticker: two copies of a birthday text, three if the first POST had also landed.
 *  2. THE RETRY LADDER'S CLOCK. The drain used to bind `now` once and reuse it for every claim and
 *     every backoff. An attachment upload has no timeout, so by the time a failure came back that
 *     value was minutes stale: the next attempt was scheduled in the PAST and the row went straight
 *     back into the very next 20 s tick with no backoff at all.
 *
 * Node-only (no RN imports): the DB is better-sqlite3 and every network leaf is a fake.
 */
import type Database from 'better-sqlite3';
import { ApiError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';
import { Chat } from '@core/models';
import {
  getChatIdByGuid,
  getScheduledById,
  insertOutgoingText,
  insertScheduled,
  outgoingBackoffMs,
  upsertChats,
  upsertHandles,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { runDueScheduled } from '@/services/send/scheduleService';
import { runOutgoingQueue, type OutgoingQueueIO } from '@/services/send/outgoingQueueService';
import { createTestDb } from '../support/testDb';

const noHttp = {} as unknown as HttpClient;

const noAttachmentIo: OutgoingQueueIO = {
  upload: async () => {
    throw new Error('unexpected attachment upload');
  },
  fileExists: async () => true,
};

async function seedChat(db: AppDatabase, guid: string): Promise<void> {
  const handles = await upsertHandles(db, [{ address: 'a@b.com' }]);
  await upsertChats(db, [Chat.parse({ guid, participants: [{ address: 'a@b.com' }] })], handles);
}

describe('runDueScheduled — handover to the outgoing queue', () => {
  it('marks the row SENT at the handover, before the send resolves', async () => {
    const { db } = await createTestDb();
    const id = await insertScheduled(db, { chatGuid: 'c1', text: 'birthday', scheduledFor: 1 });

    let statusAtHandover: string | undefined;
    let statusBeforeResolve: string | undefined;
    const fired = await runDueScheduled(db, noHttp, 1000, async (_g, _t, _s, onQueued) => {
      await onQueued(); // the optimistic message + queue row have committed
      statusAtHandover = (await getScheduledById(db, id))?.status;
      // ...the POST is still in flight here; an app kill NOW must not re-fire this row.
      statusBeforeResolve = (await getScheduledById(db, id))?.status;
    });

    expect(fired).toBe(1);
    expect(statusAtHandover).toBe('sent');
    expect(statusBeforeResolve).toBe('sent');
  });

  it('re-arms a RECURRING row at the handover too (never twice)', async () => {
    const { db } = await createTestDb();
    const id = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'daily',
      scheduledFor: 1000,
      recurrence: 'daily',
    });

    let atHandover: { status: string; scheduledFor: number } | undefined;
    await runDueScheduled(db, noHttp, 2000, async (_g, _t, _s, onQueued) => {
      await onQueued();
      const row = await getScheduledById(db, id);
      atHandover = row ? { status: row.status, scheduledFor: row.scheduledFor } : undefined;
    });

    expect(atHandover?.status).toBe('pending'); // armed for the next occurrence
    expect(atHandover?.scheduledFor).toBeGreaterThan(2000);
    // Resolving the sender must NOT settle it a second time (which would re-arm past tomorrow).
    const after = await getScheduledById(db, id);
    expect(after?.scheduledFor).toBe(atHandover?.scheduledFor);
  });

  it('a throw AFTER the handover leaves the row terminal — the queue owns delivery now', async () => {
    const { db } = await createTestDb();
    const id = await insertScheduled(db, { chatGuid: 'c1', text: 'oops', scheduledFor: 1 });

    const fired = await runDueScheduled(db, noHttp, 1000, async (_g, _t, _s, onQueued) => {
      await onQueued();
      throw new Error('POST blew up after the row was queued');
    });

    expect(fired).toBe(1);
    // Re-arming here would send the message a second time once the queue's own retry succeeds.
    expect((await getScheduledById(db, id))?.status).toBe('sent');
  });

  it('a throw BEFORE the handover still counts as a failure (attempt bumped, row released)', async () => {
    const { db } = await createTestDb();
    const id = await insertScheduled(db, { chatGuid: 'c1', text: 'nope', scheduledFor: 1 });

    const fired = await runDueScheduled(db, noHttp, 1000, async () => {
      throw new Error('unknown chat');
    });

    expect(fired).toBe(0);
    expect((await getScheduledById(db, id))?.status).toBe('pending');
  });

  /**
   * The handover's own failure path. `settled` means "the queue owns delivery" and is set BEFORE
   * the terminal write, which is right — but if that write then fails, the row is left at
   * 'sending'. The next launch's `resetStuckScheduled` re-arms every 'sending' row to 'pending'
   * unconditionally, the ticker fires it again, and the queue row this run already committed
   * delivers the first copy: the exact double-send the early handover exists to prevent, reached
   * through its own error path. So the write is re-attempted rather than skipped.
   */
  it('re-attempts a terminal write that threw, instead of leaving the row on sending', async () => {
    const { db } = await createTestDb();
    const id = await insertScheduled(db, { chatGuid: 'c1', text: 'once', scheduledFor: 1 });

    // A db whose NEXT `update` fails once, armed the instant the send hands over.
    let armed = false;
    let failures = 0;
    const flaky: AppDatabase = Object.create(db);
    flaky.update = ((...args: Parameters<AppDatabase['update']>) => {
      if (armed) {
        armed = false;
        failures += 1;
        throw new Error('transient db failure');
      }
      return db.update(...args);
    }) as AppDatabase['update'];

    const fired = await runDueScheduled(flaky, noHttp, 1000, async (_g, _t, _s, onQueued) => {
      armed = true;
      await onQueued(); // the terminal write inside this throws
    });

    expect(failures).toBe(1);
    expect(fired).toBe(1); // it WAS handed over — the queue is delivering it
    // 'sending' here is what boot re-fires. It must be terminal instead.
    expect((await getScheduledById(db, id))?.status).toBe('sent');
  });

  /**
   * The half the old `if (!terminalWritten)` guard structurally could not see, and the reason the
   * write is now RE-APPLIED rather than trusted.
   *
   * `markScheduledSent` is a bare autocommit on the single shared connection, so it JOINS whatever
   * transaction a neighbouring writer happens to have open (a live-message sink, a sync slice, a
   * queue claim — all realistic at boot, which is exactly when the ticker runs). If that neighbour
   * rolls back, the stamp is erased — and nothing throws, so `terminalWritten` stayed true and the
   * recovery never fired. The row is then left at 'sending', the next launch's unconditional
   * `resetStuckScheduled` re-arms it to 'pending', and the ticker sends a SECOND copy alongside the
   * queue row this run already committed.
   *
   * Simulated by reverting the row behind the handover's back, which is exactly what the rollback
   * does to it.
   */
  it('repairs a terminal write that RESOLVED and was then erased (no throw anywhere)', async () => {
    const { db, raw } = await createTestDb();
    const id = await insertScheduled(db, { chatGuid: 'c1', text: 'birthday', scheduledFor: 1 });

    let statusAfterErase: string | undefined;
    const fired = await runDueScheduled(db, noHttp, 1000, async (_g, _t, _s, onQueued) => {
      await onQueued(); // stamps the row 'sent' — and resolves without error
      // ...a bystander transaction rolls back and takes the stamp with it.
      raw.prepare("UPDATE scheduled_messages SET status = 'sending' WHERE id = ?").run(id);
      statusAfterErase = (await getScheduledById(db, id))?.status;
    });

    expect(fired).toBe(1);
    expect(statusAfterErase).toBe('sending'); // the erase really happened
    // 'sending' at the end is what boot re-fires. The re-apply must have landed instead.
    expect((await getScheduledById(db, id))?.status).toBe('sent');
  });

  it('a sender that never signals (the dev fixtures) settles on resolve, exactly as before', async () => {
    const { db } = await createTestDb();
    const id = await insertScheduled(db, { chatGuid: 'c1', text: 'dev', scheduledFor: 1 });

    const fired = await runDueScheduled(db, noHttp, 1000, async () => {});

    expect(fired).toBe(1);
    expect((await getScheduledById(db, id))?.status).toBe('sent');
  });
});

describe('runOutgoingQueue — the backoff is stamped at the OUTCOME', () => {
  /** A failing send that burns wall-clock time, like a large upload that eventually 502s. */
  function slowFailHttp(ms: number): HttpClient {
    return {
      post: async () => {
        await new Promise((r) => setTimeout(r, ms));
        throw new ApiError('server_error', 'bridge down', 502);
      },
    } as unknown as HttpClient;
  }

  const nextRetryAt = (raw: Database.Database, tempGuid: string): number =>
    (
      raw
        .prepare('SELECT next_retry_at n FROM outgoing_queue WHERE temp_guid = ?')
        .get(tempGuid) as {
        n: number;
      }
    ).n;

  it('schedules the next attempt from when the attempt FAILED, not from when the drain started', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const chatId = await getChatIdByGuid(db, 'c1');
    const start = 10_000_000;
    await insertOutgoingText(db, {
      tempGuid: 'temp-slow',
      chatId: chatId!,
      chatGuid: 'c1',
      text: 'hi',
      now: start - 200_000,
    });
    raw
      .prepare('UPDATE outgoing_queue SET created_at = ? WHERE temp_guid = ?')
      .run(start - 200_000, 'temp-slow');

    const res = await runOutgoingQueue(db, slowFailHttp(60), noAttachmentIo, start);
    expect(res).toEqual({ eligible: 1, sent: 0 });

    // The whole point: the ladder must land in the FUTURE relative to the moment the attempt
    // ended, so the row is not instantly re-eligible on the next tick.
    const scheduled = nextRetryAt(raw, 'temp-slow');
    expect(scheduled).toBeGreaterThan(start + outgoingBackoffMs(1));
  });

  it('leases each row from its own claim time (the lease is not shared across the batch)', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const chatId = await getChatIdByGuid(db, 'c1');
    const start = 10_000_000;
    for (const g of ['temp-1', 'temp-2']) {
      await insertOutgoingText(db, {
        tempGuid: g,
        chatId: chatId!,
        chatGuid: 'c1',
        text: 'hi',
        now: start - 200_000,
      });
      raw
        .prepare('UPDATE outgoing_queue SET created_at = ? WHERE temp_guid = ?')
        .run(start - 200_000, g);
    }

    await runOutgoingQueue(db, slowFailHttp(40), noAttachmentIo, start);

    // The second row was claimed after the first attempt had already burned time, so its ladder
    // must be strictly later — with one shared timestamp the two were identical.
    expect(nextRetryAt(raw, 'temp-2')).toBeGreaterThan(nextRetryAt(raw, 'temp-1'));
  });
});
