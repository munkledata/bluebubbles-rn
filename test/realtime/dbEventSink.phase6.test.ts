import { EventRouter } from '@core/realtime';
import { deliverRaw } from '../support/realtimeRouter';
import { DbEventSink } from '@/services/realtime/dbEventSink';
import { createTestDb } from '../support/testDb';

const inbound = (guid: string, chatGuid: string, name: string) => ({
  guid,
  text: 'hi',
  dateCreated: 1700000000000,
  handle: { address: 'bob@x.com' },
  chats: [{ guid: chatGuid, displayName: name, participants: [{ address: 'bob@x.com' }] }],
});

describe('DbEventSink — Phase 6 events', () => {
  it('chat-read-status-changed advances the local read marker', async () => {
    const { db, raw } = await createTestDb();
    const router = new EventRouter(new DbEventSink(db));
    await deliverRaw(router, 'new-message', inbound('m1', 'cR', 'Bob'), 'socket');

    await deliverRaw(router, 'chat-read-status-changed', { chatGuid: 'cR', read: true }, 'socket');

    const row = raw
      .prepare("SELECT last_read_message_guid lr FROM chats WHERE guid='cR'")
      .get() as {
      lr: string | null;
    };
    expect(row.lr).toBe('m1'); // newest received message
  });

  it('group-name-change re-upserts the chat name', async () => {
    const { db, raw } = await createTestDb();
    const router = new EventRouter(new DbEventSink(db));
    await deliverRaw(router, 'new-message', inbound('m2', 'cG', 'Old Name'), 'socket');

    await deliverRaw(
      router,
      'group-name-change',
      { chats: [{ guid: 'cG', displayName: 'New Name' }] },
      'socket',
    );

    const row = raw.prepare("SELECT display_name dn FROM chats WHERE guid='cG'").get() as {
      dn: string | null;
    };
    expect(row.dn).toBe('New Name');
  });

  it('ignores a group event with no chats (no throw)', async () => {
    const { db } = await createTestDb();
    const router = new EventRouter(new DbEventSink(db));
    await expect(
      deliverRaw(router, 'participant-added', { chats: [] }, 'socket'),
    ).resolves.toBeDefined();
  });
});
