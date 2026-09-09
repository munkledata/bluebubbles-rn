import Database from 'better-sqlite3';
import { runMigrations, type SqlRunner } from '@db/migrate';

const MIGRATION_NAME = '0046_message_send_attempt_owner';
const FIRST_COLUMN_MARKER = 'ADD COLUMN active_send_attempt_guid';

function runnerFor(raw: Database.Database, stopBefore0046: { value: boolean }): SqlRunner {
  return {
    async exec(statement, params) {
      if (stopBefore0046.value && statement.includes(FIRST_COLUMN_MARKER)) {
        throw new Error('test stop before migration 0046');
      }
      raw.prepare(statement).run(...((params as unknown[]) ?? []));
    },
    async query(statement, params) {
      return raw.prepare(statement).all(...((params as unknown[]) ?? [])) as never[];
    },
  };
}

describe('migration 0046_message_send_attempt_owner', () => {
  it('preserves 0045 messages and adds bounded attempt-owner state by migration name', async () => {
    const raw = new Database(':memory:');
    const stopBefore0046 = { value: true };
    const runner = runnerFor(raw, stopBefore0046);
    try {
      await expect(runMigrations(runner)).rejects.toThrow('test stop before migration 0046');
      expect(raw.prepare('SELECT name FROM _migrations ORDER BY rowid DESC LIMIT 1').get()).toEqual(
        { name: '0045_backup_export_indexes' },
      );

      raw.prepare("INSERT INTO chats (guid) VALUES ('chat-before-0046')").run();
      const chat = raw.prepare("SELECT id FROM chats WHERE guid = 'chat-before-0046'").get() as {
        id: number;
      };
      raw
        .prepare(
          `INSERT INTO messages (guid, chat_id, is_from_me, send_state, error)
           VALUES (?, ?, 1, ?, ?)`,
        )
        .run('canonical-before-0046', chat.id, 'sent', 0);
      raw
        .prepare(
          `INSERT INTO messages (guid, chat_id, is_from_me, send_state, error)
           VALUES (?, ?, 1, ?, ?)`,
        )
        .run('temp-before-0046', chat.id, 'error', 502);

      stopBefore0046.value = false;
      await expect(runMigrations(runner)).resolves.toEqual([
        MIGRATION_NAME,
        '0047_message_retraction_topology',
        '0048_attachment_media_exports',
      ]);

      expect(
        raw
          .prepare(
            `SELECT guid, active_send_attempt_guid AS activeSendAttemptGuid,
                    attempt_owner_pending AS attemptOwnerPending,
                    attempt_owner_generation AS attemptOwnerGeneration
               FROM messages
              ORDER BY id`,
          )
          .all(),
      ).toEqual([
        {
          guid: 'canonical-before-0046',
          activeSendAttemptGuid: null,
          attemptOwnerPending: 0,
          attemptOwnerGeneration: 0,
        },
        {
          guid: 'temp-before-0046',
          activeSendAttemptGuid: null,
          attemptOwnerPending: 0,
          attemptOwnerGeneration: 0,
        },
      ]);

      const maxAttemptGuid = 'a'.repeat(128);
      expect(() =>
        raw
          .prepare(
            `UPDATE messages
                SET active_send_attempt_guid = ?, attempt_owner_pending = 1,
                    attempt_owner_generation = 1
              WHERE guid = 'temp-before-0046'`,
          )
          .run(maxAttemptGuid),
      ).not.toThrow();
      expect(() =>
        raw
          .prepare(
            "UPDATE messages SET active_send_attempt_guid = '' WHERE guid = 'temp-before-0046'",
          )
          .run(),
      ).toThrow(/messages_active_send_attempt_guid_bounded/);
      expect(() =>
        raw
          .prepare(
            `UPDATE messages SET active_send_attempt_guid = ? WHERE guid = 'temp-before-0046'`,
          )
          .run('a'.repeat(129)),
      ).toThrow(/messages_active_send_attempt_guid_bounded/);
      expect(() =>
        raw
          .prepare(`UPDATE messages SET attempt_owner_pending = 2 WHERE guid = 'temp-before-0046'`)
          .run(),
      ).toThrow(/messages_attempt_owner_pending_boolean/);
      expect(() =>
        raw
          .prepare(
            `UPDATE messages SET attempt_owner_generation = -1 WHERE guid = 'temp-before-0046'`,
          )
          .run(),
      ).toThrow(/messages_attempt_owner_generation_valid/);
      expect(() =>
        raw
          .prepare(
            `UPDATE messages SET attempt_owner_generation = 2147483648 WHERE guid = 'temp-before-0046'`,
          )
          .run(),
      ).toThrow(/messages_attempt_owner_generation_valid/);

      await expect(runMigrations(runner)).resolves.toEqual([]);
    } finally {
      raw.close();
    }
  });
});
