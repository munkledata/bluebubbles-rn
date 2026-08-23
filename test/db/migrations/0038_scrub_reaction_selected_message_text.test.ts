import Database from 'better-sqlite3';
import { runMigrations, type SqlRunner } from '@db/migrate';
import { MIGRATIONS } from '@db/migrations';

const MIGRATION_NAME = '0038_scrub_reaction_selected_message_text';
const SCRUB_MARKER = "SET payload = json_remove(payload, '$.selectedMessageText')";
const PRIVATE_SENTINEL = `PRIVATE_LEGACY_REACTION_TEXT_${'x'.repeat(4_096)}`;

interface RunnerControl {
  stopBefore0038: boolean;
  failRecording0038: boolean;
  scrubVisibleBeforeRecordFailure: boolean;
}

function createRunner(raw: Database.Database, control: RunnerControl): SqlRunner {
  return {
    async exec(statement, params) {
      if (control.stopBefore0038 && statement.includes(SCRUB_MARKER)) {
        throw new Error('test stop before migration 0038');
      }
      if (
        control.failRecording0038 &&
        statement.startsWith('INSERT INTO _migrations') &&
        params?.[0] === MIGRATION_NAME
      ) {
        const row = raw
          .prepare("SELECT payload FROM outgoing_queue WHERE temp_guid = 'temp-canonical'")
          .get() as { payload: string };
        control.scrubVisibleBeforeRecordFailure = !Object.prototype.hasOwnProperty.call(
          JSON.parse(row.payload),
          'selectedMessageText',
        );
        throw new Error('test failure recording migration 0038');
      }
      raw.prepare(statement).run(...((params as unknown[]) ?? []));
    },
    async query(statement, params) {
      return raw.prepare(statement).all(...((params as unknown[]) ?? [])) as never[];
    },
  };
}

interface QueuePayloadRow {
  tempGuid: string;
  kind: string;
  payload: string;
}

function readPayloads(raw: Database.Database): QueuePayloadRow[] {
  return raw
    .prepare(
      `SELECT temp_guid AS tempGuid, kind, payload
         FROM outgoing_queue
        ORDER BY id`,
    )
    .all() as QueuePayloadRow[];
}

describe('migration 0038_scrub_reaction_selected_message_text', () => {
  it('scrubs only the obsolete reaction field atomically and remains idempotent', async () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    try {
      const control: RunnerControl = {
        stopBefore0038: true,
        failRecording0038: false,
        scrubVisibleBeforeRecordFailure: false,
      };
      const runner = createRunner(raw, control);

      await expect(runMigrations(runner)).rejects.toThrow('test stop before migration 0038');
      expect(raw.prepare('SELECT name FROM _migrations ORDER BY rowid DESC LIMIT 1').get()).toEqual(
        { name: '0037_purge_legacy_redacted_mode_setting' },
      );

      const canonical = JSON.stringify({
        selectedMessageGuid: 'target-canonical',
        reaction: 'emoji',
        emoji: '🫡',
        selectedMessageText: PRIVATE_SENTINEL,
        future: { nested: ['preserve', 1] },
      });
      const noKey =
        ' { "selectedMessageGuid" : "target-no-key", "reaction" : "love", "futureFlag" : true } ';
      const nonReaction = JSON.stringify({
        message: 'ordinary retry text',
        selectedMessageText: PRIVATE_SENTINEL,
      });
      const malformed = `{"selectedMessageGuid":"broken","selectedMessageText":"${PRIVATE_SENTINEL}"`;
      const nullText = JSON.stringify({
        selectedMessageGuid: 'target-null',
        reaction: 'love',
        selectedMessageText: null,
      });
      const emptyText = JSON.stringify({
        selectedMessageGuid: 'target-empty',
        reaction: '-love',
        selectedMessageText: '',
      });
      const insert = raw.prepare(
        `INSERT INTO outgoing_queue (temp_guid, chat_guid, kind, payload)
         VALUES (?, 'chat-1', ?, ?)`,
      );
      insert.run('temp-canonical', 'reaction', canonical);
      insert.run('temp-no-key', 'reaction', noKey);
      insert.run('temp-non-reaction', 'text', nonReaction);
      insert.run('temp-malformed', 'reaction', malformed);
      insert.run('temp-null', 'reaction', nullText);
      insert.run('temp-empty', 'reaction', emptyText);

      const before = readPayloads(raw);

      // Keep this named upgrade test isolated if a later migration is appended.
      const migrationIndex = MIGRATIONS.findIndex((migration) => migration.name === MIGRATION_NAME);
      expect(migrationIndex).toBeGreaterThanOrEqual(0);
      const markApplied = raw.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, 0)');
      for (const migration of MIGRATIONS.slice(migrationIndex + 1)) markApplied.run(migration.name);

      control.stopBefore0038 = false;
      control.failRecording0038 = true;
      await expect(runMigrations(runner)).rejects.toThrow('test failure recording migration 0038');

      expect(control.scrubVisibleBeforeRecordFailure).toBe(true);
      expect(raw.inTransaction).toBe(false);
      expect(readPayloads(raw)).toEqual(before);
      expect(
        raw.prepare('SELECT name FROM _migrations WHERE name = ?').get(MIGRATION_NAME),
      ).toBeUndefined();

      control.failRecording0038 = false;
      await expect(runMigrations(runner)).resolves.toEqual([MIGRATION_NAME]);

      const after = readPayloads(raw);
      const byGuid = new Map(after.map((row) => [row.tempGuid, row]));
      expect(JSON.parse(byGuid.get('temp-canonical')!.payload)).toEqual({
        selectedMessageGuid: 'target-canonical',
        reaction: 'emoji',
        emoji: '🫡',
        future: { nested: ['preserve', 1] },
      });
      expect(byGuid.get('temp-canonical')!.payload).not.toContain(PRIVATE_SENTINEL);
      expect(byGuid.get('temp-no-key')!.payload).toBe(noKey);
      expect(byGuid.get('temp-non-reaction')!.payload).toBe(nonReaction);
      expect(byGuid.get('temp-malformed')!.payload).toBe(malformed);
      expect(JSON.parse(byGuid.get('temp-null')!.payload)).toEqual({
        selectedMessageGuid: 'target-null',
        reaction: 'love',
      });
      expect(JSON.parse(byGuid.get('temp-empty')!.payload)).toEqual({
        selectedMessageGuid: 'target-empty',
        reaction: '-love',
      });

      await expect(runMigrations(runner)).resolves.toEqual([]);
      expect(readPayloads(raw)).toEqual(after);
    } finally {
      raw.close();
    }
  });
});
