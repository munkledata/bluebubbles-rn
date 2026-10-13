import { Chat, Message } from '@core/models';
import {
  claimFailedOutgoingForRetry,
  countOutgoingQueueHealth,
  insertOutgoingText,
  reconcileOutgoingError,
  reconcileOutgoingSuccess,
  resolveMessageTarget,
  retireUncertainOutgoingWithinTransaction,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import { localRouteForMessageGuid } from '@/services/notifications/notificationRouting';
import { createTestDb } from '../support/testDb';
import {
  claimOutgoingForSend,
  deleteMessageLocal,
  retireOutgoing,
} from '../support/repositoryWrappers';

describe('FEAT-06 legacy alias ownership quarantine', () => {
  it('never lets a NULL-scoped alias route, target, retry, retire, or delete a foreign message', async () => {
    const { db, raw } = await createTestDb();
    const handles = await upsertHandles(db, [
      { address: '+15550000001', service: 'SMS' },
      { address: '+15550000002', service: 'RCS' },
    ]);
    const chatIds = await upsertChats(
      db,
      [
        Chat.parse({
          guid: 'SMS;-;+15550000001',
          participants: [{ address: '+15550000001', service: 'SMS' }],
        }),
        Chat.parse({
          guid: 'RCS;-;google-conversation-2',
          participants: [{ address: '+15550000002', service: 'RCS' }],
        }),
      ],
      handles,
    );
    const appleChatId = chatIds.get('SMS;-;+15550000001')!;
    const googleChatId = chatIds.get('RCS;-;google-conversation-2')!;
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'foreign-canonical-owner',
          text: 'must remain in the Apple conversation',
          dateCreated: 1,
          isFromMe: true,
        }),
      ],
      () => appleChatId,
      handles,
    );
    raw
      .prepare(
        `UPDATE messages
            SET send_state = 'sending', error = 0, error_message = NULL
          WHERE guid = 'foreign-canonical-owner'`,
      )
      .run();
    await insertOutgoingText(db, {
      tempGuid: 'temp-ownerless-alias',
      chatId: googleChatId,
      chatGuid: 'RCS;-;google-conversation-2',
      text: 'Google queue payload',
      now: 10,
    });
    const queue = raw
      .prepare("SELECT id FROM outgoing_queue WHERE temp_guid = 'temp-ownerless-alias'")
      .get() as { id: number };
    raw.prepare("DELETE FROM messages WHERE guid = 'temp-ownerless-alias'").run();
    raw
      .prepare(
        `INSERT INTO message_guid_aliases (alias_guid, canonical_guid, chat_guid)
         VALUES ('temp-ownerless-alias', 'foreign-canonical-owner', NULL)`,
      )
      .run();

    expect(await countOutgoingQueueHealth(db)).toEqual({
      strandedSending: 0,
      orphanQueueRows: 1,
    });
    await expect(localRouteForMessageGuid('temp-ownerless-alias', db)).resolves.toBeNull();
    await expect(
      resolveMessageTarget(db, {
        chatGuid: 'RCS;-;google-conversation-2',
        messageGuid: 'temp-ownerless-alias',
        partIndex: 0,
        serverAuthorization: { allowsLegacyPartZero: true, isCurrent: () => true },
      }),
    ).resolves.toBeNull();
    await expect(claimFailedOutgoingForRetry(db, 'foreign-canonical-owner')).resolves.toEqual({
      claim: 'unsendable',
    });

    await expect(reconcileOutgoingError(db, 'temp-ownerless-alias', 42, 1_000)).resolves.toBe(true);
    await expect(claimOutgoingForSend(db, queue.id, () => 1_000_000)).resolves.toBe(false);
    await expect(
      withDbTransaction(db, (context) =>
        retireUncertainOutgoingWithinTransaction(
          context,
          'temp-ownerless-alias',
          77,
          'must not cross chats',
        ),
      ),
    ).resolves.toBe(false);
    await retireOutgoing(db, 'temp-ownerless-alias', 88);
    await expect(deleteMessageLocal(db, 'temp-ownerless-alias', 2_000)).resolves.toBe(
      'unresolved-temp',
    );
    await expect(
      reconcileOutgoingSuccess(db, 'temp-ownerless-alias', {
        guid: 'foreign-canonical-owner',
        dateCreated: 3_000,
        dateDelivered: null,
      }),
    ).resolves.toBeUndefined();

    expect(
      raw
        .prepare(
          `SELECT c.guid AS chatGuid, m.send_state AS sendState, m.error,
                  m.error_message AS errorMessage, m.date_deleted AS dateDeleted
             FROM messages m
             JOIN chats c ON c.id = m.chat_id
            WHERE m.guid = 'foreign-canonical-owner'`,
        )
        .get(),
    ).toEqual({
      chatGuid: 'SMS;-;+15550000001',
      sendState: 'sending',
      error: 0,
      errorMessage: null,
      dateDeleted: null,
    });
    expect(
      raw
        .prepare(
          `SELECT date_deleted AS dateDeleted, chat_guid AS chatGuid
             FROM message_deletion_ledger
            WHERE guid = 'temp-ownerless-alias'`,
        )
        .get(),
    ).toEqual({ dateDeleted: 2_000, chatGuid: null });
  });
});
