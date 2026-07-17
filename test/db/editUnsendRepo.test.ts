import { Chat, Message, parseMessageSummaryInfo } from '@core/models';
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

describe('messageSummaryInfo persistence (edit history)', () => {
  const INFO = {
    editedParts: {
      '0': [
        { date: 100, text: 'first draft' },
        { date: 200, text: 'final text' },
      ],
    },
    retractedParts: [2],
  };

  it('round-trips the JSON blob through write → read (JSON survives)', async () => {
    const { db } = await createTestDb();
    const chatId = await seed(db);
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'me1',
          text: 'final text',
          dateCreated: 100,
          dateEdited: 200,
          messageSummaryInfo: INFO,
        }),
      ],
      () => chatId,
      new Map(),
    );
    const row = (await listMessagesWithSenders(db, chatId)).find((m) => m.guid === 'me1')!;
    // Stored as raw JSON TEXT (like attributedBody); the tolerant helper reconstructs the shape.
    expect(typeof row.messageSummaryInfo).toBe('string');
    expect(parseMessageSummaryInfo(row.messageSummaryInfo)).toEqual(INFO);
  });

  it('parseMessageSummaryInfo returns null for garbage in the column (never throws)', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seed(db); // seeds m1 with no summary info
    raw
      .prepare('UPDATE messages SET message_summary_info = ? WHERE guid = ?')
      .run('{not valid json', 'm1');
    const row = (await listMessagesWithSenders(db, chatId)).find((m) => m.guid === 'm1')!;
    expect(row.messageSummaryInfo).toBe('{not valid json');
    expect(parseMessageSummaryInfo(row.messageSummaryInfo)).toBeNull();
  });

  it('COALESCE-preserves the stored history when a later flagless re-upsert omits it', async () => {
    const { db } = await createTestDb();
    const chatId = await seed(db);
    await upsertMessages(
      db,
      [Message.parse({ guid: 'mc1', dateCreated: 100, dateEdited: 200, messageSummaryInfo: INFO })],
      () => chatId,
      new Map(),
    );
    // A delivery/read-receipt re-upsert carries no messageSummaryInfo — it must NOT wipe the history
    // (unlike isScheduled, whose absence is meaningful; edit history is monotonic + permanent).
    await upsertMessages(
      db,
      [Message.parse({ guid: 'mc1', dateCreated: 100, dateRead: 5000 })],
      () => chatId,
      new Map(),
    );
    const row = (await listMessagesWithSenders(db, chatId)).find((m) => m.guid === 'mc1')!;
    expect(parseMessageSummaryInfo(row.messageSummaryInfo)).toEqual(INFO);
  });

  it('overwrites with the fuller history when a new edit re-supplies it', async () => {
    const { db } = await createTestDb();
    const chatId = await seed(db);
    const v1 = { editedParts: { '0': [{ date: 100, text: 'a' }, { date: 200, text: 'b' }] } };
    const v2 = {
      editedParts: {
        '0': [
          { date: 100, text: 'a' },
          { date: 200, text: 'b' },
          { date: 300, text: 'c' },
        ],
      },
    };
    await upsertMessages(
      db,
      [Message.parse({ guid: 'mo1', dateCreated: 100, dateEdited: 200, messageSummaryInfo: v1 })],
      () => chatId,
      new Map(),
    );
    await upsertMessages(
      db,
      [Message.parse({ guid: 'mo1', dateCreated: 100, dateEdited: 300, messageSummaryInfo: v2 })],
      () => chatId,
      new Map(),
    );
    const row = (await listMessagesWithSenders(db, chatId)).find((m) => m.guid === 'mo1')!;
    expect(parseMessageSummaryInfo(row.messageSummaryInfo)?.editedParts?.['0']).toHaveLength(3);
  });
});
