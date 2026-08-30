import Database from 'better-sqlite3';
import { runMigrations, type SqlRunner } from '@db/migrate';
import {
  createCustomFolder,
  deleteCustomFolder,
  listCustomFolderChatGuids,
  listCustomFolders,
  renameCustomFolder,
  reorderCustomFolders,
  replaceCustomFolderMembership,
} from '@db/repositories';
import { createTestDb } from '../../support/testDb';

const MIGRATION_NAME = '0043_custom_folders';
const CREATE_TABLE_MARKER = 'CREATE TABLE custom_folders';

function runnerFor(raw: Database.Database, stopBefore0043: { value: boolean }): SqlRunner {
  return {
    async exec(statement, params) {
      if (stopBefore0043.value && statement.includes(CREATE_TABLE_MARKER)) {
        throw new Error('test stop before migration 0043');
      }
      raw.prepare(statement).run(...((params as unknown[]) ?? []));
    },
    async query(statement, params) {
      return raw.prepare(statement).all(...((params as unknown[]) ?? [])) as never[];
    },
  };
}

describe('migration 0043_custom_folders', () => {
  it('upgrades an existing database with bounded, stable-GUID folder storage', async () => {
    const raw = new Database(':memory:');
    const stopBefore0043 = { value: true };
    const runner = runnerFor(raw, stopBefore0043);
    try {
      await expect(runMigrations(runner)).rejects.toThrow('test stop before migration 0043');
      expect(raw.prepare('SELECT name FROM _migrations ORDER BY rowid DESC LIMIT 1').get()).toEqual(
        { name: '0042_message_part_identity' },
      );
      raw.prepare("INSERT INTO chats (guid) VALUES ('chat-before-0043')").run();

      stopBefore0043.value = false;
      await expect(runMigrations(runner)).resolves.toEqual([
        MIGRATION_NAME,
        '0044_custom_folder_unread_badge',
      ]);
      raw.prepare("INSERT INTO custom_folders (name, sort_order) VALUES ('Work', 0)").run();
      const folderId = (
        raw.prepare("SELECT id FROM custom_folders WHERE name = 'Work'").get() as { id: number }
      ).id;
      raw
        .prepare('INSERT INTO custom_folder_members (folder_id, chat_guid) VALUES (?, ?)')
        .run(folderId, 'chat-before-0043');
      raw.prepare("DELETE FROM chats WHERE guid = 'chat-before-0043'").run();

      expect(raw.prepare('SELECT chat_guid AS chatGuid FROM custom_folder_members').all()).toEqual([
        { chatGuid: 'chat-before-0043' },
      ]);
      expect(() =>
        raw.prepare("INSERT INTO custom_folders (name, sort_order) VALUES (' Work ', 1)").run(),
      ).toThrow(/custom_folders_name_valid/);
      expect(() =>
        raw.prepare("INSERT INTO custom_folders (name, sort_order) VALUES ('Later', -1)").run(),
      ).toThrow(/custom_folders_sort_order_nonnegative/);
      expect(() =>
        raw
          .prepare('INSERT INTO custom_folder_members (folder_id, chat_guid) VALUES (?, ?)')
          .run(folderId, ''),
      ).toThrow(/custom_folder_members_chat_guid_valid/);
      await expect(runMigrations(runner)).resolves.toEqual([]);
    } finally {
      raw.close();
    }
  });

  it('keeps CRUD, exact ordering, and membership replacement atomic at repository level', async () => {
    const { db } = await createTestDb();
    const work = await createCustomFolder(db, '  Work  ');
    const family = await createCustomFolder(db, 'Family');

    await expect(renameCustomFolder(db, family.id, 'People')).resolves.toBe(true);
    await expect(reorderCustomFolders(db, [family.id])).resolves.toBe(false);
    await expect(reorderCustomFolders(db, [family.id, work.id])).resolves.toBe(true);
    expect(await listCustomFolders(db)).toEqual([
      { ...family, name: 'People', sortOrder: 0, showUnreadBadge: 1 },
      { ...work, sortOrder: 1, showUnreadBadge: 1 },
    ]);

    await expect(replaceCustomFolderMembership(db, work.id, ['chat-a', 'chat-b'])).resolves.toBe(
      true,
    );
    await expect(
      replaceCustomFolderMembership(db, work.id, ['chat-b', 'chat-c', 'chat-b']),
    ).resolves.toBe(true);
    expect(await listCustomFolderChatGuids(db, work.id)).toEqual(['chat-b', 'chat-c']);

    await expect(deleteCustomFolder(db, work.id)).resolves.toBe(true);
    expect(await listCustomFolderChatGuids(db, work.id)).toEqual([]);
  });
});
