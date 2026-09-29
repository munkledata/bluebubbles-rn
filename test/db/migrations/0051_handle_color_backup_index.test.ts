import Database from 'better-sqlite3';
import { runMigrations, type SqlRunner } from '@db/migrate';

const MIGRATION_NAME = '0051_handle_color_backup_index';
const INDEX_NAME = 'handles_backup_color_export_idx';
const INDEX_MARKER = `CREATE INDEX ${INDEX_NAME}`;

function runnerFor(raw: Database.Database, stopBefore0051: { value: boolean }): SqlRunner {
  return {
    async exec(statement, params) {
      if (stopBefore0051.value && statement.includes(INDEX_MARKER)) {
        throw new Error('test stop before migration 0051');
      }
      raw.prepare(statement).run(...((params as unknown[]) ?? []));
    },
    async query(statement, params) {
      return raw.prepare(statement).all(...((params as unknown[]) ?? [])) as never[];
    },
  };
}

function indexColumns(raw: Database.Database, indexName: string): string[] {
  return raw
    .prepare(`PRAGMA index_info(${indexName})`)
    .all()
    .map((row) => (row as { name: string }).name);
}

function normalizedIndexSql(raw: Database.Database, indexName: string): string {
  const row = raw
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(indexName) as { sql: string } | undefined;
  return row?.sql.replace(/\s+/g, ' ').trim() ?? '';
}

describe('migration 0051_handle_color_backup_index', () => {
  it('normalizes legacy colors and gives the bounded export selector its partial index', async () => {
    const raw = new Database(':memory:');
    const stopBefore0051 = { value: true };
    const runner = runnerFor(raw, stopBefore0051);
    try {
      await expect(runMigrations(runner)).rejects.toThrow('test stop before migration 0051');
      expect(raw.prepare('SELECT name FROM _migrations ORDER BY rowid DESC LIMIT 1').get()).toEqual(
        { name: '0050_message_identity_owner_scope' },
      );

      raw
        .prepare('INSERT INTO handles (address, service, color) VALUES (?, ?, ?)')
        .run('chosen@example.test', 'iMessage', '#123456');
      raw
        .prepare('INSERT INTO handles (address, service, color) VALUES (?, ?, NULL)')
        .run('plain@example.test', 'iMessage');
      raw
        .prepare('INSERT INTO handles (address, service, color) VALUES (?, ?, ?)')
        .run('lowercase@example.test', 'iMessage', '  #abcdef ');
      raw
        .prepare('INSERT INTO handles (address, service, color) VALUES (?, ?, ?)')
        .run('malformed@example.test', 'iMessage', 'blue');

      stopBefore0051.value = false;
      await expect(runMigrations(runner)).resolves.toEqual([
        MIGRATION_NAME,
        '0052_chat_history_deletion_boundary',
      ]);

      expect(indexColumns(raw, INDEX_NAME)).toEqual(['id']);
      expect(normalizedIndexSql(raw, INDEX_NAME)).toBe(
        'CREATE INDEX handles_backup_color_export_idx ON handles (id) WHERE color IS NOT NULL',
      );
      expect(raw.prepare('SELECT address, service, color FROM handles ORDER BY id').all()).toEqual([
        { address: 'chosen@example.test', service: 'iMessage', color: '#123456' },
        { address: 'plain@example.test', service: 'iMessage', color: null },
        { address: 'lowercase@example.test', service: 'iMessage', color: '#ABCDEF' },
        { address: 'malformed@example.test', service: 'iMessage', color: null },
      ]);

      const plan = raw
        .prepare(
          `EXPLAIN QUERY PLAN
             SELECT id
               FROM handles INDEXED BY handles_backup_color_export_idx
              WHERE color IS NOT NULL
              ORDER BY id
              LIMIT 10001`,
        )
        .all() as { detail: string }[];
      expect(plan.some((row) => row.detail.includes(INDEX_NAME))).toBe(true);
      expect(plan.some((row) => row.detail.includes('USE TEMP B-TREE'))).toBe(false);

      await expect(runMigrations(runner)).resolves.toEqual([]);
    } finally {
      raw.close();
    }
  });
});
