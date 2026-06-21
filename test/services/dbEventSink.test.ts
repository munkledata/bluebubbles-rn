import { Message } from '@core/models';
import { EventRouter } from '@core/realtime';
import { listChats, listMessages } from '@db/repositories';
import { DbEventSink } from '@/services/realtime/dbEventSink';
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

  it('ignores events it does not handle yet (no throw)', async () => {
    const { db } = await createTestDb();
    const router = new EventRouter(new DbEventSink(db));
    await expect(
      router.handle('typing-indicator', { chatGuid: 'c', display: true }, 'socket'),
    ).resolves.toBeDefined();
  });
});
