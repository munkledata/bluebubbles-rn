import { listReminders } from '@db/repositories';
import { createTestDb } from '../support/testDb';

const CHAT_GUID = 'iMessage;-;+15551234567';

describe('listReminders', () => {
  it('shows the live, visible message text and sender, never a frozen copy', async () => {
    const { db, raw } = await createTestDb();
    try {
      const chatId = Number(
        raw.prepare('INSERT INTO chats(guid, style) VALUES (?, 45)').run(CHAT_GUID).lastInsertRowid,
      );
      const handleId = Number(
        raw
          .prepare('INSERT INTO handles(address, service, display_name) VALUES (?, ?, ?)')
          .run('+15551234567', 'iMessage', 'Alice').lastInsertRowid,
      );
      const insertMessage = raw.prepare(
        `INSERT INTO messages(guid, chat_id, handle_id, text, is_from_me, date_created)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      insertMessage.run('m-visible', chatId, handleId, 'Pick up the cake', 0, 1);
      insertMessage.run('m-mine', chatId, null, 'Call the bank', 1, 2);
      insertMessage.run('m-unsent', chatId, handleId, 'secret plans', 0, 3);
      raw
        .prepare(
          `UPDATE messages SET retraction_state = 'fully-retracted', date_retracted = 4
            WHERE guid = 'm-unsent'`,
        )
        .run();
      insertMessage.run('m-deleted', chatId, handleId, 'deleted text', 0, 5);
      raw.prepare("UPDATE messages SET date_deleted = 6 WHERE guid = 'm-deleted'").run();
      const insertReminder = raw.prepare(
        `INSERT INTO reminders(message_guid, chat_guid, scheduled_for, notification_id)
         VALUES (?, ?, ?, ?)`,
      );
      ['m-visible', 'm-mine', 'm-unsent', 'm-deleted', 'm-gone'].forEach((guid, index) =>
        insertReminder.run(guid, CHAT_GUID, 100 + index, `notification-${index}`),
      );

      const rows = await listReminders(db);

      expect(rows.map((row) => [row.messageGuid, row.messagePreview, row.senderName])).toEqual([
        ['m-visible', 'Pick up the cake', 'Alice'],
        ['m-mine', 'Call the bank', null],
        // Unsent: who sent it stays, the withdrawn text does not.
        ['m-unsent', null, 'Alice'],
        // Deleted on this phone or never synced: nothing to show.
        ['m-deleted', null, null],
        ['m-gone', null, null],
      ]);
    } finally {
      raw.close();
    }
  });
});
