import Database from 'better-sqlite3';
import { runMigrations, type SqlRunner } from '@db/migrate';
import { MIGRATIONS } from '@db/migrations';

function createRunner(raw: Database.Database, stopBefore0033: { value: boolean }): SqlRunner {
  return {
    async exec(statement, params) {
      if (stopBefore0033.value && statement.includes('CREATE TABLE message_deletion_ledger')) {
        throw new Error('test stop before migration 0033');
      }
      raw.prepare(statement).run(...((params as unknown[]) ?? []));
    },
    async query(statement, params) {
      return raw.prepare(statement).all(...((params as unknown[]) ?? [])) as never[];
    },
  };
}

describe('migration 0033_message_deletion_ledger', () => {
  it('upgrades 0032 data and backfills existing message tombstones', async () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    try {
      const stopBefore0033 = { value: true };
      const runner = createRunner(raw, stopBefore0033);

      await expect(runMigrations(runner)).rejects.toThrow('test stop before migration 0033');
      expect(raw.prepare('SELECT name FROM _migrations ORDER BY rowid DESC LIMIT 1').get()).toEqual(
        { name: '0032_theme_restore_lookup_index' },
      );
      raw.prepare("INSERT INTO chats (guid) VALUES ('chat-1')").run();
      const chatId = (
        raw.prepare("SELECT id FROM chats WHERE guid = 'chat-1'").get() as { id: number }
      ).id;
      const insert = raw.prepare(
        'INSERT INTO messages (guid, chat_id, date_deleted) VALUES (?, ?, ?)',
      );
      insert.run('deleted-before-upgrade', chatId, 1234);
      insert.run('visible-before-upgrade', chatId, null);

      // Keep this named upgrade test isolated when 0034+ land: mark only migrations AFTER 0033 as
      // applied, so this run still executes exactly the ledger migration and no future schema.
      const ledgerIndex = MIGRATIONS.findIndex(
        (migration) => migration.name === '0033_message_deletion_ledger',
      );
      expect(ledgerIndex).toBeGreaterThanOrEqual(0);
      const markApplied = raw.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, 0)');
      for (const migration of MIGRATIONS.slice(ledgerIndex + 1)) markApplied.run(migration.name);

      stopBefore0033.value = false;
      await expect(runMigrations(runner)).resolves.toEqual(['0033_message_deletion_ledger']);

      expect(raw.prepare('PRAGMA table_info(message_deletion_ledger)').all()).toEqual([
        expect.objectContaining({ name: 'guid', type: 'TEXT', notnull: 1, pk: 1 }),
        expect.objectContaining({ name: 'date_deleted', type: 'INTEGER', notnull: 1, pk: 0 }),
      ]);
      expect(
        raw
          .prepare(
            'SELECT guid, date_deleted AS dateDeleted FROM message_deletion_ledger ORDER BY guid',
          )
          .all(),
      ).toEqual([{ guid: 'deleted-before-upgrade', dateDeleted: 1234 }]);
      expect(raw.prepare('PRAGMA foreign_key_list(message_deletion_ledger)').all()).toEqual([]);
    } finally {
      raw.close();
    }
  });
});
