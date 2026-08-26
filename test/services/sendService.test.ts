import type Database from 'better-sqlite3';
import { ApiError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';
import { Chat, Message } from '@core/models';
import { logger } from '@core/secure';
import {
  claimScheduled,
  getScheduledById,
  insertScheduled,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import { DbCommitGuardRejectedError } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { generateTempGuid, sendTextMessage } from '@/services/send/sendService';
import { createTestDb } from '../support/testDb';

/** Minimal fake HttpClient: only `post` is used (by sendText). */
function fakeHttp(impl: (json: unknown) => Promise<unknown>): HttpClient {
  return {
    post: (_path: string, _schema: unknown, opts: { json?: unknown }) => impl(opts?.json),
  } as unknown as HttpClient;
}

async function seedChat(db: AppDatabase, guid: string) {
  const handles = await upsertHandles(db, [{ address: 'craig@apple.com' }]);
  await upsertChats(
    db,
    [Chat.parse({ guid, participants: [{ address: 'craig@apple.com' }] })],
    handles,
  );
}

function countMessages(raw: Database.Database) {
  return (raw.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c;
}

describe('generateTempGuid', () => {
  it('matches temp-{8 alnum}', () => {
    for (let i = 0; i < 20; i++) expect(generateTempGuid()).toMatch(/^temp-[a-z0-9]{8}$/);
  });
});

describe('sendTextMessage', () => {
  it('optimistically inserts then promotes temp→real on success (one row, queue cleared)', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await sendTextMessage(
      db,
      fakeHttp(async () => ({ guid: 'real-1', dateCreated: 1000, dateDelivered: null })),
      { chatGuid: 'c1', text: 'hello' },
    );

    expect(countMessages(raw)).toBe(1);
    const row = raw.prepare('SELECT guid, send_state s, is_from_me f FROM messages').get() as {
      guid: string;
      s: string;
      f: number;
    };
    expect(row.guid).toBe('real-1');
    expect(row.s).toBe('sent');
    expect(row.f).toBe(1);
    expect((raw.prepare('SELECT COUNT(*) c FROM outgoing_queue').get() as { c: number }).c).toBe(0);
  });

  it('persists a send-effect on the optimistic message + the queue payload', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    let queuedPayload = '';
    await sendTextMessage(
      db,
      fakeHttp(async () => {
        // Capture the optimistic state BEFORE reconciliation.
        const m = raw.prepare('SELECT expressive_send_style_id e FROM messages').get() as {
          e: string | null;
        };
        expect(m.e).toBe('com.apple.messages.effect.CKConfettiEffect');
        queuedPayload =
          (raw.prepare('SELECT payload p FROM outgoing_queue').get() as { p: string } | undefined)
            ?.p ?? '';
        return { guid: 'real-1', dateCreated: 1000, dateDelivered: null };
      }),
      { chatGuid: 'c1', text: 'party', effectId: 'com.apple.messages.effect.CKConfettiEffect' },
    );
    // The effect id is also sent to the server (in the queue payload).
    expect(queuedPayload).toContain('CKConfettiEffect');
  });

  it('does not duplicate when the socket echo lands FIRST (deletes temp)', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    // The fake "server" upserts the real message (like DbEventSink) before responding.
    await sendTextMessage(
      db,
      fakeHttp(async () => {
        const handles = await upsertHandles(db, [{ address: 'craig@apple.com' }]);
        const map = new Map<string, number>();
        const chatId = (
          raw.prepare('SELECT id FROM chats WHERE guid=?').get('c1') as { id: number }
        ).id;
        map.set('craig@apple.com', handles.get('craig@apple.com')!);
        await upsertMessages(
          db,
          [Message.parse({ guid: 'real-2', text: 'hello', isFromMe: true, dateCreated: 1000 })],
          () => chatId,
          map,
        );
        return { guid: 'real-2', dateCreated: 1000, dateDelivered: 2000 };
      }),
      { chatGuid: 'c1', text: 'hello' },
    );

    expect(countMessages(raw)).toBe(1);
    expect((raw.prepare('SELECT guid FROM messages').get() as { guid: string }).guid).toBe(
      'real-2',
    );
  });

  it('does not duplicate when the echo arrives AFTER promotion (conflict update)', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await sendTextMessage(
      db,
      fakeHttp(async () => ({ guid: 'real-3', dateCreated: 1000, dateDelivered: null })),
      {
        chatGuid: 'c1',
        text: 'hi',
      },
    );
    // Now the socket echo upserts the same real guid.
    const chatId = (raw.prepare('SELECT id FROM chats WHERE guid=?').get('c1') as { id: number })
      .id;
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'real-3',
          text: 'hi',
          isFromMe: true,
          dateCreated: 1000,
          dateDelivered: 5000,
        }),
      ],
      () => chatId,
      new Map(),
    );
    expect(countMessages(raw)).toBe(1);
  });

  it('marks the message errored on failure (one row, queue attempt bumped)', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    await sendTextMessage(
      db,
      fakeHttp(async () => {
        throw new ApiError('unauthorized', 'nope', 401);
      }),
      { chatGuid: 'c1', text: 'fails' },
    );
    expect(countMessages(raw)).toBe(1);
    const row = raw.prepare('SELECT send_state s, error e FROM messages').get() as {
      s: string;
      e: number;
    };
    expect(row.s).toBe('error');
    expect(row.e).toBe(401);
    expect(
      (raw.prepare('SELECT attempts FROM outgoing_queue').get() as { attempts: number }).attempts,
    ).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[send] failed for chat c1 (code 401, HTTP 401): nope');
    warn.mockRestore();
  });

  it('throws for an unknown chat', async () => {
    const { db } = await createTestDb();
    await expect(
      sendTextMessage(
        db,
        fakeHttp(async () => ({})),
        { chatGuid: 'nope', text: 'x' },
      ),
    ).rejects.toThrow(/unknown chat/);
  });

  it('rolls back ordinary construction when its account retires before commit, then allows a fresh send', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const beforeChat = raw
      .prepare('SELECT latest_message_date AS latestMessageDate FROM chats WHERE guid = ?')
      .get('c1');
    let current = true;
    let queued = 0;
    let posts = 0;

    raw.function('retire_ordinary_send_during_insert', () => {
      current = false;
      return 0;
    });
    raw.exec(`
      CREATE TRIGGER retire_ordinary_send_during_insert
      AFTER INSERT ON outgoing_queue
      BEGIN
        SELECT retire_ordinary_send_during_insert();
      END
    `);

    await expect(
      sendTextMessage(
        db,
        fakeHttp(async () => {
          posts += 1;
          return { guid: 'must-not-send', dateCreated: 1_000, dateDelivered: null };
        }),
        { chatGuid: 'c1', text: 'account A only' },
        1_000,
        () => {
          queued += 1;
        },
        undefined,
        () => current,
      ),
    ).rejects.toBeInstanceOf(DbCommitGuardRejectedError);

    expect(posts).toBe(0);
    expect(queued).toBe(0);
    expect(raw.inTransaction).toBe(false);
    expect(raw.prepare('SELECT COUNT(*) AS count FROM outgoing_queue').get()).toEqual({ count: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 });
    expect(
      raw
        .prepare('SELECT latest_message_date AS latestMessageDate FROM chats WHERE guid = ?')
        .get('c1'),
    ).toEqual(beforeChat);

    raw.exec('DROP TRIGGER retire_ordinary_send_during_insert');
    current = true;
    await sendTextMessage(
      db,
      fakeHttp(async () => {
        expect(raw.inTransaction).toBe(false);
        posts += 1;
        return { guid: 'real-after-retry', dateCreated: 2_000, dateDelivered: null };
      }),
      { chatGuid: 'c1', text: 'fresh current send' },
      2_000,
      undefined,
      undefined,
      () => current,
    );

    expect(posts).toBe(1);
    expect(raw.prepare('SELECT guid, send_state AS sendState FROM messages').get()).toEqual({
      guid: 'real-after-retry',
      sendState: 'sent',
    });
  });

  it('does not POST an ordinary send when onQueued observes account retirement', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    let current = true;
    let posts = 0;

    const send = sendTextMessage(
      db,
      fakeHttp(async () => {
        posts += 1;
        return { guid: 'must-not-send', dateCreated: 1_000, dateDelivered: null };
      }),
      { chatGuid: 'c1', text: 'durable but retired' },
      1_000,
      () => {
        current = false;
      },
      undefined,
      () => current,
    );

    await expect(send).rejects.toBeInstanceOf(DbCommitGuardRejectedError);
    expect(posts).toBe(0);
    expect(raw.inTransaction).toBe(false);
    expect(raw.prepare('SELECT COUNT(*) AS count FROM outgoing_queue').get()).toEqual({ count: 1 });
    expect(raw.prepare('SELECT send_state AS sendState FROM messages').get()).toEqual({
      sendState: 'sending',
    });
  });

  it('does not settle an ordinary send after its account retires during HTTP', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    let current = true;
    let releaseResponse!: (value: unknown) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const response = new Promise<unknown>((resolve) => {
      releaseResponse = resolve;
    });

    const send = sendTextMessage(
      db,
      fakeHttp(() => {
        expect(raw.inTransaction).toBe(false);
        markStarted();
        return response;
      }),
      { chatGuid: 'c1', text: 'A request already started' },
      1_000,
      undefined,
      undefined,
      () => current,
    );
    await started;
    current = false;
    releaseResponse({ guid: 'late-real-guid', dateCreated: 1_000, dateDelivered: null });

    await expect(send).rejects.toBeInstanceOf(DbCommitGuardRejectedError);
    expect(raw.inTransaction).toBe(false);
    expect(raw.prepare('SELECT COUNT(*) AS count FROM outgoing_queue').get()).toEqual({ count: 1 });
    expect(raw.prepare('SELECT guid, send_state AS sendState FROM messages').get()).toMatchObject({
      guid: expect.stringMatching(/^temp-/),
      sendState: 'sending',
    });
  });

  it('does not POST when a scheduled account is revoked after handoff but before the request', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const scheduledId = await insertScheduled(db, {
      chatGuid: 'c1',
      text: 'account A only',
      scheduledFor: 1,
    });
    expect(await claimScheduled(db, scheduledId)).toBe(true);

    let current = true;
    let posts = 0;
    const send = sendTextMessage(
      db,
      fakeHttp(async () => {
        posts += 1;
        return { guid: 'must-not-send', dateCreated: 2, dateDelivered: null };
      }),
      { chatGuid: 'c1', text: 'account A only' },
      1,
      () => {
        // The atomic handoff has committed; model Disconnect landing in the precise continuation
        // before the service starts its HTTP request.
        current = false;
      },
      {
        scheduledId,
        transition: { kind: 'sent' },
        commitGuard: () => current,
      },
    );

    await expect(send).rejects.toBeInstanceOf(DbCommitGuardRejectedError);
    expect(posts).toBe(0);
    expect(await getScheduledById(db, scheduledId)).toMatchObject({ status: 'sent' });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM outgoing_queue').get()).toEqual({ count: 1 });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 1 });
  });
});
