import { drizzle } from 'drizzle-orm/better-sqlite3';
import { readFileSync } from 'node:fs';
import { MIGRATIONS } from '@db/migrations';
import {
  listChatsForInbox,
  listChatsForInboxPage,
  searchChatsForInboxPage,
} from '@db/repositories';
import { rebuildInboxSearchIndexBatch } from '@db/repositories/inboxSearchIndex';
import type { AppDatabase } from '@db/types';
import { createTestDb } from '../support/testDb';

const CHAT_COUNTS = [1_000, 10_000] as const;
const MESSAGES_PER_CHAT = 4;
const WARM_SAMPLES = 5;
const ACTIVE_PERCENT = 95;
const WARM_PAGE_BUDGET_MS = 16;
const benchmark = process.env.GATOR_INBOX_BENCHMARK === '1' ? test : test.skip;

interface CompiledQuery {
  sql: string;
  params: unknown[];
}

interface QueryMeasurement {
  firstRunMs: number;
  warmMs: {
    median: number;
    min: number;
    max: number;
    samples: number[];
  };
  rssPeakDeltaMiB: number;
}

type TestDatabase = Awaited<ReturnType<typeof createTestDb>>;

function round(value: number): number {
  return Number(value.toFixed(3));
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function collectGarbage(): void {
  if (typeof global.gc !== 'function') {
    throw new Error('The inbox benchmark requires --expose-gc; run npm run benchmark:inbox.');
  }
  global.gc();
}

function databaseBytes(raw: TestDatabase['raw']): number {
  const pages = raw.prepare('PRAGMA page_count').get() as { page_count: number };
  const size = raw.prepare('PRAGMA page_size').get() as { page_size: number };
  return pages.page_count * size.page_size;
}

function seedFixture({ raw }: TestDatabase, chatCount: number): void {
  const insertHandle = raw.prepare(
    `INSERT INTO handles (id, address, service, display_name)
     VALUES (?, ?, 'iMessage', ?)`,
  );
  const insertChat = raw.prepare(
    `INSERT INTO chats (
       id, guid, chat_identifier, display_name, style, is_archived, is_pinned,
       latest_message_date
     ) VALUES (?, ?, ?, ?, 45, ?, 0, ?)`,
  );
  const insertChatHandle = raw.prepare(
    'INSERT INTO chat_handles (chat_id, handle_id) VALUES (?, ?)',
  );
  const insertMessage = raw.prepare(
    `INSERT INTO messages (
       id, guid, original_row_id, chat_id, handle_id, text, is_from_me,
       date_created, has_attachments, error, send_state
     ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, 0, 'sent')`,
  );

  const insertAll = raw.transaction(() => {
    for (let chatId = 1; chatId <= chatCount; chatId += 1) {
      const address = `benchmark-${chatId}@example.test`;
      const chatGuid = `iMessage;-;benchmark-${chatId}`;
      const latestMessageDate = 1_700_000_000_000 + chatId * 10 + MESSAGES_PER_CHAT;
      const isArchived = chatId % 20 === 0 ? 1 : 0;

      insertHandle.run(chatId, address, `Participant ${chatId}`);
      insertChat.run(
        chatId,
        chatGuid,
        address,
        `Benchmark chat ${chatId}`,
        isArchived,
        latestMessageDate,
      );
      insertChatHandle.run(chatId, chatId);

      for (let messageOffset = 1; messageOffset <= MESSAGES_PER_CHAT; messageOffset += 1) {
        const messageId = (chatId - 1) * MESSAGES_PER_CHAT + messageOffset;
        insertMessage.run(
          messageId,
          `benchmark-message-${messageId}`,
          messageId,
          chatId,
          chatId,
          `Benchmark message ${messageOffset}`,
          1_700_000_000_000 + chatId * 10 + messageOffset,
        );
      }
    }
  });

  insertAll();
}

async function captureCompiledQuery(
  raw: TestDatabase['raw'],
  run: (db: AppDatabase) => Promise<unknown>,
): Promise<CompiledQuery> {
  let captured: CompiledQuery | undefined;
  const captureDb = drizzle(raw, {
    logger: {
      logQuery(sql, params) {
        if (captured) {
          throw new Error('Expected one SQL statement from the production inbox query.');
        }
        captured = { sql, params: [...params] };
      },
    },
  }) as unknown as AppDatabase;

  await run(captureDb);
  if (!captured) throw new Error('The production inbox query was not captured.');
  return captured;
}

async function captureSearchWork(raw: TestDatabase['raw']): Promise<{
  statementCount: number;
  candidateReadCount: number;
  candidatePlan: string[];
}> {
  const statements: CompiledQuery[] = [];
  const captureDb = drizzle(raw, {
    logger: {
      logQuery(sql, params) {
        statements.push({ sql, params: [...params] });
      },
    },
  }) as unknown as AppDatabase;
  await searchChatsForInboxPage(captureDb, { query: 'absent-search-needle', limit: 50 });
  const candidateReads = statements.filter(({ sql }) => /\bFROM chats c\b/.test(sql));
  const candidateIdQuery = statements.find(({ sql }) => /\bFROM inbox_search_postings\b/.test(sql));
  if (!candidateIdQuery) throw new Error('Inbox search candidate-id query was not captured.');
  return {
    statementCount: statements.length,
    candidateReadCount: candidateReads.length,
    candidatePlan: explainQuery(raw, candidateIdQuery),
  };
}

function explainQuery(raw: TestDatabase['raw'], query: CompiledQuery): string[] {
  if (!query.params.every((value) => typeof value === 'number' || typeof value === 'string')) {
    throw new Error('The benchmark expected only numeric/text inbox query parameters.');
  }
  const rows = raw
    .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
    .all(...(query.params as Array<number | string>)) as { detail: string }[];
  if (rows.length === 0) throw new Error('SQLite returned an empty inbox query plan.');
  return rows.map(({ detail }) => detail.replace(/\s+/g, ' ').trim());
}

async function measure<T>(
  run: () => Promise<T>,
  validate: (result: T) => void,
  rssBefore: number,
): Promise<QueryMeasurement> {
  let peakRss = rssBefore;
  const timedRun = async (): Promise<number> => {
    const started = process.hrtime.bigint();
    const result = await run();
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    validate(result);
    return elapsedMs;
  };

  const firstRunMs = await timedRun();
  const warmSamples: number[] = [];
  for (let index = 0; index < WARM_SAMPLES; index += 1) {
    warmSamples.push(await timedRun());
  }
  const rssPeakDeltaMiB = (peakRss - rssBefore) / (1024 * 1024);

  return {
    firstRunMs: round(firstRunMs),
    warmMs: {
      median: round(median(warmSamples)),
      min: round(Math.min(...warmSamples)),
      max: round(Math.max(...warmSamples)),
      samples: warmSamples.map(round),
    },
    rssPeakDeltaMiB: round(rssPeakDeltaMiB),
  };
}

async function runScale(chatCount: (typeof CHAT_COUNTS)[number]): Promise<void> {
  const fixture = await createTestDb();
  const activeChats = (chatCount * ACTIVE_PERCENT) / 100;
  try {
    seedFixture(fixture, chatCount);

    const counts = fixture.raw
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM chats) AS chats,
           (SELECT COUNT(*) FROM chats WHERE is_archived = 0) AS activeChats,
           (SELECT COUNT(*) FROM handles) AS handles,
           (SELECT COUNT(*) FROM chat_handles) AS chatHandles,
           (SELECT COUNT(*) FROM messages) AS messages,
           (SELECT COUNT(*) FROM _migrations) AS migrations`,
      )
      .get() as {
      chats: number;
      activeChats: number;
      handles: number;
      chatHandles: number;
      messages: number;
      migrations: number;
    };
    expect(counts).toEqual({
      chats: chatCount,
      activeChats,
      handles: chatCount,
      chatHandles: chatCount,
      messages: chatCount * MESSAGES_PER_CHAT,
      migrations: MIGRATIONS.length,
    });
    expect(fixture.raw.pragma('foreign_key_check')).toEqual([]);

    collectGarbage();
    const pageRssBefore = process.memoryUsage().rss;
    const page = await measure(
      () => listChatsForInboxPage(fixture.db, { limit: 50 }),
      (result) => {
        expect(result.rows).toHaveLength(50);
        expect(result.hasMore).toBe(true);
      },
      pageRssBefore,
    );

    collectGarbage();
    const fullRssBefore = process.memoryUsage().rss;
    const full = await measure(
      () => listChatsForInbox(fixture.db),
      (result) => expect(result).toHaveLength(activeChats),
      fullRssBefore,
    );

    collectGarbage();
    const searchRssBefore = process.memoryUsage().rss;
    const noMatchSearch = await measure(
      () => searchChatsForInboxPage(fixture.db, { query: 'absent-search-needle', limit: 50 }),
      (result) => expect(result).toEqual({ rows: [], hasMore: false }),
      searchRssBefore,
    );
    const searchWork = await captureSearchWork(fixture.raw);

    const pageQuery = await captureCompiledQuery(fixture.raw, (db) =>
      listChatsForInboxPage(db, { limit: 50 }),
    );
    const fullQuery = await captureCompiledQuery(fixture.raw, (db) => listChatsForInbox(db));
    const pagePlan = explainQuery(fixture.raw, pageQuery);
    const fullPlan = explainQuery(fixture.raw, fullQuery);

    // Backfill the actual production postings in bounded batches. The dirty-baseline query above
    // remains exact while this runs; the second measurement is a caught-up index, not a probe.
    const bytesBeforeIndex = databaseBytes(fixture.raw);
    const buildStarted = process.hrtime.bigint();
    let afterChatId = 0;
    let indexedChats = 0;
    while (true) {
      const batch = await rebuildInboxSearchIndexBatch(fixture.db, afterChatId);
      if (batch.visited === 0) {
        if (afterChatId === 0) break;
        afterChatId = 0;
        continue;
      }
      afterChatId = batch.lastChatId;
      indexedChats += batch.settled;
    }
    expect(indexedChats).toBe(chatCount);
    const indexBuildMs = round(Number(process.hrtime.bigint() - buildStarted) / 1_000_000);
    const indexStorageDeltaMiB = round(
      (databaseBytes(fixture.raw) - bytesBeforeIndex) / (1024 * 1024),
    );
    collectGarbage();
    const indexedSearchRssBefore = process.memoryUsage().rss;
    const indexedNoMatchSearch = await measure(
      () => searchChatsForInboxPage(fixture.db, { query: 'absent-search-needle', limit: 50 }),
      (result) => expect(result).toEqual({ rows: [], hasMore: false }),
      indexedSearchRssBefore,
    );
    const indexedSearchWork = await captureSearchWork(fixture.raw);

    const sqliteVersion = (
      fixture.raw.prepare('SELECT sqlite_version() AS version').get() as { version: string }
    ).version;
    const report = {
      artifact: 'PERF-01-PERF-02-host-inbox',
      schemaVersion: 3,
      environment: {
        node: process.version,
        sqlite: sqliteVersion,
        migrationCount: MIGRATIONS.length,
        migrationHead: MIGRATIONS.at(-1)?.name ?? null,
      },
      fixture: {
        chats: chatCount,
        activeChats,
        archivedChats: chatCount - activeChats,
        handles: chatCount,
        chatHandles: chatCount,
        messages: chatCount * MESSAGES_PER_CHAT,
        messagesPerChat: MESSAGES_PER_CHAT,
      },
      page: {
        rows: 50,
        hasMore: true,
        warmBudgetMs: WARM_PAGE_BUDGET_MS,
        withinWarmBudget: page.warmMs.median <= WARM_PAGE_BUDGET_MS,
        ...page,
        plan: pagePlan,
      },
      full: { rows: activeChats, ...full, plan: fullPlan },
      noMatchSearch: { rows: 0, hasMore: false, ...noMatchSearch, ...searchWork },
      indexedNoMatchSearch: {
        index: 'inbox_search_postings (gram, chat_id)',
        indexedChats,
        indexBuildMs,
        indexStorageDeltaMiB,
        rows: 0,
        hasMore: false,
        ...indexedNoMatchSearch,
        ...indexedSearchWork,
      },
    };
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    fixture.raw.close();
  }
}

benchmark(
  'reproduces the 1k and 10k production inbox-query baseline',
  async () => {
    const expectedNode = readFileSync('.nvmrc', 'utf8').trim();
    expect(process.version).toBe(`v${expectedNode}`);
    for (const chatCount of CHAT_COUNTS) await runScale(chatCount);
  },
  300_000,
);
