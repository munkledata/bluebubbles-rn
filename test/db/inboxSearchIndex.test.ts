import { drizzle } from 'drizzle-orm/better-sqlite3';
import { rebuildInboxSearchIndexBatch } from '@db/repositories/inboxSearchIndex';
import { InboxSearchCancelledError, searchChatsForInboxPage } from '@db/repositories';
import type { AppDatabase } from '@db/types';
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

  it('does not bridge a huge participant aggregate while rebuilding its index', async () => {
    const t = await createTestDb();
    try {
      t.raw
        .prepare("INSERT INTO chats (guid, display_name) VALUES ('large-people', 'Group')")
        .run();
      t.raw
        .prepare('INSERT INTO handles (address, service, display_name) VALUES (?, ?, ?)')
        .run('large@example.test', '', `${'x'.repeat(20_000)}Needle`);
      t.raw.prepare('INSERT INTO chat_handles (chat_id, handle_id) VALUES (1, 1)').run();

      const statements: string[] = [];
      const observedDb = drizzle(t.raw, {
        logger: {
          logQuery(query) {
            statements.push(query);
          },
        },
      }) as unknown as AppDatabase;
      expect(await rebuildInboxSearchIndexBatch(observedDb)).toMatchObject({ deferred: 1 });
      expect(statements.some((query) => query.includes('group_concat'))).toBe(false);
      expect(
        (await searchChatsForInboxPage(t.db, { query: 'needle' })).rows.map((row) => row.guid),
      ).toEqual(['large-people']);
    } finally {
      t.raw.close();
    }
  });

  it('defers an oversized participant group after a bounded preflight', async () => {
    const t = await createTestDb();
    try {
      t.raw.prepare("INSERT INTO chats (guid, display_name) VALUES ('many-people', 'Group')").run();
      const insertHandle = t.raw.prepare(
        'INSERT INTO handles (address, service, display_name) VALUES (?, ?, ?)',
      );
      const attachHandle = t.raw.prepare(
        'INSERT INTO chat_handles (chat_id, handle_id) VALUES (1, ?)',
      );
      t.raw.transaction(() => {
        for (let id = 1; id <= 514; id += 1) {
          insertHandle.run(`person-${id}@example.test`, '', `P${id}`);
          attachHandle.run(id);
        }
      })();

      const statements: string[] = [];
      const observedDb = drizzle(t.raw, {
        logger: {
          logQuery(query) {
            statements.push(query);
          },
        },
      }) as unknown as AppDatabase;
      expect(await rebuildInboxSearchIndexBatch(observedDb)).toMatchObject({ deferred: 1 });
      expect(statements.some((query) => query.includes('group_concat'))).toBe(false);
      expect(
        t.raw.prepare('SELECT is_dirty AS isDirty, rebuildable FROM inbox_search_state').get(),
      ).toEqual({ isDirty: 1, rebuildable: 0 });
      expect(
        (await searchChatsForInboxPage(t.db, { query: 'p514' })).rows.map((row) => row.guid),
      ).toEqual(['many-people']);
    } finally {
      t.raw.close();
    }
  });

  it('intersects every query bigram before loading indexed candidate details', async () => {
    const t = await createTestDb();
    try {
      t.raw
        .prepare('INSERT INTO chats (guid, display_name) VALUES (?, ?)')
        .run('first-gram-only', 'abXXcd');
      t.raw.prepare('INSERT INTO chats (guid, display_name) VALUES (?, ?)').run('exact', 'abcd');
      expect(await rebuildInboxSearchIndexBatch(t.db)).toMatchObject({ settled: 2 });
      const exactId = (
        t.raw.prepare("SELECT id FROM chats WHERE guid = 'exact'").get() as { id: number }
      ).id;

      const statements: { query: string; params: unknown[] }[] = [];
      const observedDb = drizzle(t.raw, {
        logger: {
          logQuery(query, params) {
            statements.push({ query, params: [...params] });
          },
        },
      }) as unknown as AppDatabase;
      const result = await searchChatsForInboxPage(observedDb, { query: 'abcd' });
      expect(result.rows.map((row) => row.guid)).toEqual(['exact']);
      const detail = statements.find(({ query }) =>
        /c\.id IN \(\s*SELECT CAST\(value AS INTEGER\) FROM json_each\(/.test(query),
      );
      expect(detail).toBeDefined();
      expect(detail?.params).toContain(JSON.stringify([exactId]));
    } finally {
      t.raw.close();
    }
  });

  it('bounds a common first-gram scan before checking later grams', async () => {
    const t = await createTestDb();
    try {
      const insert = t.raw.prepare('INSERT INTO chats (guid, display_name) VALUES (?, ?)');
      t.raw.transaction(() => {
        for (let index = 0; index < 300; index += 1) {
          insert.run(`common-${index}`, `ab unrelated ${index}`);
        }
        insert.run('late-exact', 'abcd');
      })();

      let cursor = 0;
      for (;;) {
        const batch = await rebuildInboxSearchIndexBatch(t.db, cursor);
        if (batch.visited === 0) break;
        cursor = batch.lastChatId;
      }

      const rawPages: { id: number; isCandidate: number }[][] = [];
      const observedDb = new Proxy(t.db, {
        get(target, property, receiver) {
          if (property !== 'all') return Reflect.get(target, property, receiver);
          return async (...args: Parameters<AppDatabase['all']>) => {
            const rows = (await target.all(...args)) as Record<string, unknown>[];
            if (rows.length > 0 && Object.hasOwn(rows[0]!, 'isCandidate')) {
              rawPages.push(rows as { id: number; isCandidate: number }[]);
            }
            return rows;
          };
        },
      });

      const result = await searchChatsForInboxPage(observedDb, { query: 'abcd' });
      expect(result.rows.map((row) => row.guid)).toEqual(['late-exact']);
      expect(rawPages).toHaveLength(3);
      expect(rawPages.every((page) => page.length <= 128)).toBe(true);
      expect(rawPages.slice(0, 2).every((page) => page.every((row) => row.isCandidate === 0))).toBe(
        true,
      );
      expect(rawPages[2]?.some((row) => row.isCandidate === 1)).toBe(true);
    } finally {
      t.raw.close();
    }
  });

  it('matches across bounded participant pages while dirty and after indexing', async () => {
    const t = await createTestDb();
    try {
      t.raw
        .prepare(
          "INSERT INTO chats (guid, display_name, latest_message_date) VALUES ('page-boundary', 'Known Group', 1)",
        )
        .run();
      const insertHandle = t.raw.prepare(
        'INSERT INTO handles (address, service, display_name) VALUES (?, ?, ?)',
      );
      const attachHandle = t.raw.prepare(
        'INSERT INTO chat_handles (chat_id, handle_id) VALUES (1, ?)',
      );
      t.raw.transaction(() => {
        for (let id = 1; id <= 127; id += 1) {
          insertHandle.run(`person-${id}@example.test`, '', `P${String(id).padStart(3, '0')}`);
          attachHandle.run(id);
        }
        insertHandle.run('alice@example.test', '', 'Alice');
        attachHandle.run(128);
        insertHandle.run('bob@example.test', '', 'Bob');
        attachHandle.run(129);
      })();

      const statements: string[] = [];
      const loggedDb = drizzle(t.raw, {
        logger: {
          logQuery(query) {
            statements.push(query);
          },
        },
      }) as unknown as AppDatabase;
      const participantPages: { chatId: number; handleId: number; participantName: string }[][] =
        [];
      const observedDb = new Proxy(loggedDb, {
        get(target, property, receiver) {
          if (property !== 'all') return Reflect.get(target, property, receiver);
          return async (...args: Parameters<AppDatabase['all']>) => {
            const rows = (await target.all(...args)) as Record<string, unknown>[];
            if (rows.length > 0 && Object.hasOwn(rows[0]!, 'participantName')) {
              participantPages.push(
                rows as { chatId: number; handleId: number; participantName: string }[],
              );
            }
            return rows;
          };
        },
      });
      const runSearch = async (
        query: string,
      ): Promise<{ guids: string[]; participantPageSizes: number[] }> => {
        participantPages.length = 0;
        statements.length = 0;
        const result = await searchChatsForInboxPage(observedDb, { query });
        return {
          guids: result.rows.map((row) => row.guid),
          participantPageSizes: participantPages.map((page) => page.length),
        };
      };

      expect(await runSearch('ice, bo')).toEqual({
        guids: ['page-boundary'],
        participantPageSizes: [128, 1],
      });
      const candidateDetails = statements.filter(
        (query) =>
          query.includes('c.latest_message_date AS latestMessageDate') &&
          !query.includes('WITH pinned AS'),
      );
      expect(candidateDetails.length).toBeGreaterThan(0);
      expect(
        candidateDetails.every(
          (query) =>
            !/\b(?:group_concat|json_group_array)\s*\(/i.test(query) &&
            !query.includes('chat_handles'),
        ),
      ).toBe(true);
      expect(await runSearch('known group p001')).toEqual({
        guids: ['page-boundary'],
        participantPageSizes: [128, 1],
      });

      expect(await rebuildInboxSearchIndexBatch(t.db)).toMatchObject({ settled: 1, deferred: 0 });
      expect(await runSearch('ice, bo')).toEqual({
        guids: ['page-boundary'],
        participantPageSizes: [128, 1],
      });
      expect(await runSearch('known group p001')).toEqual({
        guids: ['page-boundary'],
        participantPageSizes: [128, 1],
      });
    } finally {
      t.raw.close();
    }
  });

  it('keeps commas inside one participant name instead of inventing title spaces', async () => {
    const t = await createTestDb();
    try {
      t.raw
        .prepare("INSERT INTO chats (guid, display_name) VALUES ('comma-name', 'chat123')")
        .run();
      t.raw
        .prepare(
          "INSERT INTO handles (address, service, display_name) VALUES ('doe@example.test', '', 'Doe,Jane')",
        )
        .run();
      t.raw.prepare('INSERT INTO chat_handles (chat_id, handle_id) VALUES (1, 1)').run();
      const guids = async (query: string): Promise<string[]> =>
        (await searchChatsForInboxPage(t.db, { query })).rows.map((row) => row.guid);

      expect(await guids('doe,jane')).toEqual(['comma-name']);
      expect(await guids('doe, jane')).toEqual([]);
      expect(await rebuildInboxSearchIndexBatch(t.db)).toMatchObject({ settled: 1, deferred: 0 });
      expect(await guids('doe,jane')).toEqual(['comma-name']);
      expect(await guids('doe, jane')).toEqual([]);
    } finally {
      t.raw.close();
    }
  });

  it('cancels an exact participant scan after its first bounded page', async () => {
    const t = await createTestDb();
    try {
      t.raw
        .prepare("INSERT INTO chats (guid, display_name) VALUES ('cancel-people', 'Group')")
        .run();
      const insertHandle = t.raw.prepare(
        'INSERT INTO handles (address, service, display_name) VALUES (?, ?, ?)',
      );
      const attachHandle = t.raw.prepare(
        'INSERT INTO chat_handles (chat_id, handle_id) VALUES (1, ?)',
      );
      t.raw.transaction(() => {
        for (let id = 1; id <= 260; id += 1) {
          insertHandle.run(`person-${id}@example.test`, '', `Person ${id}`);
          attachHandle.run(id);
        }
      })();

      let cancelled = false;
      const participantPages: Record<string, unknown>[][] = [];
      const observedDb = new Proxy(t.db, {
        get(target, property, receiver) {
          if (property !== 'all') return Reflect.get(target, property, receiver);
          return async (...args: Parameters<AppDatabase['all']>) => {
            const rows = (await target.all(...args)) as Record<string, unknown>[];
            if (rows.length > 0 && Object.hasOwn(rows[0]!, 'participantName')) {
              participantPages.push(rows);
              cancelled = true;
            }
            return rows;
          };
        },
      });

      await expect(
        searchChatsForInboxPage(observedDb, {
          query: 'absent',
          shouldContinue: () => !cancelled,
        }),
      ).rejects.toBeInstanceOf(InboxSearchCancelledError);
      expect(participantPages).toHaveLength(1);
      expect(participantPages[0]).toHaveLength(128);
    } finally {
      t.raw.close();
    }
  });

  it('stops an obsolete dirty-backlog scan before its next candidate page', async () => {
    const t = await createTestDb();
    try {
      const insert = t.raw.prepare('INSERT INTO chats (guid, display_name) VALUES (?, ?)');
      t.raw.transaction(() => {
        for (let index = 0; index < 260; index += 1) {
          insert.run(`dirty-${index}`, `Unrelated ${index}`);
        }
      })();

      let checks = 0;
      await expect(
        searchChatsForInboxPage(t.db, {
          query: 'absent',
          shouldContinue: () => ++checks <= 5,
        }),
      ).rejects.toBeInstanceOf(InboxSearchCancelledError);
      expect(checks).toBe(6);
    } finally {
      t.raw.close();
    }
  });
});
