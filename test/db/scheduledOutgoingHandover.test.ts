import {
  claimScheduled,
  getScheduledById,
  handoverScheduledTextToOutgoing,
  insertScheduled,
  ScheduledOutgoingClaimLostError,
  type InsertOutgoingTextArgs,
} from '@db/repositories';
import { DbCommitGuardRejectedError } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

interface Fixture {
  db: AppDatabase;
  raw: import('better-sqlite3').Database;
  chatId: number;
  scheduledId: number;
}

async function createFixture(options: { serverId?: string } = {}): Promise<Fixture> {
  const { db, raw } = await createTestDb();
  const inserted = raw
    .prepare('INSERT INTO chats (guid, latest_message_date) VALUES (?, ?)')
    .run('c1', 100);
  const chatId = Number(inserted.lastInsertRowid);
  const scheduledId = await insertScheduled(db, {
    chatGuid: 'c1',
    text: 'scheduled text',
    scheduledFor: 1_000,
    selectedMessageGuid: 'reply-guid',
    serverId: options.serverId,
  });
  return { db, raw, chatId, scheduledId };
}

function outgoing(chatId: number, overrides: Partial<InsertOutgoingTextArgs> = {}) {
  return {
    tempGuid: 'temp-handoff',
    chatId,
    chatGuid: 'c1',
    text: 'scheduled text',
    now: 2_000,
    selectedMessageGuid: 'reply-guid',
    threadOriginatorGuid: 'reply-guid',
    ...overrides,
  } satisfies InsertOutgoingTextArgs;
}

describe('scheduled → outgoing repository handoff', () => {
  it('commits a one-shot terminal state with its optimistic message and queue row', async () => {
    const { db, raw, chatId, scheduledId } = await createFixture();
    expect(await claimScheduled(db, scheduledId)).toBe(true);

    await handoverScheduledTextToOutgoing(db, {
      scheduledId,
      outgoing: outgoing(chatId),
      transition: { kind: 'sent' },
    });

    expect(await getScheduledById(db, scheduledId)).toMatchObject({
      status: 'sent',
      serverId: null,
    });
    expect(
      raw
        .prepare(
          'SELECT temp_guid AS tempGuid, chat_guid AS chatGuid, kind, payload FROM outgoing_queue',
        )
        .get(),
    ).toEqual({
      tempGuid: 'temp-handoff',
      chatGuid: 'c1',
      kind: 'text',
      payload: JSON.stringify({
        message: 'scheduled text',
        selectedMessageGuid: 'reply-guid',
      }),
    });
    expect(
      raw
        .prepare(
          `SELECT guid, chat_id AS chatId, text, date_created AS dateCreated,
                  send_state AS sendState, thread_originator_guid AS threadOriginatorGuid
             FROM messages`,
        )
        .get(),
    ).toEqual({
      guid: 'temp-handoff',
      chatId,
      text: 'scheduled text',
      dateCreated: 2_000,
      sendState: 'sending',
      threadOriginatorGuid: 'reply-guid',
    });
    expect(
      raw.prepare('SELECT latest_message_date AS latest FROM chats WHERE id = ?').get(chatId),
    ).toEqual({ latest: 2_000 });
  });

  it('commits a recurring re-arm with the same outgoing handoff', async () => {
    const { db, raw, chatId, scheduledId } = await createFixture();
    raw.prepare('UPDATE scheduled_messages SET attempts = 3 WHERE id = ?').run(scheduledId);
    expect(await claimScheduled(db, scheduledId)).toBe(true);

    await handoverScheduledTextToOutgoing(db, {
      scheduledId,
      outgoing: outgoing(chatId),
      transition: { kind: 'rearm', nextScheduledFor: 50_000 },
    });

    expect(
      raw
        .prepare(
          'SELECT status, scheduled_for AS scheduledFor, attempts FROM scheduled_messages WHERE id = ?',
        )
        .get(scheduledId),
    ).toEqual({ status: 'pending', scheduledFor: 50_000, attempts: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM outgoing_queue').get()).toEqual({ count: 1 });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 1 });
  });

  it('throws a typed claim-lost error and writes no outgoing state when the row is not claimed', async () => {
    const { db, raw, chatId, scheduledId } = await createFixture();

    const handoff = handoverScheduledTextToOutgoing(db, {
      scheduledId,
      outgoing: outgoing(chatId),
      transition: { kind: 'sent' },
    });
    await expect(handoff).rejects.toBeInstanceOf(ScheduledOutgoingClaimLostError);
    await expect(handoff).rejects.toMatchObject({ scheduledId });

    expect((await getScheduledById(db, scheduledId))?.status).toBe('pending');
    expect(raw.prepare('SELECT COUNT(*) AS count FROM outgoing_queue').get()).toEqual({ count: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 });
    expect(
      raw.prepare('SELECT latest_message_date AS latest FROM chats WHERE id = ?').get(chatId),
    ).toEqual({ latest: 100 });
  });

  it('refuses a server-backed row even if another caller marked it sending', async () => {
    const { db, raw, chatId, scheduledId } = await createFixture({ serverId: 'server-owned' });
    expect(await claimScheduled(db, scheduledId)).toBe(true);

    await expect(
      handoverScheduledTextToOutgoing(db, {
        scheduledId,
        outgoing: outgoing(chatId),
        transition: { kind: 'sent' },
      }),
    ).rejects.toBeInstanceOf(ScheduledOutgoingClaimLostError);

    expect((await getScheduledById(db, scheduledId))?.status).toBe('sending');
    expect(raw.prepare('SELECT COUNT(*) AS count FROM outgoing_queue').get()).toEqual({ count: 0 });
  });

  it('rolls the scheduled transition back when the outgoing message insert fails', async () => {
    const { db, raw, scheduledId } = await createFixture();
    expect(await claimScheduled(db, scheduledId)).toBe(true);

    // Fail the second optimistic INSERT deterministically. Relying on a missing-chat foreign key
    // made this regression sensitive to connection PRAGMA state and test ordering.
    let inserts = 0;
    const failingDb: AppDatabase = Object.create(db);
    failingDb.insert = ((...args: Parameters<AppDatabase['insert']>) => {
      inserts += 1;
      if (inserts === 2) throw new Error('injected optimistic message insert failure');
      return db.insert(...args);
    }) as AppDatabase['insert'];

    await expect(
      handoverScheduledTextToOutgoing(failingDb, {
        scheduledId,
        // The queue INSERT runs first; the injected message failure must roll it and the earlier
        // scheduled UPDATE back together.
        outgoing: outgoing(1),
        transition: { kind: 'sent' },
      }),
    ).rejects.toThrow('injected optimistic message insert failure');

    expect(inserts).toBe(2);
    expect((await getScheduledById(db, scheduledId))?.status).toBe('sending');
    expect(raw.prepare('SELECT COUNT(*) AS count FROM outgoing_queue').get()).toEqual({ count: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 });
  });

  it('rolls every handoff write back when the account commit guard is revoked before commit', async () => {
    const { db, raw, chatId, scheduledId } = await createFixture();
    expect(await claimScheduled(db, scheduledId)).toBe(true);
    let checks = 0;

    await expect(
      handoverScheduledTextToOutgoing(
        db,
        {
          scheduledId,
          outgoing: outgoing(chatId),
          transition: { kind: 'sent' },
        },
        () => {
          checks += 1;
          return checks < 3;
        },
      ),
    ).rejects.toBeInstanceOf(DbCommitGuardRejectedError);

    expect(checks).toBe(3);
    expect((await getScheduledById(db, scheduledId))?.status).toBe('sending');
    expect(raw.prepare('SELECT COUNT(*) AS count FROM outgoing_queue').get()).toEqual({ count: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 });
    expect(
      raw.prepare('SELECT latest_message_date AS latest FROM chats WHERE id = ?').get(chatId),
    ).toEqual({ latest: 100 });
  });
});
