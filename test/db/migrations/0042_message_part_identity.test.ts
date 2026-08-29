import Database from 'better-sqlite3';
import { runMigrations, type SqlRunner } from '@db/migrate';

const MIGRATION_NAME = '0042_message_part_identity';
const ADD_COLUMN_MARKER = 'ADD COLUMN part_count INTEGER';

function runnerFor(raw: Database.Database, stopBefore0042: { value: boolean }): SqlRunner {
  return {
    async exec(statement, params) {
      if (stopBefore0042.value && statement.includes(ADD_COLUMN_MARKER)) {
        throw new Error('test stop before migration 0042');
      }
      raw.prepare(statement).run(...((params as unknown[]) ?? []));
    },
    async query(statement, params) {
      return raw.prepare(statement).all(...((params as unknown[]) ?? [])) as never[];
    },
  };
}

describe('migration 0042_message_part_identity', () => {
  it('adds nullable bounded part identity without changing existing messages', async () => {
    const raw = new Database(':memory:');
    const stopBefore0042 = { value: true };
    const runner = runnerFor(raw, stopBefore0042);
    try {
      await expect(runMigrations(runner)).rejects.toThrow('test stop before migration 0042');
      expect(raw.prepare('SELECT name FROM _migrations ORDER BY rowid DESC LIMIT 1').get()).toEqual(
        { name: '0041_message_balloon_bundle_id' },
      );

      raw.prepare("INSERT INTO chats (guid) VALUES ('chat-0042')").run();
      const chatId = (
        raw.prepare("SELECT id FROM chats WHERE guid = 'chat-0042'").get() as { id: number }
      ).id;
      raw
        .prepare("INSERT INTO messages (guid, chat_id, text) VALUES ('message-0042', ?, 'hello')")
        .run(chatId);

      stopBefore0042.value = false;
      await expect(runMigrations(runner)).resolves.toEqual([MIGRATION_NAME]);
      expect(
        raw
          .prepare(
            `SELECT text, part_count AS partCount,
                    associated_message_part AS associatedMessagePart,
                    thread_originator_part AS threadOriginatorPart
               FROM messages WHERE guid = 'message-0042'`,
          )
          .get(),
      ).toEqual({
        text: 'hello',
        partCount: null,
        associatedMessagePart: null,
        threadOriginatorPart: null,
      });

      const update = raw.prepare(
        `UPDATE messages
            SET part_count = ?, associated_message_part = ?, thread_originator_part = ?
          WHERE guid = 'message-0042'`,
      );
      expect(() => update.run(2, 1, 2)).not.toThrow();
      expect(() => update.run(10_001, 1, 2)).toThrow(/messages_part_count_bounded/);
      expect(() => update.run(2, -1, 2)).toThrow(/messages_associated_message_part_bounded/);
      expect(() => update.run(2, 1.5, 2)).toThrow(/messages_associated_message_part_bounded/);
      expect(() => update.run(2, 1, 10_001)).toThrow(/messages_thread_originator_part_bounded/);
      expect(() => update.run(null, null, null)).not.toThrow();
      await expect(runMigrations(runner)).resolves.toEqual([]);
    } finally {
      raw.close();
    }
  });
});
