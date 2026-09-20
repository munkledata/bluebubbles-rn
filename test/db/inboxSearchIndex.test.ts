import { rebuildInboxSearchIndexBatch } from '@db/repositories/inboxSearchIndex';
import { searchChatsForInboxPage } from '@db/repositories';
import { createTestDb } from '../support/testDb';

describe('inbox search candidate index', () => {
  it('keeps exact results while dirty, after rebuilding, and after a participant rename', async () => {
    const t = await createTestDb();
    try {
      t.raw.prepare("INSERT INTO chats (guid, display_name) VALUES ('cafe', 'Café')").run();
      t.raw.prepare("INSERT INTO chats (guid, display_name) VALUES ('other', 'Other')").run();
      t.raw
        .prepare(
          "INSERT INTO handles (address, service, display_name) VALUES ('x@test', '', 'Alice')",
        )
        .run();
      const chatId = (
        t.raw.prepare("SELECT id FROM chats WHERE guid = 'other'").get() as {
          id: number;
        }
      ).id;
      const handleId = (
        t.raw.prepare("SELECT id FROM handles WHERE address = 'x@test'").get() as {
          id: number;
        }
      ).id;
      t.raw
        .prepare('INSERT INTO chat_handles (chat_id, handle_id) VALUES (?, ?)')
        .run(chatId, handleId);

      const guids = async (query: string): Promise<string[]> =>
        (await searchChatsForInboxPage(t.db, { query })).rows.map((row) => row.guid);
      expect(await guids('café')).toEqual(['cafe']);
      expect(await guids('alice')).toEqual(['other']);
      const built = await rebuildInboxSearchIndexBatch(t.db);
      expect(built).toMatchObject({ visited: 2, settled: 2, deferred: 0 });
      expect(
        t.raw.prepare('SELECT COUNT(*) AS count FROM inbox_search_state WHERE is_dirty = 1').get(),
      ).toEqual({ count: 0 });
      expect(await guids('café')).toEqual(['cafe']);
      expect(await guids('alice')).toEqual(['other']);

      t.raw.prepare("UPDATE handles SET display_name = 'Bob' WHERE id = ?").run(handleId);
      expect(await guids('bob')).toEqual(['other']);
      expect(await guids('alice')).toEqual([]);
      expect(await rebuildInboxSearchIndexBatch(t.db)).toMatchObject({ settled: 1 });
      expect(await guids('bob')).toEqual(['other']);
      expect(await guids('alice')).toEqual([]);
      expect(await guids('missing')).toEqual([]);
    } finally {
      t.raw.close();
    }
  });

  it('leaves oversized text dirty and exactly searchable instead of indexing a huge set', async () => {
    const t = await createTestDb();
    try {
      t.raw
        .prepare('INSERT INTO chats (guid, display_name) VALUES (?, ?)')
        .run('large', `${'x'.repeat(1100)}Needle`);
      expect(await rebuildInboxSearchIndexBatch(t.db)).toMatchObject({
        visited: 1,
        settled: 0,
        deferred: 1,
      });
      expect(
        t.raw.prepare('SELECT is_dirty AS isDirty, rebuildable FROM inbox_search_state').get(),
      ).toEqual({ isDirty: 1, rebuildable: 0 });
      expect(
        (await searchChatsForInboxPage(t.db, { query: 'needle' })).rows.map((row) => row.guid),
      ).toEqual(['large']);
      t.raw.prepare("UPDATE chats SET display_name = 'Short needle' WHERE guid = 'large'").run();
      expect(await rebuildInboxSearchIndexBatch(t.db)).toMatchObject({ settled: 1 });
      expect(
        t.raw.prepare('SELECT is_dirty AS isDirty, rebuildable FROM inbox_search_state').get(),
      ).toEqual({ isDirty: 0, rebuildable: 1 });
    } finally {
      t.raw.close();
    }
  });
});
