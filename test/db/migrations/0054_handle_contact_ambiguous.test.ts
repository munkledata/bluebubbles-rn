import Database from 'better-sqlite3';
import { runMigrations, type SqlRunner } from '@db/migrate';
import { migrationNamesFrom } from '../../support/migrationNames';

const MIGRATION_NAME = '0054_handle_contact_ambiguous';

function runnerFor(raw: Database.Database, stopBefore0054: { value: boolean }): SqlRunner {
  return {
    async exec(statement, params) {
      if (
        stopBefore0054.value &&
        statement.includes('ALTER TABLE handles') &&
        statement.includes('ADD COLUMN contact_ambiguous')
      ) {
        throw new Error('test stop before migration 0054');
      }
      raw.prepare(statement).run(...((params as unknown[]) ?? []));
    },
    async query(statement, params) {
      return raw.prepare(statement).all(...((params as unknown[]) ?? [])) as never[];
    },
  };
}

describe(`migration ${MIGRATION_NAME}`, () => {
  it('adds a not-ambiguous default to existing handles and accepts only 0 or 1', async () => {
    const raw = new Database(':memory:');
    const stopBefore0054 = { value: true };
    const runner = runnerFor(raw, stopBefore0054);
    try {
      await expect(runMigrations(runner)).rejects.toThrow('test stop before migration 0054');
      expect(raw.prepare('SELECT name FROM _migrations ORDER BY rowid DESC LIMIT 1').get()).toEqual(
        { name: '0053_versioned_server_message_state' },
      );
      raw
        .prepare("INSERT INTO handles (address, service) VALUES ('+15551234567', 'iMessage')")
        .run();

      stopBefore0054.value = false;
      // This migration and every later one apply, so a newer migration cannot break this test.
      await expect(runMigrations(runner)).resolves.toEqual(migrationNamesFrom(MIGRATION_NAME));
      expect(raw.prepare('SELECT contact_ambiguous AS flag FROM handles').get()).toEqual({
        flag: 0,
      });
      raw.prepare("UPDATE handles SET contact_ambiguous = 1 WHERE address = '+15551234567'").run();
      expect(() =>
        raw
          .prepare("UPDATE handles SET contact_ambiguous = 2 WHERE address = '+15551234567'")
          .run(),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        raw
          .prepare("UPDATE handles SET contact_ambiguous = NULL WHERE address = '+15551234567'")
          .run(),
      ).toThrow(/NOT NULL constraint failed/);
    } finally {
      raw.close();
    }
  });
});
