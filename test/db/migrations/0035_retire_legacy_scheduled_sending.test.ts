import Database from 'better-sqlite3';
import { runMigrations, type SqlRunner } from '@db/migrate';
import { MIGRATIONS } from '@db/migrations';

const LEGACY_REPAIR_MARKER = "SET status = 'uncertain'";

function createRunner(raw: Database.Database, stopBefore0035: { value: boolean }): SqlRunner {
  return {
    async exec(statement, params) {
      if (stopBefore0035.value && statement.includes(LEGACY_REPAIR_MARKER)) {
        throw new Error('test stop before migration 0035');
      }
      raw.prepare(statement).run(...((params as unknown[]) ?? []));
    },
    async query(statement, params) {
      return raw.prepare(statement).all(...((params as unknown[]) ?? [])) as never[];
    },
  };
}

describe('migration 0035_retire_legacy_scheduled_sending', () => {
  it('retires ambiguous local claims without changing pending, sent, or server-owned rows', async () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    try {
      const stopBefore0035 = { value: true };
      const runner = createRunner(raw, stopBefore0035);

      await expect(runMigrations(runner)).rejects.toThrow('test stop before migration 0035');
      expect(raw.prepare('SELECT name FROM _migrations ORDER BY rowid DESC LIMIT 1').get()).toEqual(
        { name: '0034_purge_legacy_error_reports' },
      );

      const insertScheduled = raw.prepare(
        `INSERT INTO scheduled_messages
           (server_id, chat_guid, payload, scheduled_for, recurrence, status, attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      insertScheduled.run(null, 'pending-local', '{"text":"pending"}', 100, null, 'pending', 1);
      insertScheduled.run(null, 'sent-local', '{"text":"sent"}', 200, null, 'sent', 4);
      insertScheduled.run(
        null,
        'sending-without-outgoing',
        '{"text":"not queued"}',
        300,
        null,
        'sending',
        0,
      );
      insertScheduled.run(
        null,
        'sending-with-outgoing',
        '{"text":"already queued"}',
        400,
        'daily',
        'sending',
        3,
      );
      insertScheduled.run(
        'server-schedule-1',
        'server-owned-sending',
        '{"text":"server owns this"}',
        500,
        null,
        'sending',
        2,
      );
      raw
        .prepare(
          `INSERT INTO outgoing_queue
             (temp_guid, chat_guid, kind, payload, attempts, created_at, next_retry_at)
           VALUES (?, ?, 'text', ?, 0, 400, 0)`,
        )
        .run('temp-already-queued', 'sending-with-outgoing', '{"text":"already queued"}');

      // Keep the named 0034 -> 0035 upgrade test stable if later migrations are appended.
      const migrationIndex = MIGRATIONS.findIndex(
        (migration) => migration.name === '0035_retire_legacy_scheduled_sending',
      );
      expect(migrationIndex).toBeGreaterThanOrEqual(0);
      const markApplied = raw.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, 0)');
      for (const migration of MIGRATIONS.slice(migrationIndex + 1)) markApplied.run(migration.name);

      stopBefore0035.value = false;
      await expect(runMigrations(runner)).resolves.toEqual([
        '0035_retire_legacy_scheduled_sending',
      ]);

      expect(
        raw
          .prepare(
            `SELECT chat_guid AS chatGuid, server_id AS serverId, recurrence, status, attempts
               FROM scheduled_messages
              ORDER BY id`,
          )
          .all(),
      ).toEqual([
        {
          chatGuid: 'pending-local',
          serverId: null,
          recurrence: null,
          status: 'pending',
          attempts: 1,
        },
        {
          chatGuid: 'sent-local',
          serverId: null,
          recurrence: null,
          status: 'sent',
          attempts: 4,
        },
        {
          chatGuid: 'sending-without-outgoing',
          serverId: null,
          recurrence: null,
          status: 'uncertain',
          attempts: 5,
        },
        {
          chatGuid: 'sending-with-outgoing',
          serverId: null,
          recurrence: 'daily',
          status: 'uncertain',
          attempts: 5,
        },
        {
          chatGuid: 'server-owned-sending',
          serverId: 'server-schedule-1',
          recurrence: null,
          status: 'sending',
          attempts: 2,
        },
      ]);

      expect(
        raw
          .prepare(
            `SELECT chat_guid AS chatGuid
               FROM scheduled_messages
              WHERE status = 'uncertain'
              ORDER BY id`,
          )
          .all(),
      ).toEqual([{ chatGuid: 'sending-without-outgoing' }, { chatGuid: 'sending-with-outgoing' }]);
      expect(
        raw
          .prepare(
            `SELECT temp_guid AS tempGuid, chat_guid AS chatGuid, payload
               FROM outgoing_queue`,
          )
          .all(),
      ).toEqual([
        {
          tempGuid: 'temp-already-queued',
          chatGuid: 'sending-with-outgoing',
          payload: '{"text":"already queued"}',
        },
      ]);
    } finally {
      raw.close();
    }
  });
});
