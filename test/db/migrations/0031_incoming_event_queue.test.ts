import Database from 'better-sqlite3';
import { runMigrations, type SqlRunner } from '@db/migrate';

function createRunner(raw: Database.Database, stopBefore: { value: '0031' | '0032' }): SqlRunner {
  return {
    async exec(statement, params) {
      if (stopBefore.value === '0031' && statement.includes('CREATE TABLE incoming_event_queue')) {
        throw new Error('test stop before migration 0031');
      }
      if (
        stopBefore.value === '0032' &&
        statement.includes('CREATE INDEX themes_restore_lookup_idx')
      ) {
        throw new Error('test stop before migration 0032');
      }
      raw.prepare(statement).run(...((params as unknown[]) ?? []));
    },
    async query(statement, params) {
      return raw.prepare(statement).all(...((params as unknown[]) ?? [])) as never[];
    },
  };
}

const DIGEST = 'a'.repeat(64);

describe('migration 0031_incoming_event_queue', () => {
  it('upgrades 0030 data and creates the constrained durable intake + receipt indexes', async () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    try {
      const stopBefore: { value: '0031' | '0032' } = { value: '0031' };
      const runner = createRunner(raw, stopBefore);

      await expect(runMigrations(runner)).rejects.toThrow('test stop before migration 0031');
      expect(raw.prepare('SELECT name FROM _migrations ORDER BY rowid DESC LIMIT 1').get()).toEqual(
        { name: '0030_attachment_cache_entries' },
      );
      raw.prepare(`INSERT INTO kv (key, value) VALUES ('existing-setting', 'kept')`).run();

      stopBefore.value = '0032';
      await expect(runMigrations(runner)).rejects.toThrow('test stop before migration 0032');
      expect(raw.prepare('SELECT name FROM _migrations ORDER BY rowid DESC LIMIT 1').get()).toEqual(
        { name: '0031_incoming_event_queue' },
      );

      const columns = raw.prepare('PRAGMA table_info(incoming_event_queue)').all() as {
        name: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }[];
      expect(columns.map((column) => column.name)).toEqual([
        'id',
        'event_key',
        'payload_digest',
        'ordering_key',
        'schema_version',
        'event_name',
        'source',
        'payload',
        'received_at',
        'expires_at',
        'state',
        'attempts',
        'claim_version',
        'next_attempt_at',
        'lease_token',
        'lease_expires_at',
        'db_applied_at',
        'terminal_at',
        'last_error_code',
      ]);
      expect(columns.find((column) => column.name === 'id')).toEqual(
        expect.objectContaining({ pk: 1 }),
      );
      for (const required of [
        'event_key',
        'payload_digest',
        'ordering_key',
        'schema_version',
        'event_name',
        'source',
        'received_at',
        'expires_at',
        'state',
        'attempts',
        'claim_version',
        'next_attempt_at',
        'lease_expires_at',
      ]) {
        expect(columns.find((column) => column.name === required)?.notnull).toBe(1);
      }
      expect(columns.find((column) => column.name === 'schema_version')?.dflt_value).toBe('1');
      expect(columns.find((column) => column.name === 'state')?.dflt_value).toBe("'pending'");
      expect(columns.find((column) => column.name === 'attempts')?.dflt_value).toBe('0');
      expect(columns.find((column) => column.name === 'claim_version')?.dflt_value).toBe('0');
      expect(columns.find((column) => column.name === 'next_attempt_at')?.dflt_value).toBe('0');
      expect(columns.find((column) => column.name === 'lease_expires_at')?.dflt_value).toBe('0');

      const indexColumns = (name: string): string[] =>
        raw
          .prepare(`PRAGMA index_info(${name})`)
          .all()
          .map((row) => (row as { name: string }).name);
      expect(indexColumns('incoming_event_queue_event_key_idx')).toEqual(['event_key']);
      expect(indexColumns('incoming_event_queue_claim_idx')).toEqual([
        'state',
        'next_attempt_at',
        'lease_expires_at',
        'received_at',
        'id',
      ]);
      expect(indexColumns('incoming_event_queue_ordering_idx')).toEqual([
        'state',
        'ordering_key',
        'id',
      ]);
      expect(indexColumns('incoming_event_queue_terminal_idx')).toEqual([
        'state',
        'terminal_at',
        'id',
      ]);
      expect(raw.prepare('PRAGMA foreign_key_list(incoming_event_queue)').all()).toEqual([]);

      const insert = raw.prepare(`
        INSERT INTO incoming_event_queue
          (event_key, payload_digest, ordering_key, event_name, source, payload,
           received_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      insert.run('event-1', DIGEST, 'message:m1', 'new-message', 'fcm', '{}', 100, 200);
      expect(
        raw
          .prepare(
            `
            SELECT state, attempts, claim_version AS claimVersion,
                   next_attempt_at AS nextAttemptAt, lease_expires_at AS leaseExpiresAt,
                   schema_version AS schemaVersion
              FROM incoming_event_queue WHERE event_key = 'event-1'`,
          )
          .get(),
      ).toEqual({
        state: 'pending',
        attempts: 0,
        claimVersion: 0,
        nextAttemptAt: 0,
        leaseExpiresAt: 0,
        schemaVersion: 1,
      });
      expect(() =>
        insert.run('event-1', DIGEST, 'message:m1', 'new-message', 'socket', '{}', 100, 200),
      ).toThrow(/UNIQUE/);
      expect(() =>
        insert.run('bad-digest', 'abc', 'message:m1', 'new-message', 'fcm', '{}', 100, 200),
      ).toThrow(/CHECK/);
      expect(() =>
        insert.run(
          'bad-digest-hex',
          'g'.repeat(64),
          'message:m1',
          'new-message',
          'fcm',
          '{}',
          100,
          200,
        ),
      ).toThrow(/CHECK/);
      expect(() =>
        insert.run('bad-source', DIGEST, 'message:m1', 'new-message', 'retry', '{}', 100, 200),
      ).toThrow(/CHECK/);
      expect(() =>
        insert.run('bad-order', DIGEST, '', 'new-message', 'fcm', '{}', 100, 200),
      ).toThrow(/CHECK/);
      expect(() =>
        insert.run('bad-time', DIGEST, 'message:m1', 'new-message', 'fcm', '{}', 200, 100),
      ).toThrow(/CHECK/);
      expect(() =>
        insert.run('zero-life', DIGEST, 'message:m1', 'new-message', 'fcm', '{}', 200, 200),
      ).toThrow(/CHECK/);
      expect(() =>
        insert.run(
          'too-long-lived',
          DIGEST,
          'message:m1',
          'new-message',
          'fcm',
          '{}',
          100,
          100 + 24 * 60 * 60 * 1000 + 1,
        ),
      ).toThrow(/CHECK/);
      expect(() =>
        insert.run(
          'too-large',
          DIGEST,
          'message:m1',
          'new-message',
          'fcm',
          JSON.stringify({ body: 'x'.repeat(1024 * 1024) }),
          100,
          200,
        ),
      ).toThrow(/CHECK/);
      expect(() =>
        raw
          .prepare(
            `
            INSERT INTO incoming_event_queue
              (event_key, payload_digest, ordering_key, event_name, source, payload,
               received_at, expires_at, state, terminal_at)
            VALUES ('bad-terminal', ?, 'message:m2', 'new-message', 'fcm', '{}',
                    100, 200, 'completed', 200)`,
          )
          .run(DIGEST),
      ).toThrow(/CHECK/);
      expect(() =>
        raw
          .prepare(
            `UPDATE incoming_event_queue SET lease_token = 'owner' WHERE event_key = 'event-1'`,
          )
          .run(),
      ).toThrow(/CHECK/);
      expect(() =>
        raw
          .prepare(`UPDATE incoming_event_queue SET db_applied_at = -1 WHERE event_key = 'event-1'`)
          .run(),
      ).toThrow(/CHECK/);

      raw
        .prepare(
          `
          UPDATE incoming_event_queue
             SET attempts = 1, claim_version = 1,
                 lease_token = 'owner', lease_expires_at = 300,
                 db_applied_at = 150
           WHERE event_key = 'event-1'`,
        )
        .run();
      raw
        .prepare(
          `
          UPDATE incoming_event_queue
             SET state = 'completed', payload = NULL, next_attempt_at = 0,
                 lease_token = NULL, lease_expires_at = 0, terminal_at = 200
           WHERE event_key = 'event-1'`,
        )
        .run();
      expect(
        raw
          .prepare(
            `
            SELECT state, payload, db_applied_at AS dbAppliedAt, terminal_at AS terminalAt
              FROM incoming_event_queue WHERE event_key = 'event-1'`,
          )
          .get(),
      ).toEqual({ state: 'completed', payload: null, dbAppliedAt: 150, terminalAt: 200 });

      expect(raw.prepare(`SELECT value FROM kv WHERE key = 'existing-setting'`).get()).toEqual({
        value: 'kept',
      });
    } finally {
      raw.close();
    }
  });
});
