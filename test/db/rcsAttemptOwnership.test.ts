import type Database from 'better-sqlite3';
import type { HttpClient } from '@core/api/http';
import { Chat } from '@core/models';
import type { EventDeliveryContext } from '@core/realtime';
import {
  applyServerSendErrorWithinTransaction,
  claimFailedOutgoingForRetry,
  claimOutgoingForSendWithinTransaction,
  getChatIdByGuid,
  insertOutgoingAttachment,
  insertOutgoingText,
  MESSAGE_GUID_ALIAS_LIMIT,
  OUTGOING_MAX_ATTEMPTS,
  reconcileExactOutgoingAttemptSuccess,
  reconcileOutgoingAttachmentByContent,
  reconcileOutgoingError,
  recordMessageGuidAliasWithinTransaction,
  upsertChats,
  upsertHandles,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { DbEventSink } from '@/services/realtime/dbEventSink';
import { IncomingEventDependencyPendingError } from '@/services/realtime/incomingEventErrors';
import { runOutgoingQueue } from '@/services/send/outgoingQueueService';
import { reconcileSendOutcome } from '@/services/send/sendOutcome';
import { createTestDb } from '../support/testDb';

const CHAT_GUID = 'RCS;-;attempt-owner-conversation';

type OwnerState = {
  guid: string;
  sendState: string;
  error: number;
  activeAttemptGuid: string | null;
  pending: number;
  generation: number;
};

function ownerState(raw: Database.Database, guid: string): OwnerState | undefined {
  return raw
    .prepare(
      `SELECT guid, send_state AS sendState, error,
              active_send_attempt_guid AS activeAttemptGuid,
              attempt_owner_pending AS pending,
              attempt_owner_generation AS generation
         FROM messages
        WHERE guid = ?`,
    )
    .get(guid) as OwnerState | undefined;
}

function queueState(raw: Database.Database, tempGuid: string) {
  return raw
    .prepare(
      `SELECT id, attempts, next_retry_at AS nextRetryAt
         FROM outgoing_queue
        WHERE temp_guid = ?`,
    )
    .get(tempGuid) as { id: number; attempts: number; nextRetryAt: number } | undefined;
}

async function seedChat(db: AppDatabase): Promise<number> {
  const handles = await upsertHandles(db, [{ address: 'attempt-owner@example.test' }]);
  await upsertChats(
    db,
    [
      Chat.parse({
        guid: CHAT_GUID,
        participants: [{ address: 'attempt-owner@example.test' }],
      }),
    ],
    handles,
  );
  return (await getChatIdByGuid(db, CHAT_GUID))!;
}

describe('RCS active send-attempt ownership', () => {
  it('keeps delayed attempt A outcomes from overwriting retry B', async () => {
    const { db, raw } = await createTestDb();
    try {
      const chatId = await seedChat(db);
      const tempGuid = 'temp-attempt-race';
      const inserted = await insertOutgoingText(db, {
        tempGuid,
        chatId,
        chatGuid: CHAT_GUID,
        text: 'one logical message',
        now: 1_000,
        attemptAware: true,
      });
      const attemptAOwner = inserted.attemptOwnerToken!;

      // A local failure leaves the same logical send retryable under generation 1.
      await reconcileOutgoingError(db, tempGuid, 502, 2_000, undefined, null, attemptAOwner);
      const queued = queueState(raw, tempGuid)!;
      expect(queued.attempts).toBe(1);

      // The automatic retry atomically advances ownership before request B begins.
      const retryB = await withDbTransaction(db, (context) =>
        claimOutgoingForSendWithinTransaction(context, queued.id, () => queued.nextRetryAt),
      );
      expect(retryB).toEqual({ claimed: true, attemptOwnerToken: { generation: 2 } });

      // A's late HTTP response holds generation 1 and therefore cannot install itself.
      await reconcileSendOutcome(
        db,
        tempGuid,
        {
          guid: tempGuid,
          viaPrivateApi: false,
          attemptGuid: 'attempt-a',
          clientAttemptGeneration: 1,
        },
        3_000,
        undefined,
        { attemptOwnerToken: attemptAOwner, failureNoticeMode: 'suppressed' },
      );
      expect(ownerState(raw, tempGuid)).toEqual({
        guid: tempGuid,
        sendState: 'sending',
        error: 0,
        activeAttemptGuid: null,
        pending: 1,
        generation: 2,
      });

      // A's exact pushed outcomes wait while B is unresolved; they become stale once B settles.
      const pendingError = await withDbTransaction(db, (context) =>
        applyServerSendErrorWithinTransaction(context, tempGuid, 502, 3_100, true, 'test', null, {
          tempGuid,
          attemptGuid: 'attempt-a',
          clientAttemptGeneration: 1,
        }),
      );
      expect(pendingError.disposition).toBe('attempt-owner-pending');
      await expect(
        reconcileExactOutgoingAttemptSuccess(db, {
          tempGuid,
          attemptGuid: 'attempt-a',
          clientAttemptGeneration: 1,
          guid: 'rcs-attempt-a',
          dateCreated: 3_100,
          dateDelivered: null,
        }),
      ).resolves.toBe('attempt-owner-pending');

      await reconcileSendOutcome(
        db,
        tempGuid,
        {
          guid: tempGuid,
          viaPrivateApi: false,
          attemptGuid: 'attempt-b',
          clientAttemptGeneration: 2,
        },
        4_000,
        undefined,
        { attemptOwnerToken: retryB.attemptOwnerToken, failureNoticeMode: 'suppressed' },
      );
      await expect(
        reconcileExactOutgoingAttemptSuccess(db, {
          tempGuid,
          attemptGuid: 'attempt-b',
          clientAttemptGeneration: 2,
          guid: 'rcs-attempt-b',
          dateCreated: 4_100,
          dateDelivered: null,
        }),
      ).resolves.toBe('reconciled');

      const staleError = await withDbTransaction(db, (context) =>
        applyServerSendErrorWithinTransaction(
          context,
          'rcs-attempt-a',
          502,
          4_200,
          true,
          'test',
          null,
          {
            tempGuid,
            attemptGuid: 'attempt-a',
            clientAttemptGeneration: 1,
          },
        ),
      );
      expect(staleError.disposition).toBe('stale-attempt');
      expect(ownerState(raw, 'rcs-attempt-b')).toEqual({
        guid: 'rcs-attempt-b',
        sendState: 'sent',
        error: 0,
        activeAttemptGuid: 'attempt-b',
        pending: 0,
        generation: 2,
      });
      expect(queueState(raw, tempGuid)).toBeUndefined();
    } finally {
      raw.close();
    }
  });

  it('keeps an older durable error uncheckpointed until the current attempt settles', async () => {
    const { db, raw } = await createTestDb();
    try {
      const chatId = await seedChat(db);
      const tempGuid = 'temp-durable-attempt-race';
      const inserted = await insertOutgoingText(db, {
        tempGuid,
        chatId,
        chatGuid: CHAT_GUID,
        text: 'durable ordering',
        now: 10_000,
        attemptAware: true,
      });
      await reconcileOutgoingError(
        db,
        tempGuid,
        502,
        11_000,
        undefined,
        null,
        inserted.attemptOwnerToken!,
      );
      const queued = queueState(raw, tempGuid)!;
      const retry = await withDbTransaction(db, (context) =>
        claimOutgoingForSendWithinTransaction(context, queued.id, () => queued.nextRetryAt),
      );

      const markDbAppliedWithinTransaction = jest.fn(async () => undefined);
      const context: EventDeliveryContext = {
        generation: 7,
        isCurrent: () => true,
        durableEvent: { dbAppliedAt: null, markDbAppliedWithinTransaction },
      };
      const event = {
        type: 'message-send-error' as const,
        payload: {
          guid: tempGuid,
          tempGuid,
          attemptGuid: 'attempt-a',
          clientAttemptGeneration: 1,
          error: 502,
          retryable: true,
        },
      };
      const sink = new DbEventSink(db);

      await expect(sink.onEvent(event, 'fcm', context)).rejects.toBeInstanceOf(
        IncomingEventDependencyPendingError,
      );
      expect(markDbAppliedWithinTransaction).not.toHaveBeenCalled();
      expect(ownerState(raw, tempGuid)?.sendState).toBe('sending');

      await reconcileSendOutcome(
        db,
        tempGuid,
        {
          guid: tempGuid,
          viaPrivateApi: false,
          attemptGuid: 'attempt-b',
          clientAttemptGeneration: 2,
        },
        12_000,
        undefined,
        { attemptOwnerToken: retry.attemptOwnerToken, failureNoticeMode: 'suppressed' },
      );
      await expect(sink.onEvent(event, 'fcm', context)).resolves.toBeUndefined();
      expect(markDbAppliedWithinTransaction).toHaveBeenCalledTimes(1);
      expect(ownerState(raw, tempGuid)?.sendState).toBe('sent');
    } finally {
      raw.close();
    }
  });

  it('rejects a partial modern ack while preserving legacy generation zero', async () => {
    const { db, raw } = await createTestDb();
    try {
      const chatId = await seedChat(db);
      const modernGuid = 'temp-modern-partial-ack';
      const modern = await insertOutgoingText(db, {
        tempGuid: modernGuid,
        chatId,
        chatGuid: CHAT_GUID,
        text: 'modern',
        now: 20_000,
        attemptAware: true,
      });
      await expect(
        reconcileSendOutcome(
          db,
          modernGuid,
          { guid: modernGuid, viaPrivateApi: false },
          20_100,
          undefined,
          { attemptOwnerToken: modern.attemptOwnerToken!, failureNoticeMode: 'suppressed' },
        ),
      ).rejects.toMatchObject({ kind: 'parse_error' });
      expect(ownerState(raw, modernGuid)).toMatchObject({ pending: 1, generation: 1 });
      expect(queueState(raw, modernGuid)).toBeDefined();

      const legacyGuid = 'temp-legacy-retry';
      await insertOutgoingText(db, {
        tempGuid: legacyGuid,
        chatId,
        chatGuid: CHAT_GUID,
        text: 'legacy',
        now: 21_000,
      });
      await reconcileOutgoingError(db, legacyGuid, 502, 21_100);
      const queued = queueState(raw, legacyGuid)!;
      const retry = await withDbTransaction(db, (context) =>
        claimOutgoingForSendWithinTransaction(context, queued.id, () => queued.nextRetryAt),
      );
      expect(retry).toEqual({ claimed: true });
      expect(ownerState(raw, legacyGuid)).toMatchObject({
        sendState: 'sending',
        pending: 0,
        generation: 0,
      });
    } finally {
      raw.close();
    }
  });

  it('keeps a queue-owned alias when the bounded stale-action history is pruned', async () => {
    const { db, raw } = await createTestDb();
    try {
      const insertAlias = raw.prepare(
        'INSERT INTO message_guid_aliases (alias_guid, canonical_guid) VALUES (?, ?)',
      );
      raw.transaction(() => {
        for (let i = 0; i < MESSAGE_GUID_ALIAS_LIMIT; i += 1) {
          const suffix = i.toString().padStart(4, '0');
          insertAlias.run(`temp-pinned-${suffix}`, `real-pinned-${suffix}`);
        }
        raw
          .prepare(
            `INSERT INTO outgoing_queue
               (temp_guid, chat_guid, kind, payload, attempts, created_at, next_retry_at)
             VALUES (?, ?, 'text', ?, 1, 1, 0)`,
          )
          .run('temp-pinned-0000', CHAT_GUID, JSON.stringify({ message: 'pinned' }));
      })();

      await withDbTransaction(db, (context) =>
        recordMessageGuidAliasWithinTransaction(context, 'temp-pinned-new-a', 'real-pinned-new-a'),
      );
      await withDbTransaction(db, (context) =>
        recordMessageGuidAliasWithinTransaction(context, 'temp-pinned-new-b', 'real-pinned-new-b'),
      );

      const hasAlias = (guid: string): boolean =>
        raw.prepare('SELECT 1 FROM message_guid_aliases WHERE alias_guid = ?').get(guid) != null;
      expect(hasAlias('temp-pinned-0000')).toBe(true);
      expect(hasAlias('temp-pinned-0001')).toBe(false);
      expect(hasAlias('temp-pinned-new-a')).toBe(true);
      expect(hasAlias('temp-pinned-new-b')).toBe(true);
      expect(
        (
          raw.prepare('SELECT COUNT(*) AS count FROM message_guid_aliases').get() as {
            count: number;
          }
        ).count,
      ).toBe(MESSAGE_GUID_ALIAS_LIMIT + 1);
    } finally {
      raw.close();
    }
  });

  it('retires ownerless retries without a POST while later legacy work still drains', async () => {
    const { db, raw } = await createTestDb();
    try {
      const chatId = await seedChat(db);
      const autoTempGuid = 'temp-ownerless-auto';
      const automatic = await insertOutgoingText(db, {
        tempGuid: autoTempGuid,
        chatId,
        chatGuid: CHAT_GUID,
        text: 'must not post without its owner',
        now: 50_000,
        attemptAware: true,
      });
      await reconcileOutgoingError(
        db,
        autoTempGuid,
        502,
        50_100,
        undefined,
        null,
        automatic.attemptOwnerToken!,
      );
      raw
        .prepare('UPDATE messages SET guid = ? WHERE guid = ?')
        .run('rcs-ownerless-auto', autoTempGuid);

      const legacyGuid = 'temp-after-ownerless';
      await insertOutgoingText(db, {
        tempGuid: legacyGuid,
        chatId,
        chatGuid: CHAT_GUID,
        text: 'legacy still sends',
        now: 50_200,
      });
      await reconcileOutgoingError(db, legacyGuid, 502, 50_300);

      const posted: { tempGuid?: string; clientAttemptGeneration?: number }[] = [];
      let http!: HttpClient;
      http = {
        post: async (_path: string, _schema: unknown, options: { json?: unknown }) => {
          posted.push(options.json as (typeof posted)[number]);
          return {
            guid: 'real-after-ownerless',
            dateCreated: 100_000,
            dateDelivered: null,
          };
        },
        pinTransport: () => http,
        assertTransportCurrent: () => undefined,
        isTransportCurrent: () => true,
      } as unknown as HttpClient;
      const result = await runOutgoingQueue(
        db,
        http,
        {
          upload: async () => {
            throw new Error('unexpected attachment upload');
          },
          fileExists: async () => true,
        },
        100_000,
      );

      expect(result).toEqual({ eligible: 2, sent: 1 });
      expect(posted).toHaveLength(1);
      expect(posted[0]).toMatchObject({
        tempGuid: legacyGuid,
        clientAttemptGeneration: undefined,
      });
      expect(queueState(raw, autoTempGuid)?.attempts).toBe(OUTGOING_MAX_ATTEMPTS);
      expect(queueState(raw, legacyGuid)).toBeUndefined();
      expect(ownerState(raw, 'real-after-ownerless')).toMatchObject({
        sendState: 'sent',
        generation: 0,
      });

      const manualTempGuid = 'temp-ownerless-manual';
      const manual = await insertOutgoingText(db, {
        tempGuid: manualTempGuid,
        chatId,
        chatGuid: CHAT_GUID,
        text: 'manual must also retire',
        now: 110_000,
        attemptAware: true,
      });
      await reconcileOutgoingError(
        db,
        manualTempGuid,
        502,
        110_100,
        undefined,
        null,
        manual.attemptOwnerToken!,
      );
      raw
        .prepare('UPDATE messages SET guid = ? WHERE guid = ?')
        .run('rcs-ownerless-manual', manualTempGuid);

      await expect(claimFailedOutgoingForRetry(db, manualTempGuid)).resolves.toEqual({
        claim: 'settled',
      });
      expect(queueState(raw, manualTempGuid)?.attempts).toBe(OUTGOING_MAX_ATTEMPTS);
    } finally {
      raw.close();
    }
  });

  it('restores a pruned alias before rebuilding and claiming an attachment retry', async () => {
    const { db, raw } = await createTestDb();
    try {
      const chatId = await seedChat(db);
      const tempGuid = 'temp-replayed-owner';
      const inserted = await insertOutgoingAttachment(db, {
        tempGuid,
        attachmentGuid: `${tempGuid}-att`,
        chatId,
        chatGuid: CHAT_GUID,
        localPath: 'file:///retained-retry.jpg',
        mimeType: 'image/jpeg',
        transferName: 'retained-retry.jpg',
        totalBytes: 10,
        now: 30_000,
        attemptAware: true,
      });
      await reconcileOutgoingError(
        db,
        tempGuid,
        502,
        30_100,
        undefined,
        null,
        inserted.attemptOwnerToken!,
      );
      const queued = queueState(raw, tempGuid)!;
      const retry = await withDbTransaction(db, (context) =>
        claimOutgoingForSendWithinTransaction(context, queued.id, () => queued.nextRetryAt),
      );

      // The server replay belongs to its original physical attempt/generation. The request-local
      // token is what fences this response into retry B's current durable generation.
      await reconcileSendOutcome(
        db,
        tempGuid,
        {
          guid: tempGuid,
          viaPrivateApi: false,
          attemptGuid: 'attempt-retained-a',
          clientAttemptGeneration: 1,
        },
        30_200,
        undefined,
        { attemptOwnerToken: retry.attemptOwnerToken, failureNoticeMode: 'suppressed' },
      );
      expect(ownerState(raw, tempGuid)).toMatchObject({
        activeAttemptGuid: 'attempt-retained-a',
        pending: 0,
        generation: 2,
      });

      await reconcileExactOutgoingAttemptSuccess(db, {
        tempGuid,
        attemptGuid: 'attempt-retained-a',
        clientAttemptGeneration: 1,
        guid: 'rcs-retained-a',
        dateCreated: 30_300,
        dateDelivered: null,
      });
      raw.prepare('DELETE FROM message_guid_aliases WHERE alias_guid = ?').run(tempGuid);
      const afterPrune = await withDbTransaction(db, (context) =>
        applyServerSendErrorWithinTransaction(
          context,
          'attempt-retained-a',
          502,
          30_400,
          true,
          'test',
          null,
          {
            tempGuid,
            attemptGuid: 'attempt-retained-a',
            clientAttemptGeneration: 1,
          },
        ),
      );
      expect(afterPrune.disposition).toBe('applied');
      afterPrune.onCommitted?.();
      expect(ownerState(raw, 'rcs-retained-a')?.sendState).toBe('error');
      expect(
        raw
          .prepare(
            'SELECT canonical_guid AS canonicalGuid FROM message_guid_aliases WHERE alias_guid = ?',
          )
          .get(tempGuid),
      ).toEqual({ canonicalGuid: 'rcs-retained-a' });
      const rebuilt = queueState(raw, tempGuid)!;
      expect(rebuilt.attempts).toBe(1);
      await expect(
        withDbTransaction(db, (context) =>
          claimOutgoingForSendWithinTransaction(context, rebuilt.id, () => rebuilt.nextRetryAt),
        ),
      ).resolves.toEqual({ claimed: true, attemptOwnerToken: { generation: 3 } });
    } finally {
      raw.close();
    }
  });

  it('never content-matches a modern attachment when its exact tuple is absent', async () => {
    const { db, raw } = await createTestDb();
    try {
      const chatId = await seedChat(db);
      await insertOutgoingAttachment(db, {
        tempGuid: 'temp-modern-attachment',
        attachmentGuid: 'temp-modern-attachment-att',
        chatId,
        chatGuid: CHAT_GUID,
        localPath: 'file:///modern.jpg',
        mimeType: 'image/jpeg',
        transferName: 'modern.jpg',
        totalBytes: 10,
        now: 40_000,
        attemptAware: true,
      });

      await expect(
        reconcileOutgoingAttachmentByContent(
          db,
          {
            guid: 'rcs-history-lookalike',
            isFromMe: true,
            text: null,
            dateCreated: 40_100,
          },
          chatId,
        ),
      ).resolves.toBeNull();
      expect(ownerState(raw, 'temp-modern-attachment')).toMatchObject({
        pending: 1,
        generation: 1,
      });
      expect(ownerState(raw, 'rcs-history-lookalike')).toBeUndefined();
    } finally {
      raw.close();
    }
  });
});
