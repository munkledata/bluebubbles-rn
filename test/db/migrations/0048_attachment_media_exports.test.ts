import Database from 'better-sqlite3';
import { runMigrations, type SqlRunner } from '@db/migrate';

const MIGRATION_NAME = '0048_attachment_media_exports';
const FIRST_STATEMENT_MARKER = 'CREATE TABLE attachment_media_exports';

function runnerFor(raw: Database.Database, stopBefore0048: { value: boolean }): SqlRunner {
  return {
    async exec(statement, params) {
      if (stopBefore0048.value && statement.includes(FIRST_STATEMENT_MARKER)) {
        throw new Error('test stop before migration 0048');
      }
      raw.prepare(statement).run(...((params as unknown[]) ?? []));
    },
    async query(statement, params) {
      return raw.prepare(statement).all(...((params as unknown[]) ?? [])) as never[];
    },
  };
}

describe('migration 0048_attachment_media_exports', () => {
  it('adds a constrained, destination-bound receipt table without backfilling old downloads', async () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    const stopBefore0048 = { value: true };
    const runner = runnerFor(raw, stopBefore0048);
    try {
      await expect(runMigrations(runner)).rejects.toThrow('test stop before migration 0048');
      expect(raw.prepare('SELECT name FROM _migrations ORDER BY rowid DESC LIMIT 1').get()).toEqual(
        { name: '0047_message_retraction_topology' },
      );

      raw.prepare("INSERT INTO chats (guid) VALUES ('chat-before-0048')").run();
      const chat = raw.prepare("SELECT id FROM chats WHERE guid = 'chat-before-0048'").get() as {
        id: number;
      };
      raw
        .prepare('INSERT INTO messages (guid, chat_id, date_created) VALUES (?, ?, ?)')
        .run('message-before-0048', chat.id, 1000);
      const message = raw
        .prepare("SELECT id FROM messages WHERE guid = 'message-before-0048'")
        .get() as { id: number };
      raw
        .prepare(
          `INSERT INTO attachments (guid, message_id, mime_type, total_bytes, local_path)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('attachment-before-0048', message.id, 'image/jpeg', 1234, 'file:///old/image.jpg');

      stopBefore0048.value = false;
      await expect(runMigrations(runner)).resolves.toEqual([
        MIGRATION_NAME,
        '0049_inbox_search_postings',
        '0050_message_identity_owner_scope',
        '0051_handle_color_backup_index',
        '0052_chat_history_deletion_boundary',
        '0053_versioned_server_message_state',
        '0054_handle_contact_ambiguous',
      ]);
      expect(raw.prepare('SELECT COUNT(*) AS rows FROM attachment_media_exports').get()).toEqual({
        rows: 0,
      });

      raw
        .prepare(
          `INSERT INTO attachment_media_exports
             (attachment_guid, destination, created_at, expires_at)
           VALUES (?, 'album', 1000, 2000)`,
        )
        .run('attachment-before-0048');
      expect(
        raw
          .prepare(
            `SELECT destination, state, attempts, claim_version AS claimVersion
               FROM attachment_media_exports`,
          )
          .get(),
      ).toEqual({ destination: 'album', state: 'pending', attempts: 0, claimVersion: 0 });

      expect(() => raw.prepare('UPDATE attachment_media_exports SET attempts = 0.5').run()).toThrow(
        /attachment_media_exports_attempts_valid/,
      );
      expect(() =>
        raw.prepare('UPDATE attachment_media_exports SET next_attempt_at = 0.5').run(),
      ).toThrow(/attachment_media_exports_next_attempt_at_nonnegative/);
      expect(() =>
        raw
          .prepare("UPDATE attachment_media_exports SET last_error_code = 'private native text'")
          .run(),
      ).toThrow(/attachment_media_exports_last_error_code_valid/);
      expect(() =>
        raw.prepare("UPDATE attachment_media_exports SET state = 'completed'").run(),
      ).toThrow(/attachment_media_exports_state_shape_valid/);

      raw.prepare("DELETE FROM attachments WHERE guid = 'attachment-before-0048'").run();
      expect(raw.prepare('SELECT COUNT(*) AS rows FROM attachment_media_exports').get()).toEqual({
        rows: 0,
      });
      await expect(runMigrations(runner)).resolves.toEqual([]);
    } finally {
      raw.close();
    }
  });
});
