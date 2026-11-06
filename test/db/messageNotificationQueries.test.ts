import type Database from 'better-sqlite3';
import { Chat, Message } from '@core/models';
import {
  getReadThroughTarget,
  isMessageNotificationEligible,
  setLastReadMessageGuid,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import type { TestDb } from '@db/types';
import { createTestDb } from '../support/testDb';

/**
 * Direct tests for the two privacy-relevant read queries behind notifications (fix plan I-3):
 * `isMessageNotificationEligible` decides whether a replayed notification may still be shown, and
 * `getReadThroughTarget` decides where a remote read moves this chat's read marker. Both were only
 * exercised indirectly through the sink and intent suites before.
 */

const ALICE = 'alice@x.com';

async function seed(db: TestDb): Promise<{ chatId: number; otherChatId: number }> {
  const handles = await upsertHandles(db, [{ address: ALICE, displayName: 'Alice' }]);
  const chatMap = await upsertChats(
    db,
    [
      Chat.parse({ guid: 'c1', participants: [{ address: ALICE }] }),
      Chat.parse({ guid: 'c2', participants: [{ address: ALICE }] }),
    ],
    handles,
  );
  const chatId = chatMap.get('c1')!;
  const otherChatId = chatMap.get('c2')!;
  await upsertMessages(
    db,
    [
      Message.parse({
        guid: 'in-100',
        text: 'first',
        dateCreated: 100,
        handle: { address: ALICE },
      }),
      Message.parse({
        guid: 'in-200',
        text: 'second',
        dateCreated: 200,
        handle: { address: ALICE },
      }),
      Message.parse({ guid: 'mine-250', text: 'mine', isFromMe: true, dateCreated: 250 }),
      Message.parse({
        guid: 'in-300',
        text: 'third',
        dateCreated: 300,
        handle: { address: ALICE },
      }),
      Message.parse({
        guid: 'tapback-310',
        dateCreated: 310,
        handle: { address: ALICE },
        associatedMessageType: 'love',
        associatedMessageGuid: 'mine-250',
      }),
    ],
    () => chatId,
    handles,
  );
  await upsertMessages(
    db,
    [
      Message.parse({
        guid: 'other-150',
        text: 'elsewhere',
        dateCreated: 150,
        handle: { address: ALICE },
      }),
    ],
    () => otherChatId,
    handles,
  );
  return { chatId, otherChatId };
}

function setColumn(
  raw: Database.Database,
  table: 'messages' | 'chats',
  column: string,
  value: unknown,
  where: string,
  key: unknown,
): void {
  raw.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${where} = ?`).run(value, key);
}

describe('isMessageNotificationEligible', () => {
  it('is true only for a stored, received, visible, unread, non-tapback message', async () => {
    const { db } = await createTestDb();
    await seed(db);
    expect(await isMessageNotificationEligible(db, 'in-300')).toBe(true);
    expect(await isMessageNotificationEligible(db, 'mine-250')).toBe(false);
    expect(await isMessageNotificationEligible(db, 'tapback-310')).toBe(false);
    expect(await isMessageNotificationEligible(db, 'never-stored')).toBe(false);
  });

  it('turns false at and below the read marker and stays true above it', async () => {
    const { db } = await createTestDb();
    await seed(db);
    await setLastReadMessageGuid(db, 'c1', 'in-200');
    expect(await isMessageNotificationEligible(db, 'in-100')).toBe(false);
    expect(await isMessageNotificationEligible(db, 'in-200')).toBe(false);
    expect(await isMessageNotificationEligible(db, 'in-300')).toBe(true);
  });

  it('turns false when the message is deleted locally or the chat was deleted after it', async () => {
    const { db, raw } = await createTestDb();
    const { chatId } = await seed(db);
    setColumn(raw, 'messages', 'date_deleted', 1_000, 'guid', 'in-300');
    expect(await isMessageNotificationEligible(db, 'in-300')).toBe(false);

    setColumn(raw, 'chats', 'deleted_at', 250, 'id', chatId);
    expect(await isMessageNotificationEligible(db, 'in-200')).toBe(false); // before the cutoff
    expect(await isMessageNotificationEligible(db, 'in-100')).toBe(false);
  });

  it('follows the shared content-visibility rule for retracted messages', async () => {
    const { db, raw } = await createTestDb();
    await seed(db);
    // Legacy row: no aggregate state, the retraction date alone hides it.
    setColumn(raw, 'messages', 'date_retracted', 5, 'guid', 'in-100');
    expect(await isMessageNotificationEligible(db, 'in-100')).toBe(false);
    // A proven partial retraction keeps visible content; full and uncertain fail closed.
    setColumn(raw, 'messages', 'date_retracted', 5, 'guid', 'in-200');
    setColumn(raw, 'messages', 'retraction_state', 'partial', 'guid', 'in-200');
    expect(await isMessageNotificationEligible(db, 'in-200')).toBe(true);
    setColumn(raw, 'messages', 'retraction_state', 'fully-retracted', 'guid', 'in-200');
    expect(await isMessageNotificationEligible(db, 'in-200')).toBe(false);
    setColumn(raw, 'messages', 'retraction_state', 'unknown', 'guid', 'in-300');
    expect(await isMessageNotificationEligible(db, 'in-300')).toBe(false);
  });
});

describe('getReadThroughTarget', () => {
  it('returns the guid of a received message newer than the marker', async () => {
    const { db } = await createTestDb();
    const { chatId } = await seed(db);
    expect(await getReadThroughTarget(db, chatId, 'in-200', null)).toBe('in-200');
    await setLastReadMessageGuid(db, 'c1', 'in-100');
    expect(await getReadThroughTarget(db, chatId, 'in-200', null)).toBe('in-200');
  });

  it("is 'stale' at or below the marker and 'missing' for unknown, own, or other-chat guids", async () => {
    const { db } = await createTestDb();
    const { chatId } = await seed(db);
    await setLastReadMessageGuid(db, 'c1', 'in-200');
    expect(await getReadThroughTarget(db, chatId, 'in-200', null)).toBe('stale');
    expect(await getReadThroughTarget(db, chatId, 'in-100', null)).toBe('stale');
    expect(await getReadThroughTarget(db, chatId, 'in-300', null)).toBe('in-300');

    expect(await getReadThroughTarget(db, chatId, 'never-stored', null)).toBe('missing');
    expect(await getReadThroughTarget(db, chatId, 'mine-250', null)).toBe('missing');
    expect(await getReadThroughTarget(db, chatId, 'other-150', null)).toBe('missing');
  });

  it("is 'stale' when the user marked the chat unread after the remote read", async () => {
    const { db, raw } = await createTestDb();
    const { chatId } = await seed(db);
    setColumn(raw, 'chats', 'marked_unread_at', 1_000, 'id', chatId);
    expect(await getReadThroughTarget(db, chatId, 'in-300', 900)).toBe('stale');
    expect(await getReadThroughTarget(db, chatId, 'in-300', 1_000)).toBe('stale'); // boundary: at the mark
    expect(await getReadThroughTarget(db, chatId, 'in-300', 1_001)).toBe('in-300');
    // Without a read time the message's own date stands in, and 300 is before the mark.
    expect(await getReadThroughTarget(db, chatId, 'in-300', null)).toBe('stale');
  });

  it('falls back from a locally deleted target to the newest kept received message before it', async () => {
    const { db, raw } = await createTestDb();
    const { chatId } = await seed(db);
    setColumn(raw, 'messages', 'date_deleted', 1_000, 'guid', 'in-300');
    expect(await getReadThroughTarget(db, chatId, 'in-300', null)).toBe('in-200');

    await setLastReadMessageGuid(db, 'c1', 'in-200');
    expect(await getReadThroughTarget(db, chatId, 'in-300', null)).toBe('stale');

    setColumn(raw, 'messages', 'date_deleted', 1_000, 'guid', 'in-200');
    setColumn(raw, 'messages', 'date_deleted', 1_000, 'guid', 'in-100');
    expect(await getReadThroughTarget(db, chatId, 'in-300', null)).toBe('stale');
  });
});
