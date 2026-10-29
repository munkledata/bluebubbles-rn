import type Database from 'better-sqlite3';
import { ApiError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';
import { Chat, Message } from '@core/models';
import { logger } from '@core/secure';
import {
  listReactionsByMessageGuids,
  MessageTargetUnavailableError,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import { DbCommitGuardRejectedError } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import {
  sendIMessageReactionMessage,
  sendReactionMessage,
} from '@/services/send/sendReactionService';
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
    [Chat.parse({ guid: 'RCS;-;c1', participants: [{ address: 'a@x.com' }] })],
    hm,
  );
  const chatId = map.get('RCS;-;c1')!;
  await upsertMessages(
    db,
    [
      Message.parse({
        guid: 'rcs-mt',
        text: 'hi',
        dateCreated: 100,
        handle: { address: 'a@x.com' },
        messagePartTopology: {
          complete: true,
          originalPartIndexes: [0],
          currentParts: [{ index: 0, kind: 'text' }],
          attachmentOwnership: [],
        },
      }),
    ],
    () => chatId,
    hm,
  );
}

async function seedWholeMessageRcsTarget(db: AppDatabase) {
  const handles = await upsertHandles(db, [{ address: '+15550001111' }]);
  const chats = await upsertChats(
    db,
    [Chat.parse({ guid: 'RCS;-;thread-1', participants: [{ address: '+15550001111' }] })],
    handles,
  );
  await upsertMessages(
    db,
    [Message.parse({ guid: 'rcs-message-1', text: 'RCS body', dateCreated: 100 })],
    () => chats.get('RCS;-;thread-1')!,
    handles,
  );
}

async function seedExactIMessageTarget(db: AppDatabase) {
  const handles = await upsertHandles(db, [{ address: 'a@x.com' }]);
  const chats = await upsertChats(
    db,
    [Chat.parse({ guid: 'iMessage;-;c1', participants: [{ address: 'a@x.com' }] })],
    handles,
  );
  await upsertMessages(
    db,
    [
      Message.parse({
        guid: 'im-target',
        text: 'hi',
        dateCreated: 100,
        messagePartTopology: {
          complete: true,
          originalPartIndexes: [0],
          currentParts: [{ index: 0, kind: 'text' }],
          attachmentOwnership: [],
        },
      }),
    ],
    () => chats.get('iMessage;-;c1')!,
    handles,
  );
}

describe('sendIMessageReactionMessage', () => {
  it('sends one classic reaction without a retry row and requires a current capability', async () => {
    const { db, raw } = await createTestDb();
    await seedExactIMessageTarget(db);
    const post = jest.fn(async () => ({ guid: 'im-reaction' }));
    let allowed = false;
    const args = {
      chatGuid: 'iMessage;-;c1',
      targetGuid: 'im-target',
      reaction: 'like',
      partIndex: 0,
    };

    await expect(
      sendIMessageReactionMessage(
        db,
        fakeHttp(post),
        args,
        () => true,
        undefined,
        () => allowed,
      ),
    ).rejects.toThrow('unavailable');
    expect(post).not.toHaveBeenCalled();

    allowed = true;
    await expect(
      sendIMessageReactionMessage(
        db,
        fakeHttp(post),
        args,
        () => true,
        undefined,
        () => allowed,
      ),
    ).resolves.toEqual({ guid: 'im-reaction' });
    expect(post).toHaveBeenCalledWith({
      chatGuid: 'iMessage;-;c1',
      messageGuid: 'im-target',
      reactionType: 'like',
      partIndex: 0,
    });
    expect(one(raw, 'SELECT COUNT(*) AS count FROM outgoing_queue')).toEqual({ count: 0 });
    expect(one(raw, 'SELECT COUNT(*) AS count FROM messages')).toEqual({ count: 1 });
  });
});

describe('sendReactionMessage', () => {
  it('rejects an iMessage reaction before DB or HTTP even with a stale caller', async () => {
    const { db, raw } = await createTestDb();
    const post = jest.fn(async () => ({ guid: 'must-not-send' }));

    await expect(
      sendReactionMessage(db, fakeHttp(post), {
        chatGuid: 'iMessage;-;retired',
        targetGuid: 'apple-target',
        reaction: 'love',
        partIndex: 0,
      }),
    ).rejects.toThrow('iMessage reactions were retired');

    expect(post).not.toHaveBeenCalled();
    expect(one(raw, 'SELECT COUNT(*) AS count FROM messages')).toEqual({ count: 0 });
    expect(one(raw, 'SELECT COUNT(*) AS count FROM outgoing_queue')).toEqual({ count: 0 });
  });

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
        chatGuid: 'RCS;-;c1',
        targetGuid: 'rcs-mt',
        reaction: 'love',
        partIndex: 0,
        selectedMessageText: 'hi',
      },
    );

    // Server contract: { chatGuid, messageGuid, reactionType } (F-2).
    expect(body).toMatchObject({ messageGuid: 'rcs-mt', reactionType: 'love', partIndex: 0 });
    const row = one(
      raw,
      "SELECT guid, send_state s, associated_message_type t, associated_message_part p FROM messages WHERE associated_message_guid='rcs-mt'",
    );
    expect(row.guid).toBe('real-react'); // promoted
    expect(row.s).toBe('sent');
    expect(row.t).toBe('love');
    expect(row.p).toBe(0);
    expect((one(raw, 'SELECT COUNT(*) c FROM outgoing_queue') as { c: number }).c).toBe(0);
    expect(
      (await listReactionsByMessageGuids(db, 'RCS;-;c1', ['rcs-mt'])).get('rcs-mt'),
    ).toHaveLength(1);
  });

  it("keeps the reaction when the RCS reply names the TARGET message's id (R4)", async () => {
    // The server's RCS reaction reply carries the reacted-to message's id, not a new one. Treating
    // that as the reaction's own id made reconcile see a "duplicate", delete the pending reaction
    // and copy its send-tracking fields onto the target message.
    const { db, raw } = await createTestDb();
    await seed(db);
    await sendReactionMessage(
      db,
      fakeHttp(async () => ({ guid: 'rcs-mt' })),
      {
        chatGuid: 'RCS;-;c1',
        targetGuid: 'rcs-mt',
        reaction: 'love',
        partIndex: 0,
        selectedMessageText: 'hi',
      },
    );

    const reaction = one(
      raw,
      "SELECT guid, send_state s, associated_message_type t FROM messages WHERE associated_message_guid='rcs-mt'",
    );
    expect(reaction).toBeDefined();
    expect(reaction.guid).not.toBe('rcs-mt');
    expect(reaction.s).toBe('sent');
    expect(reaction.t).toBe('love');
    const target = one(
      raw,
      "SELECT text, associated_message_guid a, active_send_attempt_guid g FROM messages WHERE guid='rcs-mt'",
    );
    expect(target).toMatchObject({ text: 'hi', a: null, g: null });
    expect((one(raw, 'SELECT COUNT(*) c FROM messages') as { c: number }).c).toBe(2);
    expect((one(raw, 'SELECT COUNT(*) c FROM outgoing_queue') as { c: number }).c).toBe(0);
    expect(
      (await listReactionsByMessageGuids(db, 'RCS;-;c1', ['rcs-mt'])).get('rcs-mt'),
    ).toHaveLength(1);
  });

  it('targets a confirmed RCS message as whole-message part zero without Apple topology', async () => {
    const { db, raw } = await createTestDb();
    await seedWholeMessageRcsTarget(db);
    let body: Record<string, unknown> | undefined;

    await sendReactionMessage(
      db,
      fakeHttp(async (json) => {
        body = json as Record<string, unknown>;
        return { guid: 'real-rcs-reaction', dateCreated: 1_000 };
      }),
      {
        chatGuid: 'RCS;-;thread-1',
        targetGuid: 'rcs-message-1',
        reaction: 'love',
        partIndex: 0,
      },
    );

    expect(body).toMatchObject({
      messageGuid: 'rcs-message-1',
      reactionType: 'love',
      partIndex: 0,
    });
    expect(
      one(
        raw,
        "SELECT associated_message_guid g, associated_message_part p FROM messages WHERE guid='real-rcs-reaction'",
      ),
    ).toMatchObject({ g: 'rcs-message-1', p: 0 });

    await expect(
      sendReactionMessage(
        db,
        fakeHttp(async () => {
          throw new Error('an invalid RCS part must not reach HTTP');
        }),
        {
          chatGuid: 'RCS;-;thread-1',
          targetGuid: 'rcs-message-1',
          reaction: 'like',
          partIndex: 1,
        },
      ),
    ).rejects.toBeInstanceOf(MessageTargetUnavailableError);
  });

  it('rolls back a mid-insert account change before HTTP and lets a fresh lease send', async () => {
    const { db, raw } = await createTestDb();
    await seed(db);
    const initialChatDate = one(
      raw,
      "SELECT latest_message_date d FROM chats WHERE guid='RCS;-;c1'",
    ).d;
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
      WHEN NEW.associated_message_guid = 'rcs-mt' AND NEW.associated_message_type = 'emoji'
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
            chatGuid: 'RCS;-;c1',
            targetGuid: 'rcs-mt',
            reaction: 'emoji',
            emoji: '🫡',
            partIndex: 0,
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
      expect(
        one(raw, "SELECT COUNT(*) c FROM messages WHERE associated_message_guid='rcs-mt'").c,
      ).toBe(0);
      expect(one(raw, "SELECT COUNT(*) c FROM messages WHERE guid='rcs-mt'").c).toBe(1);
      expect(one(raw, "SELECT latest_message_date d FROM chats WHERE guid='RCS;-;c1'").d).toBe(
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
                    WHERE m.associated_message_guid = 'rcs-mt'`,
                )
                .get() as typeof localState;
              return { guid: 'real-reaction-after-retirement', dateCreated: 2_000 };
            }),
            {
              chatGuid: 'RCS;-;c1',
              targetGuid: 'rcs-mt',
              reaction: 'emoji',
              emoji: '🫡',
              partIndex: 0,
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
        selectedMessageGuid: 'rcs-mt',
        reaction: 'emoji',
        emoji: '🫡',
        partIndex: 0,
      });
      expect(localState?.payload).not.toContain('private quoted body');
      expect(requestBody).toMatchObject({
        messageGuid: 'rcs-mt',
        reactionType: 'emoji',
        reactionEmoji: '🫡',
      });
      expect(requestBody).not.toHaveProperty('tempGuid');
      expect(one(raw, 'SELECT COUNT(*) c FROM outgoing_queue').c).toBe(0);
      expect(one(raw, "SELECT COUNT(*) c FROM messages WHERE guid='rcs-mt'").c).toBe(1);
      expect(
        one(raw, "SELECT COUNT(*) c FROM messages WHERE guid='real-reaction-after-retirement'").c,
      ).toBe(1);
      expect(one(raw, "SELECT latest_message_date d FROM chats WHERE guid='RCS;-;c1'").d).toBe(
        initialChatDate,
      );
    } finally {
      raw.exec('DROP TRIGGER IF EXISTS pause_reaction_during_message_insert');
      if (drain) await drain;
      resumeRealtimeDeliveries();
    }
  });

  it('does not reinterpret a revoked success settlement as a transport failure', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { db, raw } = await createTestDb();
    await seed(db);
    resumeRealtimeDeliveries();
    const lease = captureRealtimeDeliveryLease();
    let drain: Promise<void> | undefined;

    try {
      const oldSend = runTrackedRealtimeWork(lease, (activeLease) =>
        sendReactionMessage(
          db,
          fakeHttp(async () => {
            drain = pauseRealtimeDeliveries();
            return { guid: 'late-reaction', dateCreated: 1_000 };
          }),
          { chatGuid: 'RCS;-;c1', targetGuid: 'rcs-mt', reaction: 'love', partIndex: 0 },
          1_000,
          () => activeLease.isCurrent(),
        ),
      );

      await expect(oldSend).rejects.toBeInstanceOf(DbCommitGuardRejectedError);
      if (!drain) throw new Error('reaction acknowledgement did not retire the account lease');
      await drain;

      expect(warn).not.toHaveBeenCalled();
      expect(
        one(raw, "SELECT send_state s FROM messages WHERE associated_message_guid='rcs-mt'"),
      ).toEqual({ s: 'sending' });
      expect(one(raw, 'SELECT COUNT(*) c FROM outgoing_queue').c).toBe(1);
    } finally {
      if (drain) await drain;
      resumeRealtimeDeliveries();
      warn.mockRestore();
    }
  });

  it('toggles off when the same type is sent then removed', async () => {
    const { db } = await createTestDb();
    await seed(db);
    const ok = fakeHttp(async () => ({ guid: `r${Math.random()}`, dateCreated: 1 }));
    await sendReactionMessage(
      db,
      ok,
      { chatGuid: 'RCS;-;c1', targetGuid: 'rcs-mt', reaction: 'love', partIndex: 0 },
      1000,
    );
    await sendReactionMessage(
      db,
      ok,
      { chatGuid: 'RCS;-;c1', targetGuid: 'rcs-mt', reaction: '-love', partIndex: 0 },
      2000,
    );
    expect(
      (await listReactionsByMessageGuids(db, 'RCS;-;c1', ['rcs-mt'])).get('rcs-mt') ?? [],
    ).toHaveLength(0);
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
      { chatGuid: 'RCS;-;c1', targetGuid: 'rcs-mt', reaction: 'like', partIndex: 0 },
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
      '[send-reaction] failed for chat RCS;-;c1 (code 500, HTTP 500): boom',
    );
    warn.mockRestore();
  });

  it('does not reorder the inbox (latest_message_date unchanged)', async () => {
    const { db, raw } = await createTestDb();
    await seed(db);
    const before = (
      one(raw, "SELECT latest_message_date d FROM chats WHERE guid='RCS;-;c1'") as {
        d: number | null;
      }
    ).d;
    await sendReactionMessage(
      db,
      fakeHttp(async () => ({ guid: 'r', dateCreated: 9999 })),
      { chatGuid: 'RCS;-;c1', targetGuid: 'rcs-mt', reaction: 'love', partIndex: 0 },
    );
    const after = (
      one(raw, "SELECT latest_message_date d FROM chats WHERE guid='RCS;-;c1'") as {
        d: number | null;
      }
    ).d;
    expect(after).toBe(before);
  });
});
