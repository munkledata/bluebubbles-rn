import { Chat } from '@core/models';
import {
  captureFullRepairPruneExposure,
  FULL_REPAIR_RETIRED_CHAT_KV_PREFIX,
  reconcileFullRepairPruneExposure,
  upsertChats,
  upsertHandles,
} from '@db/repositories';
import { fullSync, type FullSyncServerView } from '@/services/sync/engine';
import type { SyncApi } from '@/services/sync/types';
import { createTestDb } from '../support/testDb';

const RCS_EPOCH = `gpe1_${'A'.repeat(43)}`;
const encoded = (value: string): string => Buffer.from(value, 'utf8').toString('base64url');
const RCS_CHAT_GUID = `RCS;-;g1.${RCS_EPOCH}.${encoded('old-conversation')}`;
const RCS_MESSAGE_GUID = `rcs-g1.${RCS_EPOCH}.${encoded('old-message')}`;
const RCS_ATTACHMENT_GUID = `rcs-media-g1.${RCS_EPOCH}.${encoded('old-message')}.${encoded('old-media')}`;

describe('full repair reconciliation', () => {
  it('removes only stable phantom rows while preserving local state and concurrent protections', async () => {
    const { db, raw } = await createTestDb();
    const insertChat = raw.prepare(
      `INSERT INTO chats
         (guid, latest_message_date, is_pinned, custom_name, background_uri, deleted_at,
          history_deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const seedChat = (
      guid: string,
      options: {
        latest?: number | null;
        pinned?: number;
        customName?: string | null;
        backgroundUri?: string | null;
        deletedAt?: number | null;
        historyDeletedAt?: number | null;
      } = {},
    ): number => {
      const result = insertChat.run(
        guid,
        options.latest ?? null,
        options.pinned ?? 0,
        options.customName ?? null,
        options.backgroundUri ?? null,
        options.deletedAt ?? null,
        options.historyDeletedAt ?? null,
      );
      const id = Number(result.lastInsertRowid);
      return id;
    };
    const insertMessage = raw.prepare(
      `INSERT INTO messages
         (guid, original_row_id, chat_id, is_from_me, date_created, send_state, date_deleted)
       VALUES (?, ?, ?, ?, ?, 'sent', ?)`,
    );

    const serverChatId = seedChat('server-chat');
    const sourceChatId = seedChat('source-chat', { latest: 200 });
    const phantomChatId = seedChat('phantom-chat', { latest: 300 });
    seedChat('custom-chat', {
      pinned: 1,
      customName: 'Keep me',
      backgroundUri: 'file:///custom-wallpaper.jpg',
    });
    seedChat('draft-chat');
    seedChat('history-boundary-chat', { historyDeletedAt: 5_000 });
    const tombstoneChatId = seedChat('tombstone-chat', { latest: 400 });
    const lateTombstoneChatId = seedChat('late-tombstone-chat', { latest: 500 });
    const lateReminderChatId = seedChat('late-reminder-chat', { latest: 600 });
    const lateAttachmentChatId = seedChat('late-attachment-chat', { latest: 700 });
    const rcsChatId = seedChat(RCS_CHAT_GUID, { latest: 800 });

    insertMessage.run('source-anchor', 10, sourceChatId, 0, 100, null);
    insertMessage.run('server-last', 22, sourceChatId, 0, 200, null);
    const phantomMessageId = Number(
      insertMessage.run('phantom-message', 30, phantomChatId, 0, 300, null).lastInsertRowid,
    );
    insertMessage.run('tombstone-message', 40, tombstoneChatId, 0, 400, 401);
    insertMessage.run('late-tombstone-message', 50, lateTombstoneChatId, 0, 500, null);
    insertMessage.run('late-reminder-message', 60, lateReminderChatId, 0, 600, null);
    const lateAttachmentMessageId = Number(
      insertMessage.run('late-attachment-message', 70, lateAttachmentChatId, 0, 700, null)
        .lastInsertRowid,
    );
    const rcsMessageId = Number(
      insertMessage.run(RCS_MESSAGE_GUID, null, rcsChatId, 0, 800, null).lastInsertRowid,
    );
    raw
      .prepare('UPDATE chats SET last_read_message_guid = ? WHERE id = ?')
      .run('server-last', sourceChatId);
    raw
      .prepare('INSERT INTO attachments (guid, message_id) VALUES (?, ?)')
      .run('phantom-attachment', phantomMessageId);
    raw
      .prepare('INSERT INTO attachments (guid, message_id) VALUES (?, ?)')
      .run('late-old-attachment', lateAttachmentMessageId);
    raw
      .prepare('INSERT INTO attachments (guid, message_id) VALUES (?, ?)')
      .run(RCS_ATTACHMENT_GUID, rcsMessageId);
    raw
      .prepare(
        `INSERT INTO reminders
         (message_guid, chat_guid, scheduled_for, notification_id)
       VALUES (?, ?, ?, ?)`,
      )
      .run('source-anchor', 'source-chat', 10_000, 'source-reminder');
    raw
      .prepare('INSERT INTO message_deletion_ledger (guid, date_deleted) VALUES (?, ?)')
      .run('tombstone-message', 401);
    raw.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run('draft.draft-chat', 'draft body');

    const exposure = await captureFullRepairPruneExposure(db);
    const api: SyncApi = {
      serverVersion: async () => '1.9.0',
      fetchChats: async (offset) =>
        offset === 0
          ? [
              Chat.parse({
                guid: 'server-chat',
                participants: [],
                lastMessage: {
                  guid: 'server-last',
                  originalROWID: 22,
                  dateCreated: 200,
                  isFromMe: false,
                  text: 'authoritative RCS-style preview',
                },
              }),
            ]
          : [],
      // An RCS-style history endpoint can be empty even though chat/query returned lastMessage.
      fetchChatMessages: async () => [],
      fetchMessagesAfter: async () => [],
      fetchDeletedAfter: async () => [],
    };
    const views: FullSyncServerView[] = [];
    await fullSync(db, api, {
      maxMessagesPerChat: 0,
      failOnChatError: true,
      commitMarker: false,
      onServerView: (view) => views.push(view),
    });
    expect(views).toHaveLength(1);
    expect(views[0]!.messages.get('server-last')).toEqual({
      chatGuid: 'server-chat',
      originalRowId: 22,
    });

    // These protections land after exposure, as they can during the long network crawl.
    raw
      .prepare('UPDATE messages SET date_deleted = ? WHERE guid = ?')
      .run(501, 'late-tombstone-message');
    raw
      .prepare('INSERT INTO message_deletion_ledger (guid, date_deleted) VALUES (?, ?)')
      .run('late-tombstone-message', 501);
    raw
      .prepare(
        `INSERT INTO reminders
         (message_guid, chat_guid, scheduled_for, notification_id)
       VALUES (?, ?, ?, ?)`,
      )
      .run('late-reminder-message', 'late-reminder-chat', 20_000, 'late-reminder');
    raw
      .prepare('INSERT INTO attachments (guid, message_id) VALUES (?, ?)')
      .run('late-new-attachment', lateAttachmentMessageId);

    const confirmed = views[0]!;
    const result = await reconcileFullRepairPruneExposure(db, exposure, {
      chatGuids: new Set(confirmed.chats.keys()),
      messageGuids: new Set(confirmed.messages.keys()),
      attachmentGuidsByMessage: confirmed.attachmentsByMessage,
    });

    expect(result).toMatchObject({
      messagesRemoved: 1,
      attachmentsRemoved: 1,
      chatsRemoved: 1,
      chatShellsRetired: 2,
    });
    expect(raw.prepare('SELECT id FROM chats WHERE guid = ?').get('phantom-chat')).toBeUndefined();
    expect(raw.prepare('SELECT id FROM messages WHERE guid = ?').get('server-last')).toBeDefined();
    expect(raw.prepare('SELECT chat_id FROM messages WHERE guid = ?').get('server-last')).toEqual({
      chat_id: sourceChatId,
    });
    expect(
      raw
        .prepare('SELECT latest_message_date, last_read_message_guid FROM chats WHERE id = ?')
        .get(sourceChatId),
    ).toEqual({ latest_message_date: 200, last_read_message_guid: 'server-last' });
    expect(serverChatId).not.toBe(sourceChatId);

    expect(
      raw
        .prepare(
          'SELECT is_pinned, custom_name, background_uri, deleted_at FROM chats WHERE guid = ?',
        )
        .get('custom-chat'),
    ).toEqual({
      is_pinned: 1,
      custom_name: 'Keep me',
      background_uri: 'file:///custom-wallpaper.jpg',
      deleted_at: 0,
    });
    expect(
      raw
        .prepare('SELECT value FROM kv WHERE key = ?')
        .get(`${FULL_REPAIR_RETIRED_CHAT_KV_PREFIX}custom-chat`),
    ).toEqual({ value: '0' });
    expect(
      raw
        .prepare('SELECT deleted_at, history_deleted_at FROM chats WHERE guid = ?')
        .get('history-boundary-chat'),
    ).toEqual({ deleted_at: 0, history_deleted_at: 5_000 });
    expect(
      raw
        .prepare('SELECT value FROM kv WHERE key = ?')
        .get(`${FULL_REPAIR_RETIRED_CHAT_KV_PREFIX}history-boundary-chat`),
    ).toEqual({ value: '0' });
    for (const guid of [
      'tombstone-message',
      'late-tombstone-message',
      'late-reminder-message',
      'late-attachment-message',
    ]) {
      expect(raw.prepare('SELECT id FROM messages WHERE guid = ?').get(guid)).toBeDefined();
    }
    expect(
      raw
        .prepare('SELECT guid FROM attachments WHERE message_id = ? ORDER BY guid')
        .all(lateAttachmentMessageId),
    ).toEqual([{ guid: 'late-new-attachment' }, { guid: 'late-old-attachment' }]);
    expect(raw.prepare('SELECT id FROM chats WHERE guid = ?').get(RCS_CHAT_GUID)).toBeDefined();
    expect(
      raw.prepare('SELECT id FROM messages WHERE guid = ?').get(RCS_MESSAGE_GUID),
    ).toBeDefined();
    expect(
      raw.prepare('SELECT id FROM attachments WHERE guid = ?').get(RCS_ATTACHMENT_GUID),
    ).toBeDefined();

    // When that customized chat later returns, clear only repair's synthetic visibility floor.
    const handles = await upsertHandles(db, []);
    await upsertChats(db, [Chat.parse({ guid: 'custom-chat', participants: [] })], handles);
    expect(
      raw.prepare('SELECT custom_name, deleted_at FROM chats WHERE guid = ?').get('custom-chat'),
    ).toEqual({ custom_name: 'Keep me', deleted_at: null });
    expect(
      raw
        .prepare('SELECT value FROM kv WHERE key = ?')
        .get(`${FULL_REPAIR_RETIRED_CHAT_KV_PREFIX}custom-chat`),
    ).toBeUndefined();
  });

  it('scopes deletion-ledger protection to the exact owning chat', async () => {
    const { db, raw } = await createTestDb();
    const insertChat = raw.prepare('INSERT INTO chats (guid) VALUES (?)');
    const wrongOwnerChatId = Number(insertChat.run('wrong-owner-chat').lastInsertRowid);
    const exactOwnerChatId = Number(insertChat.run('exact-owner-chat').lastInsertRowid);
    insertChat.run('foreign-ledger-owner');

    const insertMessage = raw.prepare(
      `INSERT INTO messages
         (guid, original_row_id, chat_id, is_from_me, date_created, send_state)
       VALUES (?, ?, ?, 0, ?, 'sent')`,
    );
    const wrongOwnerMessageId = Number(
      insertMessage.run('wrong-owner-message', 901, wrongOwnerChatId, 9_010).lastInsertRowid,
    );
    insertMessage.run('exact-owner-message', 902, exactOwnerChatId, 9_020);
    const exactOwnerAttachmentMessageId = Number(
      insertMessage.run('exact-owner-attachment-message', 903, exactOwnerChatId, 9_030)
        .lastInsertRowid,
    );
    raw
      .prepare('INSERT INTO attachments (guid, message_id) VALUES (?, ?)')
      .run('wrong-owner-attachment', wrongOwnerMessageId);
    raw
      .prepare('INSERT INTO attachments (guid, message_id) VALUES (?, ?)')
      .run('exact-owner-attachment', exactOwnerAttachmentMessageId);
    raw
      .prepare(
        'INSERT INTO message_deletion_ledger (guid, date_deleted, chat_guid) VALUES (?, ?, ?)',
      )
      .run('wrong-owner-message', 9_100, 'foreign-ledger-owner');
    raw
      .prepare(
        'INSERT INTO message_deletion_ledger (guid, date_deleted, chat_guid) VALUES (?, ?, ?)',
      )
      .run('exact-owner-message', 9_200, 'exact-owner-chat');
    raw
      .prepare(
        'INSERT INTO message_deletion_ledger (guid, date_deleted, chat_guid) VALUES (?, ?, ?)',
      )
      .run('exact-owner-attachment-message', 9_300, 'exact-owner-chat');

    const exposure = await captureFullRepairPruneExposure(db);
    const result = await reconcileFullRepairPruneExposure(db, exposure, {
      chatGuids: new Set(),
      messageGuids: new Set(),
      attachmentGuidsByMessage: new Map(),
    });

    expect(result).toMatchObject({ messagesRemoved: 1, attachmentsRemoved: 1 });
    expect(
      raw.prepare('SELECT id FROM messages WHERE guid = ?').get('wrong-owner-message'),
    ).toBeUndefined();
    expect(
      raw.prepare('SELECT id FROM attachments WHERE guid = ?').get('wrong-owner-attachment'),
    ).toBeUndefined();
    expect(
      raw.prepare('SELECT id FROM messages WHERE guid = ?').get('exact-owner-message'),
    ).toBeDefined();
    expect(
      raw.prepare('SELECT id FROM messages WHERE guid = ?').get('exact-owner-attachment-message'),
    ).toBeDefined();
    expect(
      raw.prepare('SELECT id FROM attachments WHERE guid = ?').get('exact-owner-attachment'),
    ).toBeDefined();
  });

  it('keeps queued sends, scheduled messages and own messages from the last hour (M078)', async () => {
    const { db, raw } = await createTestDb();
    const insertChat = raw.prepare('INSERT INTO chats (guid) VALUES (?)');
    // Own messages the Mac has not confirmed yet carry no original_row_id.
    const insertOwnMessage = raw.prepare(
      `INSERT INTO messages
         (guid, original_row_id, chat_id, is_from_me, date_created, send_state)
       VALUES (?, NULL, ?, 1, ?, 'sent')`,
    );
    const now = Date.now();
    const tenMinutesAgo = now - 10 * 60_000;
    insertChat.run('queued-chat');
    insertChat.run('scheduled-chat');
    const recentChatId = Number(insertChat.run('recent-own-chat').lastInsertRowid);
    const oldChatId = Number(insertChat.run('old-own-chat').lastInsertRowid);
    insertChat.run('empty-chat');
    raw
      .prepare(
        `INSERT INTO outgoing_queue (temp_guid, chat_guid, kind, payload)
         VALUES ('temp-queued', 'queued-chat', 'text', '{}')`,
      )
      .run();
    raw
      .prepare(
        `INSERT INTO scheduled_messages (chat_guid, payload, scheduled_for)
         VALUES ('scheduled-chat', '{}', ?)`,
      )
      .run(now + 60_000);
    // Inside the one-hour grace: one plain message, one with a photo.
    const recentId = Number(
      insertOwnMessage.run('recent-own', recentChatId, tenMinutesAgo).lastInsertRowid,
    );
    const recentPhotoId = Number(
      insertOwnMessage.run('recent-own-photo', recentChatId, tenMinutesAgo).lastInsertRowid,
    );
    raw
      .prepare('INSERT INTO attachments (guid, message_id) VALUES (?, ?)')
      .run('recent-own-attachment', recentPhotoId);
    // Outside the grace, so the same kind of row is pruned.
    insertOwnMessage.run('old-own', oldChatId, now - 2 * 60 * 60_000);

    const exposure = await captureFullRepairPruneExposure(db);
    // Capture already leaves recent own messages out...
    expect(exposure.messages.map((row) => row.guid)).toEqual(['old-own']);
    // ...and removal checks the grace again, so a stale candidate for one is refused too.
    const staleCandidate = {
      id: recentId,
      guid: 'recent-own',
      originalRowId: null,
      chatId: recentChatId,
      dateCreated: tenMinutesAgo,
    };
    const result = await reconcileFullRepairPruneExposure(
      db,
      { ...exposure, messages: [...exposure.messages, staleCandidate] },
      { chatGuids: new Set(), messageGuids: new Set(), attachmentGuidsByMessage: new Map() },
    );

    expect(result).toMatchObject({
      messagesRemoved: 1,
      attachmentsRemoved: 0,
      chatsRemoved: 2,
      chatsPreservedForLocalWork: 3,
    });
    const guids = (table: string): unknown[] =>
      raw.prepare(`SELECT guid FROM ${table} ORDER BY guid`).all();
    expect(guids('chats')).toEqual([
      { guid: 'queued-chat' },
      { guid: 'recent-own-chat' },
      { guid: 'scheduled-chat' },
    ]);
    expect(guids('messages')).toEqual([{ guid: 'recent-own' }, { guid: 'recent-own-photo' }]);
    expect(guids('attachments')).toEqual([{ guid: 'recent-own-attachment' }]);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM outgoing_queue').get()).toEqual({ n: 1 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM scheduled_messages').get()).toEqual({ n: 1 });
  });
});
