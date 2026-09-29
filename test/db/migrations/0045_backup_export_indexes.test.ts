import Database from 'better-sqlite3';
import { runMigrations, type SqlRunner } from '@db/migrate';

const MIGRATION_NAME = '0045_backup_export_indexes';
const FIRST_INDEX_MARKER = 'CREATE INDEX themes_backup_export_idx';

function runnerFor(raw: Database.Database, stopBefore0045: { value: boolean }): SqlRunner {
  return {
    async exec(statement, params) {
      if (stopBefore0045.value && statement.includes(FIRST_INDEX_MARKER)) {
        throw new Error('test stop before migration 0045');
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

describe('migration 0045_backup_export_indexes', () => {
  it('preserves 0044 data and gives both bounded backup selectors an exact index', async () => {
    const raw = new Database(':memory:');
    const stopBefore0045 = { value: true };
    const runner = runnerFor(raw, stopBefore0045);
    try {
      await expect(runMigrations(runner)).rejects.toThrow('test stop before migration 0045');
      expect(raw.prepare('SELECT name FROM _migrations ORDER BY rowid DESC LIMIT 1').get()).toEqual(
        { name: '0044_custom_folder_unread_badge' },
      );

      raw
        .prepare('INSERT INTO themes (name, mode, tokens, is_preset) VALUES (?, ?, ?, ?)')
        .run('Existing custom', 'dark', '{"accent":"orange"}', 0);
      raw
        .prepare('INSERT INTO themes (name, mode, tokens, is_preset) VALUES (?, ?, ?, ?)')
        .run('Existing preset', 'light', '{"accent":"blue"}', 1);
      raw
        .prepare('INSERT INTO chats (guid, custom_name) VALUES (?, ?)')
        .run('chat-customized-before-0045', 'Existing name');
      raw.prepare('INSERT INTO chats (guid) VALUES (?)').run('chat-ordinary-before-0045');

      stopBefore0045.value = false;
      await expect(runMigrations(runner)).resolves.toEqual([
        MIGRATION_NAME,
        '0046_message_send_attempt_owner',
        '0047_message_retraction_topology',
        '0048_attachment_media_exports',
        '0049_inbox_search_postings',
        '0050_message_identity_owner_scope',
        '0051_handle_color_backup_index',
        '0052_chat_history_deletion_boundary',
      ]);

      expect(indexColumns(raw, 'themes_backup_export_idx')).toEqual(['is_preset', 'id']);
      expect(indexColumns(raw, 'chats_backup_export_idx')).toEqual(['id']);
      expect(normalizedIndexSql(raw, 'chats_backup_export_idx')).toBe(
        'CREATE INDEX chats_backup_export_idx ON chats (id) WHERE custom_name IS NOT NULL OR custom_color IS NOT NULL OR mute_type IS NOT NULL OR is_pinned = 1 OR is_archived = 1',
      );

      expect(
        raw.prepare('SELECT name, is_preset AS isPreset FROM themes ORDER BY id').all(),
      ).toEqual([
        { name: 'Existing custom', isPreset: 0 },
        { name: 'Existing preset', isPreset: 1 },
      ]);
      expect(raw.prepare('SELECT guid FROM chats ORDER BY id').all()).toEqual([
        { guid: 'chat-customized-before-0045' },
        { guid: 'chat-ordinary-before-0045' },
      ]);

      const themePlan = raw
        .prepare(
          `EXPLAIN QUERY PLAN
             SELECT id
               FROM themes INDEXED BY themes_backup_export_idx
              WHERE is_preset = 0
              ORDER BY id
              LIMIT 501`,
        )
        .all() as { detail: string }[];
      expect(themePlan.some((row) => row.detail.includes('themes_backup_export_idx'))).toBe(true);
      expect(themePlan.some((row) => row.detail.includes('USE TEMP B-TREE'))).toBe(false);

      const chatPlan = raw
        .prepare(
          `EXPLAIN QUERY PLAN
             SELECT id
               FROM chats INDEXED BY chats_backup_export_idx
              WHERE custom_name IS NOT NULL OR custom_color IS NOT NULL OR mute_type IS NOT NULL
                 OR is_pinned = 1 OR is_archived = 1
              ORDER BY id
              LIMIT 2001`,
        )
        .all() as { detail: string }[];
      expect(chatPlan.some((row) => row.detail.includes('chats_backup_export_idx'))).toBe(true);
      expect(chatPlan.some((row) => row.detail.includes('USE TEMP B-TREE'))).toBe(false);

      await expect(runMigrations(runner)).resolves.toEqual([]);
    } finally {
      raw.close();
    }
  });
});
