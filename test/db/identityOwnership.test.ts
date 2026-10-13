import { Attachment, Chat, Message } from '@core/models';
import {
  cancelOutgoing,
  deleteChatLocal,
  insertOutgoingText,
  reconcileEchoByContent,
  reconcileOutgoingSuccess,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import { createTestDb } from '../support/testDb';
import {
  markOutgoingSentNoGuid,
  reconcileExactOutgoingAttemptSuccess,
  upsertAttachments,
} from '../support/repositoryWrappers';

async function seedSeparatedChats() {
  const testDb = await createTestDb();
  const handles = await upsertHandles(testDb.db, [
    { address: '+15550000001', service: 'SMS' },
    { address: '+15550000002', service: 'RCS' },
    { address: '+15550000003', service: 'RCS' },
  ]);
  const chats = await upsertChats(
    testDb.db,
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
  return {
    ...testDb,
    handles,
    appleChatId: chats.get('SMS;-;+15550000001')!,
    googleChatId: chats.get('RCS;-;google-conversation-2')!,
  };
}

describe('FEAT-06 immutable ingestion ownership', () => {
  it('rejects a persisted message GUID claimed by another provider conversation', async () => {
    const { db, raw, handles, appleChatId, googleChatId } = await seedSeparatedChats();
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'provider-collision-message',
          text: 'original Apple SMS body',
          dateCreated: 100,
          handle: { address: '+15550000001', service: 'SMS' },
          attachments: [
            Attachment.parse({
              guid: 'provider-collision-attachment',
              mimeType: 'image/jpeg',
              width: 640,
            }),
          ],
        }),
      ],
      () => appleChatId,
      handles,
    );
    raw
      .prepare(
        "UPDATE attachments SET local_path = 'file:///private/apple.jpg' WHERE guid = 'provider-collision-attachment'",
      )
      .run();
    raw
      .prepare(
        "UPDATE chats SET last_read_message_guid = 'provider-collision-message' WHERE id = ?",
      )
      .run(appleChatId);

    const rejected = await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'provider-collision-message',
          text: 'must not move to Google Messages',
          dateCreated: 900,
          handle: { address: '+15550000003', service: 'RCS' },
          attachments: [
            Attachment.parse({
              guid: 'provider-collision-attachment',
              mimeType: 'application/pdf',
              width: 1,
            }),
            Attachment.parse({ guid: 'rejected-destination-only-attachment' }),
          ],
        }),
      ],
      () => googleChatId,
      handles,
    );

    expect(rejected.has('provider-collision-message')).toBe(false);
    expect(
      raw
        .prepare(
          'SELECT chat_id AS chatId, text, date_created AS dateCreated FROM messages WHERE guid = ?',
        )
        .get('provider-collision-message'),
    ).toEqual({ chatId: appleChatId, text: 'original Apple SMS body', dateCreated: 100 });
    expect(
      raw
        .prepare(
          'SELECT a.message_id AS messageId, a.mime_type AS mimeType, a.width, a.local_path AS localPath FROM attachments a WHERE a.guid = ?',
        )
        .get('provider-collision-attachment'),
    ).toEqual({
      messageId: (
        raw.prepare('SELECT id FROM messages WHERE guid = ?').get('provider-collision-message') as {
          id: number;
        }
      ).id,
      mimeType: 'image/jpeg',
      width: 640,
      localPath: 'file:///private/apple.jpg',
    });
    expect(
      raw
        .prepare("SELECT id FROM attachments WHERE guid = 'rejected-destination-only-attachment'")
        .get(),
    ).toBeUndefined();
    expect(
      raw.prepare('SELECT latest_message_date AS latest FROM chats WHERE id = ?').get(googleChatId),
    ).toEqual({ latest: null });
    expect(
      raw.prepare('SELECT last_read_message_guid AS guid FROM chats WHERE id = ?').get(appleChatId),
    ).toEqual({ guid: 'provider-collision-message' });
    expect(
      raw
        .prepare(
          `SELECT COUNT(*) AS count
             FROM chat_handles ch
             JOIN handles h ON h.id = ch.handle_id
            WHERE ch.chat_id = ? AND h.address = '+15550000003'`,
        )
        .get(googleChatId),
    ).toEqual({ count: 0 });
  });

  it('rejects same-batch ambiguity but still refreshes the same exact owner', async () => {
    const { db, raw, handles, appleChatId, googleChatId } = await seedSeparatedChats();
    const ambiguous = [
      Message.parse({ guid: 'same-batch-message', text: 'Apple candidate', dateCreated: 1 }),
      Message.parse({ guid: 'same-batch-message', text: 'Google candidate', dateCreated: 2 }),
    ];
    const rejected = await upsertMessages(
      db,
      ambiguous,
      (message) => (message.text === 'Apple candidate' ? appleChatId : googleChatId),
      handles,
    );
    expect(rejected.size).toBe(0);
    expect(
      raw.prepare("SELECT id FROM messages WHERE guid = 'same-batch-message'").get(),
    ).toBeUndefined();

    await upsertMessages(
      db,
      [Message.parse({ guid: 'same-owner-message', text: 'first', dateCreated: 3 })],
      () => googleChatId,
      handles,
    );
    const refreshed = await upsertMessages(
      db,
      [Message.parse({ guid: 'same-owner-message', text: 'updated', dateCreated: 3 })],
      () => googleChatId,
      handles,
    );
    expect(refreshed.has('same-owner-message')).toBe(true);
    expect(
      raw
        .prepare('SELECT chat_id AS chatId, text FROM messages WHERE guid = ?')
        .get('same-owner-message'),
    ).toEqual({ chatId: googleChatId, text: 'updated' });
  });

  it('keeps attachment ownership, cached files, and optimistic temp rows on GUID conflicts', async () => {
    const { db, raw, handles, appleChatId, googleChatId } = await seedSeparatedChats();
    const appleMessages = await upsertMessages(
      db,
      [Message.parse({ guid: 'apple-attachment-owner', text: 'Apple', dateCreated: 1 })],
      () => appleChatId,
      handles,
    );
    const googleMessages = await upsertMessages(
      db,
      [Message.parse({ guid: 'google-attachment-owner', text: 'Google', dateCreated: 2 })],
      () => googleChatId,
      handles,
    );
    const appleMessageId = appleMessages.get('apple-attachment-owner')!;
    const googleMessageId = googleMessages.get('google-attachment-owner')!;

    await upsertAttachments(db, [
      {
        att: Attachment.parse({
          guid: 'shared-attachment-guid',
          mimeType: 'image/jpeg',
          width: 800,
        }),
        messageId: appleMessageId,
      },
      {
        att: Attachment.parse({ guid: 'temp-google-att', mimeType: 'image/png' }),
        messageId: googleMessageId,
      },
    ]);
    raw
      .prepare(
        `UPDATE attachments
            SET local_path = CASE guid
              WHEN 'shared-attachment-guid' THEN 'file:///private/original.jpg'
              WHEN 'temp-google-att' THEN 'file:///private/temp.png'
            END
          WHERE guid IN ('shared-attachment-guid', 'temp-google-att')`,
      )
      .run();

    await upsertAttachments(db, [
      {
        att: Attachment.parse({
          guid: 'shared-attachment-guid',
          mimeType: 'application/pdf',
          width: 1,
        }),
        messageId: googleMessageId,
      },
    ]);
    expect(
      raw
        .prepare(
          'SELECT message_id AS messageId, mime_type AS mimeType, width, local_path AS localPath FROM attachments WHERE guid = ?',
        )
        .get('shared-attachment-guid'),
    ).toEqual({
      messageId: appleMessageId,
      mimeType: 'image/jpeg',
      width: 800,
      localPath: 'file:///private/original.jpg',
    });
    expect(
      raw
        .prepare(
          'SELECT message_id AS messageId, local_path AS localPath FROM attachments WHERE guid = ?',
        )
        .get('temp-google-att'),
    ).toEqual({ messageId: googleMessageId, localPath: 'file:///private/temp.png' });

    await upsertAttachments(db, [
      {
        att: Attachment.parse({ guid: 'same-batch-attachment', mimeType: 'image/jpeg' }),
        messageId: appleMessageId,
      },
      {
        att: Attachment.parse({ guid: 'same-batch-attachment', mimeType: 'image/png' }),
        messageId: googleMessageId,
      },
    ]);
    expect(
      raw.prepare("SELECT id FROM attachments WHERE guid = 'same-batch-attachment'").get(),
    ).toBeUndefined();

    raw
      .prepare(
        "INSERT INTO attachments (guid, message_id, mime_type, local_path) VALUES ('legacy-ownerless', NULL, 'image/gif', 'file:///private/orphan.gif')",
      )
      .run();
    await upsertAttachments(db, [
      {
        att: Attachment.parse({ guid: 'legacy-ownerless', mimeType: 'image/png' }),
        messageId: googleMessageId,
      },
    ]);
    expect(
      raw
        .prepare(
          "SELECT message_id AS messageId, mime_type AS mimeType, local_path AS localPath FROM attachments WHERE guid = 'legacy-ownerless'",
        )
        .get(),
    ).toEqual({
      messageId: null,
      mimeType: 'image/gif',
      localPath: 'file:///private/orphan.gif',
    });
  });

  it('settles a legacy send without adopting a canonical GUID owned by another chat', async () => {
    const { db, raw, handles, appleChatId, googleChatId } = await seedSeparatedChats();
    await insertOutgoingText(db, {
      tempGuid: 'temp-cross-chat-legacy',
      chatId: googleChatId,
      chatGuid: 'RCS;-;google-conversation-2',
      text: 'Google source send',
      now: 10,
    });
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'foreign-canonical-legacy',
          text: 'Apple-owned message',
          dateCreated: 5,
        }),
      ],
      () => appleChatId,
      handles,
    );
    const tempId = (
      raw.prepare("SELECT id FROM messages WHERE guid = 'temp-cross-chat-legacy'").get() as {
        id: number;
      }
    ).id;
    const foreignId = (
      raw.prepare("SELECT id FROM messages WHERE guid = 'foreign-canonical-legacy'").get() as {
        id: number;
      }
    ).id;
    raw
      .prepare(
        "INSERT INTO attachments (guid, message_id, local_path) VALUES ('temp-cross-chat-legacy-att', ?, 'file:///private/google.jpg'), ('foreign-cross-chat-legacy-att', ?, NULL)",
      )
      .run(tempId, foreignId);

    await reconcileOutgoingSuccess(db, 'temp-cross-chat-legacy', {
      guid: 'foreign-canonical-legacy',
      dateCreated: 20,
      dateDelivered: 21,
    });

    expect(
      raw
        .prepare(
          'SELECT chat_id AS chatId, text, send_state AS sendState FROM messages WHERE guid = ?',
        )
        .get('temp-cross-chat-legacy'),
    ).toEqual({ chatId: googleChatId, text: 'Google source send', sendState: 'sent' });
    expect(
      raw
        .prepare(
          'SELECT chat_id AS chatId, text, send_state AS sendState FROM messages WHERE guid = ?',
        )
        .get('foreign-canonical-legacy'),
    ).toEqual({ chatId: appleChatId, text: 'Apple-owned message', sendState: 'sent' });
    expect(
      raw.prepare('SELECT guid, local_path AS localPath FROM attachments ORDER BY guid').all(),
    ).toEqual([
      { guid: 'foreign-cross-chat-legacy-att', localPath: null },
      { guid: 'temp-cross-chat-legacy-att', localPath: 'file:///private/google.jpg' },
    ]);
    expect(
      raw.prepare("SELECT id FROM outgoing_queue WHERE temp_guid = 'temp-cross-chat-legacy'").get(),
    ).toBeUndefined();
    expect(
      raw
        .prepare(
          "SELECT canonical_guid FROM message_guid_aliases WHERE alias_guid = 'temp-cross-chat-legacy'",
        )
        .get(),
    ).toBeUndefined();
  });

  it('settles an exact RCS attempt without adopting a canonical GUID owned by another chat', async () => {
    const { db, raw, handles, appleChatId, googleChatId } = await seedSeparatedChats();
    const inserted = await insertOutgoingText(db, {
      tempGuid: 'temp-cross-chat-exact',
      chatId: googleChatId,
      chatGuid: 'RCS;-;google-conversation-2',
      text: 'Exact Google source send',
      now: 30,
      attemptAware: true,
    });
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'foreign-canonical-exact',
          text: 'Exact Apple-owned message',
          dateCreated: 25,
        }),
      ],
      () => appleChatId,
      handles,
    );

    await expect(
      reconcileExactOutgoingAttemptSuccess(db, {
        tempGuid: 'temp-cross-chat-exact',
        attemptGuid: 'attempt-cross-chat-exact',
        clientAttemptGeneration: inserted.attemptOwnerToken!.generation,
        guid: 'foreign-canonical-exact',
        dateCreated: 40,
        dateDelivered: 41,
      }),
    ).resolves.toBe('owner-conflict');

    expect(
      raw
        .prepare(
          'SELECT chat_id AS chatId, text, send_state AS sendState, active_send_attempt_guid AS attemptGuid, attempt_owner_pending AS pending FROM messages WHERE guid = ?',
        )
        .get('temp-cross-chat-exact'),
    ).toEqual({
      chatId: googleChatId,
      text: 'Exact Google source send',
      sendState: 'sent',
      attemptGuid: null,
      pending: 0,
    });
    expect(
      raw
        .prepare(
          'SELECT chat_id AS chatId, text, send_state AS sendState FROM messages WHERE guid = ?',
        )
        .get('foreign-canonical-exact'),
    ).toEqual({ chatId: appleChatId, text: 'Exact Apple-owned message', sendState: 'sent' });
    expect(
      raw.prepare("SELECT id FROM outgoing_queue WHERE temp_guid = 'temp-cross-chat-exact'").get(),
    ).toBeUndefined();
    expect(
      raw
        .prepare(
          "SELECT canonical_guid FROM message_guid_aliases WHERE alias_guid = 'temp-cross-chat-exact'",
        )
        .get(),
    ).toBeUndefined();
  });

  it('does not alias or tombstone a foreign canonical row after the source send was purged', async () => {
    const { db, raw, handles, appleChatId, googleChatId } = await seedSeparatedChats();
    await insertOutgoingText(db, {
      tempGuid: 'temp-purged-cross-chat',
      chatId: googleChatId,
      chatGuid: 'RCS;-;google-conversation-2',
      text: 'Purged Google source send',
      now: 50,
    });
    await cancelOutgoing(db, 'temp-purged-cross-chat', 60);
    await deleteChatLocal(db, 'RCS;-;google-conversation-2', 70);
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'foreign-canonical-after-purge',
          text: 'Apple row must stay live',
          dateCreated: 40,
        }),
      ],
      () => appleChatId,
      handles,
    );

    await reconcileOutgoingSuccess(
      db,
      'temp-purged-cross-chat',
      {
        guid: 'foreign-canonical-after-purge',
        dateCreated: 80,
        dateDelivered: 81,
      },
      undefined,
      'RCS;-;google-conversation-2',
    );

    expect(
      raw
        .prepare(
          'SELECT chat_id AS chatId, text, send_state AS sendState, date_deleted AS dateDeleted FROM messages WHERE guid = ?',
        )
        .get('foreign-canonical-after-purge'),
    ).toEqual({
      chatId: appleChatId,
      text: 'Apple row must stay live',
      sendState: 'sent',
      dateDeleted: null,
    });
    expect(
      raw
        .prepare(
          "SELECT date_deleted AS dateDeleted FROM message_deletion_ledger WHERE guid = 'temp-purged-cross-chat'",
        )
        .get(),
    ).toEqual({ dateDeleted: 60 });
    expect(
      raw
        .prepare(
          "SELECT guid FROM message_deletion_ledger WHERE guid = 'foreign-canonical-after-purge'",
        )
        .get(),
    ).toBeUndefined();
    expect(
      raw
        .prepare(
          "SELECT canonical_guid FROM message_guid_aliases WHERE alias_guid = 'temp-purged-cross-chat'",
        )
        .get(),
    ).toBeUndefined();
  });

  it('binds an ack-first canonical GUID before a different-provider echo can claim it', async () => {
    const { db, raw, handles, appleChatId, googleChatId } = await seedSeparatedChats();
    await insertOutgoingText(db, {
      tempGuid: 'temp-ack-first-google',
      chatId: googleChatId,
      chatGuid: 'RCS;-;google-conversation-2',
      text: 'Google request awaiting ack',
      now: 50,
    });
    await cancelOutgoing(db, 'temp-ack-first-google', 61);
    await deleteChatLocal(db, 'RCS;-;google-conversation-2', 70);

    await reconcileOutgoingSuccess(
      db,
      'temp-ack-first-google',
      {
        guid: 'canonical-ack-first-collision',
        dateCreated: 80,
        dateDelivered: 81,
      },
      undefined,
      'RCS;-;google-conversation-2',
    );

    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'canonical-ack-first-collision',
          text: 'Apple collision must not take ownership',
          dateCreated: 90,
        }),
      ],
      () => appleChatId,
      handles,
    );

    expect(
      raw
        .prepare(
          'SELECT chat_id AS chatId, text, date_deleted AS dateDeleted FROM messages WHERE guid = ?',
        )
        .get('canonical-ack-first-collision'),
    ).toEqual({ chatId: googleChatId, text: null, dateDeleted: 61 });
    expect(
      raw
        .prepare(
          "SELECT canonical_guid AS canonicalGuid FROM message_guid_aliases WHERE alias_guid = 'temp-ack-first-google'",
        )
        .get(),
    ).toEqual({ canonicalGuid: 'canonical-ack-first-collision' });
  });

  it('uses the scoped temp receipt when an exact echo beats the ack after purge', async () => {
    const { db, raw, handles, appleChatId, googleChatId } = await seedSeparatedChats();
    const inserted = await insertOutgoingText(db, {
      tempGuid: 'temp-echo-first-google',
      chatId: googleChatId,
      chatGuid: 'RCS;-;google-conversation-2',
      text: 'Exact echo arrives first',
      now: 50,
      attemptAware: true,
    });
    await cancelOutgoing(db, 'temp-echo-first-google', 61);
    await deleteChatLocal(db, 'RCS;-;google-conversation-2', 70);

    await expect(
      withDbTransaction(db, (context) =>
        reconcileEchoByContent(
          context,
          {
            guid: 'canonical-echo-first-google',
            tempGuid: 'temp-echo-first-google',
            attemptGuid: 'attempt-echo-first-google',
            clientAttemptGeneration: inserted.attemptOwnerToken!.generation,
            isFromMe: true,
            text: 'Exact echo arrives first',
            dateCreated: 80,
          },
          googleChatId,
        ),
      ),
    ).resolves.toBe('reconciled');
    expect(
      raw
        .prepare(
          `SELECT m.chat_id AS chatId, m.date_deleted AS dateDeleted,
                  a.chat_guid AS aliasChatGuid, l.chat_guid AS ledgerChatGuid
             FROM messages m
             JOIN message_guid_aliases a ON a.canonical_guid = m.guid
             JOIN message_deletion_ledger l ON l.guid = m.guid
            WHERE m.guid = 'canonical-echo-first-google'`,
        )
        .get(),
    ).toEqual({
      chatId: googleChatId,
      dateDeleted: 61,
      aliasChatGuid: 'RCS;-;google-conversation-2',
      ledgerChatGuid: 'RCS;-;google-conversation-2',
    });

    const second = await insertOutgoingText(db, {
      tempGuid: 'temp-echo-wrong-chat',
      chatId: googleChatId,
      chatGuid: 'RCS;-;google-conversation-2',
      text: 'Wrong chat must not claim',
      now: 90,
      attemptAware: true,
    });
    await cancelOutgoing(db, 'temp-echo-wrong-chat', 91);
    await deleteChatLocal(db, 'RCS;-;google-conversation-2', 92);
    await expect(
      withDbTransaction(db, (context) =>
        reconcileEchoByContent(
          context,
          {
            guid: 'canonical-echo-wrong-chat',
            tempGuid: 'temp-echo-wrong-chat',
            attemptGuid: 'attempt-echo-wrong-chat',
            clientAttemptGeneration: second.attemptOwnerToken!.generation,
            isFromMe: true,
            text: 'Wrong chat must not claim',
            dateCreated: 93,
          },
          appleChatId,
        ),
      ),
    ).resolves.toBe('owner-conflict');
    const rejected = await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'canonical-echo-wrong-chat',
          tempGuid: 'temp-echo-wrong-chat',
          attemptGuid: 'attempt-echo-wrong-chat',
          clientAttemptGeneration: second.attemptOwnerToken!.generation,
          isFromMe: true,
          text: 'Wrong chat must not claim',
          dateCreated: 93,
        }),
      ],
      () => appleChatId,
      handles,
    );
    expect(rejected.has('canonical-echo-wrong-chat')).toBe(false);
    expect(
      raw.prepare("SELECT id FROM messages WHERE guid = 'canonical-echo-wrong-chat'").get(),
    ).toBeUndefined();
  });

  it('keeps a GUID-less AppleScript echo hidden by the chat-history boundary after its temp row was purged', async () => {
    const { db, raw, handles, appleChatId } = await seedSeparatedChats();
    await insertOutgoingText(db, {
      tempGuid: 'temp-guidless-after-purge',
      chatId: appleChatId,
      chatGuid: 'SMS;-;+15550000001',
      text: 'Legacy text echo',
      now: 50,
    });
    await cancelOutgoing(db, 'temp-guidless-after-purge', 61);
    await deleteChatLocal(db, 'SMS;-;+15550000001', 70);
    await expect(markOutgoingSentNoGuid(db, 'temp-guidless-after-purge')).resolves.toBe('missing');

    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'canonical-guidless-after-purge',
          isFromMe: true,
          text: 'Legacy text echo',
          dateCreated: 55,
        }),
      ],
      () => appleChatId,
      handles,
    );
    expect(
      raw
        .prepare(
          `SELECT date_deleted AS dateDeleted
             FROM messages
            WHERE guid = 'canonical-guidless-after-purge'`,
        )
        .get(),
    ).toEqual({ dateDeleted: 70 });
    expect(
      raw
        .prepare(
          "SELECT guid FROM message_deletion_ledger WHERE guid = 'canonical-guidless-after-purge'",
        )
        .get(),
    ).toBeUndefined();
    expect(
      raw
        .prepare(
          "SELECT date_deleted AS dateDeleted FROM message_deletion_ledger WHERE guid = 'temp-guidless-after-purge'",
        )
        .get(),
    ).toEqual({ dateDeleted: 61 });
  });

  it('fails closed when the temp row and durable queue disagree about the source chat', async () => {
    const { db, raw, handles, appleChatId, googleChatId } = await seedSeparatedChats();
    await insertOutgoingText(db, {
      tempGuid: 'temp-conflicting-source-owners',
      chatId: googleChatId,
      chatGuid: 'RCS;-;google-conversation-2',
      text: 'Ambiguous source ownership',
      now: 90,
    });
    await upsertMessages(
      db,
      [
        Message.parse({
          guid: 'same-chat-canonical-with-corrupt-queue',
          text: 'Existing Google canonical',
          dateCreated: 91,
        }),
      ],
      () => googleChatId,
      handles,
    );
    raw
      .prepare(
        "UPDATE outgoing_queue SET chat_guid = 'SMS;-;+15550000001' WHERE temp_guid = 'temp-conflicting-source-owners'",
      )
      .run();

    await reconcileOutgoingSuccess(db, 'temp-conflicting-source-owners', {
      guid: 'same-chat-canonical-with-corrupt-queue',
      dateCreated: 92,
      dateDelivered: 93,
    });

    expect(
      raw
        .prepare('SELECT chat_id AS chatId, send_state AS sendState FROM messages WHERE guid = ?')
        .get('temp-conflicting-source-owners'),
    ).toEqual({ chatId: googleChatId, sendState: 'sent' });
    expect(
      raw
        .prepare('SELECT chat_id AS chatId, text FROM messages WHERE guid = ?')
        .get('same-chat-canonical-with-corrupt-queue'),
    ).toEqual({ chatId: googleChatId, text: 'Existing Google canonical' });
    expect(
      raw
        .prepare(
          "SELECT canonical_guid FROM message_guid_aliases WHERE alias_guid = 'temp-conflicting-source-owners'",
        )
        .get(),
    ).toBeUndefined();
    expect(
      raw
        .prepare("SELECT id FROM outgoing_queue WHERE temp_guid = 'temp-conflicting-source-owners'")
        .get(),
    ).toBeUndefined();
    expect(appleChatId).not.toBe(googleChatId);
  });
});
