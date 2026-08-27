import { Chat } from '@core/models';
import {
  captureFullRepairPruneExposure,
  FULL_REPAIR_RETIRED_CHAT_KV_PREFIX,
  reconcileFullRepairPruneExposure,
  upsertChats,
  upsertHandles,
} from '@db/repositories';
import { fullSync, sameFullSyncServerView, type FullSyncServerView } from '@/services/sync/engine';
import type { SyncApi } from '@/services/sync/types';
import { createTestDb } from '../support/testDb';

describe('full repair reconciliation', () => {
  it('removes only stable phantom rows while preserving local state and concurrent protections', async () => {
    const { db, raw } = await createTestDb();
    const insertChat = raw.prepare(
      `INSERT INTO chats
         (guid, latest_message_date, is_pinned, custom_name, background_uri, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const seedChat = (
      guid: string,
      options: {
        latest?: number | null;
        pinned?: number;
        customName?: string | null;
        backgroundUri?: string | null;
        deletedAt?: number | null;
      } = {},
    ): number => {
      const result = insertChat.run(
        guid,
        options.latest ?? null,
        options.pinned ?? 0,
        options.customName ?? null,
        options.backgroundUri ?? null,
        options.deletedAt ?? null,
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
    const tombstoneChatId = seedChat('tombstone-chat', { latest: 400 });
    const lateTombstoneChatId = seedChat('late-tombstone-chat', { latest: 500 });
    const lateReminderChatId = seedChat('late-reminder-chat', { latest: 600 });
    const lateAttachmentChatId = seedChat('late-attachment-chat', { latest: 700 });

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
    const runRepairView = async (): Promise<void> => {
      await fullSync(db, api, {
        maxMessagesPerChat: 0,
        failOnChatError: true,
        commitMarker: false,
        onServerView: (view) => views.push(view),
      });
    };
    await runRepairView();
    await runRepairView();
    expect(views).toHaveLength(2);
    expect(sameFullSyncServerView(views[0]!, views[1]!)).toBe(true);
    expect(views[1]!.messages.get('server-last')).toEqual({
      chatGuid: 'server-chat',
      originalRowId: 22,
    });

    // These protections land after exposure, as they can during the two long network crawls.
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

    const confirmed = views[1]!;
    const result = await reconcileFullRepairPruneExposure(db, exposure, {
      chatGuids: new Set(confirmed.chats.keys()),
      messageGuids: new Set(confirmed.messages.keys()),
      attachmentGuidsByMessage: confirmed.attachmentsByMessage,
    });

    expect(result).toMatchObject({
      messagesRemoved: 1,
      attachmentsRemoved: 1,
      chatsRemoved: 1,
      chatShellsRetired: 1,
    });
    expect(raw.prepare('SELECT id FROM chats WHERE guid = ?').get('phantom-chat')).toBeUndefined();
    expect(raw.prepare('SELECT id FROM messages WHERE guid = ?').get('server-last')).toBeDefined();
    expect(raw.prepare('SELECT chat_id FROM messages WHERE guid = ?').get('server-last')).toEqual({
      chat_id: serverChatId,
    });
    expect(
      raw
        .prepare('SELECT latest_message_date, last_read_message_guid FROM chats WHERE id = ?')
        .get(sourceChatId),
    ).toEqual({ latest_message_date: 100, last_read_message_guid: 'source-anchor' });

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
});
