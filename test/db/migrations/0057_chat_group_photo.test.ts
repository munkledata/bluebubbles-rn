import Database from 'better-sqlite3';
import { runMigrations, type SqlRunner } from '@db/migrate';
import { migrationNamesFrom } from '../../support/migrationNames';

const MIGRATION_NAME = '0057_chat_group_photo';

function runnerFor(raw: Database.Database, stopBefore0057: { value: boolean }): SqlRunner {
  return {
    async exec(statement, params) {
      if (stopBefore0057.value && statement.includes('group_photo_guid')) {
        throw new Error('test stop before migration 0057');
      }
      raw.prepare(statement).run(...((params as unknown[]) ?? []));
    },
    async query(statement, params) {
      return raw.prepare(statement).all(...((params as unknown[]) ?? [])) as never[];
    },
  };
}

describe(`migration ${MIGRATION_NAME}`, () => {
  it('adds the two nullable group-photo columns and keeps existing chats', async () => {
    const raw = new Database(':memory:');
    const stopBefore0057 = { value: true };
    const runner = runnerFor(raw, stopBefore0057);
    try {
      await expect(runMigrations(runner)).rejects.toThrow('test stop before migration 0057');
      expect(raw.prepare('SELECT name FROM _migrations ORDER BY rowid DESC LIMIT 1').get()).toEqual(
        { name: '0056_retire_doubled_rcs_local_copies' },
      );
      raw.prepare("INSERT INTO chats (guid, style) VALUES ('any;+;chat0057', 43)").run();

      stopBefore0057.value = false;
      await expect(runMigrations(runner)).resolves.toEqual(migrationNamesFrom(MIGRATION_NAME));
      expect(
        raw
          .prepare('SELECT guid, group_photo_guid AS photo, group_photo_uri AS uri FROM chats')
          .all(),
      ).toEqual([{ guid: 'any;+;chat0057', photo: null, uri: null }]);
      raw
        .prepare(
          "UPDATE chats SET group_photo_guid = 'at_0_photo', group_photo_uri = 'file:///x.jpg'",
        )
        .run();
      expect(raw.prepare('SELECT group_photo_guid AS photo FROM chats').get()).toEqual({
        photo: 'at_0_photo',
      });
    } finally {
      raw.close();
    }
  });
});
