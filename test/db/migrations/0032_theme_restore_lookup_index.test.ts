import Database from 'better-sqlite3';
import { runMigrations, type SqlRunner } from '@db/migrate';

function createRunner(raw: Database.Database, stopBefore: { value: '0032' | '0033' }): SqlRunner {
  return {
    async exec(statement, params) {
      if (
        stopBefore.value === '0032' &&
        statement.includes('CREATE INDEX themes_restore_lookup_idx')
      ) {
        throw new Error('test stop before migration 0032');
      }
      if (
        stopBefore.value === '0033' &&
        statement.includes('CREATE TABLE message_deletion_ledger')
      ) {
        throw new Error('test stop before migration 0033');
      }
      raw.prepare(statement).run(...((params as unknown[]) ?? []));
    },
    async query(statement, params) {
      return raw.prepare(statement).all(...((params as unknown[]) ?? [])) as never[];
    },
  };
}

describe('migration 0032_theme_restore_lookup_index', () => {
  it('upgrades 0031 data and gives theme restore an indexed lookup', async () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    try {
      const stopBefore: { value: '0032' | '0033' } = { value: '0032' };
      const runner = createRunner(raw, stopBefore);

      await expect(runMigrations(runner)).rejects.toThrow('test stop before migration 0032');
      expect(raw.prepare('SELECT name FROM _migrations ORDER BY rowid DESC LIMIT 1').get()).toEqual(
        { name: '0031_incoming_event_queue' },
      );
      raw
        .prepare('INSERT INTO themes (name, mode, tokens, is_preset) VALUES (?, ?, ?, 0)')
        .run('Existing', 'dark', '{"kept":true}');

      stopBefore.value = '0033';
      await expect(runMigrations(runner)).rejects.toThrow('test stop before migration 0033');
      expect(raw.prepare('SELECT name FROM _migrations ORDER BY rowid DESC LIMIT 1').get()).toEqual(
        { name: '0032_theme_restore_lookup_index' },
      );

      expect(
        raw
          .prepare('PRAGMA index_info(themes_restore_lookup_idx)')
          .all()
          .map((row) => (row as { name: string }).name),
      ).toEqual(['is_preset', 'name', 'mode', 'id']);
      expect(raw.prepare("SELECT tokens FROM themes WHERE name = 'Existing'").get()).toEqual({
        tokens: '{"kept":true}',
      });

      const plan = raw
        .prepare(
          `EXPLAIN QUERY PLAN
             SELECT id
               FROM themes
              WHERE is_preset = 0
                AND name = ?
                AND mode = ?
                AND id > ?
                AND id <= ?
              ORDER BY id
              LIMIT 1`,
        )
        .all('Existing', 'dark', 0, 100) as { detail: string }[];
      expect(plan.some((row) => row.detail.includes('themes_restore_lookup_idx'))).toBe(true);

      // The restore cutoff is MAX(id) over the whole table, so SQLite can jump straight to the
      // last rowid. Filtering to custom themes here would make the composite lookup index walk the
      // entire is_preset=0 group while holding the process-wide write lock.
      const cutoffOpcodes = raw
        .prepare('EXPLAIN SELECT COALESCE(MAX(id), 0) AS maxId FROM themes')
        .all()
        .map((row) => (row as { opcode: string }).opcode);
      expect(cutoffOpcodes).toContain('Last');
      expect(cutoffOpcodes).not.toContain('Next');
    } finally {
      raw.close();
    }
  });
});
