import { sql } from 'drizzle-orm';
import { logger } from '@core/secure';
import {
  listChatsForInbox,
  listChatsForInboxPage,
  searchChatsForInboxPage,
} from '../repositories/chatQueries';
import { rebuildInboxSearchIndexBatch } from '../repositories/inboxSearchIndex';
import { withDbTransaction } from '../transaction';
import type { AppDatabase } from '../types';

const MESSAGES_PER_CHAT = 4;
const SEED_BATCH_SIZE = 100;
const WARM_SAMPLES = 50;
const SEARCH_TERM = 'absent-search-needle';

export interface DeviceInboxTiming {
  firstMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  samples: number;
}

export interface DeviceInboxBenchmarkResult {
  chats: number;
  activeChats: number;
  messages: number;
  page: DeviceInboxTiming;
  full: DeviceInboxTiming;
  dirtySearch: DeviceInboxTiming;
  indexedSearch: DeviceInboxTiming;
  indexBuildMs: number;
  databaseMiB: number;
  indexStorageDeltaMiB: number;
  pagePlan: string[];
  fullPlan: string[];
}

export type DeviceInboxQueryPlanCapture = <T>(
  run: () => Promise<T>,
) => Promise<{ result: T; plan: string[] }>;

function round(value: number): number {
  return Number(value.toFixed(3));
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}

async function measure<T>(
  run: () => Promise<T>,
  verify: (result: T) => void,
): Promise<DeviceInboxTiming> {
  const timed = async (): Promise<number> => {
    const started = performance.now();
    verify(await run());
    return performance.now() - started;
  };
  const firstMs = await timed();
  const warm: number[] = [];
  for (let sample = 0; sample < WARM_SAMPLES; sample += 1) warm.push(await timed());
  return {
    firstMs: round(firstMs),
    medianMs: round(percentile(warm, 0.5)),
    p95Ms: round(percentile(warm, 0.95)),
    maxMs: round(Math.max(...warm)),
    samples: warm.length,
  };
}

async function databaseBytes(db: AppDatabase): Promise<number> {
  const rows = await db.all<{ bytes: number }>(sql`
    SELECT (SELECT page_count FROM pragma_page_count) *
           (SELECT page_size FROM pragma_page_size) AS bytes
  `);
  const bytes = Number(rows[0]?.bytes);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error('PERF-02 fixture could not read SQLite storage size.');
  }
  return bytes;
}

async function seedFixture(
  db: AppDatabase,
  chatCount: number,
  signal?: AbortSignal,
): Promise<void> {
  for (let firstId = 1; firstId <= chatCount; firstId += SEED_BATCH_SIZE) {
    if (signal?.aborted) throw new Error('PERF-02 benchmark was cancelled.');
    const ids = Array.from(
      { length: Math.min(SEED_BATCH_SIZE, chatCount - firstId + 1) },
      (_, offset) => firstId + offset,
    );
    const json = JSON.stringify(ids);
    await withDbTransaction(db, async () => {
      await db.run(sql`
        INSERT INTO handles (id, address, service, display_name)
        SELECT CAST(value AS INTEGER),
               'benchmark-' || value || '@example.test',
               'iMessage', 'Participant ' || value
          FROM json_each(${json})
      `);
      await db.run(sql`
        INSERT INTO chats (
          id, guid, chat_identifier, display_name, style, is_archived, is_pinned,
          latest_message_date
        )
        SELECT CAST(value AS INTEGER),
               'iMessage;-;benchmark-' || value,
               'benchmark-' || value || '@example.test',
               'Benchmark chat ' || value, 45,
               CASE WHEN CAST(value AS INTEGER) % 20 = 0 THEN 1 ELSE 0 END,
               0, 1700000000000 + CAST(value AS INTEGER) * 10 + ${MESSAGES_PER_CHAT}
          FROM json_each(${json})
      `);
      await db.run(sql`
        INSERT INTO chat_handles (chat_id, handle_id)
        SELECT CAST(value AS INTEGER), CAST(value AS INTEGER)
          FROM json_each(${json})
      `);
      await db.run(sql`
        WITH offsets(k) AS (VALUES (1), (2), (3), (4))
        INSERT INTO messages (
          id, guid, original_row_id, chat_id, handle_id, text, is_from_me,
          date_created, has_attachments, error, send_state
        )
        SELECT (CAST(item.value AS INTEGER) - 1) * ${MESSAGES_PER_CHAT} + offsets.k,
               'benchmark-message-' || ((CAST(item.value AS INTEGER) - 1) * ${MESSAGES_PER_CHAT} + offsets.k),
               (CAST(item.value AS INTEGER) - 1) * ${MESSAGES_PER_CHAT} + offsets.k,
               CAST(item.value AS INTEGER), CAST(item.value AS INTEGER),
               'Benchmark message ' || offsets.k, 0,
               1700000000000 + CAST(item.value AS INTEGER) * 10 + offsets.k,
               0, 0, 'sent'
          FROM json_each(${json}) AS item CROSS JOIN offsets
      `);
    });
  }
}

/** Seed only the fixed disposable DEV connection before the rendered-list measurement. */
export async function seedDeviceInboxBenchmarkFixture(
  db: AppDatabase,
  chatCount: 1_000 | 10_000,
  signal?: AbortSignal,
): Promise<void> {
  if (!__DEV__) throw new Error('PERF-02 fixture is development-only.');
  logger.info('[perf02] seeding disposable fixture', { chats: chatCount });
  await seedFixture(db, chatCount, signal);

  const counts = await db.all<{
    chats: number;
    activeChats: number;
    messages: number;
  }>(sql`
    SELECT (SELECT COUNT(*) FROM chats) AS chats,
           (SELECT COUNT(*) FROM chats WHERE is_archived = 0) AS activeChats,
           (SELECT COUNT(*) FROM messages) AS messages
  `);
  if (
    Number(counts[0]?.chats) !== chatCount ||
    Number(counts[0]?.activeChats) !== (chatCount * 95) / 100 ||
    Number(counts[0]?.messages) !== chatCount * MESSAGES_PER_CHAT
  ) {
    throw new Error('PERF-02 fixture row counts are wrong.');
  }
  const foreignKeyProblems = await db.all(sql`PRAGMA foreign_key_check`);
  if (foreignKeyProblems.length !== 0) throw new Error('PERF-02 fixture has invalid foreign keys.');
}

/** One bounded, fixture-only arrival that moves a distinct older active chat to the top. */
export async function bumpDeviceInboxBenchmarkFixture(
  db: AppDatabase,
  chatCount: 1_000 | 10_000,
  revision: number,
): Promise<void> {
  if (!__DEV__) throw new Error('PERF-02 fixture is development-only.');
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 100) {
    throw new RangeError('PERF-02 fixture revision is outside its bounded range.');
  }
  const messageId = chatCount * MESSAGES_PER_CHAT + revision;
  // Every twentieth fixture chat is archived; skip those so each revision is a new visible row.
  const chatId = revision + Math.floor((revision - 1) / 19);
  const date = 1_900_000_000_000 + revision;
  await withDbTransaction(db, async () => {
    await db.run(sql`
      INSERT INTO messages (
        id, guid, original_row_id, chat_id, handle_id, text, is_from_me,
        date_created, has_attachments, error, send_state
      ) VALUES (
        ${messageId}, ${`benchmark-burst-${messageId}`}, ${messageId}, ${chatId}, ${chatId},
        ${`Benchmark burst ${revision}`}, 0, ${date}, 0, 0, 'sent'
      )
    `);
    await db.run(sql`
      UPDATE chats SET latest_message_date = ${date} WHERE id = ${chatId}
    `);
  });
}

/** Only the fixed disposable SQLCipher runner in database.ts may call this. */
export async function runDeviceInboxBenchmarkFixture(
  db: AppDatabase,
  chatCount: 1_000 | 10_000,
  capturePlan: DeviceInboxQueryPlanCapture,
): Promise<DeviceInboxBenchmarkResult> {
  await seedDeviceInboxBenchmarkFixture(db, chatCount);
  const activeChats = (chatCount * 95) / 100;

  logger.info('[perf02] measuring native queries', { chats: chatCount });
  const page = await measure(
    () => listChatsForInboxPage(db, { limit: 50 }),
    (result) => {
      if (result.rows.length !== 50 || !result.hasMore) {
        throw new Error('PERF-02 inbox page did not return 50 rows and hasMore.');
      }
    },
  );
  const full = await measure(
    () => listChatsForInbox(db),
    (result) => {
      if (result.length !== activeChats) throw new Error('PERF-02 full inbox count is wrong.');
    },
  );
  const verifyEmptySearch = (result: { rows: unknown[]; hasMore: boolean }): void => {
    if (result.rows.length !== 0 || result.hasMore) {
      throw new Error('PERF-02 no-match search returned a result.');
    }
  };
  const dirtySearch = await measure(
    () => searchChatsForInboxPage(db, { query: SEARCH_TERM, limit: 50 }),
    verifyEmptySearch,
  );

  const bytesBeforeIndex = await databaseBytes(db);
  logger.info('[perf02] rebuilding disposable search index', { chats: chatCount });
  const buildStarted = performance.now();
  let afterChatId = 0;
  let indexedChats = 0;
  while (true) {
    const batch = await rebuildInboxSearchIndexBatch(db, afterChatId);
    if (batch.visited === 0) {
      if (afterChatId === 0) break;
      afterChatId = 0;
      continue;
    }
    afterChatId = batch.lastChatId;
    indexedChats += batch.settled;
  }
  if (indexedChats !== chatCount) throw new Error('PERF-02 search index is incomplete.');
  const indexBuildMs = round(performance.now() - buildStarted);
  const bytesAfterIndex = await databaseBytes(db);
  const indexedSearch = await measure(
    () => searchChatsForInboxPage(db, { query: SEARCH_TERM, limit: 50 }),
    verifyEmptySearch,
  );
  // Preserve `firstMs` as the first execution after seeding. Plans are captured only after every
  // timing sample, using the exact production query and bindings on the same native connection.
  const capturedPage = await capturePlan(() => listChatsForInboxPage(db, { limit: 50 }));
  if (capturedPage.result.rows.length !== 50 || !capturedPage.result.hasMore) {
    throw new Error('PERF-02 planned inbox page did not return 50 rows and hasMore.');
  }
  const capturedFull = await capturePlan(() => listChatsForInbox(db));
  if (capturedFull.result.length !== activeChats) {
    throw new Error('PERF-02 planned full inbox count is wrong.');
  }
  const result: DeviceInboxBenchmarkResult = {
    chats: chatCount,
    activeChats,
    messages: chatCount * MESSAGES_PER_CHAT,
    page,
    full,
    dirtySearch,
    indexedSearch,
    indexBuildMs,
    databaseMiB: round(bytesAfterIndex / 1024 / 1024),
    indexStorageDeltaMiB: round((bytesAfterIndex - bytesBeforeIndex) / 1024 / 1024),
    pagePlan: capturedPage.plan,
    fullPlan: capturedFull.plan,
  };
  logger.info('[perf02] inbox query result', {
    chats: chatCount,
    page,
    full,
  });
  for (const [shape, plan] of [
    ['page', result.pagePlan],
    ['full', result.fullPlan],
  ] as const) {
    plan.forEach((detail, step) => {
      // Keep each native plan step short enough for lossless Android logcat evidence.
      logger.info('[perf02] inbox query plan step', { chats: chatCount, shape, step, detail });
    });
  }
  logger.info('[perf02] search and storage result', {
    chats: chatCount,
    dirtySearch,
    indexedSearch,
    indexBuildMs,
    databaseMiB: result.databaseMiB,
    indexStorageDeltaMiB: result.indexStorageDeltaMiB,
  });
  return result;
}
