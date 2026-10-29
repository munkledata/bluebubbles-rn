import Database from 'better-sqlite3';
import { runMigrations, type SqlRunner } from '@db/migrate';
import { migrationNamesFrom } from '../../support/migrationNames';

const MIGRATION_NAME = '0058_apple_screening_flags';

function runnerFor(raw: Database.Database, stopBefore0058: { value: boolean }): SqlRunner {
  return {
    async exec(statement, params) {
      if (stopBefore0058.value && statement.includes('apple_filtered')) {
        throw new Error('test stop before migration 0058');
      }
      raw.prepare(statement).run(...((params as unknown[]) ?? []));
    },
    async query(statement, params) {
      return raw.prepare(statement).all(...((params as unknown[]) ?? [])) as never[];
    },
  };
}

describe(`migration ${MIGRATION_NAME}`, () => {
  it('adds nullable screening flags, keeps existing rows unknown, and indexes spam by chat', async () => {
    const raw = new Database(':memory:');
    const stopBefore0058 = { value: true };
    const runner = runnerFor(raw, stopBefore0058);
    try {
      await expect(runMigrations(runner)).rejects.toThrow('test stop before migration 0058');
      expect(raw.prepare('SELECT name FROM _migrations ORDER BY rowid DESC LIMIT 1').get()).toEqual(
        { name: '0057_chat_group_photo' },
      );
      raw.prepare("INSERT INTO chats (guid, style) VALUES ('any;-;chat0058', 45)").run();
      raw
        .prepare(
          "INSERT INTO messages (guid, chat_id) SELECT 'msg0058', id FROM chats WHERE guid = 'any;-;chat0058'",
        )
        .run();

      stopBefore0058.value = false;
      await expect(runMigrations(runner)).resolves.toEqual(migrationNamesFrom(MIGRATION_NAME));
      // Existing rows read as unknown (null), never as "not filtered".
      expect(raw.prepare('SELECT apple_filtered AS filtered FROM chats').get()).toEqual({
        filtered: null,
      });
      expect(raw.prepare('SELECT apple_spam AS spam FROM messages').get()).toEqual({ spam: null });

      raw.prepare('UPDATE messages SET apple_spam = 1').run();
      const plan = raw
        .prepare(
          `EXPLAIN QUERY PLAN SELECT 1 FROM messages WHERE chat_id = 1 AND apple_spam = 1 LIMIT 1`,
        )
        .all() as { detail: string }[];
      expect(plan.map((row) => row.detail).join(' ')).toContain('messages_apple_spam_chat_idx');
    } finally {
      raw.close();
    }
  });
});
