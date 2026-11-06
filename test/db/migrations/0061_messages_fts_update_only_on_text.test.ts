import Database from 'better-sqlite3';
import { runMigrations, type SqlRunner } from '@db/migrate';
import { migrationNamesFrom } from '../../support/migrationNames';

const MIGRATION_NAME = '0061_messages_fts_update_only_on_text';

function runnerFor(raw: Database.Database, stopBefore0061: { value: boolean }): SqlRunner {
  return {
    async exec(statement, params) {
      if (stopBefore0061.value && statement.includes('DROP TRIGGER IF EXISTS messages_au')) {
        throw new Error('test stop before migration 0061');
      }
      raw.prepare(statement).run(...((params as unknown[]) ?? []));
    },
    async query(statement, params) {
      return raw.prepare(statement).all(...((params as unknown[]) ?? [])) as never[];
    },
  };
}

describe(`migration ${MIGRATION_NAME}`, () => {
  it('re-indexes a message only when its text changes', async () => {
    const raw = new Database(':memory:');
    const stopBefore0061 = { value: true };
    const runner = runnerFor(raw, stopBefore0061);
    const hits = (term: string): unknown[] =>
      raw.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?').all(term);
    try {
      await expect(runMigrations(runner)).rejects.toThrow('test stop before migration 0061');
      expect(raw.prepare('SELECT name FROM _migrations ORDER BY rowid DESC LIMIT 1').get()).toEqual(
        { name: '0060_chat_auto_unarchive' },
      );
      raw.prepare("INSERT INTO chats (guid, style) VALUES ('c1', 45)").run();
      raw
        .prepare(
          "INSERT INTO messages (guid, chat_id, text, date_created) VALUES ('m1', 1, 'hello world', 100)",
        )
        .run();
      expect(hits('hello')).toEqual([{ rowid: 1 }]);

      // Before the upgrade the trigger has no column list: it fires on ANY update. (Taking the
      // posting away by hand to watch it come back is not possible here: the old trigger's own
      // 'delete' of a posting that is already gone makes FTS5 report a corrupt index.)
      const before = raw
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'messages_au'")
        .get() as { sql: string };
      expect(before.sql).toMatch(/AFTER UPDATE ON messages/);
      expect(before.sql).not.toMatch(/UPDATE OF/);

      stopBefore0061.value = false;
      await expect(runMigrations(runner)).resolves.toEqual(migrationNamesFrom(MIGRATION_NAME));

      const trigger = raw
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'messages_au'")
        .get() as { sql: string };
      expect(trigger.sql).toMatch(/AFTER UPDATE OF text ON messages/);
      expect(trigger.sql).toMatch(/WHEN old\.text IS NOT new\.text/);

      // Same experiment after the upgrade: a non-text update leaves the index alone.
      raw
        .prepare(
          "INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', 1, 'hello world')",
        )
        .run();
      raw.prepare("UPDATE messages SET date_read = 6, has_attachments = 1 WHERE guid = 'm1'").run();
      expect(hits('hello')).toEqual([]);
      // Restore the posting, then prove an unchanged text in the SET list is a no-op too.
      raw.prepare("INSERT INTO messages_fts(rowid, text) VALUES (1, 'hello world')").run();
      raw.prepare("UPDATE messages SET text = 'hello world' WHERE guid = 'm1'").run();
      expect(hits('hello')).toEqual([{ rowid: 1 }]);

      // A real text change (an edit or an unsend) still re-indexes.
      raw.prepare("UPDATE messages SET text = 'goodbye' WHERE guid = 'm1'").run();
      expect(hits('goodbye')).toEqual([{ rowid: 1 }]);
      expect(hits('hello')).toEqual([]);
    } finally {
      raw.close();
    }
  });
});
