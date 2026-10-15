import type Database from 'better-sqlite3';
import type { HttpClient } from '@core/api/http';
import { Chat } from '@core/models';
import type { EventDeliveryContext } from '@core/realtime';
import {
  applyServerSendErrorWithinTransaction,
  cancelOutgoing,
  claimFailedOutgoingForRetry,
  claimOutgoingForSendWithinTransaction,
  deleteChatLocal,
  getChatIdByGuid,
  insertOutgoingText,
  MESSAGE_GUID_ALIAS_LIMIT,
  OUTGOING_MAX_ATTEMPTS,
  reconcileOutgoingAttachmentByContent,
  reconcileOutgoingError,
  recordMessageGuidAliasWithinTransaction,
  restoreDeletedChatWithinTransaction,
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
import {
  insertOutgoingAttachment,
  reconcileExactOutgoingAttemptSuccess,
} from '../support/repositoryWrappers';

const RCS_PROVIDER_EPOCH = `gpe1_${'A'.repeat(43)}`;
const RCS_PROVIDER_INFO = {
  rcs: true,
  supports_rcs_epoch_qualified_ids: true,
  rcs_provider_epoch: RCS_PROVIDER_EPOCH,
} as const;
const CHAT_GUID = `RCS;-;g1.${RCS_PROVIDER_EPOCH}.YQ`;

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
  const handles = await upsertHandles(db, [
    { address: 'attempt-owner@example.test', service: 'RCS' },
  ]);
  await upsertChats(
    db,
    [
      Chat.parse({
        guid: CHAT_GUID,
        providerEpoch: RCS_PROVIDER_EPOCH,
        participants: [{ address: 'attempt-owner@example.test', service: 'RCS' }],
      }),
    ],
    handles,
  );
  return (await getChatIdByGuid(db, CHAT_GUID))!;
}

describe('RCS active send-attempt ownership', () => {
  it('keeps a send hidden when its late ack arrives after the whole chat was deleted', async () => {
    const { db, raw } = await createTestDb();
    try {
      const chatId = await seedChat(db);
      const tempGuid = 'temp-chat-deleted-mid-send';
      const inserted = await insertOutgoingText(db, {
        tempGuid,
        chatId,
        chatGuid: CHAT_GUID,
        text: 'sent just before the chat was deleted',
        now: 1_000,
        attemptAware: true,
      });
      // No cancel: deleting the chat purges the in-flight send's rows and records only the chat's
      // history boundary, with no per-message deletion record.
      await deleteChatLocal(db, CHAT_GUID, 2_500);
      expect(ownerState(raw, tempGuid)).toBeUndefined();
      expect(queueState(raw, tempGuid)).toBeUndefined();

      await reconcileSendOutcome(
        db,
        tempGuid,
        {
          guid: tempGuid,
          attemptGuid: 'attempt-chat-deleted',
          clientAttemptGeneration: inserted.attemptOwnerToken!.generation,
        },
        3_000,
        undefined,
        {
          attemptOwnerToken: inserted.attemptOwnerToken!,
          expectedChatGuid: CHAT_GUID,
          failureNoticeMode: 'suppressed',
        },
      );

      const row = () =>
        raw
          .prepare(
            'SELECT date_created AS dateCreated, date_deleted AS dateDeleted FROM messages WHERE guid = ?',
          )
          .get(tempGuid);
      // It stays inside the deleted history, so it neither shows nor brings the chat back.
      expect(row()).toEqual({ dateCreated: 2_500, dateDeleted: 2_500 });
      expect(
        raw.prepare('SELECT deleted_at AS deletedAt FROM chats WHERE guid = ?').get(CHAT_GUID),
      ).toEqual({ deletedAt: 2_500 });

      // An explicit restore brings it back with the rest of the history.
      await expect(
        withDbTransaction(db, (context) =>
          restoreDeletedChatWithinTransaction(context, {
            guid: CHAT_GUID,
            expectedDeletedAt: 2_500,
            historyExhausted: true,
            repairedReadFloor: null,
          }),
        ),
      ).resolves.toBe(true);
      expect(row()).toEqual({ dateCreated: 2_500, dateDeleted: null });
    } finally {
      raw.close();
    }
  });

  it('recreates the exact chat owner when a capable ack arrives after local purge', async () => {
    const { db, raw } = await createTestDb();
    try {
      const chatId = await seedChat(db);
      const tempGuid = 'temp-capable-purge-ack';
      const realGuid = 'rcs-capable-purge-echo';
      const inserted = await insertOutgoingText(db, {
        tempGuid,
        chatId,
        chatGuid: CHAT_GUID,
        text: 'cancelled while capable request is in flight',
        now: 1_000,
        attemptAware: true,
      });
      await cancelOutgoing(db, tempGuid, 2_000);
      await deleteChatLocal(db, CHAT_GUID, 2_500);
      expect(ownerState(raw, tempGuid)).toBeUndefined();
      expect(queueState(raw, tempGuid)).toBeUndefined();

      await reconcileSendOutcome(
        db,
        tempGuid,
        {
          guid: tempGuid,
          attemptGuid: 'attempt-capable-purge',
          clientAttemptGeneration: inserted.attemptOwnerToken!.generation,
        },
        3_000,
        undefined,
        {
          attemptOwnerToken: inserted.attemptOwnerToken!,
          expectedChatGuid: CHAT_GUID,
          failureNoticeMode: 'suppressed',
        },
      );

      expect(ownerState(raw, tempGuid)).toEqual({
        guid: tempGuid,
        sendState: 'sent',
        error: 0,
        activeAttemptGuid: 'attempt-capable-purge',
        pending: 0,
        generation: inserted.attemptOwnerToken!.generation,
      });
      expect(
        raw
          .prepare('SELECT date_deleted AS dateDeleted FROM messages WHERE guid = ?')
          .get(tempGuid),
      ).toEqual({ dateDeleted: 2_000 });

      await expect(
        reconcileExactOutgoingAttemptSuccess(db, {
          tempGuid,
          attemptGuid: 'attempt-capable-purge',
          clientAttemptGeneration: inserted.attemptOwnerToken!.generation,
          guid: realGuid,
          dateCreated: 3_100,
          dateDelivered: null,
        }),
      ).resolves.toBe('reconciled');

      expect(ownerState(raw, tempGuid)).toBeUndefined();
      expect(ownerState(raw, realGuid)).toMatchObject({
        guid: realGuid,
        sendState: 'sent',
        activeAttemptGuid: 'attempt-capable-purge',
      });
      expect(
        raw
          .prepare('SELECT date_deleted AS dateDeleted FROM messages WHERE guid = ?')
          .get(realGuid),
      ).toEqual({ dateDeleted: 2_000 });
    } finally {
      raw.close();
    }
  });

  it('settles a conflicting duplicate exact success without replacing its canonical owner', async () => {
    const { db, raw } = await createTestDb();
    try {
      const chatId = await seedChat(db);
      const tempGuid = 'temp-conflicting-exact-success';
      const firstCanonicalGuid = 'rcs-first-canonical-owner';
      const inserted = await insertOutgoingText(db, {
        tempGuid,
        chatId,
        chatGuid: CHAT_GUID,
        text: 'one physical RCS send',
        now: 1_000,
        attemptAware: true,
      });
      const exactOwner = {
        tempGuid,
        attemptGuid: 'attempt-conflicting-exact-success',
        clientAttemptGeneration: inserted.attemptOwnerToken!.generation,
        dateCreated: 1_100,
        dateDelivered: null,
      };

      await expect(
        reconcileExactOutgoingAttemptSuccess(db, {
          ...exactOwner,
          guid: firstCanonicalGuid,
        }),
      ).resolves.toBe('reconciled');
      raw
        .prepare(
          `UPDATE messages
              SET send_state = 'sending', active_send_attempt_guid = 'retained-attempt-owner',
                  attempt_owner_pending = 1, attempt_owner_generation = 2
            WHERE guid = ?`,
        )
        .run(firstCanonicalGuid);
      raw
        .prepare(
          `INSERT INTO outgoing_queue (temp_guid, chat_guid, kind, payload, attempts, next_retry_at)
           VALUES (?, ?, 'text', '{}', 0, 0)`,
        )
        .run(tempGuid, CHAT_GUID);
      await expect(
        reconcileExactOutgoingAttemptSuccess(db, {
          ...exactOwner,
          attemptGuid: 'disputed-attempt-owner',
          clientAttemptGeneration: 2,
          guid: 'rcs-conflicting-canonical-owner',
        }),
      ).resolves.toBe('owner-conflict');

      expect(ownerState(raw, firstCanonicalGuid)).toEqual({
        guid: firstCanonicalGuid,
        sendState: 'sent',
        error: 0,
        activeAttemptGuid: 'retained-attempt-owner',
        pending: 0,
        generation: 2,
      });
      expect(queueState(raw, tempGuid)).toBeUndefined();
      expect(ownerState(raw, 'rcs-conflicting-canonical-owner')).toBeUndefined();
      expect(
        raw
          .prepare(
            `SELECT canonical_guid AS canonicalGuid, chat_guid AS chatGuid
               FROM message_guid_aliases
              WHERE alias_guid = ?`,
          )
          .get(tempGuid),
      ).toEqual({ canonicalGuid: firstCanonicalGuid, chatGuid: CHAT_GUID });
    } finally {
      raw.close();
    }
  });

  it('settles only a proven temp source when its alias reserves another canonical identity', async () => {
    const { db, raw } = await createTestDb();
    try {
      const chatId = await seedChat(db);
      const tempGuid = 'temp-direct-alias-conflict';
      const inserted = await insertOutgoingText(db, {
        tempGuid,
        chatId,
        chatGuid: CHAT_GUID,
        text: 'do not send twice',
        now: 2_000,
        attemptAware: true,
      });
      raw
        .prepare(
          `INSERT INTO message_guid_aliases (alias_guid, canonical_guid, chat_guid)
           VALUES (?, 'rcs-reserved-canonical', ?)`,
        )
        .run(tempGuid, CHAT_GUID);

      await expect(
        reconcileExactOutgoingAttemptSuccess(db, {
          tempGuid,
          attemptGuid: 'attempt-direct-alias-conflict',
          clientAttemptGeneration: inserted.attemptOwnerToken!.generation,
          guid: 'rcs-disputed-canonical',
          dateCreated: 2_100,
          dateDelivered: null,
        }),
      ).resolves.toBe('owner-conflict');

      expect(ownerState(raw, tempGuid)).toEqual({
        guid: tempGuid,
        sendState: 'sent',
        error: 0,
        activeAttemptGuid: null,
        pending: 0,
        generation: inserted.attemptOwnerToken!.generation,
      });
      expect(queueState(raw, tempGuid)).toBeUndefined();
      expect(ownerState(raw, 'rcs-disputed-canonical')).toBeUndefined();
      expect(
        raw
          .prepare(
            `SELECT canonical_guid AS canonicalGuid, chat_guid AS chatGuid
               FROM message_guid_aliases
              WHERE alias_guid = ?`,
          )
          .get(tempGuid),
      ).toEqual({ canonicalGuid: 'rcs-reserved-canonical', chatGuid: CHAT_GUID });
    } finally {
      raw.close();
    }
  });

  it('never installs exact success or error ownership through a NULL-scoped alias fallback', async () => {
    const { db, raw } = await createTestDb();
    try {
      const chatId = await seedChat(db);
      const tempGuid = 'temp-null-alias-fallback';
      const canonicalGuid = 'rcs-null-alias-canonical';
      const inserted = await insertOutgoingText(db, {
        tempGuid,
        chatId,
        chatGuid: CHAT_GUID,
        text: 'quarantined legacy alias',
        now: 3_000,
        attemptAware: true,
      });
      await expect(
        reconcileExactOutgoingAttemptSuccess(db, {
          tempGuid,
          attemptGuid: 'attempt-before-null-quarantine',
          clientAttemptGeneration: inserted.attemptOwnerToken!.generation,
          guid: canonicalGuid,
          dateCreated: 3_100,
          dateDelivered: null,
        }),
      ).resolves.toBe('reconciled');
      raw
        .prepare(`UPDATE message_guid_aliases SET chat_guid = NULL WHERE alias_guid = ?`)
        .run(tempGuid);
      raw
        .prepare(
          `UPDATE messages
              SET send_state = 'sending', active_send_attempt_guid = 'retained-before-quarantine',
                  attempt_owner_pending = 1, attempt_owner_generation = 2
            WHERE guid = ?`,
        )
        .run(canonicalGuid);
      raw
        .prepare(
          `INSERT INTO outgoing_queue (temp_guid, chat_guid, kind, payload, attempts, next_retry_at)
           VALUES (?, ?, 'text', '{}', 0, 0)`,
        )
        .run(tempGuid, CHAT_GUID);

      await expect(
        reconcileExactOutgoingAttemptSuccess(db, {
          tempGuid,
          attemptGuid: 'attempt-must-not-install',
          clientAttemptGeneration: 2,
          guid: canonicalGuid,
          dateCreated: 3_200,
          dateDelivered: null,
        }),
      ).resolves.toBe('owner-conflict');
      expect(ownerState(raw, canonicalGuid)).toEqual({
        guid: canonicalGuid,
        sendState: 'sending',
        error: 0,
        activeAttemptGuid: 'retained-before-quarantine',
        pending: 1,
        generation: 2,
      });
      expect(queueState(raw, tempGuid)).toBeUndefined();

      raw
        .prepare(
          `INSERT INTO outgoing_queue (temp_guid, chat_guid, kind, payload, attempts, next_retry_at)
           VALUES (?, ?, 'text', '{}', 0, 0)`,
        )
        .run(tempGuid, CHAT_GUID);
      const errorResult = await withDbTransaction(db, (context) =>
        applyServerSendErrorWithinTransaction(
          context,
          canonicalGuid,
          502,
          3_300,
          true,
          'test',
          null,
          {
            tempGuid,
            attemptGuid: 'error-attempt-must-not-install',
            clientAttemptGeneration: 2,
          },
        ),
      );
      expect(errorResult).toEqual({
        matched: true,
        disposition: 'owner-conflict',
        onCommitted: null,
      });
      expect(ownerState(raw, canonicalGuid)).toEqual({
        guid: canonicalGuid,
        sendState: 'sending',
        error: 0,
        activeAttemptGuid: 'retained-before-quarantine',
        pending: 1,
        generation: 2,
      });
      expect(queueState(raw, tempGuid)).toBeUndefined();
      expect(
        raw
          .prepare(
            `SELECT canonical_guid AS canonicalGuid, chat_guid AS chatGuid
               FROM message_guid_aliases
              WHERE alias_guid = ?`,
          )
          .get(tempGuid),
      ).toEqual({ canonicalGuid, chatGuid: null });
    } finally {
      raw.close();
    }
  });

  it('keeps a sticky server error retryable when an HTTP ack has a disputed canonical identity', async () => {
    const { db, raw } = await createTestDb();
    try {
      const chatId = await seedChat(db);
      const tempGuid = 'temp-sticky-ack-conflict';
      const inserted = await insertOutgoingText(db, {
        tempGuid,
        chatId,
        chatGuid: CHAT_GUID,
        text: 'error committed before ack',
        now: 4_000,
        attemptAware: true,
      });
      raw
        .prepare(
          `INSERT INTO message_guid_aliases (alias_guid, canonical_guid, chat_guid)
           VALUES (?, 'rcs-retained-before-ack', ?)`,
        )
        .run(tempGuid, CHAT_GUID);
      raw
        .prepare(
          `UPDATE messages
              SET send_state = 'error', error = 502, error_message = 'bounded server failure'
            WHERE guid = ?`,
        )
        .run(tempGuid);

      await expect(
        reconcileSendOutcome(
          db,
          tempGuid,
          {
            guid: 'rcs-disputed-http-ack',
            attemptGuid: 'attempt-sticky-ack-conflict',
            clientAttemptGeneration: inserted.attemptOwnerToken!.generation,
          },
          4_100,
          undefined,
          {
            attemptOwnerToken: inserted.attemptOwnerToken!,
            expectedChatGuid: CHAT_GUID,
            failureNoticeMode: 'suppressed',
          },
        ),
      ).resolves.toBeUndefined();

      expect(ownerState(raw, tempGuid)).toEqual({
        guid: tempGuid,
        sendState: 'error',
        error: 502,
        activeAttemptGuid: null,
        pending: 0,
        generation: inserted.attemptOwnerToken!.generation,
      });
      expect(queueState(raw, tempGuid)).toBeDefined();
      expect(ownerState(raw, 'rcs-disputed-http-ack')).toBeUndefined();
    } finally {
      raw.close();
    }
  });

  it('does not retry a confirmed HTTP ack when only a foreign canonical ledger remains', async () => {
    const { db, raw } = await createTestDb();
    try {
      const chatId = await seedChat(db);
      const tempGuid = 'temp-purged-ack-ledger-conflict';
      const canonicalGuid = 'rcs-purged-ack-ledger-conflict';
      const inserted = await insertOutgoingText(db, {
        tempGuid,
        chatId,
        chatGuid: CHAT_GUID,
        text: 'confirmed before local purge',
        now: 5_000,
        attemptAware: true,
      });
      raw.prepare("INSERT INTO chats (guid) VALUES ('RCS;-;foreign-ledger-owner')").run();
      raw
        .prepare(
          `INSERT INTO message_deletion_ledger (guid, date_deleted, chat_guid)
           VALUES (?, 5_050, 'RCS;-;foreign-ledger-owner')`,
        )
        .run(canonicalGuid);
      raw.prepare('DELETE FROM messages WHERE guid = ?').run(tempGuid);

      await expect(
        reconcileSendOutcome(
          db,
          tempGuid,
          {
            guid: canonicalGuid,
            attemptGuid: 'attempt-purged-ack-ledger-conflict',
            clientAttemptGeneration: inserted.attemptOwnerToken!.generation,
          },
          5_100,
          undefined,
          {
            attemptOwnerToken: inserted.attemptOwnerToken!,
            expectedChatGuid: CHAT_GUID,
            failureNoticeMode: 'suppressed',
          },
        ),
      ).resolves.toBeUndefined();

      expect(queueState(raw, tempGuid)).toBeUndefined();
      expect(ownerState(raw, canonicalGuid)).toBeUndefined();
      expect(
        raw
          .prepare(
            `SELECT date_deleted AS dateDeleted, chat_guid AS chatGuid
               FROM message_deletion_ledger
              WHERE guid = ?`,
          )
          .get(canonicalGuid),
      ).toEqual({ dateDeleted: 5_050, chatGuid: 'RCS;-;foreign-ledger-owner' });
    } finally {
      raw.close();
    }
  });

  it('keeps the queued source untouched when an HTTP ack claims a different chat', async () => {
    const { db, raw } = await createTestDb();
    try {
      const chatId = await seedChat(db);
      const tempGuid = 'temp-purged-ack-chat-conflict';
      const inserted = await insertOutgoingText(db, {
        tempGuid,
        chatId,
        chatGuid: CHAT_GUID,
        text: 'retain the legitimate queue owner',
        now: 6_000,
        attemptAware: true,
      });
      raw.prepare("INSERT INTO chats (guid) VALUES ('RCS;-;wrong-ack-chat')").run();
      raw.prepare('DELETE FROM messages WHERE guid = ?').run(tempGuid);

      await expect(
        reconcileSendOutcome(
          db,
          tempGuid,
          {
            guid: 'rcs-wrong-ack-chat-canonical',
            attemptGuid: 'attempt-wrong-ack-chat',
            clientAttemptGeneration: inserted.attemptOwnerToken!.generation,
          },
          6_100,
          undefined,
          {
            attemptOwnerToken: inserted.attemptOwnerToken!,
            expectedChatGuid: 'RCS;-;wrong-ack-chat',
            failureNoticeMode: 'suppressed',
          },
        ),
      ).resolves.toBeUndefined();

      expect(queueState(raw, tempGuid)).toBeDefined();
      expect(ownerState(raw, 'rcs-wrong-ack-chat-canonical')).toBeUndefined();
    } finally {
      raw.close();
    }
  });

  it('does not recreate a purged temp row through a retained alias on a no-GUID HTTP ack', async () => {
    const { db, raw } = await createTestDb();
    try {
      const chatId = await seedChat(db);
      const tempGuid = 'temp-purged-no-guid-retained-alias';
      const inserted = await insertOutgoingText(db, {
        tempGuid,
        chatId,
        chatGuid: CHAT_GUID,
        text: 'do not resurrect this temp row',
        now: 7_000,
        attemptAware: true,
      });
      raw
        .prepare(
          `INSERT INTO message_guid_aliases (alias_guid, canonical_guid, chat_guid)
           VALUES (?, 'rcs-retained-no-guid-owner', NULL)`,
        )
        .run(tempGuid);
      raw.prepare('DELETE FROM messages WHERE guid = ?').run(tempGuid);

      await expect(
        reconcileSendOutcome(
          db,
          tempGuid,
          {
            guid: tempGuid,
            attemptGuid: 'attempt-purged-no-guid-retained-alias',
            clientAttemptGeneration: inserted.attemptOwnerToken!.generation,
          },
          7_100,
          undefined,
          {
            attemptOwnerToken: inserted.attemptOwnerToken!,
            expectedChatGuid: CHAT_GUID,
            failureNoticeMode: 'suppressed',
          },
        ),
      ).resolves.toBeUndefined();

      expect(queueState(raw, tempGuid)).toBeUndefined();
      expect(ownerState(raw, tempGuid)).toBeUndefined();
      expect(
        raw
          .prepare(
            `SELECT canonical_guid AS canonicalGuid, chat_guid AS chatGuid
               FROM message_guid_aliases
              WHERE alias_guid = ?`,
          )
          .get(tempGuid),
      ).toEqual({ canonicalGuid: 'rcs-retained-no-guid-owner', chatGuid: null });
    } finally {
      raw.close();
    }
  });

  it('does not adopt a NULL alias or duplicate its existing canonical row on an HTTP ack', async () => {
    const { db, raw } = await createTestDb();
    try {
      const chatId = await seedChat(db);
      const tempGuid = 'temp-purged-distinct-null-alias';
      const canonicalGuid = 'rcs-existing-null-alias-canonical';
      const inserted = await insertOutgoingText(db, {
        tempGuid,
        chatId,
        chatGuid: CHAT_GUID,
        text: 'preserve the existing canonical row',
        now: 8_000,
        attemptAware: true,
      });
      raw
        .prepare(
          `INSERT INTO messages (guid, chat_id, is_from_me, text, send_state)
           VALUES (?, ?, 1, 'retained canonical content', 'sent')`,
        )
        .run(canonicalGuid, chatId);
      raw
        .prepare(
          `INSERT INTO message_guid_aliases (alias_guid, canonical_guid, chat_guid)
           VALUES (?, ?, NULL)`,
        )
        .run(tempGuid, canonicalGuid);
      raw.prepare('DELETE FROM messages WHERE guid = ?').run(tempGuid);

      await expect(
        reconcileSendOutcome(
          db,
          tempGuid,
          {
            guid: canonicalGuid,
            attemptGuid: 'attempt-purged-distinct-null-alias',
            clientAttemptGeneration: inserted.attemptOwnerToken!.generation,
          },
          8_100,
          undefined,
          {
            attemptOwnerToken: inserted.attemptOwnerToken!,
            expectedChatGuid: CHAT_GUID,
            failureNoticeMode: 'suppressed',
          },
        ),
      ).resolves.toBeUndefined();

      expect(queueState(raw, tempGuid)).toBeUndefined();
      expect(
        raw
          .prepare(
            `SELECT text, active_send_attempt_guid AS activeAttemptGuid,
                    attempt_owner_pending AS pending
               FROM messages
              WHERE guid = ?`,
          )
          .get(canonicalGuid),
      ).toEqual({ text: 'retained canonical content', activeAttemptGuid: null, pending: 0 });
      expect(
        raw
          .prepare(
            `SELECT canonical_guid AS canonicalGuid, chat_guid AS chatGuid
               FROM message_guid_aliases
              WHERE alias_guid = ?`,
          )
          .get(tempGuid),
      ).toEqual({ canonicalGuid, chatGuid: null });
    } finally {
      raw.close();
    }
  });

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
      expect(retryB).toEqual({
        claimed: true,
        attemptOwnerToken: { generation: 2 },
        deferToken: expect.objectContaining({
          queueId: queued.id,
          tempGuid,
          previousAttempts: 1,
          ownerGuid: tempGuid,
          ownerGeneration: 2,
        }),
      });

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
          chatGuid: CHAT_GUID,
          error: 502,
          retryable: true,
        },
      };
      const sink = new DbEventSink(db, undefined, undefined, undefined, () => RCS_PROVIDER_INFO);

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
      expect(retry).toEqual({
        claimed: true,
        deferToken: expect.objectContaining({
          queueId: queued.id,
          tempGuid: legacyGuid,
          previousAttempts: 1,
          ownerGuid: legacyGuid,
          ownerGeneration: 0,
        }),
      });
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
        recordMessageGuidAliasWithinTransaction(
          context,
          'temp-pinned-new-a',
          'real-pinned-new-a',
          CHAT_GUID,
        ),
      );
      await withDbTransaction(db, (context) =>
        recordMessageGuidAliasWithinTransaction(
          context,
          'temp-pinned-new-b',
          'real-pinned-new-b',
          CHAT_GUID,
        ),
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
            guid: `rcs-g1.${RCS_PROVIDER_EPOCH}.Yg`,
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
        undefined,
        undefined,
        undefined,
        undefined,
        (chatGuid) => chatGuid == null || chatGuid === CHAT_GUID,
      );

      expect(result).toEqual({ eligible: 2, sent: 1 });
      expect(posted).toHaveLength(1);
      expect(posted[0]).toMatchObject({
        tempGuid: legacyGuid,
        clientAttemptGeneration: undefined,
      });
      expect(queueState(raw, autoTempGuid)?.attempts).toBe(OUTGOING_MAX_ATTEMPTS);
      expect(queueState(raw, legacyGuid)).toBeUndefined();
      expect(ownerState(raw, `rcs-g1.${RCS_PROVIDER_EPOCH}.Yg`)).toMatchObject({
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

      await expect(
        claimFailedOutgoingForRetry(
          db,
          manualTempGuid,
          Date.now,
          undefined,
          undefined,
          undefined,
          (chatGuid) => chatGuid === CHAT_GUID,
        ),
      ).resolves.toEqual({ claim: 'settled' });
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
      ).resolves.toEqual({
        claimed: true,
        attemptOwnerToken: { generation: 3 },
        deferToken: expect.objectContaining({
          queueId: rebuilt.id,
          tempGuid,
          previousAttempts: 1,
          ownerGuid: 'rcs-retained-a',
          ownerGeneration: 3,
        }),
      });
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
