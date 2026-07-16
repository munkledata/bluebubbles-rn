import type Database from 'better-sqlite3';
import { ApiError } from '@core/api/errors';
import { Chat } from '@core/models';
import { logger } from '@core/secure';
import { sendErrorCode } from '@utils';
import { getChatIdByGuid, insertOutgoingText, upsertChats, upsertHandles } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { handleSendFailure, reconcileSendOutcome } from '@/services/send/sendOutcome';
import { createTestDb } from '../support/testDb';

async function seedOutgoing(db: AppDatabase, tempGuid: string, now: number): Promise<void> {
  const handles = await upsertHandles(db, [{ address: 'a@b.com' }]);
  await upsertChats(
    db,
    [Chat.parse({ guid: 'c1', participants: [{ address: 'a@b.com' }] })],
    handles,
  );
  const chatId = await getChatIdByGuid(db, 'c1');
  await insertOutgoingText(db, { tempGuid, chatId: chatId!, chatGuid: 'c1', text: 'hi', now });
}

const msgRow = (raw: Database.Database, guid: string) =>
  raw.prepare('SELECT guid, send_state s, error e FROM messages WHERE guid = ?').get(guid) as
    { guid: string; s: string; e: number } | undefined;
const msgCount = (raw: Database.Database): number =>
  (raw.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c;
const queueCount = (raw: Database.Database): number =>
  (raw.prepare('SELECT COUNT(*) c FROM outgoing_queue').get() as { c: number }).c;

describe('reconcileSendOutcome', () => {
  it('promotes temp→real and clears the queue when the ack carries a guid', async () => {
    const { db, raw } = await createTestDb();
    await seedOutgoing(db, 'temp-aaaa0000', 1000);
    await reconcileSendOutcome(db, 'temp-aaaa0000', { guid: 'real-1' }, 1000);
    expect(msgCount(raw)).toBe(1);
    expect(msgRow(raw, 'real-1')?.s).toBe('sent');
    expect(queueCount(raw)).toBe(0);
  });

  it('marks sent-no-guid (row keeps its temp guid) when the ack has NO guid', async () => {
    const { db, raw } = await createTestDb();
    await seedOutgoing(db, 'temp-bbbb0000', 1000);
    await reconcileSendOutcome(db, 'temp-bbbb0000', {}, 1000);
    expect(msgCount(raw)).toBe(1);
    expect(msgRow(raw, 'temp-bbbb0000')?.s).toBe('sent');
    expect(queueCount(raw)).toBe(0);
  });

  it('treats an RCS ack echoing our OWN tempGuid as guid-absent (row survives)', async () => {
    const { db, raw } = await createTestDb();
    await seedOutgoing(db, 'temp-cccc0000', 1000);
    await reconcileSendOutcome(db, 'temp-cccc0000', { guid: 'temp-cccc0000' }, 1000);
    // NOT promoted/deleted — flipped to 'sent' under the temp guid, queue cleared,
    // leaving the live `new-message` fanout to reconcile the real rcs-<id> by content.
    expect(msgCount(raw)).toBe(1);
    expect(msgRow(raw, 'temp-cccc0000')?.s).toBe('sent');
    expect(queueCount(raw)).toBe(0);
  });
});

describe('handleSendFailure', () => {
  afterEach(() => jest.restoreAllMocks());

  it('logs the rich diagnostic (code + HTTP status + message) and errors the row', async () => {
    const { db, raw } = await createTestDb();
    await seedOutgoing(db, 'temp-dddd0000', 1000);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await handleSendFailure(
      db,
      'temp-dddd0000',
      new ApiError('unauthorized', 'nope', 401),
      'send',
      'c1',
    );
    expect(warn).toHaveBeenCalledWith('[send] failed for chat c1 (code 401, HTTP 401): nope');
    const row = msgRow(raw, 'temp-dddd0000');
    expect(row?.s).toBe('error');
    expect(row?.e).toBe(401);
    expect(
      (raw.prepare('SELECT attempts FROM outgoing_queue').get() as { attempts: number }).attempts,
    ).toBe(1);
  });

  it('maps a non-HTTP throw to the connection error code (no HTTP part in the log)', async () => {
    const { db, raw } = await createTestDb();
    await seedOutgoing(db, 'temp-eeee0000', 1000);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await handleSendFailure(db, 'temp-eeee0000', new Error('boom'), 'queue', 'c1', 5000);
    const code = sendErrorCode(null);
    expect(warn).toHaveBeenCalledWith(`[queue] failed for chat c1 (code ${code}): boom`);
    expect(msgRow(raw, 'temp-eeee0000')?.e).toBe(code);
    // The explicit `now` seeds the backoff (first retry = now + 30s).
    expect(
      (raw.prepare('SELECT next_retry_at n FROM outgoing_queue').get() as { n: number }).n,
    ).toBe(5000 + 30_000);
  });
});
