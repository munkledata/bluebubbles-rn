import Database from 'better-sqlite3';
import { runMigrations, type SqlRunner } from '@db/migrate';
import { MIGRATIONS } from '@db/migrations';

const MIGRATION_NAME = '0037_purge_legacy_redacted_mode_setting';
const DELETE_STATEMENT = "DELETE FROM kv WHERE key = 'privacy.redactedMode'";

interface RunnerControl {
  stopBefore0037: boolean;
  failRecording0037: boolean;
  targetMissingBeforeRecordFailure: boolean;
}

function createRunner(raw: Database.Database, control: RunnerControl): SqlRunner {
  return {
    async exec(statement, params) {
      if (control.stopBefore0037 && statement === DELETE_STATEMENT) {
        throw new Error('test stop before migration 0037');
      }
      if (
        control.failRecording0037 &&
        statement.startsWith('INSERT INTO _migrations') &&
        params?.[0] === MIGRATION_NAME
      ) {
        control.targetMissingBeforeRecordFailure =
          raw.prepare("SELECT key FROM kv WHERE key = 'privacy.redactedMode'").get() === undefined;
        throw new Error('test failure recording migration 0037');
      }
      raw.prepare(statement).run(...((params as unknown[]) ?? []));
    },
    async query(statement, params) {
      return raw.prepare(statement).all(...((params as unknown[]) ?? [])) as never[];
    },
  };
}

describe('migration 0037_purge_legacy_redacted_mode_setting', () => {
  it('atomically removes only the retired setting and remains idempotent', async () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    try {
      const control: RunnerControl = {
        stopBefore0037: true,
        failRecording0037: false,
        targetMissingBeforeRecordFailure: false,
      };
      const runner = createRunner(raw, control);

      await expect(runMigrations(runner)).rejects.toThrow('test stop before migration 0037');
      expect(raw.prepare('SELECT name FROM _migrations ORDER BY rowid DESC LIMIT 1').get()).toEqual(
        { name: '0036_message_guid_aliases' },
      );

      const insertKv = raw.prepare('INSERT INTO kv (key, value) VALUES (?, ?)');
      insertKv.run('privacy.redactedMode', '1');
      insertKv.run('privacy.redactedMode.extra', 'neighbor survives');
      insertKv.run('theme.preset', 'nord');
      insertKv.run('sync.messagesPerChat', '42');
      insertKv.run('draft.iMessage;-;+15555550123', 'private unsent text');

      // Keep this named upgrade test isolated if a later migration is appended.
      const migrationIndex = MIGRATIONS.findIndex((migration) => migration.name === MIGRATION_NAME);
      expect(migrationIndex).toBeGreaterThanOrEqual(0);
      const markApplied = raw.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, 0)');
      for (const migration of MIGRATIONS.slice(migrationIndex + 1)) markApplied.run(migration.name);

      control.stopBefore0037 = false;
      control.failRecording0037 = true;
      await expect(runMigrations(runner)).rejects.toThrow('test failure recording migration 0037');

      expect(control.targetMissingBeforeRecordFailure).toBe(true);
      expect(raw.inTransaction).toBe(false);
      expect(raw.prepare('SELECT key, value FROM kv ORDER BY key').all()).toEqual([
        { key: 'draft.iMessage;-;+15555550123', value: 'private unsent text' },
        { key: 'privacy.redactedMode', value: '1' },
        { key: 'privacy.redactedMode.extra', value: 'neighbor survives' },
        { key: 'sync.messagesPerChat', value: '42' },
        { key: 'theme.preset', value: 'nord' },
      ]);
      expect(
        raw.prepare('SELECT name FROM _migrations WHERE name = ?').get(MIGRATION_NAME),
      ).toBeUndefined();

      control.failRecording0037 = false;
      await expect(runMigrations(runner)).resolves.toEqual([MIGRATION_NAME]);
      expect(raw.prepare('SELECT key, value FROM kv ORDER BY key').all()).toEqual([
        { key: 'draft.iMessage;-;+15555550123', value: 'private unsent text' },
        { key: 'privacy.redactedMode.extra', value: 'neighbor survives' },
        { key: 'sync.messagesPerChat', value: '42' },
        { key: 'theme.preset', value: 'nord' },
      ]);

      await expect(runMigrations(runner)).resolves.toEqual([]);
      expect(raw.prepare('SELECT key, value FROM kv ORDER BY key').all()).toEqual([
        { key: 'draft.iMessage;-;+15555550123', value: 'private unsent text' },
        { key: 'privacy.redactedMode.extra', value: 'neighbor survives' },
        { key: 'sync.messagesPerChat', value: '42' },
        { key: 'theme.preset', value: 'nord' },
      ]);
    } finally {
      raw.close();
    }
  });
});
