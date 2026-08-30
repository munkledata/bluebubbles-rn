import Database from 'better-sqlite3';
import { runMigrations, type SqlRunner } from '@db/migrate';

const MIGRATION_NAME = '0041_message_balloon_bundle_id';
const ADD_COLUMN_MARKER = 'ADD COLUMN balloon_bundle_id TEXT';

function hasBalloonColumn(raw: Database.Database): boolean {
  return (
    raw
      .prepare("SELECT name FROM pragma_table_info('messages') WHERE name = 'balloon_bundle_id'")
      .get() !== undefined
  );
}

function runnerFor(raw: Database.Database, stopBefore0041: { value: boolean }): SqlRunner {
  return {
    async exec(statement, params) {
      if (stopBefore0041.value && statement.includes(ADD_COLUMN_MARKER)) {
        throw new Error('test stop before migration 0041');
      }
      raw.prepare(statement).run(...((params as unknown[]) ?? []));
    },
    async query(statement, params) {
      return raw.prepare(statement).all(...((params as unknown[]) ?? [])) as never[];
    },
  };
}

describe('migration 0041_message_balloon_bundle_id', () => {
  it('adds a bounded nullable identifier without changing existing messages', async () => {
    const raw = new Database(':memory:');
    const stopBefore0041 = { value: true };
    const runner = runnerFor(raw, stopBefore0041);
    try {
      await expect(runMigrations(runner)).rejects.toThrow('test stop before migration 0041');
      expect(raw.prepare('SELECT name FROM _migrations ORDER BY rowid DESC LIMIT 1').get()).toEqual(
        {
          name: '0040_chats_pin_order',
        },
      );
      expect(hasBalloonColumn(raw)).toBe(false);

      raw.prepare("INSERT INTO chats (guid) VALUES ('chat-0041')").run();
      const chatId = (
        raw.prepare("SELECT id FROM chats WHERE guid = 'chat-0041'").get() as {
          id: number;
        }
      ).id;
      raw
        .prepare("INSERT INTO messages (guid, chat_id, text) VALUES ('message-0041', ?, 'hello')")
        .run(chatId);

      stopBefore0041.value = false;
      await expect(runMigrations(runner)).resolves.toEqual([
        MIGRATION_NAME,
        '0042_message_part_identity',
        '0043_custom_folders',
        '0044_custom_folder_unread_badge',
      ]);
      expect(hasBalloonColumn(raw)).toBe(true);
      expect(
        raw
          .prepare(
            "SELECT text, balloon_bundle_id AS balloonBundleId FROM messages WHERE guid = 'message-0041'",
          )
          .get(),
      ).toEqual({ text: 'hello', balloonBundleId: null });

      const update = raw.prepare(
        "UPDATE messages SET balloon_bundle_id = ? WHERE guid = 'message-0041'",
      );
      expect(() => update.run('com.apple.Handwriting.HandwritingProvider')).not.toThrow();
      expect(() => update.run('')).toThrow(/messages_balloon_bundle_id_bounded/);
      expect(() => update.run('x'.repeat(256))).toThrow(/messages_balloon_bundle_id_bounded/);
      expect(() => update.run(null)).not.toThrow();
      await expect(runMigrations(runner)).resolves.toEqual([]);
    } finally {
      raw.close();
    }
  });
});
