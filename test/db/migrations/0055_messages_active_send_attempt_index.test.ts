import Database from 'better-sqlite3';
import { runMigrations, type SqlRunner } from '@db/migrate';
import { migrationNamesFrom } from '../../support/migrationNames';

const MIGRATION_NAME = '0055_messages_active_send_attempt_index';

function runnerFor(raw: Database.Database, stopBefore0055: { value: boolean }): SqlRunner {
  return {
    async exec(statement, params) {
      if (stopBefore0055.value && statement.includes('messages_active_send_attempt_idx')) {
        throw new Error('test stop before migration 0055');
      }
      raw.prepare(statement).run(...((params as unknown[]) ?? []));
    },
    async query(statement, params) {
      return raw.prepare(statement).all(...((params as unknown[]) ?? [])) as never[];
    },
  };
}

describe(`migration ${MIGRATION_NAME}`, () => {
  it('indexes only in-flight attempt ids and lets the attempt lookup use it', async () => {
    const raw = new Database(':memory:');
    const stopBefore0055 = { value: true };
    const runner = runnerFor(raw, stopBefore0055);
    try {
      await expect(runMigrations(runner)).rejects.toThrow('test stop before migration 0055');
      expect(raw.prepare('SELECT name FROM _migrations ORDER BY rowid DESC LIMIT 1').get()).toEqual(
        { name: '0054_handle_contact_ambiguous' },
      );
      raw.prepare("INSERT INTO chats (guid) VALUES ('iMessage;-;+15550000055')").run();
      raw
        .prepare(
          `INSERT INTO messages (guid, chat_id, active_send_attempt_guid)
           VALUES ('in-flight', 1, 'attempt-55'), ('settled', 1, NULL)`,
        )
        .run();

      stopBefore0055.value = false;
      // This migration and every later one apply, so a newer migration cannot break this test.
      await expect(runMigrations(runner)).resolves.toEqual(migrationNamesFrom(MIGRATION_NAME));
      const index = raw
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get('messages_active_send_attempt_idx') as { sql: string };
      expect(index.sql).toMatch(/WHERE active_send_attempt_guid IS NOT NULL/);
      const plan = (
        raw
          .prepare(
            `EXPLAIN QUERY PLAN SELECT m.guid FROM messages m JOIN chats c ON c.id = m.chat_id
              WHERE m.active_send_attempt_guid = ? LIMIT 2`,
          )
          .all('attempt-55') as { detail: string }[]
      ).map((row) => row.detail);
      expect(plan.some((detail) => detail.includes('messages_active_send_attempt_idx'))).toBe(true);
      expect(
        raw
          .prepare('SELECT guid FROM messages WHERE active_send_attempt_guid = ?')
          .all('attempt-55'),
      ).toEqual([{ guid: 'in-flight' }]);
    } finally {
      raw.close();
    }
  });
});
