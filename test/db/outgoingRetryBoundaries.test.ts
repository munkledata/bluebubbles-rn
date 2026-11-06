import type Database from 'better-sqlite3';
import { Chat, Message } from '@core/models';
import { CURRENT_LOCATION_MAX_REPLAY_AGE_MS } from '@core/api/endpoints/messages';
import {
  listRetryableOutgoing,
  markMessageSendErrorWithinTransaction,
  reconcileOutgoingErrorWithinTransaction,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import {
  OUTGOING_GRACE_MS,
  OUTGOING_MAX_ATTEMPTS,
  outgoingBackoffMs,
} from '@db/repositories/outgoingRetryPolicy';
import { withDbTransaction } from '@db/transaction';
import type { TestDb } from '@db/types';
import { createTestDb } from '../support/testDb';

/**
 * The automatic-retry predicate and the two transaction-only error writers at their exact
 * boundaries (fix plan I-2). The queue rows are seeded with raw SQL so every column is explicit.
 */

const NOW = 1_800_000_000_000;
const OLD = NOW - 10 * OUTGOING_GRACE_MS;

interface QueueRowSeed {
  tempGuid: string;
  chatGuid?: string;
  kind?: string;
  payload?: string;
  attempts?: number;
  createdAt?: number | null;
  nextRetryAt?: number;
}

function seedQueue(raw: Database.Database, row: QueueRowSeed): void {
  raw
    .prepare(
      `INSERT INTO outgoing_queue (temp_guid, chat_guid, kind, payload, attempts, created_at, next_retry_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.tempGuid,
      row.chatGuid ?? 'iMessage;-;alice@x.com',
      row.kind ?? 'text',
      row.payload ?? '{"message":"hi"}',
      row.attempts ?? 1,
      row.createdAt === undefined ? OLD : row.createdAt,
      row.nextRetryAt ?? 0,
    );
}

const guids = (rows: Array<{ tempGuid: string }>): string[] => rows.map((row) => row.tempGuid);

describe('listRetryableOutgoing at its boundaries', () => {
  it('includes the last attempt under the cap and excludes the cap itself', async () => {
    const { db, raw } = await createTestDb();
    seedQueue(raw, { tempGuid: 'temp-under', attempts: OUTGOING_MAX_ATTEMPTS - 1 });
    seedQueue(raw, { tempGuid: 'temp-at-cap', attempts: OUTGOING_MAX_ATTEMPTS });
    expect(guids(await listRetryableOutgoing(db, NOW))).toEqual(['temp-under']);
  });

  it('is due exactly at next_retry_at and not one millisecond before', async () => {
    const { db, raw } = await createTestDb();
    seedQueue(raw, { tempGuid: 'temp-due', nextRetryAt: NOW });
    seedQueue(raw, { tempGuid: 'temp-early', nextRetryAt: NOW + 1 });
    expect(guids(await listRetryableOutgoing(db, NOW))).toEqual(['temp-due']);
  });

  it('lets a never-attempted row through only once the in-flight grace window has fully elapsed', async () => {
    const { db, raw } = await createTestDb();
    seedQueue(raw, { tempGuid: 'temp-stranded', attempts: 0, createdAt: NOW - OUTGOING_GRACE_MS });
    seedQueue(raw, {
      tempGuid: 'temp-in-flight',
      attempts: 0,
      createdAt: NOW - OUTGOING_GRACE_MS + 1,
    });
    expect(guids(await listRetryableOutgoing(db, NOW))).toEqual(['temp-stranded']);
  });

  it('surfaces a stale or clock-skewed location row even past the attempt cap, but not an empty one', async () => {
    const { db, raw } = await createTestDb();
    const stale = NOW - CURRENT_LOCATION_MAX_REPLAY_AGE_MS;
    seedQueue(raw, {
      tempGuid: 'temp-loc-stale',
      kind: 'location',
      payload: '{"lat":1}',
      attempts: OUTGOING_MAX_ATTEMPTS,
      createdAt: stale,
      nextRetryAt: NOW + 1,
    });
    seedQueue(raw, {
      tempGuid: 'temp-loc-fresh',
      kind: 'location',
      payload: '{"lat":1}',
      attempts: OUTGOING_MAX_ATTEMPTS,
      createdAt: stale + 1,
      nextRetryAt: NOW + 1,
    });
    seedQueue(raw, {
      tempGuid: 'temp-loc-future',
      kind: 'location',
      payload: '{"lat":1}',
      attempts: OUTGOING_MAX_ATTEMPTS,
      createdAt: NOW + 1,
      nextRetryAt: NOW + 1,
    });
    seedQueue(raw, {
      tempGuid: 'temp-loc-empty',
      kind: 'location',
      payload: '{}',
      attempts: OUTGOING_MAX_ATTEMPTS,
      createdAt: stale,
      nextRetryAt: NOW + 1,
    });
    expect(guids(await listRetryableOutgoing(db, NOW)).sort()).toEqual([
      'temp-loc-future',
      'temp-loc-stale',
    ]);
    // excludeLocation keeps a live location row out of a drain but still surfaces the stale one.
    seedQueue(raw, { tempGuid: 'temp-loc-live', kind: 'location', payload: '{"lat":1}' });
    expect(guids(await listRetryableOutgoing(db, NOW, undefined, false, true)).sort()).toEqual([
      'temp-loc-future',
      'temp-loc-stale',
    ]);
    expect(guids(await listRetryableOutgoing(db, NOW))).toContain('temp-loc-live');
  });

  it('filters RCS rows by the exclude flag and by the current provider epoch', async () => {
    const { db, raw } = await createTestDb();
    seedQueue(raw, { tempGuid: 'temp-imessage', chatGuid: 'iMessage;-;alice@x.com' });
    seedQueue(raw, { tempGuid: 'temp-rcs-current', chatGuid: 'RCS;-;g1.epochA.abc' });
    seedQueue(raw, { tempGuid: 'temp-rcs-old', chatGuid: 'RCS;-;g1.epochB.abc' });
    expect(guids(await listRetryableOutgoing(db, NOW, undefined, true))).toEqual(['temp-imessage']);
    expect(
      guids(await listRetryableOutgoing(db, NOW, undefined, false, false, 'epochA')).sort(),
    ).toEqual(['temp-imessage', 'temp-rcs-current']);
    expect(guids(await listRetryableOutgoing(db, NOW)).sort()).toEqual([
      'temp-imessage',
      'temp-rcs-current',
      'temp-rcs-old',
    ]);
  });

  it('excludes exactly the retry-safe plain-text iMessage payload and nothing wider', async () => {
    const { db, raw } = await createTestDb();
    const exact = JSON.stringify({
      message: 'text',
      imessagePlainTextV1: true,
      imessagePlainTextRetrySafeV1: true,
    });
    seedQueue(raw, { tempGuid: 'temp-retry-safe', payload: exact });
    seedQueue(raw, {
      tempGuid: 'temp-extra-key',
      payload: JSON.stringify({ ...JSON.parse(exact), extra: 1 }),
    });
    seedQueue(raw, {
      tempGuid: 'temp-not-safe',
      payload: JSON.stringify({ message: 'text', imessagePlainTextV1: true }),
    });
    seedQueue(raw, { tempGuid: 'temp-attachment', kind: 'attachment', payload: exact });
    const excluded = guids(
      await listRetryableOutgoing(db, NOW, undefined, false, false, undefined, true),
    ).sort();
    expect(excluded).toEqual(['temp-attachment', 'temp-extra-key', 'temp-not-safe']);
    expect(guids(await listRetryableOutgoing(db, NOW))).toHaveLength(4);
  });

  it('treats an undefined limit as all rows, a non-positive or non-finite limit as none, and floors a fraction', async () => {
    const { db, raw } = await createTestDb();
    for (const index of [1, 2, 3]) {
      seedQueue(raw, { tempGuid: `temp-${index}`, createdAt: OLD + index });
    }
    expect(guids(await listRetryableOutgoing(db, NOW))).toEqual(['temp-1', 'temp-2', 'temp-3']);
    expect(guids(await listRetryableOutgoing(db, NOW, 2))).toEqual(['temp-1', 'temp-2']);
    expect(guids(await listRetryableOutgoing(db, NOW, 2.9))).toEqual(['temp-1', 'temp-2']);
    expect(await listRetryableOutgoing(db, NOW, 0)).toEqual([]);
    expect(await listRetryableOutgoing(db, NOW, -1)).toEqual([]);
    expect(await listRetryableOutgoing(db, NOW, Number.NaN)).toEqual([]);
  });
});

async function seedTempMessage(
  db: TestDb,
  guid: string,
  chatGuid = 'iMessage;-;alice@x.com',
): Promise<void> {
  const handles = await upsertHandles(db, [{ address: 'alice@x.com' }]);
  const chatMap = await upsertChats(
    db,
    [Chat.parse({ guid: chatGuid, participants: [{ address: 'alice@x.com' }] })],
    handles,
  );
  await upsertMessages(
    db,
    [Message.parse({ guid, text: 'hello', isFromMe: true, dateCreated: NOW - 5_000 })],
    () => chatMap.get(chatGuid)!,
    handles,
  );
}

function messageState(raw: Database.Database, guid: string) {
  return raw
    .prepare(
      'SELECT send_state AS sendState, error, error_message AS errorMessage FROM messages WHERE guid = ?',
    )
    .get(guid) as { sendState: string; error: number; errorMessage: string | null } | undefined;
}

function queueState(raw: Database.Database, tempGuid: string) {
  return raw
    .prepare(
      'SELECT attempts, next_retry_at AS nextRetryAt FROM outgoing_queue WHERE temp_guid = ?',
    )
    .get(tempGuid) as { attempts: number; nextRetryAt: number } | undefined;
}

describe('markMessageSendErrorWithinTransaction', () => {
  it('marks an existing row, leaves the detail alone when omitted, clears it on null, and reports a missing guid', async () => {
    const { db, raw } = await createTestDb();
    await seedTempMessage(db, 'temp-mark');
    expect(
      await withDbTransaction(db, (_tx, context) =>
        markMessageSendErrorWithinTransaction(context, 'temp-mark', 7, 'boom'),
      ),
    ).toBe(true);
    expect(messageState(raw, 'temp-mark')).toEqual({
      sendState: 'error',
      error: 7,
      errorMessage: 'boom',
    });

    await withDbTransaction(db, (_tx, context) =>
      markMessageSendErrorWithinTransaction(context, 'temp-mark', 8),
    );
    expect(messageState(raw, 'temp-mark')).toEqual({
      sendState: 'error',
      error: 8,
      errorMessage: 'boom',
    });

    await withDbTransaction(db, (_tx, context) =>
      markMessageSendErrorWithinTransaction(context, 'temp-mark', 9, null),
    );
    expect(messageState(raw, 'temp-mark')).toEqual({
      sendState: 'error',
      error: 9,
      errorMessage: null,
    });

    expect(
      await withDbTransaction(db, (_tx, context) =>
        markMessageSendErrorWithinTransaction(context, 'temp-missing', 1),
      ),
    ).toBe(false);
  });
});

describe('reconcileOutgoingErrorWithinTransaction', () => {
  const reconcile = (
    db: TestDb,
    tempGuid: string,
    options: { token?: { generation: number }; code?: number } = {},
  ) =>
    withDbTransaction(db, (_tx, context) =>
      reconcileOutgoingErrorWithinTransaction(
        context,
        tempGuid,
        options.code ?? 42,
        NOW,
        undefined,
        options.token,
      ),
    );

  it('advances a legacy ladder exactly once per distinct failure and schedules the first backoff', async () => {
    const { db, raw } = await createTestDb();
    await seedTempMessage(db, 'temp-legacy');
    seedQueue(raw, { tempGuid: 'temp-legacy', attempts: 0, createdAt: NOW - 1_000 });

    expect(await reconcile(db, 'temp-legacy')).toBe(true);
    expect(messageState(raw, 'temp-legacy')?.sendState).toBe('error');
    expect(queueState(raw, 'temp-legacy')).toEqual({
      attempts: 1,
      nextRetryAt: NOW + outgoingBackoffMs(1),
    });

    // The socket and FCM copies of the same error must not consume two attempts.
    expect(await reconcile(db, 'temp-legacy')).toBe(true);
    expect(queueState(raw, 'temp-legacy')?.attempts).toBe(1);

    // A different failure code is a new failure and advances the ladder.
    expect(await reconcile(db, 'temp-legacy', { code: 43 })).toBe(true);
    expect(queueState(raw, 'temp-legacy')).toEqual({
      attempts: 2,
      nextRetryAt: NOW + outgoingBackoffMs(2),
    });
  });

  it('refuses to downgrade a modern row without its token, and honours the token only while that generation is pending', async () => {
    const { db, raw } = await createTestDb();
    await seedTempMessage(db, 'temp-modern');
    seedQueue(raw, { tempGuid: 'temp-modern', attempts: 0, createdAt: NOW - 1_000 });
    raw
      .prepare(
        'UPDATE messages SET attempt_owner_pending = 1, attempt_owner_generation = 2 WHERE guid = ?',
      )
      .run('temp-modern');

    expect(await reconcile(db, 'temp-modern')).toBe(false); // no token
    expect(await reconcile(db, 'temp-modern', { token: { generation: 3 } })).toBe(false); // wrong generation
    expect(queueState(raw, 'temp-modern')?.attempts).toBe(0);
    expect(messageState(raw, 'temp-modern')?.sendState).not.toBe('error');

    expect(await reconcile(db, 'temp-modern', { token: { generation: 2 } })).toBe(true);
    expect(queueState(raw, 'temp-modern')?.attempts).toBe(1);

    raw.prepare('UPDATE messages SET attempt_owner_pending = 0 WHERE guid = ?').run('temp-modern');
    expect(await reconcile(db, 'temp-modern', { token: { generation: 2 }, code: 44 })).toBe(false); // settled
    expect(queueState(raw, 'temp-modern')?.attempts).toBe(1);
  });

  it('follows a temp guid through its alias to the canonical message of the same chat', async () => {
    const { db, raw } = await createTestDb();
    await seedTempMessage(db, 'p:0/real-1');
    raw
      .prepare(
        'INSERT INTO message_guid_aliases (alias_guid, canonical_guid, chat_guid) VALUES (?, ?, ?)',
      )
      .run('temp-alias', 'p:0/real-1', 'iMessage;-;alice@x.com');
    seedQueue(raw, { tempGuid: 'temp-alias', attempts: 0, createdAt: NOW - 1_000 });

    expect(await reconcile(db, 'temp-alias')).toBe(true);
    expect(messageState(raw, 'p:0/real-1')?.sendState).toBe('error');
    expect(queueState(raw, 'temp-alias')?.attempts).toBe(1);
  });

  it('reports false, and never relabels a sent message, when the queue row is already gone', async () => {
    const { db, raw } = await createTestDb();
    await seedTempMessage(db, 'temp-settled');
    raw.prepare("UPDATE messages SET send_state = 'sent' WHERE guid = ?").run('temp-settled');
    expect(await reconcile(db, 'temp-settled')).toBe(false);
    expect(messageState(raw, 'temp-settled')?.sendState).toBe('sent');
    expect(await reconcile(db, 'temp-never-queued')).toBe(false);
  });
});
