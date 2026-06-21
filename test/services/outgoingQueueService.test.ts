import type Database from 'better-sqlite3';
import { ApiError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';
import { Chat } from '@core/models';
import {
  getChatIdByGuid,
  insertOutgoingText,
  listRetryableOutgoing,
  outgoingBackoffMs,
  upsertChats,
  upsertHandles,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { runOutgoingQueue } from '@/services/send/outgoingQueueService';
import { createTestDb } from '../support/testDb';

function fakeHttp(impl: (json: unknown) => Promise<unknown>): HttpClient {
  return {
    post: (_path: string, _schema: unknown, opts: { json?: unknown }) => impl(opts?.json),
  } as unknown as HttpClient;
}
const okHttp = (now: number): HttpClient =>
  fakeHttp(async () => ({ guid: 'real-1', dateCreated: now, dateDelivered: null }));
const failHttp = (): HttpClient =>
  fakeHttp(async () => {
    throw new ApiError('unauthorized', 'boom', 500);
  });

async function seedChat(db: AppDatabase, guid: string): Promise<void> {
  const handles = await upsertHandles(db, [{ address: 'a@b.com' }]);
  await upsertChats(db, [Chat.parse({ guid, participants: [{ address: 'a@b.com' }] })], handles);
}
const queueCount = (raw: Database.Database): number =>
  (raw.prepare('SELECT COUNT(*) c FROM outgoing_queue').get() as { c: number }).c;
const stateOf = (raw: Database.Database, guid: string): string | undefined =>
  (raw.prepare('SELECT send_state s FROM messages WHERE guid = ?').get(guid) as { s: string })?.s;

/** Insert an outgoing text whose created_at is forced old, so it's a stranded (eligible) row. */
async function strandedText(
  db: AppDatabase,
  raw: Database.Database,
  chatGuid: string,
  tempGuid: string,
  createdAt: number,
): Promise<void> {
  const chatId = await getChatIdByGuid(db, chatGuid);
  await insertOutgoingText(db, { tempGuid, chatId: chatId!, chatGuid, text: 'hi', now: createdAt });
  raw
    .prepare('UPDATE outgoing_queue SET created_at = ? WHERE temp_guid = ?')
    .run(createdAt, tempGuid);
}

describe('outgoingBackoffMs', () => {
  it('doubles per attempt and caps at 1h', () => {
    expect(outgoingBackoffMs(1)).toBe(30_000);
    expect(outgoingBackoffMs(2)).toBe(60_000);
    expect(outgoingBackoffMs(3)).toBe(120_000);
    expect(outgoingBackoffMs(99)).toBe(3_600_000);
  });
});

describe('runOutgoingQueue', () => {
  it('retries a stranded send to success and clears the queue row', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const now = 10_000_000;
    await strandedText(db, raw, 'c1', 'temp-a', now - 200_000);

    const res = await runOutgoingQueue(db, okHttp(now), now);
    expect(res).toEqual({ eligible: 1, sent: 1 });
    expect(queueCount(raw)).toBe(0); // reconciled + dequeued
    expect(stateOf(raw, 'real-1')).toBe('sent'); // temp promoted to the real guid
  });

  it('does not touch a FRESH in-flight row (within the grace window)', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const now = 10_000_000;
    const chatId = await getChatIdByGuid(db, 'c1');
    // created_at defaults to ~real-now; pass now far in the PAST so the row looks fresh.
    await insertOutgoingText(db, {
      tempGuid: 'temp-fresh',
      chatId: chatId!,
      chatGuid: 'c1',
      text: 'hi',
      now,
    });
    const res = await runOutgoingQueue(db, okHttp(now), now);
    expect(res.eligible).toBe(0);
    expect(queueCount(raw)).toBe(1); // left for the in-flight UI send
  });

  it('schedules a backoff retry on failure, then succeeds once it elapses', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    const t = 10_000_000;
    await strandedText(db, raw, 'c1', 'temp-b', t - 200_000);

    // First attempt fails → attempts=1, next_retry_at = t + 30s, message errored.
    expect(await runOutgoingQueue(db, failHttp(), t)).toEqual({ eligible: 1, sent: 0 });
    expect(stateOf(raw, 'temp-b')).toBe('error');
    expect(queueCount(raw)).toBe(1);

    // Before the backoff elapses → not eligible.
    expect((await listRetryableOutgoing(db, t + 10_000)).length).toBe(0);

    // After the backoff → retried, and this time it succeeds.
    const res = await runOutgoingQueue(db, okHttp(t + 31_000), t + 31_000);
    expect(res.sent).toBe(1);
    expect(queueCount(raw)).toBe(0);
  });

  it('retires a permanently-failing row after the attempt cap (no infinite retry)', async () => {
    const { db, raw } = await createTestDb();
    await seedChat(db, 'c1');
    let t = 10_000_000;
    await strandedText(db, raw, 'c1', 'temp-c', t - 200_000);

    // Drive 5 failures, advancing past each backoff window.
    for (let i = 0; i < 5; i++) {
      await runOutgoingQueue(db, failHttp(), t);
      t += 3_700_000; // past the max backoff so the next attempt is eligible
    }
    // Capped: no longer eligible, message stays errored, row retired (still present).
    expect((await listRetryableOutgoing(db, t)).length).toBe(0);
    expect(stateOf(raw, 'temp-c')).toBe('error');
  });
});
