import { EventRouter, type NotificationIntent } from '@core/realtime';
import { buildMessageIntents } from '@/services/notifications/intents';
import { DbEventSink } from '@/services/realtime/dbEventSink';
import { NotifyingEventSink } from '@/services/realtime/notifyingEventSink';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

function wire(db: AppDatabase) {
  const intents: NotificationIntent[] = [];
  const sink = new NotifyingEventSink(new DbEventSink(db), db, buildMessageIntents, (i) =>
    intents.push(i),
  );
  return { intents, router: new EventRouter(sink) };
}

describe('NotifyingEventSink + buildMessageIntents', () => {
  it('emits a message intent for an inbound message (title/sender from data)', async () => {
    const { db } = await createTestDb();
    const { intents, router } = wire(db);
    await router.handle(
      'new-message',
      {
        guid: 'n1',
        text: 'yo',
        dateCreated: 1700000000000,
        handle: { address: 'bob@x.com', displayName: 'Bob' },
        chats: [{ guid: 'cN', displayName: 'Bob', participants: [{ address: 'bob@x.com' }] }],
      },
      'socket',
    );
    expect(intents).toHaveLength(1);
    const i = intents[0]!;
    expect(i.kind).toBe('message');
    if (i.kind === 'message') {
      expect(i.chatGuid).toBe('cN');
      expect(i.body).toBe('yo');
      expect(i.senderName).toBe('Bob');
      expect(i.isGroup).toBe(false);
    }
  });

  it('does not notify for our own messages', async () => {
    const { db } = await createTestDb();
    const { intents, router } = wire(db);
    await router.handle(
      'new-message',
      { guid: 'mine', text: 'sent', isFromMe: true, dateCreated: 1, chats: [{ guid: 'cMe' }] },
      'socket',
    );
    expect(intents).toHaveLength(0);
  });

  it('emits a cancel intent on remote read', async () => {
    const { db } = await createTestDb();
    const { intents, router } = wire(db);
    await router.handle(
      'new-message',
      {
        guid: 's1',
        dateCreated: 1,
        handle: { address: 'a@b.com' },
        chats: [{ guid: 'cC', participants: [{ address: 'a@b.com' }] }],
      },
      'socket',
    );
    intents.length = 0;
    await router.handle('chat-read-status-changed', { chatGuid: 'cC', read: true }, 'socket');
    expect(intents).toEqual([{ kind: 'cancel', chatGuid: 'cC' }]);
  });

  it('emits an alias-removed intent when iMessage aliases are deregistered (F-6)', async () => {
    const { db } = await createTestDb();
    const { intents, router } = wire(db);
    await router.handle(
      'imessage-aliases-removed',
      { aliases: ['me@icloud.com', '+15551234567'] },
      'socket',
    );
    expect(intents).toEqual([
      { kind: 'alias-removed', aliases: ['me@icloud.com', '+15551234567'] },
    ]);
  });

  it('drops an aliases-removed event with no aliases', async () => {
    const { db } = await createTestDb();
    const { intents, router } = wire(db);
    await router.handle('imessage-aliases-removed', { aliases: [] }, 'socket');
    expect(intents).toHaveLength(0);
  });
});
