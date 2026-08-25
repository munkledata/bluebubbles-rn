import Database from 'better-sqlite3';
import { runMigrations, type SqlRunner } from '@db/migrate';
import { MIGRATIONS } from '@db/migrations';

const MIGRATION_NAME = '0039_message_error_message';
const ADD_COLUMN_MARKER = 'ADD COLUMN error_message TEXT';

interface RunnerControl {
  stopBefore0039: boolean;
  failRecording0039: boolean;
  columnVisibleBeforeRecordFailure: boolean;
}

function hasErrorMessageColumn(raw: Database.Database): boolean {
  return (
    raw
      .prepare("SELECT name FROM pragma_table_info('messages') WHERE name = 'error_message'")
      .get() !== undefined
  );
}

function createRunner(raw: Database.Database, control: RunnerControl): SqlRunner {
  return {
    async exec(statement, params) {
      if (control.stopBefore0039 && statement.includes(ADD_COLUMN_MARKER)) {
        throw new Error('test stop before migration 0039');
      }
      if (
        control.failRecording0039 &&
        statement.startsWith('INSERT INTO _migrations') &&
        params?.[0] === MIGRATION_NAME
      ) {
        control.columnVisibleBeforeRecordFailure = hasErrorMessageColumn(raw);
        throw new Error('test failure recording migration 0039');
      }
      raw.prepare(statement).run(...((params as unknown[]) ?? []));
    },
    async query(statement, params) {
      return raw.prepare(statement).all(...((params as unknown[]) ?? [])) as never[];
    },
  };
}

describe('migration 0039_message_error_message', () => {
  it('adds a bounded nullable detail atomically and remains retryable/idempotent', async () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    try {
      const control: RunnerControl = {
        stopBefore0039: true,
        failRecording0039: false,
        columnVisibleBeforeRecordFailure: false,
      };
      const runner = createRunner(raw, control);

      await expect(runMigrations(runner)).rejects.toThrow('test stop before migration 0039');
      expect(raw.prepare('SELECT name FROM _migrations ORDER BY rowid DESC LIMIT 1').get()).toEqual(
        { name: '0038_scrub_reaction_selected_message_text' },
      );
      expect(hasErrorMessageColumn(raw)).toBe(false);

      raw.prepare("INSERT INTO chats (guid) VALUES ('chat-0039')").run();
      const chatId = (
        raw.prepare("SELECT id FROM chats WHERE guid = 'chat-0039'").get() as {
          id: number;
        }
      ).id;
      raw
        .prepare(
          "INSERT INTO messages (guid, chat_id, is_from_me, send_state, error) VALUES ('message-0039', ?, 1, 'error', 502)",
        )
        .run(chatId);

      const migrationIndex = MIGRATIONS.findIndex((migration) => migration.name === MIGRATION_NAME);
      expect(migrationIndex).toBeGreaterThanOrEqual(0);
      const markApplied = raw.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, 0)');
      for (const migration of MIGRATIONS.slice(migrationIndex + 1)) markApplied.run(migration.name);

      control.stopBefore0039 = false;
      control.failRecording0039 = true;
      await expect(runMigrations(runner)).rejects.toThrow('test failure recording migration 0039');
      expect(control.columnVisibleBeforeRecordFailure).toBe(true);
      expect(raw.inTransaction).toBe(false);
      expect(hasErrorMessageColumn(raw)).toBe(false);
      expect(
        raw.prepare('SELECT name FROM _migrations WHERE name = ?').get(MIGRATION_NAME),
      ).toBeUndefined();
      expect(raw.prepare("SELECT error FROM messages WHERE guid = 'message-0039'").get()).toEqual({
        error: 502,
      });

      control.failRecording0039 = false;
      await expect(runMigrations(runner)).resolves.toEqual([MIGRATION_NAME]);
      expect(hasErrorMessageColumn(raw)).toBe(true);
      expect(
        raw
          .prepare("SELECT error_message AS errorMessage FROM messages WHERE guid = 'message-0039'")
          .get(),
      ).toEqual({ errorMessage: null });

      const update = raw.prepare(
        "UPDATE messages SET error_message = ? WHERE guid = 'message-0039'",
      );
      expect(() => update.run('x'.repeat(240))).not.toThrow();
      expect(() => update.run('x'.repeat(241))).toThrow(/messages_error_message_bounded/);
      expect(() => update.run('😀'.repeat(128))).not.toThrow();
      expect(() => update.run('😀'.repeat(129))).toThrow(/messages_error_message_bounded/);
      expect(() => update.run('')).toThrow(/messages_error_message_bounded/);
      expect(() => update.run(null)).not.toThrow();

      await expect(runMigrations(runner)).resolves.toEqual([]);
    } finally {
      raw.close();
    }
  });
});
