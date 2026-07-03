import { Chat, Message } from '@core/models';
import {
  getChatHeader,
  getChatIdByGuid,
  getNewestReceivedGuid,
  listChatsForInbox,
  listMessagesWithSenders,
  setLastReadMessageGuid,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

async function seed(db: AppDatabase) {
  const handles = await upsertHandles(db, [
    { address: 'a@x.com', displayName: 'Alice' },
    { address: 'b@x.com', displayName: 'Bob' },
  ]);
  const map = await upsertChats(
    db,
    [
      Chat.parse({
        guid: 'c1',
        displayName: 'Group',
        participants: [{ address: 'a@x.com' }, { address: 'b@x.com' }],
      }),
    ],
    handles,
  );
  const chatId = map.get('c1')!;
  await upsertMessages(
    db,
    [
      Message.parse({
        guid: 'm1',
        text: 'first',
        dateCreated: 100,
        handle: { address: 'a@x.com' },
      }),
      Message.parse({ guid: 'm2', text: 'mine', isFromMe: true, dateCreated: 200 }),
      Message.parse({
        guid: 'm3',
        text: 'latest',
        dateCreated: 300,
        handle: { address: 'b@x.com' },
      }),
    ],
    () => chatId,
    handles,
  );
  return chatId;
}

describe('conversation-view repositories', () => {
  it('getChatIdByGuid resolves hit/miss', async () => {
    const { db } = await createTestDb();
    const id = await seed(db);
    expect(await getChatIdByGuid(db, 'c1')).toBe(id);
    expect(await getChatIdByGuid(db, 'nope')).toBeNull();
  });

  it('listMessagesWithSenders returns newest-first with sender names', async () => {
    const { db } = await createTestDb();
    const chatId = await seed(db);
    const rows = await listMessagesWithSenders(db, chatId);
    expect(rows.map((r) => r.guid)).toEqual(['m3', 'm2', 'm1']); // newest first
    expect(rows[0]!.senderName).toBe('Bob');
    expect(rows[1]!.isFromMe).toBe(1);
    expect(rows[2]!.senderName).toBe('Alice');
  });

  it('repairs a null sender on a later hydrated re-sync, and never wipes a good one', async () => {
    const { db } = await createTestDb();
    const handles = await upsertHandles(db, [{ address: 'a@x.com', displayName: 'Alice' }]);
    const map = await upsertChats(db, [Chat.parse({ guid: 'c1', displayName: 'Group' })], handles);
    const chatId = map.get('c1')!;

    // 1) Handle-less fetch (the old chat-open backfill): message inserted with NO sender.
    await upsertMessages(
      db,
      [Message.parse({ guid: 'mX', text: 'hi', dateCreated: 100 })],
      () => chatId,
      handles,
    );
    let row = (await listMessagesWithSenders(db, chatId)).find((r) => r.guid === 'mX')!;
    expect(row.senderAddress).toBeNull(); // renders as "?"

    // 2) A later hydrated re-sync carries the sender → COALESCE fills the null handle.
    await upsertMessages(
      db,
      [Message.parse({ guid: 'mX', text: 'hi', dateCreated: 100, handle: { address: 'a@x.com' } })],
      () => chatId,
      handles,
    );
    row = (await listMessagesWithSenders(db, chatId)).find((r) => r.guid === 'mX')!;
    expect(row.senderAddress).toBe('a@x.com');
    expect(row.senderName).toBe('Alice');

    // 3) A subsequent handle-less fetch must NOT wipe the resolved sender.
    await upsertMessages(
      db,
      [Message.parse({ guid: 'mX', text: 'hi edited', dateCreated: 100 })],
      () => chatId,
      handles,
    );
    row = (await listMessagesWithSenders(db, chatId)).find((r) => r.guid === 'mX')!;
    expect(row.senderAddress).toBe('a@x.com');
  });

  it('paginates with beforeDate', async () => {
    const { db } = await createTestDb();
    const chatId = await seed(db);
    const older = await listMessagesWithSenders(db, chatId, 100, 300); // strictly older than m3
    expect(older.map((r) => r.guid)).toEqual(['m2', 'm1']);
  });

  it('getNewestReceivedGuid ignores outgoing', async () => {
    const { db } = await createTestDb();
    const chatId = await seed(db);
    expect(await getNewestReceivedGuid(db, chatId)).toBe('m3'); // not m2 (mine)
  });

  it('getChatHeader returns title + participant info', async () => {
    const { db } = await createTestDb();
    await seed(db);
    const h = await getChatHeader(db, 'c1');
    expect(h?.displayName).toBe('Group');
    expect(h?.participantCount).toBe(2);
  });

  it('setLastReadMessageGuid clears the inbox unread count', async () => {
    const { db } = await createTestDb();
    await seed(db);
    let inbox = await listChatsForInbox(db);
    expect(inbox[0]!.unreadCount).toBeGreaterThan(0);
    await setLastReadMessageGuid(db, 'c1', 'm3');
    inbox = await listChatsForInbox(db);
    expect(inbox[0]!.unreadCount).toBe(0);
  });

  // Fix #8: a later event that OMITS a delivery-tier flag must not downgrade a stored
  // `true` (COALESCE(excluded.x, messages.x) on conflict). A later event that DOES carry
  // the flag still updates it.
  it('upsertMessages does not let a flagless re-upsert downgrade a stored delivery tier', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seed(db);
    const tier = (guid: string): { q: number | null; n: number | null } =>
      raw
        .prepare(
          'SELECT was_delivered_quietly q, did_notify_recipient n FROM messages WHERE guid = ?',
        )
        .get(guid) as { q: number | null; n: number | null };

    // First event sets the quiet-delivery tier true.
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'q1',
          text: 'quiet',
          dateCreated: 400,
          handle: { address: 'a@x.com' },
          wasDeliveredQuietly: true,
          didNotifyRecipient: true,
        }),
      ],
      () => chatId,
      new Map(),
    );
    expect(tier('q1').q).toBe(1);
    expect(tier('q1').n).toBe(1);

    // A later event for the same guid OMITS both flags → the stored trues must survive.
    await upsertMessages(
      db,
      [Message.parse({ guid: 'q1', text: 'quiet edited', dateCreated: 400 })],
      () => chatId,
      new Map(),
    );
    expect(tier('q1').q).toBe(1); // not downgraded
    expect(tier('q1').n).toBe(1);

    // A later event that DOES carry a (different) flag still updates it.
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'q1',
          dateCreated: 400,
          wasDeliveredQuietly: true,
          didNotifyRecipient: false,
        }),
      ],
      () => chatId,
      new Map(),
    );
    expect(tier('q1').q).toBe(1);
    expect(tier('q1').n).toBe(0); // explicit false IS applied
  });
});
