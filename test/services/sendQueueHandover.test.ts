/**
 * Where ownership of a send changes hands, and what the clock says when it does.
 *
 *  1. SCHEDULED → OUTGOING QUEUE. The scheduled row used to stay 'sending' until the whole network
 *     round trip resolved, but the queue owns delivery from the moment its row commits — seconds
 *     earlier. Killed inside that window, the next launch found a live queue row AND a 'sending'
 *     scheduled row. Boot used to reset every `sending` row independently before the queue drain
 *     and ticker: two copies of a birthday text, three if the first POST had also landed.
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
import { logger } from '@core/secure';
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

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeHttp(impl: (json: unknown) => Promise<unknown>): HttpClient {
  return {
    post: (_path: string, _schema: unknown, options: { json?: unknown }) => impl(options.json),
  } as unknown as HttpClient;
}

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

/** Run one synchronous edit after the due SELECT returns but before runDueScheduled can claim it. */
function raceAfterDueSnapshot(db: AppDatabase, edit: () => void): AppDatabase {
  const raced = Object.create(db) as AppDatabase;
  let edited = false;
  raced.all = (async (...args: Parameters<AppDatabase['all']>) => {
    const rows = await db.all(...args);
    const isScheduledSnapshot =
      Array.isArray(rows) &&
      rows.some(
        (row: unknown) =>
          typeof row === 'object' &&
          row !== null &&
          'payload' in row &&
          'scheduledFor' in row &&
          'status' in row,
      );
    if (!edited && isScheduledSnapshot) {
      edited = true;
      edit();
    }
    return rows;
  }) as AppDatabase['all'];
  return raced;
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
   * 'sending'. Under the old independent-reset path, the next launch re-armed that row, the ticker
   * fired it again, and the queue row this run already committed delivered the first copy: the
   * exact double-send the early handover exists to prevent, reached through its own error path. So
   * the write is re-attempted rather than skipped.
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

  it('a sender that never signals (the dev fixtures) settles on resolve, exactly as before', async () => {
    const { db } = await createTestDb();
    const id = await insertScheduled(db, { chatGuid: 'c1', text: 'dev', scheduledFor: 1 });

    const fired = await runDueScheduled(db, noHttp, 1000, async () => {});

    expect(fired).toBe(1);
    expect((await getScheduledById(db, id))?.status).toBe('sent');
  });
});

describe('runDueScheduled — production atomic handover', () => {
  it('uses text edited after the due-list snapshot instead of sending the stale payload', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const id = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'stale text',
      scheduledFor: 1,
      selectedMessageGuid: 'reply-guid',
    });
    const edit = jest.fn(() => {
      raw
        .prepare('UPDATE scheduled_messages SET payload = ? WHERE id = ?')
        .run(JSON.stringify({ text: 'edited text', selectedMessageGuid: 'reply-guid' }), id);
    });
    const raced = raceAfterDueSnapshot(db, edit);
    const response = deferred<unknown>();
    const postStarted = deferred<void>();
    let postedBody: unknown;
    const http = fakeHttp(async (json) => {
      postedBody = json;
      postStarted.resolve(undefined);
      return response.promise;
    });

    const run = runDueScheduled(raced, http, 1_000);
    await postStarted.promise;
    try {
      expect(edit).toHaveBeenCalledTimes(1);
      expect(postedBody).toMatchObject({
        text: 'edited text',
        selectedMessageGuid: 'reply-guid',
      });
      expect(raw.prepare('SELECT payload FROM outgoing_queue').get()).toEqual({
        payload: JSON.stringify({ message: 'edited text', selectedMessageGuid: 'reply-guid' }),
      });
      expect(raw.prepare('SELECT text FROM messages').get()).toEqual({ text: 'edited text' });
      expect(await getScheduledById(db, id)).toMatchObject({ status: 'sent', text: 'edited text' });
    } finally {
      response.resolve({ guid: 'real-edited', dateCreated: 2_000, dateDelivered: null });
    }
    await expect(run).resolves.toBe(1);
  });

  it('uses the edited recurrence and fire time when calculating the next occurrence', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const id = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'changed cadence',
      scheduledFor: 1,
      recurrence: 'daily',
    });
    const edit = jest.fn(() => {
      raw
        .prepare('UPDATE scheduled_messages SET scheduled_for = ?, recurrence = ? WHERE id = ?')
        .run(500, 'weekly', id);
    });
    const raced = raceAfterDueSnapshot(db, edit);

    await expect(
      runDueScheduled(
        raced,
        fakeHttp(async () => ({ guid: 'real-weekly', dateCreated: 2_000, dateDelivered: null })),
        1_000,
      ),
    ).resolves.toBe(1);

    expect(edit).toHaveBeenCalledTimes(1);
    expect(await getScheduledById(db, id)).toMatchObject({
      status: 'pending',
      recurrence: 'weekly',
      // One week after the authoritative edited slot (500), not one day after stale slot 1.
      scheduledFor: 500 + 7 * 24 * 60 * 60 * 1_000,
    });
  });

  it('does not send a row edited into the future after the due-list snapshot', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const id = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'not yet',
      scheduledFor: 1,
    });
    const edit = jest.fn(() => {
      raw.prepare('UPDATE scheduled_messages SET scheduled_for = ? WHERE id = ?').run(5_000, id);
    });
    const raced = raceAfterDueSnapshot(db, edit);
    let posts = 0;
    const http = fakeHttp(async () => {
      posts += 1;
      return { guid: 'must-not-send', dateCreated: 2_000, dateDelivered: null };
    });

    await expect(runDueScheduled(raced, http, 1_000)).resolves.toBe(0);

    expect(edit).toHaveBeenCalledTimes(1);
    expect(posts).toBe(0);
    expect(raw.prepare('SELECT COUNT(*) AS count FROM outgoing_queue').get()).toEqual({ count: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 });
    expect(await getScheduledById(db, id)).toMatchObject({
      status: 'pending',
      scheduledFor: 5_000,
    });
  });

  it('does not send a row assigned to the server after the due-list snapshot', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const id = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'server takes over',
      scheduledFor: 1,
    });
    const edit = jest.fn(() => {
      raw.prepare('UPDATE scheduled_messages SET server_id = ? WHERE id = ?').run('srv-race', id);
    });
    const raced = raceAfterDueSnapshot(db, edit);
    let posts = 0;
    const http = fakeHttp(async () => {
      posts += 1;
      return { guid: 'must-not-send', dateCreated: 2_000, dateDelivered: null };
    });

    await expect(runDueScheduled(raced, http, 1_000)).resolves.toBe(0);

    expect(edit).toHaveBeenCalledTimes(1);
    expect(posts).toBe(0);
    expect(raw.prepare('SELECT COUNT(*) AS count FROM outgoing_queue').get()).toEqual({ count: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 });
    expect(await getScheduledById(db, id)).toMatchObject({
      status: 'pending',
      serverId: 'srv-race',
    });
  });

  it('commits a one-shot schedule, queue row, optimistic reply, and reply metadata before HTTP resolves', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const id = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'reply later',
      scheduledFor: 1,
      selectedMessageGuid: 'original-guid',
    });
    const response = deferred<unknown>();
    const postStarted = deferred<void>();
    let postedBody: unknown;
    const http = fakeHttp(async (json) => {
      postedBody = json;
      postStarted.resolve(undefined);
      return response.promise;
    });

    const run = runDueScheduled(db, http, 1_000);
    await postStarted.promise;
    try {
      expect(await getScheduledById(db, id)).toMatchObject({ status: 'sent' });
      expect(
        raw
          .prepare(
            `SELECT temp_guid AS tempGuid, chat_guid AS chatGuid, kind, payload
               FROM outgoing_queue`,
          )
          .get(),
      ).toMatchObject({
        tempGuid: expect.stringMatching(/^temp-/),
        chatGuid: 'c1',
        kind: 'text',
        payload: JSON.stringify({
          message: 'reply later',
          selectedMessageGuid: 'original-guid',
        }),
      });
      expect(
        raw
          .prepare(
            `SELECT guid, text, send_state AS sendState,
                    thread_originator_guid AS threadOriginatorGuid
               FROM messages`,
          )
          .get(),
      ).toMatchObject({
        guid: expect.stringMatching(/^temp-/),
        text: 'reply later',
        sendState: 'sending',
        threadOriginatorGuid: 'original-guid',
      });
      expect(postedBody).toMatchObject({
        text: 'reply later',
        selectedMessageGuid: 'original-guid',
      });
    } finally {
      response.resolve({ guid: 'real-reply', dateCreated: 2_000, dateDelivered: null });
    }

    await expect(run).resolves.toBe(1);
  });

  it('re-arms a recurring occurrence exactly once before HTTP resolves', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const id = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'every day',
      scheduledFor: 1_000,
      recurrence: 'daily',
    });
    const response = deferred<unknown>();
    const postStarted = deferred<void>();
    let posts = 0;
    const http = fakeHttp(async () => {
      posts += 1;
      postStarted.resolve(undefined);
      return response.promise;
    });

    const firstRun = runDueScheduled(db, http, 2_000);
    await postStarted.promise;
    const atHandover = await getScheduledById(db, id);
    if (!atHandover) throw new Error('recurring schedule disappeared during its handoff');
    expect(atHandover.status).toBe('pending');
    expect(atHandover.scheduledFor).toBeGreaterThan(2_000);
    expect(raw.prepare('SELECT COUNT(*) AS count FROM outgoing_queue').get()).toEqual({ count: 1 });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 1 });

    // The next occurrence is in the future. An overlapping production ticker must neither POST
    // nor apply the recurrence calculation a second time while the first POST is still pending.
    await expect(runDueScheduled(db, http, 2_000)).resolves.toBe(0);
    expect(posts).toBe(1);
    expect((await getScheduledById(db, id))?.scheduledFor).toBe(atHandover.scheduledFor);

    response.resolve({ guid: 'real-recurring', dateCreated: 2_000, dateDelivered: null });
    await expect(firstRun).resolves.toBe(1);
    expect((await getScheduledById(db, id))?.scheduledFor).toBe(atHandover.scheduledFor);
  });

  it('rolls back partial outgoing work and safely records a failed occurrence without POSTing', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const id = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'fail atomically',
      scheduledFor: 1,
    });
    const chatBefore = raw
      .prepare('SELECT latest_message_date AS latest FROM chats WHERE guid = ?')
      .get('c1');
    raw.exec(`
      CREATE TRIGGER fail_scheduled_message_insert
      BEFORE INSERT ON messages
      BEGIN
        SELECT RAISE(ABORT, 'forced outgoing insert failure');
      END
    `);
    let posts = 0;
    const http = fakeHttp(async () => {
      posts += 1;
      return { guid: 'must-not-send', dateCreated: 2_000, dateDelivered: null };
    });

    await expect(runDueScheduled(db, http, 1_000)).resolves.toBe(0);

    expect(posts).toBe(0);
    expect(raw.prepare('SELECT COUNT(*) AS count FROM outgoing_queue').get()).toEqual({ count: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 });
    expect(
      raw.prepare('SELECT status, attempts FROM scheduled_messages WHERE id = ?').get(id),
    ).toEqual({ status: 'pending', attempts: 1 });
    expect(
      raw.prepare('SELECT latest_message_date AS latest FROM chats WHERE guid = ?').get('c1'),
    ).toEqual(chatBefore);
  });

  it('does not POST or create outgoing work after the scheduled claim is lost', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const id = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'lost race',
      scheduledFor: 1,
    });
    let claimWasMoved = false;
    const raced: AppDatabase = Object.create(db) as AppDatabase;
    raced.all = (async (...args: Parameters<AppDatabase['all']>) => {
      const rows = await db.all(...args);
      const row = raw.prepare('SELECT status FROM scheduled_messages WHERE id = ?').get(id) as {
        status: string;
      };
      // `getChatIdByGuid` is the first read after the claim commits. Finish the row as if another
      // owner won before the handoff transaction; its status CAS must then fail closed.
      if (!claimWasMoved && row.status === 'sending') {
        raw.prepare("UPDATE scheduled_messages SET status = 'sent' WHERE id = ?").run(id);
        claimWasMoved = true;
      }
      return rows;
    }) as AppDatabase['all'];
    let posts = 0;
    const http = fakeHttp(async () => {
      posts += 1;
      return { guid: 'must-not-send', dateCreated: 2_000, dateDelivered: null };
    });

    await expect(runDueScheduled(raced, http, 1_000)).resolves.toBe(0);

    expect(claimWasMoved).toBe(true);
    expect(posts).toBe(0);
    expect(raw.prepare('SELECT COUNT(*) AS count FROM outgoing_queue').get()).toEqual({ count: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 });
    expect(
      raw.prepare('SELECT status, attempts FROM scheduled_messages WHERE id = ?').get(id),
    ).toEqual({ status: 'sent', attempts: 0 });
  });

  it('rolls back the atomic handoff when the account is revoked after claim', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const id = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'belongs to account A',
      scheduledFor: 1,
    });
    let current = true;
    let revokedAfterClaim = false;
    const raced: AppDatabase = Object.create(db) as AppDatabase;
    raced.all = (async (...args: Parameters<AppDatabase['all']>) => {
      const shape = JSON.stringify(args[0]).replace(/\s+/g, ' ').toLowerCase();
      const rows = await db.all(...args);
      if (
        !revokedAfterClaim &&
        shape.includes('select id from chats') &&
        shape.includes('where guid')
      ) {
        // The chat lookup now belongs INSIDE the atomic scheduled→outgoing handoff, after its
        // provisional status transition. Revoke here so the handoff's final commit guard must
        // roll that transition and every outgoing row back together.
        revokedAfterClaim = true;
        current = false;
      }
      return rows;
    }) as AppDatabase['all'];
    const scope = { generation: 40, isCurrent: () => current };
    let posts = 0;
    const http = fakeHttp(async () => {
      posts += 1;
      return { guid: 'must-not-send', dateCreated: 2_000, dateDelivered: null };
    });

    await expect(runDueScheduled(raced, http, 1_000, undefined, scope)).rejects.toThrow(
      'account session changed',
    );

    expect(revokedAfterClaim).toBe(true);
    expect(posts).toBe(0);
    expect(raw.prepare('SELECT COUNT(*) AS count FROM outgoing_queue').get()).toEqual({ count: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 });
    expect(
      raw.prepare('SELECT status, attempts FROM scheduled_messages WHERE id = ?').get(id),
    ).toEqual({ status: 'sending', attempts: 0 });
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
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
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
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[queue] failed for chat c1 (code 10002, HTTP 502): bridge down',
    );
    warn.mockRestore();
  });

  it('leases each row from its own claim time (the lease is not shared across the batch)', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
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
    expect(warn.mock.calls).toEqual([
      ['[queue] failed for chat c1 (code 10002, HTTP 502): bridge down'],
      ['[queue] failed for chat c1 (code 10002, HTTP 502): bridge down'],
    ]);
    warn.mockRestore();
  });
});
