import Database from 'better-sqlite3';
import { runMigrations, type SqlRunner } from '@db/migrate';

const ADD_COLUMN_MARKER = 'ADD COLUMN pin_order INTEGER';

function runnerFor(raw: Database.Database, stopBefore0040: { value: boolean }): SqlRunner {
  return {
    async exec(statement, params) {
      if (stopBefore0040.value && statement.includes(ADD_COLUMN_MARKER)) {
        throw new Error('test stop before migration 0040');
      }
      raw.prepare(statement).run(...((params as unknown[]) ?? []));
    },
    async query(statement, params) {
      return raw.prepare(statement).all(...((params as unknown[]) ?? [])) as never[];
    },
  };
}

describe('migration 0040_chats_pin_order', () => {
  it('backfills the prior visible pin order and enforces a nonnegative integer rank', async () => {
    const raw = new Database(':memory:');
    const stopBefore0040 = { value: true };
    const runner = runnerFor(raw, stopBefore0040);
    try {
      await expect(runMigrations(runner)).rejects.toThrow('test stop before migration 0040');
      expect(raw.prepare('SELECT name FROM _migrations ORDER BY rowid DESC LIMIT 1').get()).toEqual(
        { name: '0039_message_error_message' },
      );

      raw
        .prepare('INSERT INTO chats (guid, is_pinned, latest_message_date) VALUES (?, ?, ?)')
        .run('older-pin', 1, 100);
      raw
        .prepare('INSERT INTO chats (guid, is_pinned, latest_message_date) VALUES (?, ?, ?)')
        .run('newer-pin', 1, 900);
      raw
        .prepare('INSERT INTO chats (guid, is_pinned, latest_message_date) VALUES (?, ?, ?)')
        .run('ordinary-chat', 0, 1_000);

      stopBefore0040.value = false;
      await expect(runMigrations(runner)).resolves.toEqual([
        '0040_chats_pin_order',
        '0041_message_balloon_bundle_id',
        '0042_message_part_identity',
        '0043_custom_folders',
        '0044_custom_folder_unread_badge',
      ]);
      expect(
        raw.prepare('SELECT guid, pin_order AS pinOrder FROM chats ORDER BY guid').all(),
      ).toEqual([
        { guid: 'newer-pin', pinOrder: 0 },
        { guid: 'older-pin', pinOrder: 1 },
        { guid: 'ordinary-chat', pinOrder: null },
      ]);
      expect(
        raw
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
          .get('chats_pin_order_idx'),
      ).toEqual({ name: 'chats_pin_order_idx' });

      const update = raw.prepare('UPDATE chats SET pin_order = ? WHERE guid = ?');
      expect(() => update.run(-1, 'older-pin')).toThrow(/chats_pin_order_nonnegative/);
      expect(() => update.run(1.5, 'older-pin')).toThrow(/chats_pin_order_nonnegative/);
      expect(() => update.run(2, 'older-pin')).not.toThrow();
      await expect(runMigrations(runner)).resolves.toEqual([]);
    } finally {
      raw.close();
    }
  });
});
