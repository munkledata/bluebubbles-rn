import { Chat, Message } from '@core/models';
import { EventRouter } from '@core/realtime';
import {
  getChatIdByGuid,
  listChats,
  listMessages,
  listMessagesWithSenders,
  upsertChats,
  upsertHandles,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { DbEventSink } from '@/services/realtime/dbEventSink';
import { buildMessageIntents } from '@/services/notifications/intents';
import { createTestDb } from '../support/testDb';

describe('DbEventSink (live path)', () => {
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
      JSON.stringify({ guid: 'send-fail-1', error: 22 }),
      'socket',
    );

    const chats = (await listChats(db)) as Array<{ id: number; guid: string }>;
    const chat = chats.find((c) => c.guid === 'cErr')!;
    const msgs = (await listMessages(db, chat.id)) as Array<{
      guid: string;
      error: number;
      sendState: string;
    }>;
    const m = msgs.find((x) => x.guid === 'send-fail-1')!;
    expect(m.error).toBe(22);
    expect(m.sendState).toBe('error');
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
    const { db } = await createTestDb();
    const router = new EventRouter(new DbEventSink(db));
    const orphan = { guid: 'orphan', text: 'hi', dateCreated: 1 };
    await expect(router.handle('new-message', orphan, 'socket')).resolves.toBeDefined();
    // No chat → no message row anywhere.
    const chats = (await listChats(db)) as Array<{ id: number }>;
    for (const c of chats) {
      expect(await listMessages(db, c.id)).toHaveLength(0);
    }
  });
});

describe('DbEventSink — message-deleted (tombstone)', () => {
  // Seed a received message via the live new-message path (creates the chat + row), returning the
  // router so the follow-up message-deleted rides the SAME sink/db.
  async function seedInbound(db: AppDatabase, guid: string, chatGuid: string): Promise<EventRouter> {
    const router = new EventRouter(new DbEventSink(db));
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
    const router = await seedInbound(db, 'del-live', 'cDel');
    const chatId = (await getChatIdByGuid(db, 'cDel'))!;
    expect((await listMessagesWithSenders(db, chatId)).map((r) => r.guid)).toContain('del-live');

    await router.handle(
      'message-deleted',
      JSON.stringify({ guid: 'del-live', chatGuid: 'cDel', dateDeleted: 1700000009000 }),
      'socket',
    );

    // The row STILL EXISTS (tombstone, so the next sync re-returning it can't resurrect it) …
    const row = raw.prepare('SELECT date_deleted d FROM messages WHERE guid = ?').get('del-live') as {
      d: number | null;
    };
    expect(row.d).toBe(1700000009000);
    // … but VANISHES from the rendered thread (deleted messages don't render, unlike unsends).
    expect((await listMessagesWithSenders(db, chatId)).map((r) => r.guid)).not.toContain('del-live');
  });

  it('applies a delete carrying ONLY a guid (chat resolved from the row; date falls back to now)', async () => {
    const { db, raw } = await createTestDb();
    const router = await seedInbound(db, 'del-bare', 'cBare');
    const before = Date.now();
    // No chatGuid, no dateDeleted — markMessageDeleted still resolves the chat from the message row.
    await router.handle('message-deleted', { guid: 'del-bare' }, 'socket');
    const row = raw.prepare('SELECT date_deleted d FROM messages WHERE guid = ?').get('del-bare') as {
      d: number | null;
    };
    expect(typeof row.d).toBe('number');
    expect(row.d as number).toBeGreaterThanOrEqual(before); // now() fallback for an absent date
  });

  it('is a safe no-op for an unknown guid (no throw, no rows touched)', async () => {
    const { db } = await createTestDb();
    const router = new EventRouter(new DbEventSink(db));
    await expect(
      router.handle('message-deleted', { guid: 'never-synced', dateDeleted: 1 }, 'socket'),
    ).resolves.toBeDefined();
  });
});
