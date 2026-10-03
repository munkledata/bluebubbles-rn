import Database from 'better-sqlite3';
import { runMigrations, type SqlRunner } from '@db/migrate';

const MIGRATION_NAME = '0052_chat_history_deletion_boundary';

function runnerFor(raw: Database.Database, stopBefore0052: { value: boolean }): SqlRunner {
  return {
    async exec(statement, params) {
      if (
        stopBefore0052.value &&
        statement.includes('ALTER TABLE chats') &&
        statement.includes('ADD COLUMN history_deleted_at')
      ) {
        throw new Error('test stop before migration 0052');
      }
      raw.prepare(statement).run(...((params as unknown[]) ?? []));
    },
    async query(statement, params) {
      return raw.prepare(statement).all(...((params as unknown[]) ?? [])) as never[];
    },
  };
}

describe('migration 0052_chat_history_deletion_boundary', () => {
  it('backfills user deletion provenance without adopting Full Repair synthetic shells', async () => {
    const raw = new Database(':memory:');
    const stopBefore0052 = { value: true };
    const runner = runnerFor(raw, stopBefore0052);
    try {
      await expect(runMigrations(runner)).rejects.toThrow('test stop before migration 0052');
      expect(raw.prepare('SELECT name FROM _migrations ORDER BY rowid DESC LIMIT 1').get()).toEqual(
        { name: '0051_handle_color_backup_index' },
      );

      raw
        .prepare(
          `INSERT INTO chats (guid, deleted_at)
           VALUES ('user-deleted', 5000), ('repair-shell', 0), ('live-chat', NULL)`,
        )
        .run();
      raw
        .prepare('INSERT INTO kv (key, value) VALUES (?, ?)')
        .run('sync.fullRepair.retiredChat.repair-shell', '0');

      stopBefore0052.value = false;
      await expect(runMigrations(runner)).resolves.toEqual([
        MIGRATION_NAME,
        '0053_versioned_server_message_state',
      ]);

      expect(
        raw
          .prepare(
            `SELECT guid, deleted_at AS deletedAt, history_deleted_at AS historyDeletedAt
               FROM chats
              ORDER BY guid`,
          )
          .all(),
      ).toEqual([
        { guid: 'live-chat', deletedAt: null, historyDeletedAt: null },
        { guid: 'repair-shell', deletedAt: 0, historyDeletedAt: null },
        { guid: 'user-deleted', deletedAt: 5000, historyDeletedAt: 5000 },
      ]);
      await expect(runMigrations(runner)).resolves.toEqual([]);
    } finally {
      raw.close();
    }
  });
});
