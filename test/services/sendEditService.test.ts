import type Database from 'better-sqlite3';
import { ApiError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';
import { Chat, Message } from '@core/models';
import {
  revertLocalEdit,
  revertLocalUnsend,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import { DbCommitGuardRejectedError, withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
  runTrackedRealtimeWork,
} from '@/services/realtime/deliveryCoordinator';
import { sendEdit, sendUnsend } from '@/services/send/sendEditService';
import { createTestDb } from '../support/testDb';

const okHttp = { post: async () => ({ guid: 'm1' }) } as unknown as HttpClient;
const unsendOkHttp = { post: async () => ({ unsent: true }) } as unknown as HttpClient;
const failHttp = {
  post: async () => {
    throw new ApiError('no_connection', 'offline', 0);
  },
} as unknown as HttpClient;

/** Capture the JSON body so we can assert the server-required wire shape (F-4/F-5). */
function capturingHttp(impl: () => Promise<unknown>): { http: HttpClient; body(): unknown } {
  let captured: unknown;
  const http = {
    post: (_p: string, _s: unknown, opts?: { json?: unknown }) => {
      captured = opts?.json;
      return impl();
    },
  } as unknown as HttpClient;
  return { http, body: () => captured };
}

const one = (raw: Database.Database, sql: string) =>
  raw.prepare(sql).get() as Record<string, unknown>;

function attributedBody(text: string): string {
  return JSON.stringify([{ string: text, runs: [] }]);
}

function ftsHits(raw: Database.Database, query: string): number {
  const row = raw
    .prepare('SELECT COUNT(*) AS count FROM messages_fts WHERE messages_fts MATCH ?')
    .get(query) as { count: number };
  return row.count;
}

type Outcome<T> = { kind: 'fulfilled'; value: T } | { kind: 'rejected'; error: unknown };

function observe<T>(promise: Promise<T>): { outcome: Promise<Outcome<T>>; settled: () => boolean } {
  let didSettle = false;
  const outcome = promise.then<Outcome<T>, Outcome<T>>(
    (value) => ({ kind: 'fulfilled', value }),
    (error: unknown) => ({ kind: 'rejected', error }),
  );
  void outcome.then(() => {
    didSettle = true;
  });
  return { outcome, settled: () => didSettle };
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${description}`);
}

function errorMessages(error: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const record = current as { message?: unknown; cause?: unknown };
    if (typeof record.message === 'string') messages.push(record.message);
    current = record.cause;
  }
  return messages;
}

async function seed(db: AppDatabase): Promise<{
  chatId: number;
  handleMap: Map<string, number>;
}> {
  const hm = await upsertHandles(db, [{ address: 'a@x.com' }]);
  const map = await upsertChats(
    db,
    [Chat.parse({ guid: 'c1', participants: [{ address: 'a@x.com' }] })],
    hm,
  );
  await upsertMessages(
    db,
    [Message.parse({ guid: 'm1', text: 'original', isFromMe: true, dateCreated: 100 })],
    () => map.get('c1')!,
    hm,
  );
  return { chatId: map.get('c1')!, handleMap: hm };
}

describe('sendEdit / sendUnsend', () => {
  it('edit: applies the new text on success', async () => {
    const { db, raw } = await createTestDb();
    await seed(db);
    const r = await sendEdit(db, okHttp, { messageGuid: 'm1', newText: 'edited!' }, 5000);
    expect(r.ok).toBe(true);
    const row = one(raw, "SELECT text, date_edited e FROM messages WHERE guid='m1'");
    expect(row.text).toBe('edited!');
    expect(row.e).toBe(5000);

    let missingPostCalls = 0;
    const missing = await sendEdit(
      db,
      {
        post: async () => {
          missingPostCalls += 1;
          return { guid: 'missing' };
        },
      } as unknown as HttpClient,
      { chatGuid: 'c1', messageGuid: 'missing', newText: 'must not post' },
      5001,
    );
    expect(missing).toEqual({ ok: false });
    expect(missingPostCalls).toBe(0);
    expect(one(raw, "SELECT COUNT(*) AS count FROM messages WHERE guid='missing'").count).toBe(0);
  });

  it('edit: posts the server-required body {chatGuid, editedText, backwardsCompatText} (F-4)', async () => {
    const { db } = await createTestDb();
    await seed(db); // m1 lives in chat c1
    const cap = capturingHttp(async () => ({ guid: 'm1' }));
    await sendEdit(db, cap.http, { messageGuid: 'm1', newText: 'edited!', partIndex: 2 }, 5000);
    expect(cap.body()).toMatchObject({
      chatGuid: 'c1', // resolved from the message's DB row
      editedText: 'edited!',
      partIndex: 2,
    });
    expect((cap.body() as Record<string, unknown>).backwardsCompatText).toContain('edited!');
  });

  it('edit: rolls back a retired optimistic apply before HTTP and lets a fresh lease revert', async () => {
    const { db, raw } = await createTestDb();
    await seed(db);
    const originalBody = attributedBody('birthday decoded body');
    raw
      .prepare(
        "UPDATE messages SET text = 'birthday original', attributed_body = ?, date_edited = 4321 WHERE guid = 'm1'",
      )
      .run(originalBody);
    let drain: Promise<void> | undefined;
    let triggerRan = false;
    raw.function('pause_edit_during_apply', () => {
      triggerRan = true;
      drain = pauseRealtimeDeliveries();
      return 0;
    });
    raw.exec(`CREATE TRIGGER pause_edit_during_apply
      AFTER UPDATE OF text, attributed_body, date_edited ON messages
      WHEN NEW.date_edited = 5000
      BEGIN SELECT pause_edit_during_apply(); END`);

    let posts = 0;
    const oldLease = captureRealtimeDeliveryLease();
    try {
      const oldEdit = runTrackedRealtimeWork(oldLease, (lease) =>
        sendEdit(
          db,
          {
            post: async () => {
              posts += 1;
              return { guid: 'must-not-edit' };
            },
          } as unknown as HttpClient,
          { messageGuid: 'm1', newText: 'optimistic retired' },
          5_000,
          () => lease.isCurrent(),
        ),
      );

      await expect(oldEdit).rejects.toBeInstanceOf(DbCommitGuardRejectedError);
      if (!drain) throw new Error('edit apply did not retire the account lease');
      await drain;

      expect(triggerRan).toBe(true);
      expect(posts).toBe(0);
      expect(raw.inTransaction).toBe(false);
      expect(
        one(
          raw,
          "SELECT text, attributed_body AS body, date_edited AS edited FROM messages WHERE guid='m1'",
        ),
      ).toEqual({ text: 'birthday original', body: originalBody, edited: 4_321 });
      expect(ftsHits(raw, 'birthday')).toBe(1);
      expect(ftsHits(raw, 'optimistic')).toBe(0);

      raw.exec('DROP TRIGGER pause_edit_during_apply');
      resumeRealtimeDeliveries();
      raw
        .prepare("UPDATE messages SET text = '', attributed_body = ? WHERE guid = 'm1'")
        .run(originalBody);
      const freshLease = captureRealtimeDeliveryLease();
      let freshResult: { ok: boolean } | undefined;
      let postRanInsideTransaction = true;
      let optimisticRow: Record<string, unknown> | undefined;
      await expect(
        runTrackedRealtimeWork(freshLease, async (lease) => {
          freshResult = await sendEdit(
            db,
            {
              post: async () => {
                posts += 1;
                postRanInsideTransaction = raw.inTransaction;
                optimisticRow = one(
                  raw,
                  "SELECT text, attributed_body AS body, date_edited AS edited FROM messages WHERE guid='m1'",
                );
                return {};
              },
            } as unknown as HttpClient,
            { messageGuid: 'm1', newText: 'optimistic searchable' },
            6_000,
            () => lease.isCurrent(),
          );
        }),
      ).resolves.toBe('delivered');

      expect(freshResult).toEqual({ ok: false });
      expect(posts).toBe(1);
      expect(postRanInsideTransaction).toBe(false);
      expect(optimisticRow).toEqual({
        text: 'optimistic searchable',
        body: null,
        edited: 6_000,
      });
      expect(raw.inTransaction).toBe(false);
      expect(
        one(
          raw,
          "SELECT text, attributed_body AS body, date_edited AS edited FROM messages WHERE guid='m1'",
        ),
      ).toEqual({ text: 'birthday decoded body', body: originalBody, edited: 4_321 });
      expect(ftsHits(raw, 'birthday')).toBe(1);
      expect(ftsHits(raw, 'optimistic')).toBe(0);
    } finally {
      raw.exec('DROP TRIGGER IF EXISTS pause_edit_during_apply');
      if (drain) await drain;
      resumeRealtimeDeliveries();
      raw.close();
    }
  });

  it('edit: attempts a failed local revert once and permits an exact public retry', async () => {
    const { db, raw } = await createTestDb();
    await seed(db);
    const previousBody = attributedBody('birthday previous body');
    raw
      .prepare(
        "UPDATE messages SET text = '', attributed_body = ?, date_edited = 4321 WHERE guid = 'm1'",
      )
      .run(previousBody);
    let revertAttempts = 0;
    raw.function('record_edit_revert', () => {
      revertAttempts += 1;
      return 0;
    });
    raw.exec(`CREATE TRIGGER fail_edit_revert
      BEFORE UPDATE OF text, attributed_body, date_edited ON messages
      WHEN OLD.date_edited = 5000
        AND OLD.text = 'optimistic searchable'
        AND OLD.attributed_body IS NULL
      BEGIN
        SELECT record_edit_revert();
        SELECT RAISE(ABORT, 'EDIT_REVERT_CANARY');
      END`);

    let posts = 0;
    try {
      const attempt = await observe(
        sendEdit(
          db,
          {
            post: async () => {
              posts += 1;
              return {};
            },
          } as unknown as HttpClient,
          { messageGuid: 'm1', newText: 'optimistic searchable' },
          5_000,
        ),
      ).outcome;

      expect({
        outcome: attempt.kind,
        posts,
        revertAttempts,
        inTransaction: raw.inTransaction,
        row: one(
          raw,
          "SELECT text, attributed_body AS body, date_edited AS edited FROM messages WHERE guid='m1'",
        ),
      }).toEqual({
        outcome: 'rejected',
        posts: 1,
        revertAttempts: 1,
        inTransaction: false,
        row: { text: 'optimistic searchable', body: null, edited: 5_000 },
      });
      if (attempt.kind === 'rejected') {
        expect(errorMessages(attempt.error)).toContain('EDIT_REVERT_CANARY');
      }
      expect(ftsHits(raw, 'optimistic')).toBe(1);
      expect(ftsHits(raw, 'birthday')).toBe(0);

      raw.exec('DROP TRIGGER fail_edit_revert');
      await expect(
        revertLocalEdit(
          db,
          'm1',
          'birthday previous body',
          4_321,
          5_000,
          previousBody,
          'optimistic searchable',
        ),
      ).resolves.toBe(true);
      expect(
        one(
          raw,
          "SELECT text, attributed_body AS body, date_edited AS edited FROM messages WHERE guid='m1'",
        ),
      ).toEqual({ text: 'birthday previous body', body: previousBody, edited: 4_321 });
      expect(ftsHits(raw, 'birthday')).toBe(1);
      expect(ftsHits(raw, 'optimistic')).toBe(0);
    } finally {
      raw.exec('DROP TRIGGER IF EXISTS fail_edit_revert');
      raw.close();
    }
  });

  it('unsend: posts the server-required body {chatGuid} (F-5)', async () => {
    const { db } = await createTestDb();
    await seed(db);
    const cap = capturingHttp(async () => ({ unsent: true }));
    await sendUnsend(db, cap.http, { messageGuid: 'm1', partIndex: 3 }, 7000);
    expect(cap.body()).toMatchObject({ chatGuid: 'c1', partIndex: 3 });
  });

  it('unsend: resolves committed row identity inside its owner and never posts a missing row', async () => {
    const { db, raw } = await createTestDb();
    const { handleMap } = await seed(db);
    raw.prepare("UPDATE messages SET date_retracted = 4321 WHERE guid = 'm1'").run();
    const secondChat = await upsertChats(
      db,
      [Chat.parse({ guid: 'c2', participants: [{ address: 'a@x.com' }] })],
      handleMap,
    );
    let neighbourDidStart = false;
    let releaseNeighbour!: () => void;
    const neighbourRelease = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const neighbour = observe(
      withDbTransaction(db, async () => {
        raw
          .prepare("UPDATE messages SET chat_id = ?, date_retracted = 9999 WHERE guid = 'm1'")
          .run(secondChat.get('c2'));
        neighbourDidStart = true;
        await neighbourRelease;
        throw new Error('unsend identity neighbour rollback');
      }),
    );
    const postedBodies: unknown[] = [];
    const http = {
      post: async (_path: string, _schema: unknown, options?: { json?: unknown }) => {
        postedBodies.push(options?.json);
        throw new ApiError('no_connection', 'unsend identity request failed', 0);
      },
    } as unknown as HttpClient;
    let unsend: ReturnType<typeof observe<{ ok: boolean }>> | undefined;
    try {
      try {
        await waitFor(() => neighbourDidStart, 'unsend identity neighbour');
        unsend = observe(sendUnsend(db, http, { messageGuid: 'm1' }, 7_000));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(unsend.settled()).toBe(false);
        expect(postedBodies).toEqual([]);
        expect(
          one(
            raw,
            "SELECT c.guid FROM messages m JOIN chats c ON c.id=m.chat_id WHERE m.guid='m1'",
          ),
        ).toEqual({
          guid: 'c2',
        });
      } finally {
        releaseNeighbour();
        await Promise.allSettled([neighbour.outcome, ...(unsend ? [unsend.outcome] : [])]);
      }

      expect(await neighbour.outcome).toMatchObject({ kind: 'rejected' });
      expect(await unsend?.outcome).toEqual({ kind: 'fulfilled', value: { ok: false } });
      expect(postedBodies).toEqual([{ chatGuid: 'c1', partIndex: 0 }]);
      expect(one(raw, "SELECT date_retracted AS value FROM messages WHERE guid='m1'")).toEqual({
        value: 4_321,
      });

      const missing = await sendUnsend(db, http, { chatGuid: 'c1', messageGuid: 'missing' }, 7_001);
      expect(missing).toEqual({ ok: false });
      expect(postedBodies).toHaveLength(1);
    } finally {
      raw.close();
    }
  });

  it('unsend: rolls back a retired optimistic apply before HTTP and lets a fresh lease revert', async () => {
    const { db, raw } = await createTestDb();
    await seed(db);
    raw.prepare("UPDATE messages SET date_retracted = 4321 WHERE guid = 'm1'").run();
    let drain: Promise<void> | undefined;
    let triggerRan = false;
    raw.function('pause_unsend_during_apply', () => {
      triggerRan = true;
      drain = pauseRealtimeDeliveries();
      return 0;
    });
    raw.exec(`CREATE TRIGGER pause_unsend_during_apply
      AFTER UPDATE OF date_retracted ON messages
      WHEN NEW.date_retracted = 7000
      BEGIN SELECT pause_unsend_during_apply(); END`);

    let posts = 0;
    const oldLease = captureRealtimeDeliveryLease();
    try {
      const oldUnsend = runTrackedRealtimeWork(oldLease, (lease) =>
        sendUnsend(
          db,
          {
            post: async () => {
              posts += 1;
              return { unsent: true };
            },
          } as unknown as HttpClient,
          { messageGuid: 'm1' },
          7_000,
          () => lease.isCurrent(),
        ),
      );

      await expect(oldUnsend).rejects.toBeInstanceOf(DbCommitGuardRejectedError);
      if (!drain) throw new Error('unsend apply did not retire the account lease');
      await drain;

      expect(triggerRan).toBe(true);
      expect(posts).toBe(0);
      expect(raw.inTransaction).toBe(false);
      expect(one(raw, "SELECT date_retracted AS value FROM messages WHERE guid='m1'")).toEqual({
        value: 4_321,
      });

      raw.exec('DROP TRIGGER pause_unsend_during_apply');
      resumeRealtimeDeliveries();
      const freshLease = captureRealtimeDeliveryLease();
      let freshResult: { ok: boolean } | undefined;
      let postRanInsideTransaction = true;
      await expect(
        runTrackedRealtimeWork(freshLease, async (lease) => {
          freshResult = await sendUnsend(
            db,
            {
              post: async () => {
                posts += 1;
                postRanInsideTransaction = raw.inTransaction;
                return { unsent: false };
              },
            } as unknown as HttpClient,
            { messageGuid: 'm1' },
            8_000,
            () => lease.isCurrent(),
          );
        }),
      ).resolves.toBe('delivered');

      expect(freshResult).toEqual({ ok: false });
      expect(posts).toBe(1);
      expect(postRanInsideTransaction).toBe(false);
      expect(raw.inTransaction).toBe(false);
      expect(one(raw, "SELECT date_retracted AS value FROM messages WHERE guid='m1'")).toEqual({
        value: 4_321,
      });
    } finally {
      raw.exec('DROP TRIGGER IF EXISTS pause_unsend_during_apply');
      if (drain) await drain;
      resumeRealtimeDeliveries();
      raw.close();
    }
  });

  it('unsend: attempts a failed local revert once and permits an exact public retry', async () => {
    const { db, raw } = await createTestDb();
    await seed(db);
    raw.prepare("UPDATE messages SET date_retracted = 4321 WHERE guid = 'm1'").run();
    let revertAttempts = 0;
    raw.function('record_unsend_revert', () => {
      revertAttempts += 1;
      return 0;
    });
    raw.exec(`CREATE TRIGGER fail_unsend_revert
      BEFORE UPDATE OF date_retracted ON messages
      WHEN OLD.date_retracted = 7000 AND NEW.date_retracted = 4321
      BEGIN
        SELECT record_unsend_revert();
        SELECT RAISE(ABORT, 'UNSEND_REVERT_CANARY');
      END`);

    let posts = 0;
    try {
      const attempt = await observe(
        sendUnsend(
          db,
          {
            post: async () => {
              posts += 1;
              return { unsent: false };
            },
          } as unknown as HttpClient,
          { messageGuid: 'm1' },
          7_000,
        ),
      ).outcome;

      expect({
        outcome: attempt.kind,
        posts,
        revertAttempts,
        inTransaction: raw.inTransaction,
        marker: one(raw, "SELECT date_retracted AS value FROM messages WHERE guid='m1'").value,
      }).toEqual({
        outcome: 'rejected',
        posts: 1,
        revertAttempts: 1,
        inTransaction: false,
        marker: 7_000,
      });
      if (attempt.kind === 'rejected') {
        expect(errorMessages(attempt.error)).toContain('UNSEND_REVERT_CANARY');
      }

      raw.exec('DROP TRIGGER fail_unsend_revert');
      await expect(revertLocalUnsend(db, 'm1', 7_000, 4_321)).resolves.toBe(true);
      expect(one(raw, "SELECT date_retracted AS value FROM messages WHERE guid='m1'")).toEqual({
        value: 4_321,
      });
    } finally {
      raw.exec('DROP TRIGGER IF EXISTS fail_unsend_revert');
      raw.close();
    }
  });

  it('edit: reverts the text when the POST THROWS', async () => {
    const { db, raw } = await createTestDb();
    await seed(db);
    const r = await sendEdit(db, failHttp, { messageGuid: 'm1', newText: 'edited!' }, 5000);
    expect(r.ok).toBe(false);
    expect((one(raw, "SELECT text FROM messages WHERE guid='m1'") as { text: string }).text).toBe(
      'original',
    );
  });

  it('edit: restores searchable rich text for both NULL and empty legacy rows after failure', async () => {
    const legacyStates = [
      { storedText: null, previousEdited: 4321, label: 'null' },
      { storedText: '', previousEdited: null, label: 'empty' },
    ] as const;
    for (const { storedText, previousEdited, label } of legacyStates) {
      const { db, raw } = await createTestDb();
      try {
        await seed(db);
        const originalBody = attributedBody(`birthday original ${label}`);
        raw
          .prepare(
            `UPDATE messages
                SET text = ?, attributed_body = ?, date_edited = ?
              WHERE guid = 'm1'`,
          )
          .run(storedText, originalBody, previousEdited);
        raw
          .prepare(
            `INSERT INTO kv(key, value) VALUES ('maintenance.searchTextBackfill.v1', 'done')
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          )
          .run();

        let optimisticRow: Record<string, unknown> | undefined;
        let optimisticHits: number | undefined;
        const http = {
          post: async () => {
            optimisticRow = one(
              raw,
              "SELECT text, attributed_body AS body, date_edited AS edited FROM messages WHERE guid='m1'",
            );
            optimisticHits = ftsHits(raw, 'optimistic');
            throw new ApiError('no_connection', 'offline', 0);
          },
        } as unknown as HttpClient;

        await expect(
          sendEdit(db, http, { messageGuid: 'm1', newText: 'optimistic searchable' }, 5000),
        ).resolves.toEqual({ ok: false });
        expect(optimisticRow).toEqual({ text: 'optimistic searchable', body: null, edited: 5000 });
        expect(optimisticHits).toBe(1);
        expect(
          one(
            raw,
            "SELECT text, attributed_body AS body, date_edited AS edited FROM messages WHERE guid='m1'",
          ),
        ).toEqual({
          text: `birthday original ${label}`,
          body: originalBody,
          edited: previousEdited,
        });
        expect(ftsHits(raw, 'birthday')).toBe(1);
        expect(ftsHits(raw, 'optimistic')).toBe(0);
      } finally {
        raw.close();
      }
    }
  });

  it('edit: preserves NULL versus empty when an undecodable body cannot supply restore text', async () => {
    for (const storedText of [null, ''] as const) {
      const { db, raw } = await createTestDb();
      try {
        await seed(db);
        raw
          .prepare("UPDATE messages SET text = ?, attributed_body = 'not-json' WHERE guid = 'm1'")
          .run(storedText);

        await expect(
          sendEdit(
            db,
            failHttp,
            { messageGuid: 'm1', chatGuid: 'c1', newText: 'optimistic' },
            5_000,
          ),
        ).resolves.toEqual({ ok: false });

        const row = one(raw, "SELECT text, attributed_body FROM messages WHERE guid = 'm1'");
        expect(row).toEqual({ text: storedText, attributed_body: 'not-json' });
      } finally {
        raw.close();
      }
    }
  });

  it('edit: snapshots only after a rolling-back neighbour, never persisting its phantom text', async () => {
    const { db, raw } = await createTestDb();
    await seed(db);
    const originalBody = attributedBody('committed birthday body');
    raw
      .prepare("UPDATE messages SET text = '', attributed_body = ? WHERE guid = 'm1'")
      .run(originalBody);
    raw
      .prepare("INSERT INTO kv(key, value) VALUES ('maintenance.searchTextBackfill.v1', 'done')")
      .run();

    let neighbourDidStart = false;
    let releaseNeighbour!: () => void;
    const neighbourRelease = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const neighbour = observe(
      withDbTransaction(db, async () => {
        raw
          .prepare(
            "UPDATE messages SET text = 'phantom dirty text', date_edited = 777 WHERE guid = 'm1'",
          )
          .run();
        neighbourDidStart = true;
        await neighbourRelease;
        throw new Error('phantom neighbour rollback');
      }),
    );
    let postCalls = 0;
    let optimisticHits: number | undefined;
    let edit: ReturnType<typeof observe<{ ok: boolean }>> | undefined;
    try {
      try {
        await waitFor(() => neighbourDidStart, 'phantom neighbour');
        edit = observe(
          sendEdit(
            db,
            {
              post: async () => {
                postCalls += 1;
                optimisticHits = ftsHits(raw, 'optimistic');
                return {};
              },
            } as unknown as HttpClient,
            { messageGuid: 'm1', newText: 'optimistic searchable' },
            5000,
          ),
        );

        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(edit.settled()).toBe(false);
        expect(postCalls).toBe(0);
        expect(
          one(raw, "SELECT text, date_edited AS edited FROM messages WHERE guid='m1'"),
        ).toEqual({ text: 'phantom dirty text', edited: 777 });
      } finally {
        releaseNeighbour();
        await Promise.allSettled([neighbour.outcome, ...(edit ? [edit.outcome] : [])]);
      }

      expect(await neighbour.outcome).toMatchObject({ kind: 'rejected' });
      expect(await edit?.outcome).toEqual({ kind: 'fulfilled', value: { ok: false } });
      expect(postCalls).toBe(1);
      expect(optimisticHits).toBe(1);
      expect(
        one(
          raw,
          "SELECT text, attributed_body AS body, date_edited AS edited FROM messages WHERE guid='m1'",
        ),
      ).toEqual({ text: 'committed birthday body', body: originalBody, edited: null });
      expect(ftsHits(raw, 'birthday')).toBe(1);
      expect(ftsHits(raw, 'phantom')).toBe(0);
      expect(ftsHits(raw, 'optimistic')).toBe(0);
    } finally {
      raw.close();
    }
  });

  it('edit: serializes three same-message failures and keeps queue cleanup identity-safe', async () => {
    const { db, raw } = await createTestDb();
    await seed(db);
    const independentDb = await createTestDb();
    await seed(independentDb.db);
    const gates = Array.from({ length: 3 }, () => {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release: () => release() };
    });
    const started: number[] = [];
    const http = {
      post: async () => {
        const call = started.length + 1;
        started.push(call);
        await gates[call - 1]?.promise;
        throw new ApiError('no_connection', `offline edit ${call}`, 0);
      },
    } as unknown as HttpClient;
    const outcomes: Promise<unknown>[] = [];
    let triggerInstalled = false;
    try {
      // One unexpected local-driver failure must not poison this message's service tail.
      raw.exec(`CREATE TRIGGER fail_first_optimistic
        BEFORE UPDATE OF text ON messages
        WHEN NEW.date_edited = 4999
        BEGIN SELECT RAISE(ABORT, 'EDIT_LOCAL_DRIVER_CANARY'); END`);
      triggerInstalled = true;
      const unexpected = observe(
        sendEdit(db, http, { messageGuid: 'm1', newText: 'driver failed' }, 4999),
      );
      outcomes.push(unexpected.outcome);
      const failed = await unexpected.outcome;
      expect(failed).toMatchObject({ kind: 'rejected' });
      if (failed.kind === 'rejected') {
        expect(errorMessages(failed.error)).toContain('EDIT_LOCAL_DRIVER_CANARY');
      }
      raw.exec('DROP TRIGGER IF EXISTS fail_first_optimistic');
      triggerInstalled = false;

      const firstArgs = { messageGuid: 'm1', newText: 'first failed' };
      const first = observe(sendEdit(db, http, firstArgs, 5001));
      // Mutating the caller-owned object after synchronous queue admission must not change the
      // operation's captured key or the exact slot its eventual cleanup addresses.
      firstArgs.messageGuid = 'caller-mutated-after-admission';
      const second = observe(
        sendEdit(db, http, { messageGuid: 'm1', newText: 'second failed' }, 5002),
      );
      outcomes.push(first.outcome, second.outcome);
      let third: ReturnType<typeof observe<{ ok: boolean }>> | undefined;
      await waitFor(() => started.length === 1, 'first edit HTTP');
      expect(second.settled()).toBe(false);
      expect(one(raw, "SELECT text FROM messages WHERE guid='m1'").text).toBe('first failed');

      let independentStarts = 0;
      const independent = observe(
        sendEdit(
          independentDb.db,
          {
            post: async () => {
              independentStarts += 1;
              return { guid: 'm1' };
            },
          } as unknown as HttpClient,
          { messageGuid: 'm1', newText: 'other database succeeds' },
          6001,
        ),
      );
      outcomes.push(independent.outcome);
      await waitFor(() => independentStarts === 1, 'same-guid edit on another database');
      expect(await independent.outcome).toEqual({ kind: 'fulfilled', value: { ok: true } });

      gates[0]?.release();
      await waitFor(() => started.length === 2, 'second edit HTTP');
      third = observe(sendEdit(db, http, { messageGuid: 'm1', newText: 'third failed' }, 5003));
      outcomes.push(third.outcome);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(started).toEqual([1, 2]);
      expect(third.settled()).toBe(false);
      expect(one(raw, "SELECT text FROM messages WHERE guid='m1'").text).toBe('second failed');

      gates[1]?.release();
      await waitFor(() => started.length === 3, 'third edit HTTP');
      expect(one(raw, "SELECT text FROM messages WHERE guid='m1'").text).toBe('third failed');
      gates[2]?.release();
      await Promise.allSettled(outcomes);

      expect(await first.outcome).toEqual({ kind: 'fulfilled', value: { ok: false } });
      expect(await second.outcome).toEqual({ kind: 'fulfilled', value: { ok: false } });
      expect(await third.outcome).toEqual({ kind: 'fulfilled', value: { ok: false } });
      expect(one(raw, "SELECT text, date_edited AS edited FROM messages WHERE guid='m1'")).toEqual({
        text: 'original',
        edited: null,
      });
    } finally {
      for (const gate of gates) gate.release();
      if (triggerInstalled) raw.exec('DROP TRIGGER IF EXISTS fail_first_optimistic');
      await Promise.allSettled(outcomes);
      raw.close();
      independentDb.raw.close();
    }
  });

  it('serializes edit and unsend lifecycles while leaving HTTP outside the DB mutex', async () => {
    const { db, raw } = await createTestDb();
    await seed(db);
    const independent = await createTestDb();
    await seed(independent.db);
    const gates = Array.from({ length: 3 }, () => {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release: () => release() };
    });
    const starts: string[] = [];
    const http = {
      post: async (path: string) => {
        const call = starts.length;
        const kind = path.endsWith('/unsend') ? 'unsend' : 'edit';
        starts.push(kind);
        await gates[call]?.promise;
        if (call === 0) return { unsent: true };
        if (call === 1) throw new ApiError('no_connection', 'edit failed', 0);
        return {};
      },
    } as unknown as HttpClient;
    const outcomes: Promise<unknown>[] = [];
    try {
      const firstArgs = { messageGuid: 'm1' };
      const first = observe(sendUnsend(db, http, firstArgs, 7_001));
      firstArgs.messageGuid = 'caller-mutated-after-admission';
      const second = observe(
        sendEdit(db, http, { messageGuid: 'm1', newText: 'failed edit' }, 7_002),
      );
      const third = observe(sendUnsend(db, http, { messageGuid: 'm1' }, 7_003));
      outcomes.push(first.outcome, second.outcome, third.outcome);

      await waitFor(() => starts.length === 1, 'first unsend HTTP');
      expect(starts).toEqual(['unsend']);
      expect(second.settled()).toBe(false);
      expect(third.settled()).toBe(false);

      // HTTP must not hold the process-wide DB mutex: an unrelated transaction can finish while
      // the first network request is deliberately paused.
      const successor = observe(
        withDbTransaction(db, async () => {
          raw.prepare("INSERT INTO kv(key, value) VALUES ('unsend.successor', 'done')").run();
        }),
      );
      outcomes.push(successor.outcome);
      expect(await successor.outcome).toMatchObject({ kind: 'fulfilled' });

      let independentStarts = 0;
      const independentResult = observe(
        sendUnsend(
          independent.db,
          {
            post: async () => {
              independentStarts += 1;
              return { unsent: true };
            },
          } as unknown as HttpClient,
          { messageGuid: 'm1' },
          8_001,
        ),
      );
      outcomes.push(independentResult.outcome);
      await waitFor(() => independentStarts === 1, 'same-guid unsend on another database');
      expect(await independentResult.outcome).toEqual({
        kind: 'fulfilled',
        value: { ok: true },
      });

      gates[0]?.release();
      await waitFor(() => starts.length === 2, 'queued edit HTTP');
      expect(starts).toEqual(['unsend', 'edit']);
      expect(third.settled()).toBe(false);
      gates[1]?.release();

      await waitFor(() => starts.length === 3, 'final unsend HTTP');
      expect(starts).toEqual(['unsend', 'edit', 'unsend']);
      expect(
        one(
          raw,
          "SELECT text, date_edited AS edited, date_retracted AS retracted FROM messages WHERE guid='m1'",
        ),
      ).toEqual({ text: 'original', edited: null, retracted: 7_003 });
      gates[2]?.release();
      await Promise.allSettled(outcomes);

      expect(await first.outcome).toEqual({ kind: 'fulfilled', value: { ok: true } });
      expect(await second.outcome).toEqual({ kind: 'fulfilled', value: { ok: false } });
      expect(await third.outcome).toEqual({ kind: 'fulfilled', value: { ok: false } });
      expect(
        one(
          raw,
          "SELECT text, date_edited AS edited, date_retracted AS retracted FROM messages WHERE guid='m1'",
        ),
      ).toEqual({ text: 'original', edited: null, retracted: 7_001 });
    } finally {
      for (const gate of gates) gate.release();
      await Promise.allSettled(outcomes);
      raw.close();
      independent.raw.close();
    }
  });

  // THE SOFT FAILURE: the transport succeeded, so nothing throws — the server just didn't confirm.
  // These two are the only tests that reach the in-`try` revert branches; every other failure test
  // in this file drives a THROWING client and lands in the catch, so without them both branches can
  // be deleted outright and the whole suite still passes. The residue they prevent is PERMANENT:
  // `date_edited` and `date_retracted` are COALESCE-preserved in `upsertMessages`' conflict clause
  // (absence never clears a stamp), so no later re-page can remove a marker the optimistic write
  // left behind — an "Edited" label on a message nobody else sees edited, or a retracted-looking
  // bubble whose content every other participant still has.
  it('edit: reverts the optimistic text when the POST returns 200 with NO guid', async () => {
    const { db, raw } = await createTestDb();
    await seed(db);
    // A present guid is the Private-API confirmation the edit went through; its absence is the
    // server saying "accepted, but nothing was edited".
    const http = { post: async () => ({}) } as unknown as HttpClient;
    expect((await sendEdit(db, http, { messageGuid: 'm1', newText: 'edited!' }, 5000)).ok).toBe(
      false,
    );
    const row = one(raw, "SELECT text, date_edited d FROM messages WHERE guid='m1'") as {
      text: string;
      d: number | null;
    };
    expect(row.text).toBe('original');
    expect(row.d).toBeNull(); // no stranded "Edited" marker on a message nobody else sees edited
  });

  it('unsend: requires exact true and restores the exact prior marker on soft failure', async () => {
    for (const ack of [{ unsent: false }, { unsent: null }, {}]) {
      const { db, raw } = await createTestDb();
      try {
        await seed(db);
        raw.prepare("UPDATE messages SET date_retracted = 4321 WHERE guid = 'm1'").run();
        const http = { post: async () => ack } as unknown as HttpClient;
        expect((await sendUnsend(db, http, { messageGuid: 'm1' }, 7_000)).ok).toBe(false);
        expect(
          (
            one(raw, "SELECT date_retracted d FROM messages WHERE guid='m1'") as {
              d: number | null;
            }
          ).d,
        ).toBe(4_321);
      } finally {
        raw.close();
      }
    }
  });

  it('unsend: sets dateRetracted on success, clears it when the POST THROWS', async () => {
    const a = await createTestDb();
    await seed(a.db);
    expect((await sendUnsend(a.db, unsendOkHttp, { messageGuid: 'm1' }, 7000)).ok).toBe(true);
    expect(
      (one(a.raw, "SELECT date_retracted d FROM messages WHERE guid='m1'") as { d: number | null })
        .d,
    ).toBe(7000);

    const b = await createTestDb();
    await seed(b.db);
    expect((await sendUnsend(b.db, failHttp, { messageGuid: 'm1' }, 7000)).ok).toBe(false);
    expect(
      (one(b.raw, "SELECT date_retracted d FROM messages WHERE guid='m1'") as { d: number | null })
        .d,
    ).toBeNull();
  });

  // The revert is a COMPARE-AND-SET on the marker our own optimistic write left behind. A failed
  // POST does NOT prove the server didn't apply the change — a lost response still emits an echo,
  // and that echo lands first. Reverting blindly on top of it is a lost update: for an edit the
  // message reads the old wording to you and the new one to everyone else, permanently; for an
  // unsend it puts content the user revoked from everyone back on their own screen.
  it('edit: does NOT revert over an echo that landed while the POST was failing', async () => {
    const scenarios = [
      {
        // Same timestamp AND text: only a newer rich body proves the row is no longer locally owned.
        // A rich server event now refreshes this column. This raw state independently pins the CAS
        // conjunct without claiming an identical marker/text/NULL-body echo is distinguishable.
        authoritativeText: 'edited!',
        authoritativeBody: attributedBody('server authoritative rich body'),
      },
      {
        // Same timestamp AND empty rich body: only the different text proves server ownership.
        authoritativeText: 'server authoritative',
        authoritativeBody: null,
      },
    ] as const;

    for (const scenario of scenarios) {
      const { db, raw } = await createTestDb();
      try {
        await seed(db);
        const http = {
          post: async () => {
            // The server echo deliberately collides with our millisecond marker. Both optimistic
            // text and cleared-body ownership must match before a local failure may revert it.
            await withDbTransaction(db, async () => {
              raw
                .prepare(
                  `UPDATE messages
                      SET text = ?, attributed_body = ?, date_edited = 5000
                    WHERE guid = 'm1'`,
                )
                .run(scenario.authoritativeText, scenario.authoritativeBody);
            });
            throw new ApiError('no_connection', 'offline', 0);
          },
        } as unknown as HttpClient;

        const r = await sendEdit(db, http, { messageGuid: 'm1', newText: 'edited!' }, 5000);
        expect(r.ok).toBe(false);
        expect(
          one(
            raw,
            "SELECT text, attributed_body AS body, date_edited d FROM messages WHERE guid='m1'",
          ),
        ).toEqual({
          text: scenario.authoritativeText,
          body: scenario.authoritativeBody,
          d: 5000,
        });
      } finally {
        raw.close();
      }
    }
  });

  it('unsend: does NOT clear a retraction the server actually stamped', async () => {
    const { db, raw } = await createTestDb();
    await seed(db);
    const http = {
      post: async () => {
        // The server retracted it and echoed with its OWN timestamp; then our POST throws.
        await upsertMessages(
          db,
          [
            Message.parse({
              guid: 'm1',
              text: 'original',
              isFromMe: true,
              dateCreated: 100,
              dateRetracted: 8888,
            }),
          ],
          () => 1,
          new Map(),
        );
        throw new ApiError('no_connection', 'offline', 0);
      },
    } as unknown as HttpClient;

    expect((await sendUnsend(db, http, { messageGuid: 'm1' }, 7000)).ok).toBe(false);
    expect(
      (one(raw, "SELECT date_retracted d FROM messages WHERE guid='m1'") as { d: number | null }).d,
    ).toBe(8888); // still retracted — the revoked content is not put back on screen
  });
});
