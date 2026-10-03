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

      const statements: string[] = [];
      const loggedDb = drizzle(t.raw, {
        logger: {
          logQuery(query) {
            statements.push(query);
          },
        },
      }) as unknown as AppDatabase;
      const detailedIds: number[] = [];
      const observedDb = new Proxy(loggedDb, {
        get(target, property, receiver) {
          if (property !== 'all') return Reflect.get(target, property, receiver);
          return async (...args: Parameters<AppDatabase['all']>) => {
            const rows = (await target.all(...args)) as Record<string, unknown>[];
            for (const row of rows) {
              if (typeof row.candidateId === 'number') detailedIds.push(row.candidateId);
            }
            return rows;
          };
        },
      });
      const result = await searchChatsForInboxPage(observedDb, { query: 'abcd' });
      expect(result.rows.map((row) => row.guid)).toEqual(['exact']);
      const detail = statements.find((query) =>
        query.includes('candidate_details AS MATERIALIZED'),
      );
      expect(detail).toBeDefined();
      expect(detail).toContain('SELECT id FROM classified_ids WHERE isCandidate = 1');
      expect(detailedIds).toEqual([exactId]);
    } finally {
      t.raw.close();
    }
  });

  it('keeps a full hidden raw page and loads later visible details in the same read', async () => {
    const t = await createTestDb();
    try {
      const insert = t.raw.prepare(
        'INSERT INTO chats (guid, display_name, is_archived, deleted_at) VALUES (?, ?, ?, ?)',
      );
      t.raw.transaction(() => {
        for (let index = 0; index < 128; index += 1) {
          insert.run(`hidden-${index}`, 'Needle hidden', index % 2, index % 2 === 0 ? 100 : null);
        }
        insert.run('late-visible', 'Needle visible', 0, null);
      })();

      const statements: string[] = [];
      const candidatePlans: string[][] = [];
      const loggedDb = drizzle(t.raw, {
        logger: {
          logQuery(query, params) {
            statements.push(query);
            if (query.includes('candidate_details AS MATERIALIZED')) {
              const plan = t.raw.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...params) as {
                detail: string;
              }[];
              candidatePlans.push(plan.map((row) => row.detail));
            }
          },
        },
      }) as unknown as AppDatabase;
      const rawPages: { id: number; candidateId: number | null }[][] = [];
      const observedDb = new Proxy(loggedDb, {
        get(target, property, receiver) {
          if (property !== 'all') return Reflect.get(target, property, receiver);
          return async (...args: Parameters<AppDatabase['all']>) => {
            const rows = (await target.all(...args)) as Record<string, unknown>[];
            if (rows.length > 0 && Object.hasOwn(rows[0]!, 'isCandidate')) {
              rawPages.push(rows as { id: number; candidateId: number | null }[]);
            }
            return rows;
          };
        },
      });

      const result = await searchChatsForInboxPage(observedDb, { query: 'needle' });
      expect(result.rows.map((row) => row.guid)).toEqual(['late-visible']);
      expect(result.hasMore).toBe(false);
      expect(rawPages.map((page) => page.length)).toEqual([128, 1]);
      expect(rawPages[0]?.every((row) => row.candidateId === null)).toBe(true);
      expect(rawPages[1]).toEqual([expect.objectContaining({ id: 129, candidateId: 129 })]);
      expect(
        statements.filter((query) => query.includes('candidate_details AS MATERIALIZED')),
      ).toHaveLength(2);
      // One horizon, two fused candidate/detail reads, and one final decoration read.
      expect(statements).toHaveLength(4);
      expect(candidatePlans).toHaveLength(2);
      expect(
        candidatePlans.every((plan) =>
          plan.some((step) => step.includes('SEARCH c USING INTEGER PRIMARY KEY')),
        ),
      ).toBe(true);
    } finally {
      t.raw.close();
    }
  });

  it('verifies the extra match before pruning dominated names and still admits a later better match', async () => {
    const t = await createTestDb();
    try {
      const insertChat = t.raw.prepare(
        'INSERT INTO chats (guid, display_name, latest_message_date, is_archived, is_pinned, pin_order) VALUES (?, ?, ?, ?, ?, ?)',
      );
      const insertHandle = t.raw.prepare(
        'INSERT INTO handles (address, service, display_name) VALUES (?, ?, ?)',
      );
      const attachHandle = t.raw.prepare(
        'INSERT INTO chat_handles (chat_id, handle_id) VALUES (?, ?)',
      );
      t.raw.transaction(() => {
        insertChat.run('early-first', 'Needle first', 1_000, 0, 0, null);
        insertChat.run('early-second', 'Needle second', 900, 0, 0, null);
        for (let id = 3; id <= 128; id += 1) {
          insertChat.run(`hidden-${id}`, 'Needle hidden', 0, 1, 0, null);
        }
        // The first page fills the visible limit, but this worse-ranked name must still be read
        // to establish the extra exact match. It is intentionally larger than one text chunk.
        insertChat.run('extra-match', 'Known Group', 100, 0, 0, null);
        insertHandle.run('extra@example.test', '', `${'x'.repeat(4_097)}Needle`);
        attachHandle.run(129, 1);
        for (let id = 130; id <= 256; id += 1) {
          insertChat.run(`hidden-${id}`, 'Needle hidden', 0, 1, 0, null);
        }
        insertChat.run('dominated-match', 'Known Group', 0, 0, 0, null);
        insertHandle.run('dominated@example.test', '', `${'x'.repeat(4_097)}Needle`);
        attachHandle.run(257, 2);
        insertChat.run('late-pinned', 'Known Group', 0, 0, 1, 0);
        insertHandle.run('late@example.test', '', 'Needle late');
        attachHandle.run(258, 3);
      })();

      const participantChatIds: number[] = [];
      let chunkReads = 0;
      const observedDb = new Proxy(t.db, {
        get(target, property, receiver) {
          if (property !== 'all') return Reflect.get(target, property, receiver);
          return async (...args: Parameters<AppDatabase['all']>) => {
            const rows = (await target.all(...args)) as Record<string, unknown>[];
            for (const row of rows) {
              if (Object.hasOwn(row, 'participantBytes')) {
                participantChatIds.push(row.chatId as number);
              }
              if (Object.hasOwn(row, 'participantChunk')) chunkReads += 1;
            }
            return rows;
          };
        },
      });

      const result = await searchChatsForInboxPage(observedDb, { query: 'needle', limit: 2 });
      expect(result.rows.map((row) => row.guid)).toEqual(['late-pinned', 'early-first']);
      expect(result.hasMore).toBe(true);
      expect(participantChatIds).toEqual([129, 258]);
      expect(chunkReads).toBe(2);
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

  async function largeNameFixture(name: string) {
    const t = await createTestDb();
    t.raw
      .prepare("INSERT INTO chats (guid, display_name) VALUES ('large-name', 'Known Group')")
      .run();
    t.raw
      .prepare('INSERT INTO handles (address, service, display_name) VALUES (?, ?, ?)')
      .run('large@example.test', '', name);
    t.raw.prepare('INSERT INTO chat_handles (chat_id, handle_id) VALUES (1, 1)').run();
    return t;
  }

  function observeReads(
    db: AppDatabase,
    observe: (rows: Record<string, unknown>[]) => void,
  ): AppDatabase {
    return new Proxy(db, {
      get(target, property, receiver) {
        if (property !== 'all') return Reflect.get(target, property, receiver);
        return async (...args: Parameters<AppDatabase['all']>) => {
          const rows = (await target.all(...args)) as Record<string, unknown>[];
          observe(rows);
          return rows;
        };
      },
    });
  }

  it('bounds participant transfers without losing a match at the end of an oversized name', async () => {
    const t = await largeNameFixture(`${'x'.repeat(4096 * 10)}Tailneedle`);
    try {
      const insert = t.raw.prepare(
        'INSERT INTO handles (address, service, display_name) VALUES (?, ?, ?)',
      );
      const attach = t.raw.prepare('INSERT INTO chat_handles (chat_id, handle_id) VALUES (1, ?)');
      t.raw.transaction(() => {
        for (let id = 2; id <= 128; id += 1) {
          // Multi-byte names fit the exact 512-byte inline threshold, not 512 characters.
          insert.run(`person-${id}@example.test`, '', 'é'.repeat(256));
          attach.run(id);
        }
      })();
      const pages: Record<string, unknown>[][] = [];
      const chunks: Record<string, unknown>[] = [];
      const observed = observeReads(t.db, (rows) => {
        if (rows[0] && Object.hasOwn(rows[0], 'participantName')) pages.push(rows);
        if (rows[0] && Object.hasOwn(rows[0], 'participantChunk')) chunks.push(...rows);
      });
      const result = await searchChatsForInboxPage(observed, { query: 'tailneedle' });
      expect(result.rows.map((row) => row.guid)).toEqual(['large-name']);
      expect(pages.map((page) => page.length)).toEqual([128]);
      expect(pages[0]?.[0]).toMatchObject({ participantName: null, participantBytes: 40970 });
      expect(
        pages[0]?.every(
          (row) =>
            row.participantName == null || Buffer.byteLength(String(row.participantName)) <= 512,
        ),
      ).toBe(true);
      expect(chunks).toHaveLength(11);
      expect(chunks.every((row) => String(row.participantChunk).length <= 8192)).toBe(true);
      expect(String(chunks.at(-1)?.participantChunk)).toBe(
        Buffer.from('Tailneedle').toString('hex').toUpperCase(),
      );
    } finally {
      t.raw.close();
    }
  });

  it('preserves split UTF-8, NFC and case context, initial BOM and embedded NUL in large names', async () => {
    const cases = [
      { name: `\uFEFF${'x'.repeat(4092)}🚀tail`, queries: ['🚀tail', 'known group \uFEFFxx'] },
      { name: `${'x'.repeat(4095)}A\u030Aend`, queries: ['åend'] },
      { name: `${'x'.repeat(4094)}AΣAend`, queries: ['aσaend'], absent: 'aςaend' },
      { name: `${'x'.repeat(5000)}xy\0needle`, queries: ['xy\0needle'] },
    ];
    for (const fixture of cases) {
      const t = await largeNameFixture(fixture.name);
      try {
        for (const query of fixture.queries) {
          expect(
            (await searchChatsForInboxPage(t.db, { query })).rows.map((row) => row.guid),
          ).toEqual(['large-name']);
        }
        if (fixture.absent) {
          expect((await searchChatsForInboxPage(t.db, { query: fixture.absent })).rows).toEqual([]);
        }
      } finally {
        t.raw.close();
      }
    }
  });

  it.each(['after-read', 'yield'] as const)(
    'stops an oversized-name continuation at %s cancellation',
    async (when) => {
      const t = await largeNameFixture('x'.repeat(4096 * 10));
      try {
        let cancelled = false;
        let chunkReads = 0;
        const observed = observeReads(t.db, (rows) => {
          if (!rows[0] || !Object.hasOwn(rows[0], 'participantChunk')) return;
          chunkReads += 1;
          if (when === 'after-read') cancelled = true;
          else if (chunkReads === 8)
            setTimeout(() => {
              cancelled = true;
            }, 0);
        });
        await expect(
          searchChatsForInboxPage(observed, {
            query: 'absent',
            shouldContinue: () => !cancelled,
          }),
        ).rejects.toBeInstanceOf(InboxSearchCancelledError);
        expect(chunkReads).toBe(when === 'after-read' ? 1 : 8);
      } finally {
        t.raw.close();
      }
    },
  );

  it.each(['rename', 'rollback-and-rewrite'] as const)(
    'restarts a changed name once without inventing a cross-version match after %s',
    async (change) => {
      const original = `${'x'.repeat(4094)}AB${'q'.repeat(32)}`;
      const replacement = `${'x'.repeat(4094)}zzCD${'q'.repeat(30)}`;
      const t = await largeNameFixture(
        change === 'rename' ? original : 'x'.repeat(original.length),
      );
      try {
        if (change === 'rollback-and-rewrite') {
          t.raw.exec('BEGIN');
          t.raw.prepare('UPDATE handles SET display_name = ? WHERE id = 1').run(original);
        }
        let chunkReads = 0;
        const observed = observeReads(t.db, (rows) => {
          if (!rows[0] || !Object.hasOwn(rows[0], 'participantChunk')) return;
          chunkReads += 1;
          if (chunkReads !== 1) return;
          const first = rows[0];
          if (change === 'rollback-and-rewrite') t.raw.exec('ROLLBACK');
          t.raw.prepare('UPDATE handles SET display_name = ? WHERE id = 1').run(replacement);
          const current = t.raw
            .prepare(
              'SELECT revision, total_changes() AS changes FROM inbox_search_state WHERE chat_id = 1',
            )
            .get() as { revision: number; changes: number };
          // Rollback + rewrite reuses the revision; the connection counter must still reject it.
          expect(current.revision).toBe(Number(first.revision) + (change === 'rename' ? 1 : 0));
          expect(current.changes).toBeGreaterThan(Number(first.changes));
        });
        const result = await searchChatsForInboxPage(observed, { query: 'abcd' });
        expect(result.rows).toEqual([]);
        expect(chunkReads).toBe(4); // Two discarded chunks, then two from the fresh complete name.
        expect(
          (await searchChatsForInboxPage(t.db, { query: 'zzcd' })).rows.map((row) => row.guid),
        ).toEqual(['large-name']);
      } finally {
        if (t.raw.inTransaction) t.raw.exec('ROLLBACK');
        t.raw.close();
      }
    },
  );

  it('reports repeated snapshot changes instead of looping or returning partial search results', async () => {
    const t = await largeNameFixture('x'.repeat(5000));
    try {
      let chunkReads = 0;
      const observed = observeReads(t.db, (rows) => {
        if (!rows[0] || !Object.hasOwn(rows[0], 'participantChunk')) return;
        chunkReads += 1;
        if (chunkReads % 2 === 1) {
          // Even an unrelated same-connection write conservatively invalidates this rare path.
          t.raw.prepare('UPDATE chats SET latest_message_date = ? WHERE id = 1').run(chunkReads);
        }
      });
      await expect(searchChatsForInboxPage(observed, { query: 'absent' })).rejects.toThrow(
        'Inbox search text changed while reading. Please try again.',
      );
      expect(chunkReads).toBe(4);
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
