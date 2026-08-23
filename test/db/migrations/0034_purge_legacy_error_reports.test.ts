import Database from 'better-sqlite3';
import { runMigrations, type SqlRunner } from '@db/migrate';
import { MIGRATIONS } from '@db/migrations';

function createRunner(raw: Database.Database, stopBefore0034: { value: boolean }): SqlRunner {
  return {
    async exec(statement, params) {
      if (stopBefore0034.value && statement === 'DELETE FROM error_reports') {
        throw new Error('test stop before migration 0034');
      }
      raw.prepare(statement).run(...((params as unknown[]) ?? []));
    },
    async query(statement, params) {
      return raw.prepare(statement).all(...((params as unknown[]) ?? [])) as never[];
    },
  };
}

describe('migration 0034_purge_legacy_error_reports', () => {
  it('purges every pre-policy diagnostic row and leaves the strict queue usable', async () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    try {
      const stopBefore0034 = { value: true };
      const runner = createRunner(raw, stopBefore0034);

      await expect(runMigrations(runner)).rejects.toThrow('test stop before migration 0034');
      expect(raw.prepare('SELECT name FROM _migrations ORDER BY rowid DESC LIMIT 1').get()).toEqual(
        { name: '0033_message_deletion_ledger' },
      );
      raw
        .prepare(
          `INSERT INTO error_reports (level, message, stack, tag, meta, created_at)
           VALUES ('error', ?, ?, 'legacy', ?, 1)`,
        )
        .run(
          'private message for alice@example.com',
          '/Users/alice/PrivateMessage.tsx:12',
          '{"response":"raw-body-canary"}',
        );

      // Keep this named upgrade test isolated when 0035+ land: mark only migrations AFTER 0034
      // as applied, so this run still executes exactly the diagnostic purge and no later repair.
      const purgeIndex = MIGRATIONS.findIndex(
        (migration) => migration.name === '0034_purge_legacy_error_reports',
      );
      expect(purgeIndex).toBeGreaterThanOrEqual(0);
      const markApplied = raw.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, 0)');
      for (const migration of MIGRATIONS.slice(purgeIndex + 1)) markApplied.run(migration.name);

      stopBefore0034.value = false;
      await expect(runMigrations(runner)).resolves.toEqual(['0034_purge_legacy_error_reports']);

      expect(raw.prepare('SELECT COUNT(*) AS count FROM error_reports').get()).toEqual({
        count: 0,
      });

      raw
        .prepare(
          `INSERT INTO error_reports (level, message, stack, tag, meta, created_at)
           VALUES ('error', 'diagnostic.unclassified', 'at gator.diagnostic.unclassified',
                   'diagnostic', '{"schemaVersion":1}', 2)`,
        )
        .run();
      expect(raw.prepare('SELECT message, meta FROM error_reports ORDER BY id').all()).toEqual([
        { message: 'diagnostic.unclassified', meta: '{"schemaVersion":1}' },
      ]);
    } finally {
      raw.close();
    }
  });
});
