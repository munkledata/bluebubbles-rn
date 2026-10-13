import Database from 'better-sqlite3';
import { runMigrations, type SqlRunner } from '@db/migrate';
import { migrationNamesFrom } from '../../support/migrationNames';

it('adds reversible server state without reinterpreting historical local deletions', async () => {
  const raw = new Database(':memory:');
  let stop = true;
  const runner: SqlRunner = {
    async exec(statement, params) {
      if (stop && statement.includes('CREATE TABLE message_server_states'))
        throw new Error('stop before 0053');
      raw.prepare(statement).run(...((params as unknown[]) ?? []));
    },
    async query(statement, params) {
      return raw.prepare(statement).all(...((params as unknown[]) ?? [])) as never[];
    },
  };
  try {
    await expect(runMigrations(runner)).rejects.toThrow('stop before 0053');
    raw
      .prepare('INSERT INTO message_deletion_ledger(guid,date_deleted,chat_guid) VALUES (?,?,?)')
      .run('legacy', 123, null);
    stop = false;
    await expect(runMigrations(runner)).resolves.toEqual(
      migrationNamesFrom('0053_versioned_server_message_state'),
    );
    expect(raw.prepare('SELECT * FROM message_server_states').all()).toEqual([]);
    expect(raw.prepare('SELECT * FROM message_deletion_ledger').all()).toEqual([
      { guid: 'legacy', date_deleted: 123, chat_guid: null },
    ]);
    await expect(runMigrations(runner)).resolves.toEqual([]);
  } finally {
    raw.close();
  }
});
