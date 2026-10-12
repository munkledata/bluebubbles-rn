import Database from 'better-sqlite3';
import { runMigrations, type SqlRunner } from '@db/migrate';

const MIGRATION_NAME = '0049_inbox_search_postings';

function runnerFor(raw: Database.Database, stopBefore0049: { value: boolean }): SqlRunner {
  return {
    async exec(statement, params) {
      if (stopBefore0049.value && statement.includes('CREATE TABLE inbox_search_state')) {
        throw new Error('test stop before migration 0049');
      }
      raw.prepare(statement).run(...((params as unknown[]) ?? []));
    },
    async query(statement, params) {
      return raw.prepare(statement).all(...((params as unknown[]) ?? [])) as never[];
    },
  };
}

describe('migration 0049_inbox_search_postings', () => {
  it('backfills dirty revisions and invalidates title, participant, and handle changes safely', async () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    const stopBefore0049 = { value: true };
    const runner = runnerFor(raw, stopBefore0049);
    try {
      await expect(runMigrations(runner)).rejects.toThrow('test stop before migration 0049');
      expect(raw.prepare('SELECT name FROM _migrations ORDER BY rowid DESC LIMIT 1').get()).toEqual(
        { name: '0048_attachment_media_exports' },
      );
      raw.prepare("INSERT INTO chats (guid, display_name) VALUES ('old-chat', 'Old name')").run();
      raw.prepare("INSERT INTO handles (address, service) VALUES ('old@example.test', '')").run();
      const chatId = (
        raw.prepare("SELECT id FROM chats WHERE guid = 'old-chat'").get() as {
          id: number;
        }
      ).id;
      const handleId = (
        raw.prepare("SELECT id FROM handles WHERE address = 'old@example.test'").get() as {
          id: number;
        }
      ).id;
      raw
        .prepare('INSERT INTO chat_handles (chat_id, handle_id) VALUES (?, ?)')
        .run(chatId, handleId);

      stopBefore0049.value = false;
      await expect(runMigrations(runner)).resolves.toEqual([
        MIGRATION_NAME,
        '0050_message_identity_owner_scope',
        '0051_handle_color_backup_index',
        '0052_chat_history_deletion_boundary',
        '0053_versioned_server_message_state',
        '0054_handle_contact_ambiguous',
      ]);
      const state = () =>
        raw
          .prepare(
            'SELECT revision, is_dirty AS isDirty, rebuildable FROM inbox_search_state WHERE chat_id = ?',
          )
          .get(chatId) as { revision: number; isDirty: number; rebuildable: number };
      expect(state()).toEqual({ revision: 1, isDirty: 1, rebuildable: 1 });
      expect(raw.prepare('SELECT COUNT(*) AS count FROM inbox_search_postings').get()).toEqual({
        count: 0,
      });

      raw.prepare("UPDATE chats SET display_name = 'New name' WHERE id = ?").run(chatId);
      expect(state().revision).toBe(2);
      raw.prepare("UPDATE chats SET display_name = 'New name' WHERE id = ?").run(chatId);
      expect(state().revision).toBe(2);
      raw.prepare("UPDATE handles SET display_name = 'Contact name' WHERE id = ?").run(handleId);
      expect(state().revision).toBe(3);
      raw
        .prepare('DELETE FROM chat_handles WHERE chat_id = ? AND handle_id = ?')
        .run(chatId, handleId);
      expect(state().revision).toBe(4);
      raw
        .prepare('INSERT INTO chat_handles (chat_id, handle_id) VALUES (?, ?)')
        .run(chatId, handleId);
      expect(state().revision).toBe(5);

      raw
        .prepare('INSERT INTO inbox_search_postings (chat_id, gram) VALUES (?, ?)')
        .run(chatId, 97 * 65_536 + 98);
      const plan = raw
        .prepare(
          'EXPLAIN QUERY PLAN SELECT chat_id FROM inbox_search_postings WHERE gram = ? AND chat_id > ? ORDER BY chat_id LIMIT 128',
        )
        .all(97 * 65_536 + 98, 0) as Array<{ detail: string }>;
      expect(plan.map((row) => row.detail).join(' ')).toContain('inbox_search_postings_gram_idx');

      // A handle delete cascades the link and dirties its surviving chat. A chat delete cascades
      // both the link and postings without trying to recreate a state row for the deleted parent.
      raw.prepare('DELETE FROM handles WHERE id = ?').run(handleId);
      expect(state().revision).toBe(6);
      raw.prepare('DELETE FROM chats WHERE id = ?').run(chatId);
      expect(raw.prepare('SELECT COUNT(*) AS count FROM inbox_search_state').get()).toEqual({
        count: 0,
      });
      expect(raw.prepare('SELECT COUNT(*) AS count FROM inbox_search_postings').get()).toEqual({
        count: 0,
      });
      await expect(runMigrations(runner)).resolves.toEqual([]);
    } finally {
      raw.close();
    }
  });
});
