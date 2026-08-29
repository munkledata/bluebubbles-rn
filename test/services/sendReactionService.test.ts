import type Database from 'better-sqlite3';
import { ApiError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';
import { Chat } from '@core/models';
import { logger } from '@core/secure';
import {
  listReactionsByMessageGuids,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import { DbCommitGuardRejectedError } from '@db/transaction';
import { Message } from '@core/models';
import type { AppDatabase } from '@db/types';
import { sendReactionMessage } from '@/services/send/sendReactionService';
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
  runTrackedRealtimeWork,
} from '@/services/realtime/deliveryCoordinator';
import { createTestDb } from '../support/testDb';

function fakeHttp(impl: (json?: unknown) => Promise<unknown>): HttpClient {
  return {
    post: (_p: string, _s: unknown, opts?: { json?: unknown }) => impl(opts?.json),
  } as unknown as HttpClient;
}
const one = (raw: Database.Database, sql: string) =>
  raw.prepare(sql).get() as Record<string, unknown>;

async function seed(db: AppDatabase) {
  const hm = await upsertHandles(db, [{ address: 'a@x.com' }]);
  const map = await upsertChats(
    db,
    [Chat.parse({ guid: 'c1', participants: [{ address: 'a@x.com' }] })],
    hm,
  );
  const chatId = map.get('c1')!;
  await upsertMessages(
    db,
    [Message.parse({ guid: 'mt', text: 'hi', dateCreated: 100, handle: { address: 'a@x.com' } })],
    () => chatId,
    hm,
  );
}

describe('sendReactionMessage', () => {
  it('optimistically inserts a reaction + reconciles, posting the right body', async () => {
    const { db, raw } = await createTestDb();
    await seed(db);
    let body: Record<string, unknown> | undefined;
    await sendReactionMessage(
      db,
      fakeHttp(async (json) => {
        body = json as Record<string, unknown>;
        return { guid: 'real-react', dateCreated: 1000 };
      }),
      {
        chatGuid: 'c1',
        targetGuid: 'mt',
        reaction: 'love',
        partIndex: 2,
        selectedMessageText: 'hi',
      },
    );

    // Server contract: { chatGuid, messageGuid, reactionType } (F-2).
    expect(body).toMatchObject({ messageGuid: 'mt', reactionType: 'love', partIndex: 2 });
    const row = one(
      raw,
      "SELECT guid, send_state s, associated_message_type t, associated_message_part p FROM messages WHERE associated_message_guid='mt'",
    );
    expect(row.guid).toBe('real-react'); // promoted
    expect(row.s).toBe('sent');
    expect(row.t).toBe('love');
    expect(row.p).toBe(2);
    expect((one(raw, 'SELECT COUNT(*) c FROM outgoing_queue') as { c: number }).c).toBe(0);
    expect((await listReactionsByMessageGuids(db, ['mt'])).get('mt')).toHaveLength(1);
  });

  it('rolls back a mid-insert account change before HTTP and lets a fresh lease send', async () => {
    const { db, raw } = await createTestDb();
    await seed(db);
    const initialChatDate = one(raw, "SELECT latest_message_date d FROM chats WHERE guid='c1'").d;
    let drain: Promise<void> | undefined;
    let triggerRan = false;
    raw.function('pause_reaction_during_message_insert', () => {
      triggerRan = true;
      drain = pauseRealtimeDeliveries();
      return 0;
    });
    raw.exec(`
      CREATE TRIGGER pause_reaction_during_message_insert
      AFTER INSERT ON messages
      WHEN NEW.associated_message_guid = 'mt' AND NEW.associated_message_type = 'emoji'
      BEGIN
        SELECT pause_reaction_during_message_insert();
      END
    `);

    let posts = 0;
    const oldLease = captureRealtimeDeliveryLease();
    try {
      const oldSend = runTrackedRealtimeWork(oldLease, (lease) =>
        sendReactionMessage(
          db,
          fakeHttp(async () => {
            posts += 1;
            return { guid: 'must-not-send' };
          }),
          {
            chatGuid: 'c1',
            targetGuid: 'mt',
            reaction: 'emoji',
            emoji: '🫡',
            selectedMessageText: 'private quoted body',
          },
          1_000,
          () => lease.isCurrent(),
        ),
      );

      await expect(oldSend).rejects.toBeInstanceOf(DbCommitGuardRejectedError);
      if (!drain) throw new Error('reaction insert did not retire the account lease');
      await drain;

      expect(triggerRan).toBe(true);
      expect(posts).toBe(0);
      expect(raw.inTransaction).toBe(false);
      expect(one(raw, 'SELECT COUNT(*) c FROM outgoing_queue').c).toBe(0);
      expect(one(raw, "SELECT COUNT(*) c FROM messages WHERE associated_message_guid='mt'").c).toBe(
        0,
      );
      expect(one(raw, "SELECT COUNT(*) c FROM messages WHERE guid='mt'").c).toBe(1);
      expect(one(raw, "SELECT latest_message_date d FROM chats WHERE guid='c1'").d).toBe(
        initialChatDate,
      );

      raw.exec('DROP TRIGGER pause_reaction_during_message_insert');
      resumeRealtimeDeliveries();
      const freshLease = captureRealtimeDeliveryLease();
      let result: { tempGuid: string } | undefined;
      let postRanInsideTransaction = true;
      let localState:
        { messageGuid: string; queueGuid: string; kind: string; payload: string } | undefined;
      let requestBody: Record<string, unknown> | undefined;
      await expect(
        runTrackedRealtimeWork(freshLease, async (lease) => {
          result = await sendReactionMessage(
            db,
            fakeHttp(async (json) => {
              postRanInsideTransaction = raw.inTransaction;
              requestBody = json as Record<string, unknown>;
              localState = raw
                .prepare(
                  `SELECT m.guid AS messageGuid, q.temp_guid AS queueGuid, q.kind, q.payload
                     FROM messages m
                     JOIN outgoing_queue q ON q.temp_guid = m.guid
                    WHERE m.associated_message_guid = 'mt'`,
                )
                .get() as typeof localState;
              return { guid: 'real-reaction-after-retirement', dateCreated: 2_000 };
            }),
            {
              chatGuid: 'c1',
              targetGuid: 'mt',
              reaction: 'emoji',
              emoji: '🫡',
              selectedMessageText: 'private quoted body',
            },
            2_000,
            () => lease.isCurrent(),
          );
        }),
      ).resolves.toBe('delivered');

      expect(postRanInsideTransaction).toBe(false);
      expect(localState).toMatchObject({
        messageGuid: result?.tempGuid,
        queueGuid: result?.tempGuid,
        kind: 'reaction',
      });
      expect(JSON.parse(localState?.payload ?? '{}')).toEqual({
        selectedMessageGuid: 'mt',
        reaction: 'emoji',
        emoji: '🫡',
      });
      expect(localState?.payload).not.toContain('private quoted body');
      expect(requestBody).toMatchObject({
        messageGuid: 'mt',
        reactionType: 'emoji',
        reactionEmoji: '🫡',
      });
      expect(requestBody).not.toHaveProperty('tempGuid');
      expect(one(raw, 'SELECT COUNT(*) c FROM outgoing_queue').c).toBe(0);
      expect(one(raw, "SELECT COUNT(*) c FROM messages WHERE guid='mt'").c).toBe(1);
      expect(
        one(raw, "SELECT COUNT(*) c FROM messages WHERE guid='real-reaction-after-retirement'").c,
      ).toBe(1);
      expect(one(raw, "SELECT latest_message_date d FROM chats WHERE guid='c1'").d).toBe(
        initialChatDate,
      );
    } finally {
      raw.exec('DROP TRIGGER IF EXISTS pause_reaction_during_message_insert');
      if (drain) await drain;
      resumeRealtimeDeliveries();
    }
  });

  it('toggles off when the same type is sent then removed', async () => {
    const { db } = await createTestDb();
    await seed(db);
    const ok = fakeHttp(async () => ({ guid: `r${Math.random()}`, dateCreated: 1 }));
    await sendReactionMessage(db, ok, { chatGuid: 'c1', targetGuid: 'mt', reaction: 'love' }, 1000);
    await sendReactionMessage(
      db,
      ok,
      { chatGuid: 'c1', targetGuid: 'mt', reaction: '-love' },
      2000,
    );
    expect((await listReactionsByMessageGuids(db, ['mt'])).get('mt') ?? []).toHaveLength(0);
  });

  it('marks the reaction errored on failure', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { db, raw } = await createTestDb();
    await seed(db);
    await sendReactionMessage(
      db,
      fakeHttp(async () => {
        throw new ApiError('server_error', 'boom', 500);
      }),
      { chatGuid: 'c1', targetGuid: 'mt', reaction: 'like' },
    );
    expect(
      (
        one(
          raw,
          'SELECT send_state s, error e FROM messages WHERE associated_message_type IS NOT NULL',
        ) as { s: string; e: number }
      ).s,
    ).toBe('error');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[send-reaction] failed for chat c1 (code 500, HTTP 500): boom',
    );
    warn.mockRestore();
  });

  it('does not reorder the inbox (latest_message_date unchanged)', async () => {
    const { db, raw } = await createTestDb();
    await seed(db);
    const before = (
      one(raw, "SELECT latest_message_date d FROM chats WHERE guid='c1'") as { d: number | null }
    ).d;
    await sendReactionMessage(
      db,
      fakeHttp(async () => ({ guid: 'r', dateCreated: 9999 })),
      { chatGuid: 'c1', targetGuid: 'mt', reaction: 'love' },
    );
    const after = (
      one(raw, "SELECT latest_message_date d FROM chats WHERE guid='c1'") as { d: number | null }
    ).d;
    expect(after).toBe(before);
  });
});
