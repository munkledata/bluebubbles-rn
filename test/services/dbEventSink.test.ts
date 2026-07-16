import { Chat, Message } from '@core/models';
import { EventRouter } from '@core/realtime';
import { listChats, listMessages, upsertChats, upsertHandles } from '@db/repositories';
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
