import Database from 'better-sqlite3';
import { runMigrations, type SqlRunner } from '@db/migrate';
import { MIGRATIONS } from '@db/migrations';

const MIGRATION_MARKER = 'CREATE TABLE message_guid_aliases';

function createRunner(raw: Database.Database, stopBefore0036: { value: boolean }): SqlRunner {
  return {
    async exec(statement, params) {
      if (stopBefore0036.value && statement.includes(MIGRATION_MARKER)) {
        throw new Error('test stop before migration 0036');
      }
      raw.prepare(statement).run(...((params as unknown[]) ?? []));
    },
    async query(statement, params) {
      return raw.prepare(statement).all(...((params as unknown[]) ?? [])) as never[];
    },
  };
}

describe('migration 0036_message_guid_aliases', () => {
  it('upgrades 0035 without inventing correlations and installs the bounded alias constraints', async () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    try {
      const stopBefore0036 = { value: true };
      const runner = createRunner(raw, stopBefore0036);

      await expect(runMigrations(runner)).rejects.toThrow('test stop before migration 0036');
      expect(raw.prepare('SELECT name FROM _migrations ORDER BY rowid DESC LIMIT 1').get()).toEqual(
        { name: '0035_retire_legacy_scheduled_sending' },
      );
      raw.prepare("INSERT INTO chats (guid) VALUES ('chat-1')").run();
      const chatId = (
        raw.prepare("SELECT id FROM chats WHERE guid = 'chat-1'").get() as { id: number }
      ).id;
      raw
        .prepare(
          `INSERT INTO messages (guid, chat_id, text, is_from_me, date_created, send_state)
           VALUES ('temp-before-upgrade', ?, 'no authoritative real guid', 1, 100, 'sending')`,
        )
        .run(chatId);

      const migrationIndex = MIGRATIONS.findIndex(
        (migration) => migration.name === '0036_message_guid_aliases',
      );
      expect(migrationIndex).toBeGreaterThanOrEqual(0);
      const markApplied = raw.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, 0)');
      for (const migration of MIGRATIONS.slice(migrationIndex + 1)) markApplied.run(migration.name);

      stopBefore0036.value = false;
      await expect(runMigrations(runner)).resolves.toEqual(['0036_message_guid_aliases']);

      expect(raw.prepare('PRAGMA table_info(message_guid_aliases)').all()).toEqual([
        expect.objectContaining({ name: 'id', type: 'INTEGER', notnull: 0, pk: 1 }),
        expect.objectContaining({ name: 'alias_guid', type: 'TEXT', notnull: 1, pk: 0 }),
        expect.objectContaining({ name: 'canonical_guid', type: 'TEXT', notnull: 1, pk: 0 }),
      ]);
      expect(raw.prepare('SELECT * FROM message_guid_aliases').all()).toEqual([]);
      expect(raw.prepare('PRAGMA foreign_key_list(message_guid_aliases)').all()).toEqual([]);
      expect(raw.prepare('PRAGMA index_list(message_guid_aliases)').all()).toContainEqual(
        expect.objectContaining({ name: 'message_guid_aliases_alias_guid_idx', unique: 1 }),
      );

      const insert = raw.prepare(
        'INSERT INTO message_guid_aliases (alias_guid, canonical_guid) VALUES (?, ?)',
      );
      insert.run('temp-a', 'real-shared');
      insert.run('temp-b', 'real-shared');
      expect(
        raw
          .prepare(
            'SELECT alias_guid AS aliasGuid, canonical_guid AS canonicalGuid FROM message_guid_aliases ORDER BY id',
          )
          .all(),
      ).toEqual([
        { aliasGuid: 'temp-a', canonicalGuid: 'real-shared' },
        { aliasGuid: 'temp-b', canonicalGuid: 'real-shared' },
      ]);

      expect(() => insert.run('real-alias', 'real-target')).toThrow(
        /message_guid_aliases_alias_valid/,
      );
      expect(() => insert.run('temp-', 'real-target')).toThrow(/message_guid_aliases_alias_valid/);
      expect(() => insert.run('temp-c', 'temp-target')).toThrow(
        /message_guid_aliases_canonical_valid/,
      );
      expect(() => insert.run('temp-c', 'x'.repeat(4097))).toThrow(
        /message_guid_aliases_canonical_valid/,
      );
      expect(() => insert.run('temp-a', 'real-other')).toThrow(/UNIQUE constraint failed/);
    } finally {
      raw.close();
    }
  });
});
