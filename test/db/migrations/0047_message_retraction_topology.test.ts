import Database from 'better-sqlite3';
import { runMigrations, type SqlRunner } from '@db/migrate';

const MIGRATION_NAME = '0047_message_retraction_topology';
const FIRST_COLUMN_MARKER = 'ADD COLUMN retraction_state';

function runnerFor(raw: Database.Database, stopBefore0047: { value: boolean }): SqlRunner {
  return {
    async exec(statement, params) {
      if (stopBefore0047.value && statement.includes(FIRST_COLUMN_MARKER)) {
        throw new Error('test stop before migration 0047');
      }
      raw.prepare(statement).run(...((params as unknown[]) ?? []));
    },
    async query(statement, params) {
      return raw.prepare(statement).all(...((params as unknown[]) ?? [])) as never[];
    },
  };
}

describe('migration 0047_message_retraction_topology', () => {
  it('preserves existing rows and adds constrained message/attachment visibility state', async () => {
    const raw = new Database(':memory:');
    const stopBefore0047 = { value: true };
    const runner = runnerFor(raw, stopBefore0047);
    try {
      await expect(runMigrations(runner)).rejects.toThrow('test stop before migration 0047');
      expect(raw.prepare('SELECT name FROM _migrations ORDER BY rowid DESC LIMIT 1').get()).toEqual(
        { name: '0046_message_send_attempt_owner' },
      );

      raw.prepare("INSERT INTO chats (guid) VALUES ('chat-before-0047')").run();
      const chat = raw.prepare("SELECT id FROM chats WHERE guid = 'chat-before-0047'").get() as {
        id: number;
      };
      raw.prepare('INSERT INTO messages (guid, chat_id) VALUES (?, ?)').run('message', chat.id);
      const message = raw.prepare("SELECT id FROM messages WHERE guid = 'message'").get() as {
        id: number;
      };
      raw
        .prepare('INSERT INTO attachments (guid, message_id) VALUES (?, ?)')
        .run('attachment', message.id);
      raw
        .prepare(
          `INSERT INTO reminders
             (message_guid, chat_guid, message_preview, sender_name, scheduled_for, notification_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run('message', 'chat-before-0047', 'PRIVATE REMINDER BODY', 'PRIVATE SENDER', 99, 'r1');

      stopBefore0047.value = false;
      await expect(runMigrations(runner)).resolves.toEqual([
        MIGRATION_NAME,
        '0048_attachment_media_exports',
        '0049_inbox_search_postings',
        '0050_message_identity_owner_scope',
        '0051_handle_color_backup_index',
        '0052_chat_history_deletion_boundary',
        '0053_versioned_server_message_state',
      ]);
      expect(
        raw
          .prepare(
            `SELECT retraction_state AS retractionState,
                    message_part_topology AS messagePartTopology,
                    pending_retraction_part_index AS pendingRetractionPartIndex
               FROM messages WHERE guid = 'message'`,
          )
          .get(),
      ).toEqual({
        retractionState: null,
        messagePartTopology: null,
        pendingRetractionPartIndex: null,
      });
      expect(
        raw
          .prepare(
            `SELECT message_part_index AS messagePartIndex, is_retracted AS isRetracted
               FROM attachments WHERE guid = 'attachment'`,
          )
          .get(),
      ).toEqual({ messagePartIndex: null, isRetracted: 0 });
      expect(
        raw
          .prepare(
            `SELECT message_preview AS messagePreview, sender_name AS senderName
               FROM reminders WHERE notification_id = 'r1'`,
          )
          .get(),
      ).toEqual({ messagePreview: null, senderName: null });

      expect(() =>
        raw
          .prepare("UPDATE messages SET retraction_state = 'invalid' WHERE guid = 'message'")
          .run(),
      ).toThrow(/messages_retraction_state_valid/);
      expect(() =>
        raw
          .prepare('UPDATE messages SET pending_retraction_part_index = 10001 WHERE guid = ?')
          .run('message'),
      ).toThrow(/messages_pending_retraction_part_index_valid/);
      expect(() =>
        raw
          .prepare("UPDATE attachments SET message_part_index = 10001 WHERE guid = 'attachment'")
          .run(),
      ).toThrow(/attachments_message_part_index_valid/);
      expect(() =>
        raw.prepare("UPDATE attachments SET is_retracted = 2 WHERE guid = 'attachment'").run(),
      ).toThrow(/attachments_is_retracted_boolean/);

      await expect(runMigrations(runner)).resolves.toEqual([]);
    } finally {
      raw.close();
    }
  });
});
