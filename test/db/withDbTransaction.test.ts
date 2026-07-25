import type Database from 'better-sqlite3';
import { Chat } from '@core/models';
import {
  getChatIdByGuid,
  insertOutgoingText,
  reconcileEchoByContent,
  upsertChats,
  upsertHandles,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

// withDbTransaction exists for ONE call site today: DbEventSink wraps
// reconcileEchoByContent + upsertMessages so the queue-delete and the temp→real guid promote
// commit atomically (a crash in the gap used to strand a queue-less unpromoted temp row — a
// permanent duplicate bubble). These tests exercise that exact pair through the helper.

async function seedChat(db: AppDatabase, guid: string): Promise<number> {
  const handles = await upsertHandles(db, [{ address: 'a@x.com' }]);
  await upsertChats(db, [Chat.parse({ guid, participants: [{ address: 'a@x.com' }] })], handles);
  return (await getChatIdByGuid(db, guid))!;
}

function count(raw: Database.Database, table: string, where: string, ...args: unknown[]): number {
  return (
    raw.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${where}`).get(...args) as { c: number }
  ).c;
}

describe('withDbTransaction', () => {
  it('commits: the echo-reconcile inside the transaction persists and the result is returned', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'cTx1');
    await insertOutgoingText(db, {
      tempGuid: 'temp-tx1',
      chatId,
      chatGuid: 'cTx1',
      text: 'hello',
      now: 1000,
    });

    const result = await withDbTransaction(db, async () => {
      await reconcileEchoByContent(
        db,
        { guid: 'real-tx1', isFromMe: true, text: 'hello', dateCreated: 1000 },
        chatId,
      );
      return 'done';
    });

    expect(result).toBe('done');
    // Queue row dropped and temp row promoted — both committed.
    expect(count(raw, 'outgoing_queue', 'temp_guid = ?', 'temp-tx1')).toBe(0);
    expect(count(raw, 'messages', 'guid = ?', 'real-tx1')).toBe(1);
    expect(count(raw, 'messages', 'guid = ?', 'temp-tx1')).toBe(0);
  });

  it('rolls back: a failure after the reconcile restores the queue row AND the temp identity', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'cTx2');
    await insertOutgoingText(db, {
      tempGuid: 'temp-tx2',
      chatId,
      chatGuid: 'cTx2',
      text: 'hello',
      now: 1000,
    });

    await expect(
      withDbTransaction(db, async () => {
        await reconcileEchoByContent(
          db,
          { guid: 'real-tx2', isFromMe: true, text: 'hello', dateCreated: 1000 },
          chatId,
        );
        throw new Error('upsert failed');
      }),
    ).rejects.toThrow('upsert failed');

    // Neither half of the reconcile survived: the queue row is back and the message row still
    // carries its temp identity (no half-promoted state).
    expect(count(raw, 'outgoing_queue', 'temp_guid = ?', 'temp-tx2')).toBe(1);
    expect(count(raw, 'messages', 'guid = ?', 'temp-tx2')).toBe(1);
    expect(count(raw, 'messages', 'guid = ?', 'real-tx2')).toBe(0);
  });

  it('a later write on the same connection still works after a rollback', async () => {
    const { db, raw } = await createTestDb();
    const chatId = await seedChat(db, 'cTx3');

    await expect(
      withDbTransaction(db, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // The connection is out of the failed transaction — a normal autocommit write succeeds.
    await insertOutgoingText(db, {
      tempGuid: 'temp-tx3',
      chatId,
      chatGuid: 'cTx3',
      text: 'after',
      now: 2000,
    });
    expect(count(raw, 'messages', 'guid = ?', 'temp-tx3')).toBe(1);
  });
});
