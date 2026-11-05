import Database from 'better-sqlite3';
import { runMigrations, type SqlRunner } from '@db/migrate';
import { migrationNamesFrom } from '../../support/migrationNames';

const MIGRATION_NAME = '0060_chat_auto_unarchive';

function runnerFor(raw: Database.Database, stopBefore0060: { value: boolean }): SqlRunner {
  return {
    async exec(statement, params) {
      if (stopBefore0060.value && statement.includes('archived_at')) {
        throw new Error('test stop before migration 0060');
      }
      raw.prepare(statement).run(...((params as unknown[]) ?? []));
    },
    async query(statement, params) {
      return raw.prepare(statement).all(...((params as unknown[]) ?? [])) as never[];
    },
  };
}

describe(`migration ${MIGRATION_NAME}`, () => {
  it('stamps chats archived before the upgrade, defaults the switch on, and adds the triggers', async () => {
    const raw = new Database(':memory:');
    const stopBefore0060 = { value: true };
    const runner = runnerFor(raw, stopBefore0060);
    try {
      await expect(runMigrations(runner)).rejects.toThrow('test stop before migration 0060');
      expect(raw.prepare('SELECT name FROM _migrations ORDER BY rowid DESC LIMIT 1').get()).toEqual(
        { name: '0059_retire_doubled_text_local_copies' },
      );
      raw
        .prepare(
          "INSERT INTO chats (guid, style, is_archived) VALUES ('archived-before', 45, 1), ('active', 45, 0)",
        )
        .run();

      const before = Date.now();
      stopBefore0060.value = false;
      await expect(runMigrations(runner)).resolves.toEqual(migrationNamesFrom(MIGRATION_NAME));

      const rows = raw
        .prepare(
          'SELECT guid, is_archived AS archived, archived_at AS archivedAt, auto_unarchive AS auto FROM chats ORDER BY guid',
        )
        .all() as { guid: string; archived: number; archivedAt: number | null; auto: number }[];
      expect(rows).toEqual([
        { guid: 'active', archived: 0, archivedAt: null, auto: 1 },
        { guid: 'archived-before', archived: 1, archivedAt: expect.any(Number), auto: 1 },
      ]);
      // The upgrade time, in epoch milliseconds like messages.date_created.
      expect(rows[1]!.archivedAt).toBeGreaterThanOrEqual(before - 5_000);
      expect(rows[1]!.archivedAt).toBeLessThanOrEqual(Date.now() + 5_000);

      raw.prepare("UPDATE chats SET is_archived = 1 WHERE guid = 'active'").run();
      expect(
        raw.prepare("SELECT archived_at AS archivedAt FROM chats WHERE guid = 'active'").get(),
      ).toEqual({ archivedAt: expect.any(Number) });
      raw.prepare("UPDATE chats SET is_archived = 0 WHERE guid = 'archived-before'").run();
      expect(
        raw
          .prepare("SELECT archived_at AS archivedAt FROM chats WHERE guid = 'archived-before'")
          .get(),
      ).toEqual({ archivedAt: null });
    } finally {
      raw.close();
    }
  });
});
