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
});
