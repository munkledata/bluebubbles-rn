import { Chat, Message } from '@core/models';
import { EventRouter, type EventDeliveryContext } from '@core/realtime';
import { logger } from '@core/secure';
import {
  getChatIdByGuid,
  insertOutgoingAttachment,
  listChats,
  listMessages,
  listMessagesWithSenders,
  upsertChats,
  upsertContacts,
  upsertHandles,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import {
  DbEventSink,
  RealtimeGroupMutationUnavailableError,
  RealtimeMessageChatUnavailableError,
  RealtimeReadStatusUnavailableError,
} from '@/services/realtime/dbEventSink';
import { buildMessageIntents } from '@/services/notifications/intents';
import { createTestDb } from '../support/testDb';

/** Current at sink entry + transaction admission, revoked immediately before commit. */
function revokedBeforeCommit(): EventDeliveryContext {
  let checks = 0;
  return {
    generation: 1,
    isCurrent: () => {
      checks += 1;
      return checks < 3;
    },
  };
}

/** Current through the sink callback, revoked by the transaction helper's final commit guard. */
function revokedAtCommitHandoff(): EventDeliveryContext {
  let checks = 0;
  return {
    generation: 1,
    isCurrent: () => {
      checks += 1;
      return checks < 6;
    },
  };
}

describe('DbEventSink (live path)', () => {
  it('does not hold a realtime delivery open for a long post-commit attachment hook', async () => {
    const { db } = await createTestDb();
    let release!: () => void;
    const autoDownload = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onMessageStored = jest.fn(() => autoDownload);
    const sink = new DbEventSink(db, onMessageStored);
    const message = Message.parse({
      guid: 'tracked-download',
      text: 'image follows',
      dateCreated: 1,
      handle: { address: 'a@b.com' },
      chats: [{ guid: 'cDownload', participants: [{ address: 'a@b.com' }] }],
    });
    const handled = sink.onEvent({ type: 'new-message', message }, 'fcm');
    for (let i = 0; i < 20 && onMessageStored.mock.calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(onMessageStored).toHaveBeenCalledWith(expect.any(Number));
    await expect(handled).resolves.toBeUndefined();

    release();
    await autoDownload;
  });

  it('persists a new-message event (with embedded chat) into the DB', async () => {
    const { db } = await createTestDb();
    const router = new EventRouter(new DbEventSink(db));

    const payload = Message.parse({
      guid: 'live1',
      text: 'incoming!',
      dateCreated: 1700000000000,
      originalROWID: 7,
      handle: { address: 'bob@x.com' },
      chats: [{ guid: 'cLive', displayName: 'Bob', participants: [{ address: 'bob@x.com' }] }],
    });

    // Simulate an event arriving over the socket as a JSON string (FCM-style).
    await router.handle('new-message', JSON.stringify(payload), 'socket');

    const chats = (await listChats(db)) as Array<{ id: number; guid: string }>;
    const chat = chats.find((c) => c.guid === 'cLive');
    expect(chat).toBeDefined();
    const msgs = (await listMessages(db, chat!.id)) as Array<{ guid: string; text: string }>;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toBe('incoming!');
  });

  it('links a new realtime handle to device contacts only after the event transaction commits', async () => {
    const { db, raw } = await createTestDb();
    await upsertContacts(db, [
      {
        sourceId: 'contact-live',
        displayName: 'Device Alice',
        givenName: 'Device',
        familyName: 'Alice',
        phones: [],
        emails: ['alice-live@example.com'],
        avatar: null,
      },
    ]);
    const sink = new DbEventSink(db);

    await sink.onEvent(
      {
        type: 'new-message',
        message: Message.parse({
          guid: 'contact-linked-live',
          text: 'hello',
          dateCreated: 10,
          handle: { address: 'alice-live@example.com', displayName: 'Server Alice' },
          chats: [
            { guid: 'contact-linked-chat', participants: [{ address: 'alice-live@example.com' }] },
          ],
        }),
      },
      'socket',
    );

    expect(
      raw
        .prepare(
          `SELECT h.display_name AS displayName, c.source_id AS sourceId
             FROM handles h
             JOIN contacts c ON c.id = h.contact_id
            WHERE h.address = 'alice-live@example.com'`,
        )
        .get(),
    ).toEqual({ displayName: 'Device Alice', sourceId: 'contact-live' });
  });

  it('marks a message errored on a server message-send-error event', async () => {
    const { db } = await createTestDb();
    const router = new EventRouter(new DbEventSink(db));
    // Seed a message, then fire the server-pushed send failure referencing its guid.
    await router.handle(
      'new-message',
      JSON.stringify(
        Message.parse({
          guid: 'send-fail-1',
          text: 'hi',
          dateCreated: 1700000000000,
          handle: { address: 'a@b.com' },
          chats: [{ guid: 'cErr', participants: [{ address: 'a@b.com' }] }],
        }),
      ),
      'socket',
    );
    await router.handle(
      'message-send-error',
      JSON.stringify({
        guid: 'send-fail-1',
        tempGuid: 'temp-no-local-row',
        error: 22,
        errorMessage: 'Helper rejected person@example.com on https://private.example.',
      }),
      'socket',
    );
    // A second fanout without prose must preserve the useful first detail.
    await router.handle(
      'message-send-error',
      JSON.stringify({ guid: 'send-fail-1', tempGuid: 'temp-no-local-row', error: 22 }),
      'fcm',
    );
    // Oversized decorative prose is omitted without erasing the already-projected detail.
    await router.handle(
      'message-send-error',
      JSON.stringify({
        guid: 'send-fail-1',
        error: 22,
        errorMessage: `oversized-canary-${'x'.repeat(5_000)}`,
      }),
      'socket',
    );

    const chats = (await listChats(db)) as Array<{ id: number; guid: string }>;
    const chat = chats.find((c) => c.guid === 'cErr')!;
    const msgs = (await listMessages(db, chat.id)) as Array<{
      guid: string;
      error: number;
      errorMessage: string | null;
      sendState: string;
    }>;
    const m = msgs.find((x) => x.guid === 'send-fail-1')!;
    expect(m.error).toBe(22);
    expect(m.errorMessage).toBe('Helper rejected [redacted] on [redacted URL]');
    expect(m.sendState).toBe('error');
  });

  it('a message-send-error with retryable:true re-arms the outgoing queue for a post-ack failure', async () => {
    // The RCS immediate-ack path: the ack consumed the queue row and marked the bubble sent;
    // the async send-phase failure (retryable:true) must re-enqueue the ladder — the wire flag
    // flows raw through the eventRouter payload into applyServerSendError.
    const { db, raw } = await createTestDb();
    const router = new EventRouter(new DbEventSink(db));
    const handles = await upsertHandles(db, [{ address: 'rcs@x.com' }]);
    await upsertChats(
      db,
      [Chat.parse({ guid: 'RCS;-;conv-1', participants: [{ address: 'rcs@x.com' }] })],
      handles,
    );
    const chatId = await getChatIdByGuid(db, 'RCS;-;conv-1');
    await insertOutgoingAttachment(db, {
      tempGuid: 'temp-sink-pic',
      attachmentGuid: 'temp-sink-pic-att',
      chatId: chatId!,
      chatGuid: 'RCS;-;conv-1',
      localPath: 'file:///sink.jpg',
      mimeType: 'image/jpeg',
      transferName: 'sink.jpg',
      totalBytes: 5,
      now: 1000,
    });
    raw.prepare("UPDATE messages SET send_state='sent' WHERE guid='temp-sink-pic'").run();
    raw.prepare("DELETE FROM outgoing_queue WHERE temp_guid='temp-sink-pic'").run();

    await router.handle(
      'message-send-error',
      JSON.stringify({
        guid: 'server-real-sink-pic',
        tempGuid: 'temp-sink-pic',
        error: 502,
        retryable: true,
      }),
      'socket',
    );
    // The real server fans the same failure over socket + FCM. Without a shared attempt id the DB
    // transition itself must be idempotent so the second copy cannot consume another retry rung.
    await router.handle(
      'message-send-error',
      JSON.stringify({
        guid: 'server-real-sink-pic',
        tempGuid: 'temp-sink-pic',
        error: 502,
        retryable: true,
      }),
      'fcm',
    );

    const q = raw
      .prepare("SELECT kind, attempts FROM outgoing_queue WHERE temp_guid='temp-sink-pic'")
      .get() as { kind: string; attempts: number } | undefined;
    expect(q).toEqual({ kind: 'attachment', attempts: 1 });
    const state = raw
      .prepare("SELECT send_state s FROM messages WHERE guid='temp-sink-pic'")
      .get() as { s: string };
    expect(state.s).toBe('error');
  });

  it('does not spend a retry cycle when the durable checkpoint rolls back', async () => {
    const { db, raw } = await createTestDb();
    const handles = await upsertHandles(db, [{ address: 'checkpoint-rcs@x.com' }]);
    await upsertChats(
      db,
      [
        Chat.parse({
          guid: 'RCS;-;checkpoint-conv',
          participants: [{ address: 'checkpoint-rcs@x.com' }],
        }),
      ],
      handles,
    );
    const chatId = await getChatIdByGuid(db, 'RCS;-;checkpoint-conv');
    await insertOutgoingAttachment(db, {
      tempGuid: 'temp-checkpoint-requeue',
      attachmentGuid: 'temp-checkpoint-requeue-att',
      chatId: chatId!,
      chatGuid: 'RCS;-;checkpoint-conv',
      localPath: 'file:///checkpoint.jpg',
      mimeType: 'image/jpeg',
      transferName: 'checkpoint.jpg',
      totalBytes: 5,
      now: 1000,
    });
    raw.prepare("UPDATE messages SET send_state='sent' WHERE guid='temp-checkpoint-requeue'").run();
    raw.prepare("DELETE FROM outgoing_queue WHERE temp_guid='temp-checkpoint-requeue'").run();

    let checkpointAttempts = 0;
    const checkpoint = jest.fn(async () => {
      checkpointAttempts += 1;
      if (checkpointAttempts <= 2) throw new Error('checkpoint retry');
    });
    const context: EventDeliveryContext = {
      generation: 9_876,
      isCurrent: () => true,
      durableEvent: { dbAppliedAt: null, markDbAppliedWithinTransaction: checkpoint },
    };
    const event = {
      type: 'message-send-error' as const,
      payload: { tempGuid: 'temp-checkpoint-requeue', error: 502, retryable: true },
    };
    const sink = new DbEventSink(db);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const error = await sink.onEvent(event, 'fcm', context).then(
        () => null,
        (reason: unknown) => reason,
      );
      expect(String(error)).toContain('checkpoint retry');
      expect(
        raw
          .prepare("SELECT id FROM outgoing_queue WHERE temp_guid='temp-checkpoint-requeue'")
          .get(),
      ).toBeUndefined();
    }

    await expect(sink.onEvent(event, 'fcm', context)).resolves.toBeUndefined();
    expect(checkpoint).toHaveBeenCalledTimes(3);
    expect(
      raw
        .prepare("SELECT attempts FROM outgoing_queue WHERE temp_guid='temp-checkpoint-requeue'")
        .get(),
    ).toEqual({ attempts: 1 });
  });

  it('ignores events it does not handle yet (no throw)', async () => {
    const { db } = await createTestDb();
    const router = new EventRouter(new DbEventSink(db));
    await expect(
      router.handle('typing-indicator', { chatGuid: 'c', display: true }, 'socket'),
    ).resolves.toBeDefined();
  });

  it('F-1: a BARE chats-less message (top-level chatGuid only) lands a row + builds an intent', async () => {
    const { db } = await createTestDb();
    // The chat already exists locally (from a prior sync) but the live event did NOT embed it —
    // it carries only the top-level chatGuid fallback. Without the fallback this row would be
    // silently dropped (no resolvable chat) and produce no notification.
    const hm = await upsertHandles(db, [{ address: 'bob@x.com' }]);
    await upsertChats(
      db,
      [Chat.parse({ guid: 'cBare', displayName: 'Bob', participants: [{ address: 'bob@x.com' }] })],
      hm,
    );
    const router = new EventRouter(new DbEventSink(db));

    const bare = {
      guid: 'live-bare',
      text: 'no chats[] here',
      dateCreated: 1700000001000,
      handle: { address: 'bob@x.com' },
      chatGuid: 'cBare', // top-level fallback (no `chats` array)
    };
    const normalized = await router.handle('new-message', JSON.stringify(bare), 'fcm');
    expect(normalized?.type).toBe('new-message');

    const chats = (await listChats(db)) as Array<{ id: number; guid: string }>;
    const chat = chats.find((c) => c.guid === 'cBare')!;
    const msgs = (await listMessages(db, chat.id)) as Array<{ guid: string; text: string }>;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toBe('no chats[] here');

    // …and the notification intent builds off the same fallback chatGuid.
    const intents = await buildMessageIntents(db, normalized!);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      kind: 'message',
      chatGuid: 'cBare',
      body: 'no chats[] here',
    });
  });

  it('F-1: a message with NEITHER chats[] nor chatGuid is skipped (not crashed, no row)', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { db } = await createTestDb();
    const router = new EventRouter(new DbEventSink(db));
    const orphan = { guid: 'orphan', text: 'hi', dateCreated: 1 };
    await expect(router.handle('new-message', orphan, 'socket')).resolves.toBeDefined();
    // No chat → no message row anywhere.
    const chats = (await listChats(db)) as Array<{ id: number }>;
    for (const c of chats) {
      expect(await listMessages(db, c.id)).toHaveLength(0);
    }
    expect(warn).toHaveBeenCalledWith(
      '[dbEventSink] message event has no chat reference — skipped',
      expect.objectContaining({ type: 'new-message' }),
    );
  });

  it("refreshes rich text through the server's chats-less updated-message path", async () => {
    const { db, raw } = await createTestDb();
    try {
      const router = new EventRouter(new DbEventSink(db));
      const oldBody = [{ string: 'old realtime body', runs: [] }];
      const newBody = [{ string: 'new realtime body', runs: [] }];
      await router.handle(
        'new-message',
        {
          guid: 'lean-update-1',
          text: '',
          attributedBody: oldBody,
          dateCreated: 100,
          dateEdited: 100,
          handle: { address: 'lean@x.com' },
          chats: [{ guid: 'cLean', participants: [{ address: 'lean@x.com' }] }],
        },
        'socket',
      );

      // No chats[] or chatGuid: production updated-message must recover the existing row's owner.
      await router.handle(
        'updated-message',
        {
          guid: 'lean-update-1',
          text: '',
          attributedBody: newBody,
          dateCreated: 100,
          dateEdited: 200,
        },
        'socket',
      );
      await router.handle(
        'updated-message',
        {
          guid: 'lean-update-1',
          text: 'new realtime body',
          attributedBody: null,
          dateCreated: 100,
          dateEdited: 200,
          dateDelivered: 300,
        },
        'fcm',
      );

      expect(
        raw
          .prepare(
            `SELECT text, attributed_body AS attributedBody,
                    date_edited AS dateEdited, date_delivered AS dateDelivered
               FROM messages WHERE guid = ?`,
          )
          .get('lean-update-1'),
      ).toEqual({
        text: 'new realtime body',
        attributedBody: JSON.stringify(newBody),
        dateEdited: 200,
        dateDelivered: 300,
      });
    } finally {
      raw.close();
    }
  });

  it('keeps a durable message retryable when its chat is unavailable', async () => {
    const { db, raw } = await createTestDb();
    const requestRecovery = jest.fn(async () => undefined);
    const markDbAppliedWithinTransaction = jest.fn(async () => undefined);
    const context: EventDeliveryContext = {
      generation: 1,
      isCurrent: () => true,
      durableEvent: { dbAppliedAt: null, markDbAppliedWithinTransaction },
    };
    const sink = new DbEventSink(db, undefined, undefined, requestRecovery);
    const message = Message.parse({
      guid: 'durable-missing-chat',
      text: 'wait for sync',
      dateCreated: 300,
      chatGuid: 'cNotHydrated',
      handle: { address: 'missing@x.com' },
    });

    await expect(sink.onEvent({ type: 'new-message', message }, 'fcm', context)).rejects.toEqual(
      expect.objectContaining<Partial<RealtimeMessageChatUnavailableError>>({
        name: 'RealtimeMessageChatUnavailableError',
        messageGuid: 'durable-missing-chat',
        chatGuid: 'cNotHydrated',
      }),
    );
    expect(requestRecovery).toHaveBeenCalledWith('cNotHydrated', context);
    expect(markDbAppliedWithinTransaction).not.toHaveBeenCalled();
    expect(
      (
        raw
          .prepare('SELECT COUNT(*) AS count FROM messages WHERE guid = ?')
          .get('durable-missing-chat') as { count: number }
      ).count,
    ).toBe(0);
  });

  it('keeps a durable read retryable and requests account recovery when its chat is absent', async () => {
    const { db } = await createTestDb();
    const requestRecovery = jest.fn(async () => undefined);
    const markDbAppliedWithinTransaction = jest.fn(async () => undefined);
    const context: EventDeliveryContext = {
      generation: 1,
      isCurrent: () => true,
      durableEvent: { dbAppliedAt: null, markDbAppliedWithinTransaction },
    };
    const sink = new DbEventSink(db, undefined, undefined, requestRecovery);
    const event = {
      type: 'chat-read-status-changed' as const,
      payload: { chatGuid: 'cReadNotHydrated', read: true as const },
    };

    await expect(sink.onEvent(event, 'fcm', context)).rejects.toEqual(
      expect.objectContaining<Partial<RealtimeReadStatusUnavailableError>>({
        name: 'RealtimeReadStatusUnavailableError',
        chatGuid: 'cReadNotHydrated',
        reason: 'chat-unavailable',
      }),
    );
    expect(requestRecovery).toHaveBeenCalledWith(null, context);
    expect(markDbAppliedWithinTransaction).not.toHaveBeenCalled();

    // The compatibility direct path has no durable receipt to retain; preserve its historical no-op.
    await expect(sink.onEvent(event, 'socket')).resolves.toBeUndefined();
  });

  it('requests account recovery until a durable read has a received message to mark', async () => {
    const { db } = await createTestDb();
    const handles = await upsertHandles(db, [{ address: 'empty@x.com' }]);
    await upsertChats(
      db,
      [Chat.parse({ guid: 'cReadEmpty', participants: [{ address: 'empty@x.com' }] })],
      handles,
    );
    const requestRecovery = jest.fn(async () => undefined);
    const markDbAppliedWithinTransaction = jest.fn(async () => undefined);
    const context: EventDeliveryContext = {
      generation: 1,
      isCurrent: () => true,
      durableEvent: { dbAppliedAt: null, markDbAppliedWithinTransaction },
    };
    const sink = new DbEventSink(db, undefined, undefined, requestRecovery);

    await expect(
      sink.onEvent(
        {
          type: 'chat-read-status-changed',
          payload: { chatGuid: 'cReadEmpty', read: true },
        },
        'fcm',
        context,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<RealtimeReadStatusUnavailableError>>({
        name: 'RealtimeReadStatusUnavailableError',
        chatGuid: 'cReadEmpty',
        reason: 'message-unavailable',
      }),
    );
    expect(requestRecovery).toHaveBeenCalledWith(null, context);
    expect(markDbAppliedWithinTransaction).not.toHaveBeenCalled();
  });

  it('keeps an unusable durable group mutation retryable and requests account recovery', async () => {
    const { db } = await createTestDb();
    const requestRecovery = jest.fn(async () => undefined);
    const markDbAppliedWithinTransaction = jest.fn(async () => undefined);
    const context: EventDeliveryContext = {
      generation: 1,
      isCurrent: () => true,
      durableEvent: { dbAppliedAt: null, markDbAppliedWithinTransaction },
    };
    const sink = new DbEventSink(db, undefined, undefined, requestRecovery);

    await expect(
      sink.onEvent(
        { type: 'participant-added', payload: { chats: [{ guid: '' }] } },
        'fcm',
        context,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<RealtimeGroupMutationUnavailableError>>({
        name: 'RealtimeGroupMutationUnavailableError',
        eventType: 'participant-added',
      }),
    );
    expect(requestRecovery).toHaveBeenCalledWith(null, context);
    expect(markDbAppliedWithinTransaction).not.toHaveBeenCalled();
  });
});

// Every write a message event makes must be in ONE transaction — including the handle/chat
// upserts and the chat-id lookup that used to run as plain autocommit statements before it.
// There is a SINGLE shared connection, so an "outside" statement joins whatever transaction is
// already open, and a rollback on that side erases it while this handler is still holding the ids
// it read back. The next statement then writes a message against a chat row that no longer exists.
describe('DbEventSink — write atomicity under a concurrent transaction', () => {
  it('a neighbouring rollback cannot erase the chat/handle rows this event just wrote', async () => {
    const { db, raw } = await createTestDb();
    const sink = new DbEventSink(db);

    // Hold a transaction open (a doomed one), then start the sink while it is mid-flight.
    let markBegun = (): void => {};
    const begun = new Promise<void>((r) => {
      markBegun = r;
    });
    let releaseGate = (): void => {};
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    const doomed = withDbTransaction(db, async () => {
      markBegun();
      await gate;
      throw new Error('neighbouring transaction failed');
    });
    await begun; // BEGIN IMMEDIATE has run — the connection is inside a transaction

    const message = Message.parse({
      guid: 'atomic-1',
      text: 'survives the neighbour',
      dateCreated: 1700000000000,
      handle: { address: 'zoe@x.com' },
      chats: [{ guid: 'cAtomic', displayName: 'Zoe', participants: [{ address: 'zoe@x.com' }] }],
    });
    const handled = sink.onEvent({ type: 'new-message', message }, 'socket');
    // Give the sink every chance to run its prologue inside the open transaction (microtasks
    // drain before this macrotask), which is exactly what used to happen.
    await new Promise((r) => setTimeout(r, 0));

    releaseGate();
    await expect(doomed).rejects.toThrow('neighbouring transaction failed');
    await expect(handled).resolves.toBeUndefined();

    // The chat + handle rows the event created are still here (they were never inside the
    // neighbour's transaction), and the message landed against a chat id that really exists.
    const chatId = await getChatIdByGuid(db, 'cAtomic');
    expect(chatId).not.toBeNull();
    expect(
      (
        raw.prepare('SELECT COUNT(*) c FROM handles WHERE address = ?').get('zoe@x.com') as {
          c: number;
        }
      ).c,
    ).toBe(1);
    const msgs = (await listMessages(db, chatId!)) as Array<{ guid: string }>;
    expect(msgs.map((m) => m.guid)).toEqual(['atomic-1']);
  });

  it('an unresolvable chat still commits the handle/chat upserts (skip, not rollback)', async () => {
    // The event carries only a top-level chatGuid for a chat that was never synced: the message
    // is skipped (the next sync brings chat + message together), but the handles it did resolve
    // are real work and must survive — returning early from the transaction, not throwing, is
    // what keeps that true now the prologue lives inside it.
    const { db, raw } = await createTestDb();
    const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    const sink = new DbEventSink(db);
    const message = Message.parse({
      guid: 'no-chat-row',
      text: 'hi',
      dateCreated: 1700000000000,
      handle: { address: 'ghost@x.com' },
      chatGuid: 'cNeverSynced',
    });

    await expect(sink.onEvent({ type: 'new-message', message }, 'socket')).resolves.toBeUndefined();

    expect(
      (
        raw.prepare('SELECT COUNT(*) c FROM handles WHERE address = ?').get('ghost@x.com') as {
          c: number;
        }
      ).c,
    ).toBe(1);
    expect(
      (
        raw.prepare('SELECT COUNT(*) c FROM messages WHERE guid = ?').get('no-chat-row') as {
          c: number;
        }
      ).c,
    ).toBe(0);
    expect(info).toHaveBeenCalledWith(
      '[dbEventSink] chat not found for live message — skipped (will sync)',
      expect.objectContaining({ chatGuid: 'cNeverSynced' }),
    );
  });

  it('rolls back every writable event branch when Disconnect revokes it before commit', async () => {
    const { db, raw } = await createTestDb();
    const sink = new DbEventSink(db);

    const staleNew = Message.parse({
      guid: 'stale-new',
      text: 'must roll back',
      dateCreated: 1,
      handle: { address: 'stale@x.com' },
      chats: [{ guid: 'cStaleNew', participants: [{ address: 'stale@x.com' }] }],
    });
    await sink.onEvent({ type: 'new-message', message: staleNew }, 'socket', revokedBeforeCommit());
    expect(
      (
        raw.prepare("SELECT COUNT(*) c FROM messages WHERE guid='stale-new'").get() as {
          c: number;
        }
      ).c,
    ).toBe(0);
    expect(
      (
        raw.prepare("SELECT COUNT(*) c FROM chats WHERE guid='cStaleNew'").get() as {
          c: number;
        }
      ).c,
    ).toBe(0);

    const retained = Message.parse({
      guid: 'retained-message',
      text: 'retained',
      dateCreated: 2,
      handle: { address: 'retained@x.com' },
      chats: [
        { guid: 'cRetained', displayName: 'Before', participants: [{ address: 'retained@x.com' }] },
      ],
    });
    await sink.onEvent({ type: 'new-message', message: retained }, 'socket');

    await sink.onEvent(
      {
        type: 'message-deleted',
        payload: { guid: 'retained-message', chatGuid: 'cRetained', dateDeleted: 10 },
      },
      'socket',
      revokedBeforeCommit(),
    );
    await sink.onEvent(
      { type: 'chat-read-status-changed', payload: { chatGuid: 'cRetained', read: true } },
      'socket',
      revokedBeforeCommit(),
    );
    await sink.onEvent(
      { type: 'message-send-error', payload: { guid: 'retained-message', error: 22 } },
      'socket',
      revokedBeforeCommit(),
    );
    await sink.onEvent(
      {
        type: 'group-name-change',
        payload: { chats: [{ guid: 'cRetained', displayName: 'After' }] },
      },
      'socket',
      revokedBeforeCommit(),
    );

    const row = raw
      .prepare(
        `SELECT m.date_deleted deleted, m.send_state sendState, m.error,
                c.last_read_message_guid lastRead, c.display_name displayName
           FROM messages m JOIN chats c ON c.id = m.chat_id
          WHERE m.guid = 'retained-message'`,
      )
      .get() as {
      deleted: number | null;
      sendState: string | null;
      error: number | null;
      lastRead: string | null;
      displayName: string | null;
    };
    expect(row).toEqual({
      deleted: null,
      sendState: 'sent',
      error: 0,
      lastRead: null,
      displayName: 'Before',
    });
    expect(
      (
        raw
          .prepare("SELECT COUNT(*) c FROM message_deletion_ledger WHERE guid = 'retained-message'")
          .get() as { c: number }
      ).c,
    ).toBe(0);
  });

  it('rolls back when ownership changes after the sink callback but before COMMIT', async () => {
    const { db, raw } = await createTestDb();
    const sink = new DbEventSink(db);
    const message = Message.parse({
      guid: 'commit-handoff',
      text: 'must not commit',
      dateCreated: 3,
      handle: { address: 'handoff@x.com' },
      chats: [{ guid: 'cHandoff', participants: [{ address: 'handoff@x.com' }] }],
    });

    await expect(
      sink.onEvent({ type: 'new-message', message }, 'socket', revokedAtCommitHandoff()),
    ).resolves.toBeUndefined();
    expect(
      (
        raw.prepare("SELECT COUNT(*) c FROM messages WHERE guid='commit-handoff'").get() as {
          c: number;
        }
      ).c,
    ).toBe(0);
    expect(
      (
        raw.prepare("SELECT COUNT(*) c FROM chats WHERE guid='cHandoff'").get() as {
          c: number;
        }
      ).c,
    ).toBe(0);
  });
});

describe('DbEventSink — message-deleted (tombstone)', () => {
  // Seed a received message via the live new-message path (creates the chat + row), returning the
  // router so the follow-up message-deleted rides the SAME sink/db.
  async function seedInbound(
    db: AppDatabase,
    guid: string,
    chatGuid: string,
    onAttachmentCacheRetirement?: () => void | Promise<void>,
  ): Promise<EventRouter> {
    const router = new EventRouter(new DbEventSink(db, undefined, onAttachmentCacheRetirement));
    await router.handle(
      'new-message',
      JSON.stringify(
        Message.parse({
          guid,
          text: 'delete me',
          dateCreated: 1700000000000,
          handle: { address: 'bob@x.com' },
          chats: [{ guid: chatGuid, displayName: 'Bob', participants: [{ address: 'bob@x.com' }] }],
        }),
      ),
      'socket',
    );
    return router;
  }

  it('tombstones the local row (not a hard delete) and hides it from the rendered thread', async () => {
    const { db, raw } = await createTestDb();
    const committedDates: Array<number | null> = [];
    const retirement = jest.fn(async () => {
      const row = raw
        .prepare('SELECT date_deleted d FROM messages WHERE guid = ?')
        .get('del-live') as { d: number | null };
      committedDates.push(row.d);
    });
    const router = await seedInbound(db, 'del-live', 'cDel', retirement);
    const chatId = (await getChatIdByGuid(db, 'cDel'))!;
    expect((await listMessagesWithSenders(db, chatId)).map((r) => r.guid)).toContain('del-live');

    await router.handle(
      'message-deleted',
      JSON.stringify({ guid: 'del-live', chatGuid: 'cDel', dateDeleted: 1700000009000 }),
      'socket',
    );

    // The row STILL EXISTS (tombstone, so the next sync re-returning it can't resurrect it) …
    const row = raw
      .prepare('SELECT date_deleted d FROM messages WHERE guid = ?')
      .get('del-live') as {
      d: number | null;
    };
    expect(row.d).toBe(1700000009000);
    // … but VANISHES from the rendered thread (deleted messages don't render, unlike unsends).
    expect((await listMessagesWithSenders(db, chatId)).map((r) => r.guid)).not.toContain(
      'del-live',
    );
    // Native cleanup is a post-commit hook: it can observe the durable tombstone and never runs
    // while markMessageDeleted still owns the process-wide DB transaction.
    expect(retirement).toHaveBeenCalledTimes(1);
    expect(committedDates).toEqual([1700000009000]);
  });

  it('applies a delete carrying ONLY a guid (chat resolved from the row; date falls back to now)', async () => {
    const { db, raw } = await createTestDb();
    const router = await seedInbound(db, 'del-bare', 'cBare');
    const before = Date.now();
    // No chatGuid, no dateDeleted — markMessageDeleted still resolves the chat from the message row.
    await router.handle('message-deleted', { guid: 'del-bare' }, 'socket');
    const row = raw
      .prepare('SELECT date_deleted d FROM messages WHERE guid = ?')
      .get('del-bare') as {
      d: number | null;
    };
    expect(typeof row.d).toBe('number');
    expect(row.d as number).toBeGreaterThanOrEqual(before); // now() fallback for an absent date
  });

  it('records an unknown guid in the durable deletion ledger without creating a message', async () => {
    const { db, raw } = await createTestDb();
    const router = new EventRouter(new DbEventSink(db));
    await expect(
      router.handle('message-deleted', { guid: 'never-synced', dateDeleted: 1 }, 'socket'),
    ).resolves.toBeDefined();
    expect(
      raw
        .prepare(
          `SELECT guid, date_deleted AS dateDeleted
             FROM message_deletion_ledger WHERE guid = 'never-synced'`,
        )
        .get(),
    ).toEqual({ guid: 'never-synced', dateDeleted: 1 });
    expect(
      raw.prepare("SELECT id FROM messages WHERE guid = 'never-synced'").get(),
    ).toBeUndefined();
  });

  it('checkpoints an unknown durable deletion without recovery or attachment retirement', async () => {
    const { db, raw } = await createTestDb();
    const requestRecovery = jest.fn(async () => undefined);
    const retirement = jest.fn(async () => undefined);
    const markDbAppliedWithinTransaction = jest.fn(async () => undefined);
    const context: EventDeliveryContext = {
      generation: 1,
      isCurrent: () => true,
      durableEvent: { dbAppliedAt: null, markDbAppliedWithinTransaction },
    };
    const sink = new DbEventSink(db, undefined, retirement, requestRecovery);

    await expect(
      sink.onEvent(
        {
          type: 'message-deleted',
          payload: { guid: 'delete-before-message', chatGuid: 'cDeleteLate', dateDeleted: 123 },
        },
        'fcm',
        context,
      ),
    ).resolves.toBeUndefined();
    expect(
      raw
        .prepare(
          `SELECT date_deleted AS dateDeleted
             FROM message_deletion_ledger WHERE guid = 'delete-before-message'`,
        )
        .get(),
    ).toEqual({ dateDeleted: 123 });
    expect(markDbAppliedWithinTransaction).toHaveBeenCalledTimes(1);
    expect(requestRecovery).not.toHaveBeenCalled();
    expect(retirement).not.toHaveBeenCalled();
  });

  it('rolls back an unknown deletion marker when its durable checkpoint fails', async () => {
    const { db, raw } = await createTestDb();
    const checkpoint = jest.fn(async () => {
      throw new Error('checkpoint failed');
    });
    const sink = new DbEventSink(db);

    await expect(
      sink.onEvent(
        {
          type: 'message-deleted',
          payload: { guid: 'checkpoint-rollback', chatGuid: null, dateDeleted: 456 },
        },
        'fcm',
        {
          generation: 1,
          isCurrent: () => true,
          durableEvent: { dbAppliedAt: null, markDbAppliedWithinTransaction: checkpoint },
        },
      ),
    ).rejects.toThrow('checkpoint failed');

    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(
      raw
        .prepare("SELECT guid FROM message_deletion_ledger WHERE guid = 'checkpoint-rollback'")
        .get(),
    ).toBeUndefined();
  });

  it('checkpoints a known durable deletion and retires attachments once after commit', async () => {
    const { db, raw } = await createTestDb();
    await seedInbound(db, 'durable-known-delete', 'cDurableKnown');
    const checkpoint = jest.fn(async () => undefined);
    const committedDates: Array<number | null> = [];
    const retirement = jest.fn(async () => {
      const row = raw
        .prepare('SELECT date_deleted AS dateDeleted FROM messages WHERE guid = ?')
        .get('durable-known-delete') as { dateDeleted: number | null };
      committedDates.push(row.dateDeleted);
    });
    const sink = new DbEventSink(db, undefined, retirement);

    await sink.onEvent(
      {
        type: 'message-deleted',
        payload: { guid: 'durable-known-delete', chatGuid: 'cDurableKnown', dateDeleted: 789 },
      },
      'fcm',
      {
        generation: 1,
        isCurrent: () => true,
        durableEvent: { dbAppliedAt: null, markDbAppliedWithinTransaction: checkpoint },
      },
    );

    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(retirement).toHaveBeenCalledTimes(1);
    expect(committedDates).toEqual([789]);
    expect(
      raw
        .prepare(
          `SELECT date_deleted AS dateDeleted
             FROM message_deletion_ledger WHERE guid = 'durable-known-delete'`,
        )
        .get(),
    ).toEqual({ dateDeleted: 789 });
  });
});
