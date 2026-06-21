import type Database from 'better-sqlite3';
import { Chat } from '@core/models';
import {
  cancelOutgoing,
  insertOutgoingText,
  reconcileOutgoingError,
  reconcileOutgoingSuccess,
  upsertChats,
  upsertHandles,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

async function seedChat(db: AppDatabase, guid: string): Promise<number> {
  const handles = await upsertHandles(db, [{ address: 'a@x.com' }]);
  const map = await upsertChats(
    db,
    [Chat.parse({ guid, participants: [{ address: 'a@x.com' }] })],
    handles,
  );
  return map.get(guid)!;
}

function count(raw: Database.Database, table: string, where: string, ...args: unknown[]): number {
  return (
    raw.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${where}`).get(...args) as { c: number }
  ).c;
}

describe('cancelOutgoing (2.3)', () => {
  it('removes a still-sending optimistic message + its queue row', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-1',
      chatId,
      chatGuid: 'c1',
      text: 'hi',
      now: 100,
    });
    expect(count(raw, 'messages', 'guid = ?', 'temp-1')).toBe(1);
    expect(count(raw, 'outgoing_queue', 'temp_guid = ?', 'temp-1')).toBe(1);

    const cancelled = await cancelOutgoing(db, 'temp-1');

    expect(cancelled).toBe(true);
    expect(count(raw, 'messages', 'guid = ?', 'temp-1')).toBe(0);
    expect(count(raw, 'outgoing_queue', 'temp_guid = ?', 'temp-1')).toBe(0);
  });

  it('removes an errored optimistic message (the failed bubble)', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-err',
      chatId,
      chatGuid: 'c1',
      text: 'oops',
      now: 100,
    });
    await reconcileOutgoingError(db, 'temp-err', 10003, 1000);
    expect(count(raw, 'messages', "guid = ? AND send_state = 'error'", 'temp-err')).toBe(1);

    const cancelled = await cancelOutgoing(db, 'temp-err');

    expect(cancelled).toBe(true);
    expect(count(raw, 'messages', 'guid = ?', 'temp-err')).toBe(0);
    expect(count(raw, 'outgoing_queue', 'temp_guid = ?', 'temp-err')).toBe(0);
  });

  it('is a guarded no-op once the send is reconciled to its real guid', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-2',
      chatId,
      chatGuid: 'c1',
      text: 'sent already',
      now: 100,
    });
    // The send succeeded: temp promoted to the real guid, queue row dropped.
    await reconcileOutgoingSuccess(db, 'temp-2', {
      guid: 'real-2',
      dateCreated: 100,
      dateDelivered: 200,
    });
    expect(count(raw, 'messages', 'guid = ?', 'real-2')).toBe(1);
    expect(count(raw, 'outgoing_queue', 'temp_guid = ?', 'temp-2')).toBe(0);

    // Cancelling the now-stale tempGuid must NOT touch the confirmed real message.
    const cancelled = await cancelOutgoing(db, 'temp-2');

    expect(cancelled).toBe(false);
    expect(count(raw, 'messages', 'guid = ?', 'real-2')).toBe(1);
  });

  it('returns false for an unknown tempGuid', async () => {
    const { db } = await createTestDb();
    await seedChat(db, 'c1');
    expect(await cancelOutgoing(db, 'temp-nope')).toBe(false);
  });

  it('clears a stranded queue row whose temp message is gone', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'c1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-3',
      chatId,
      chatGuid: 'c1',
      text: 'orphan',
      now: 100,
    });
    // Simulate the message being removed out-of-band, leaving only the queue row.
    raw.prepare('DELETE FROM messages WHERE guid = ?').run('temp-3');

    const cancelled = await cancelOutgoing(db, 'temp-3');

    expect(cancelled).toBe(true);
    expect(count(raw, 'outgoing_queue', 'temp_guid = ?', 'temp-3')).toBe(0);
  });
});
