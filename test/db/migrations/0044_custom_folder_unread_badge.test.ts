import Database from 'better-sqlite3';
import { runMigrations, type SqlRunner } from '@db/migrate';

const MIGRATION_NAME = '0044_custom_folder_unread_badge';
const ADD_COLUMN_MARKER = 'ADD COLUMN show_unread_badge';

function runnerFor(raw: Database.Database, stopBefore0044: { value: boolean }): SqlRunner {
  return {
    async exec(statement, params) {
      if (stopBefore0044.value && statement.includes(ADD_COLUMN_MARKER)) {
        throw new Error('test stop before migration 0044');
      }
      raw.prepare(statement).run(...((params as unknown[]) ?? []));
    },
    async query(statement, params) {
      return raw.prepare(statement).all(...((params as unknown[]) ?? [])) as never[];
    },
  };
}

describe('migration 0044_custom_folder_unread_badge', () => {
  it('upgrades existing folders with a constrained default-on unread badge preference', async () => {
    const raw = new Database(':memory:');
    const stopBefore0044 = { value: true };
    const runner = runnerFor(raw, stopBefore0044);
    try {
      await expect(runMigrations(runner)).rejects.toThrow('test stop before migration 0044');
      expect(raw.prepare('SELECT name FROM _migrations ORDER BY rowid DESC LIMIT 1').get()).toEqual(
        { name: '0043_custom_folders' },
      );
      raw.prepare("INSERT INTO custom_folders (name, sort_order) VALUES ('Existing', 0)").run();

      stopBefore0044.value = false;
      await expect(runMigrations(runner)).resolves.toEqual([MIGRATION_NAME]);
      expect(
        raw
          .prepare(
            'SELECT name, show_unread_badge AS showUnreadBadge FROM custom_folders ORDER BY id',
          )
          .all(),
      ).toEqual([{ name: 'Existing', showUnreadBadge: 1 }]);

      raw.prepare("UPDATE custom_folders SET show_unread_badge = 0 WHERE name = 'Existing'").run();
      raw.prepare("INSERT INTO custom_folders (name, sort_order) VALUES ('New', 1)").run();
      expect(
        raw
          .prepare(
            'SELECT name, show_unread_badge AS showUnreadBadge FROM custom_folders ORDER BY id',
          )
          .all(),
      ).toEqual([
        { name: 'Existing', showUnreadBadge: 0 },
        { name: 'New', showUnreadBadge: 1 },
      ]);
      expect(() =>
        raw
          .prepare("UPDATE custom_folders SET show_unread_badge = 2 WHERE name = 'Existing'")
          .run(),
      ).toThrow(/custom_folders_show_unread_badge_boolean/);
      await expect(runMigrations(runner)).resolves.toEqual([]);
    } finally {
      raw.close();
    }
  });
});
