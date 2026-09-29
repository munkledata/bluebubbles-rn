import Database from 'better-sqlite3';
import { runMigrations, type SqlRunner } from '@db/migrate';

const MIGRATION_NAME = '0050_message_identity_owner_scope';

function runnerFor(raw: Database.Database, stopBefore0050: { value: boolean }): SqlRunner {
  return {
    async exec(statement, params) {
      if (
        stopBefore0050.value &&
        statement.includes('ALTER TABLE message_deletion_ledger') &&
        statement.includes('ADD COLUMN chat_guid')
      ) {
        throw new Error('test stop before migration 0050');
      }
      raw.prepare(statement).run(...((params as unknown[]) ?? []));
    },
    async query(statement, params) {
      return raw.prepare(statement).all(...((params as unknown[]) ?? [])) as never[];
    },
  };
}

describe('migration 0050_message_identity_owner_scope', () => {
  it('backfills only provable exact owners and keeps ownerless/conflicting legacy rows inert', async () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    const stopBefore0050 = { value: true };
    const runner = runnerFor(raw, stopBefore0050);
    try {
      await expect(runMigrations(runner)).rejects.toThrow('test stop before migration 0050');
      expect(raw.prepare('SELECT name FROM _migrations ORDER BY rowid DESC LIMIT 1').get()).toEqual(
        { name: '0049_inbox_search_postings' },
      );

      raw.prepare("INSERT INTO chats (guid) VALUES ('chat-owner-a'), ('chat-owner-b')").run();
      const chatA = raw.prepare("SELECT id FROM chats WHERE guid = 'chat-owner-a'").get() as {
        id: number;
      };
      const chatB = raw.prepare("SELECT id FROM chats WHERE guid = 'chat-owner-b'").get() as {
        id: number;
      };
      raw
        .prepare(
          `INSERT INTO messages (guid, chat_id, is_from_me)
           VALUES ('temp-owned-a', ?, 1),
                  ('real-canonical-only', ?, 1),
                  ('real-conflict-b', ?, 1)`,
        )
        .run(chatA.id, chatA.id, chatB.id);
      raw
        .prepare(
          `INSERT INTO message_deletion_ledger (guid, date_deleted)
           VALUES ('temp-owned-a', 10), ('ownerless-ledger', 20)`,
        )
        .run();
      raw
        .prepare(
          `INSERT INTO message_guid_aliases (alias_guid, canonical_guid)
           VALUES ('temp-owned-a', 'real-owned-a'),
                  ('temp-canonical-only', 'real-canonical-only'),
                  ('temp-ownerless', 'real-ownerless'),
                  ('temp-owned-conflict', 'real-conflict-b')`,
        )
        .run();
      raw
        .prepare(
          `INSERT INTO messages (guid, chat_id, is_from_me)
           VALUES ('temp-owned-conflict', ?, 1)`,
        )
        .run(chatA.id);

      stopBefore0050.value = false;
      await expect(runMigrations(runner)).resolves.toEqual([
        MIGRATION_NAME,
        '0051_handle_color_backup_index',
        '0052_chat_history_deletion_boundary',
      ]);

      expect(
        raw
          .prepare(
            `SELECT guid, chat_guid AS chatGuid
               FROM message_deletion_ledger
              ORDER BY guid`,
          )
          .all(),
      ).toEqual([
        { guid: 'ownerless-ledger', chatGuid: null },
        { guid: 'temp-owned-a', chatGuid: 'chat-owner-a' },
      ]);
      expect(
        raw
          .prepare(
            `SELECT alias_guid AS aliasGuid, chat_guid AS chatGuid
               FROM message_guid_aliases
              ORDER BY alias_guid`,
          )
          .all(),
      ).toEqual([
        { aliasGuid: 'temp-canonical-only', chatGuid: 'chat-owner-a' },
        { aliasGuid: 'temp-owned-a', chatGuid: 'chat-owner-a' },
        { aliasGuid: 'temp-owned-conflict', chatGuid: null },
        { aliasGuid: 'temp-ownerless', chatGuid: null },
      ]);
      await expect(runMigrations(runner)).resolves.toEqual([]);
    } finally {
      raw.close();
    }
  });
});
