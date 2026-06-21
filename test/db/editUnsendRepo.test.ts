import { Chat, Message } from '@core/models';
import {
  applyLocalEdit,
  applyLocalUnsend,
  clearLocalUnsend,
  getMessageTextByGuid,
  listMessagesWithSenders,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

async function seed(db: AppDatabase): Promise<number> {
  const hm = await upsertHandles(db, [{ address: 'a@x.com' }]);
  const map = await upsertChats(
    db,
    [Chat.parse({ guid: 'c1', participants: [{ address: 'a@x.com' }] })],
    hm,
  );
  const chatId = map.get('c1')!;
  await upsertMessages(
    db,
    [Message.parse({ guid: 'm1', text: 'original', isFromMe: true, dateCreated: 100 })],
    () => chatId,
    hm,
  );
  return chatId;
}

describe('edit/unsend repo fns', () => {
  it('applyLocalEdit updates text + dateEdited', async () => {
    const { db } = await createTestDb();
    const chatId = await seed(db);
    await applyLocalEdit(db, 'm1', 'edited!', 5000);
    const row = (await listMessagesWithSenders(db, chatId)).find((m) => m.guid === 'm1')!;
    expect(row.text).toBe('edited!');
    expect(row.dateEdited).toBe(5000);
    expect(row.dateRetracted).toBeNull();
  });

  it('applyLocalUnsend sets, and clearLocalUnsend clears, dateRetracted', async () => {
    const { db } = await createTestDb();
    const chatId = await seed(db);
    await applyLocalUnsend(db, 'm1', 7000);
    let row = (await listMessagesWithSenders(db, chatId)).find((m) => m.guid === 'm1')!;
    expect(row.dateRetracted).toBe(7000);
    await clearLocalUnsend(db, 'm1');
    row = (await listMessagesWithSenders(db, chatId)).find((m) => m.guid === 'm1')!;
    expect(row.dateRetracted).toBeNull();
  });

  it('getMessageTextByGuid returns the current text/edit marker', async () => {
    const { db } = await createTestDb();
    await seed(db);
    expect(await getMessageTextByGuid(db, 'm1')).toEqual({ text: 'original', dateEdited: null });
    expect(await getMessageTextByGuid(db, 'nope')).toBeNull();
  });

  it('upsertMessages round-trips a server dateRetracted', async () => {
    const { db } = await createTestDb();
    const chatId = await seed(db);
    await upsertMessages(
      db,
      [Message.parse({ guid: 'm1', text: 'original', dateCreated: 100, dateRetracted: 9000 })],
      () => chatId,
      new Map(),
    );
    const row = (await listMessagesWithSenders(db, chatId)).find((m) => m.guid === 'm1')!;
    expect(row.dateRetracted).toBe(9000);
  });
});
