import type { InboxFilters } from '@core/models';
import {
  closeThrowawayDatabase,
  deleteThrowawayDatabase,
  migrateThrowawayDatabase,
  openThrowawayDatabase,
  throwawayDrizzle,
} from '../database';
import {
  bumpDeviceInboxBenchmarkFixture,
  runDeviceInboxBenchmarkFixture,
  seedDeviceInboxBenchmarkFixture,
  type DeviceInboxBenchmarkResult,
  type DeviceInboxQueryPlanCapture,
} from '../performance/deviceInboxBenchmark';
import {
  countChatsForInbox,
  listChatsForInboxPage,
  type InboxArchiveFilter,
  type InboxRow,
  type InboxSenderFilter,
} from '../repositories/chatQueries';
import type { AppDatabase } from '../types';

/**
 * DEV-only PERF-01/PERF-02 inbox fixtures (moved out of database.ts in P6.5 stage 1). Every database
 * they touch is a fixed, disposable file reached only through the throwaway-database doorway in
 * database.ts, which refuses the real account database; no native driver, runner or adapter is
 * imported here.
 */

/** The rows of a native result (the same shape rules as database.ts's private extractRows). */
function rowsOf(res: unknown): Array<Record<string, unknown>> {
  const r = res as { rows?: unknown };
  if (Array.isArray(r?.rows)) return r.rows as Array<Record<string, unknown>>;
  const legacy = (r?.rows as { _array?: unknown })?._array;
  if (Array.isArray(legacy)) return legacy as Array<Record<string, unknown>>;
  return [];
}

const PERF02_BENCHMARK_DB_NAME = 'perf02-inbox-benchmark.db';
const PERF02_BENCHMARK_KEY = 'perf02-public-throwaway-key-v1';
let perf02BenchmarkRunning = false;

/** No raw driver or Drizzle handle crosses this DEV-only fixture boundary. */
export interface Perf02RenderFixtureSource {
  readonly key: string;
  readonly query: (request: {
    limit: number | null;
    archive: InboxArchiveFilter;
    sender: InboxSenderFilter;
    filters: InboxFilters;
    countUnknown: boolean;
  }) => Promise<{ rows: InboxRow[]; hasMore: boolean; unknownCount: number }>;
  readonly subscribe: (tables: readonly string[], onChange: () => void) => () => void;
  readonly bump: (revision: number) => Promise<void>;
}

function deletePerf02BenchmarkDatabase(): void {
  deleteThrowawayDatabase(PERF02_BENCHMARK_DB_NAME);
}

/**
 * Run the production inbox queries against an encrypted, disposable Android database.
 * This fixed-purpose DEV path never publishes its handle as the production singleton.
 */
export async function runPerf02DeviceInboxBenchmark(
  onFixtureReady?: (source: Perf02RenderFixtureSource, chats: 1_000 | 10_000) => Promise<void>,
  signal?: AbortSignal,
): Promise<DeviceInboxBenchmarkResult[]> {
  if (!__DEV__) throw new Error('PERF-02 benchmark is development-only.');
  if (perf02BenchmarkRunning) throw new Error('PERF-02 benchmark is already running.');
  perf02BenchmarkRunning = true;
  try {
    const results: DeviceInboxBenchmarkResult[] = [];
    for (const chatCount of [1_000, 10_000] as const) {
      if (signal?.aborted) throw new Error('PERF-02 benchmark was cancelled.');
      deletePerf02BenchmarkDatabase();
      const opened = openThrowawayDatabase(PERF02_BENCHMARK_DB_NAME, PERF02_BENCHMARK_KEY, false);
      const inFlight = new Set<Promise<unknown>>();
      const listeners = new Set<() => void>();
      let nativeUnsubscribe: (() => void) | undefined;
      let fixtureActive = true;
      const track = <T>(run: () => Promise<T>): Promise<T> => {
        if (!fixtureActive) return Promise.reject(new Error('PERF-02 fixture is closed.'));
        const task = run();
        inFlight.add(task);
        void task.then(
          () => inFlight.delete(task),
          () => inFlight.delete(task),
        );
        return task;
      };
      try {
        await opened.execute('PRAGMA foreign_keys = ON');
        await migrateThrowawayDatabase(opened);
        let capturedPlanQueries: Array<{ statement: string; params: unknown[] }> | null = null;
        const database = throwawayDrizzle(opened, {
          logQuery(statement, params) {
            capturedPlanQueries?.push({ statement, params: [...params] });
          },
        });
        const capturePlan: DeviceInboxQueryPlanCapture = async <T>(run: () => Promise<T>) => {
          if (capturedPlanQueries) {
            throw new Error('PERF-02 query-plan capture overlapped another capture.');
          }
          const captured: Array<{ statement: string; params: unknown[] }> = [];
          capturedPlanQueries = captured;
          let result: T;
          try {
            result = await run();
          } finally {
            capturedPlanQueries = null;
          }
          if (captured.length !== 1) {
            throw new Error('PERF-02 query-plan capture expected exactly one statement.');
          }
          const query = captured[0]!;
          const explained = rowsOf(
            await opened.execute(`EXPLAIN QUERY PLAN ${query.statement}`, query.params as never[]),
          );
          const plan = explained.map((row) =>
            String(row.detail ?? '')
              .replace(/\s+/g, ' ')
              .trim(),
          );
          if (plan.length === 0 || plan.some((detail) => detail.length === 0)) {
            throw new Error('PERF-02 query-plan capture returned an invalid plan.');
          }
          return { result, plan };
        };
        if (onFixtureReady) {
          await seedDeviceInboxBenchmarkFixture(database, chatCount, signal);
          if (signal?.aborted) throw new Error('PERF-02 benchmark was cancelled.');
          nativeUnsubscribe = opened.reactiveExecute({
            query: 'SELECT 1',
            arguments: [],
            fireOn: ['messages', 'chats', 'chat_handles', 'handles'].map((table) => ({ table })),
            callback: () => {
              if (!fixtureActive) return;
              for (const notify of listeners) notify();
            },
          });
          const source: Perf02RenderFixtureSource = {
            key: `perf02-disposable-${chatCount}`,
            query: (request) =>
              track(async () => {
                if (
                  request.limit == null ||
                  !Number.isSafeInteger(request.limit) ||
                  request.limit < 1 ||
                  request.limit > chatCount
                ) {
                  throw new RangeError('PERF-02 fixture page limit is out of range.');
                }
                const page = await listChatsForInboxPage(database, {
                  limit: request.limit,
                  archive: request.archive,
                  sender: request.sender,
                  filters: request.filters,
                });
                const unknownCount = request.countUnknown
                  ? await countChatsForInbox(database, { archive: 'active', sender: 'unknown' })
                  : 0;
                return { ...page, unknownCount };
              }),
            subscribe: (tables, onChange) => {
              if (!fixtureActive) throw new Error('PERF-02 fixture is closed.');
              if (tables.join(',') !== 'messages,chats,chat_handles,handles') {
                throw new Error('PERF-02 fixture subscription has unexpected tables.');
              }
              listeners.add(onChange);
              let released = false;
              const release = (): void => {
                if (released) return;
                released = true;
                listeners.delete(onChange);
              };
              return release;
            },
            bump: (revision) =>
              track(() => bumpDeviceInboxBenchmarkFixture(database, chatCount, revision)),
          };
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const onAbort = (): void => rejectWait(new Error('PERF-02 benchmark was cancelled.'));
          let rejectWait: (error: Error) => void = () => undefined;
          const stopWaiting = new Promise<never>((_, reject) => {
            rejectWait = reject;
            timeout = setTimeout(
              () => reject(new Error('PERF-02 fixture display timed out.')),
              5 * 60_000,
            );
            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted) onAbort();
          });
          try {
            await Promise.race([onFixtureReady(source, chatCount), stopWaiting]);
            if (signal?.aborted) throw new Error('PERF-02 benchmark was cancelled.');
          } finally {
            if (timeout) clearTimeout(timeout);
            signal?.removeEventListener('abort', onAbort);
          }
        } else {
          results.push(await runDeviceInboxBenchmarkFixture(database, chatCount, capturePlan));
        }
      } finally {
        fixtureActive = false;
        try {
          await Promise.allSettled(inFlight);
          try {
            await opened.flushPendingReactiveQueries();
          } finally {
            listeners.clear();
            nativeUnsubscribe?.();
          }
        } finally {
          try {
            closeThrowawayDatabase(opened);
          } finally {
            deletePerf02BenchmarkDatabase();
          }
        }
      }
    }
    return results;
  } finally {
    perf02BenchmarkRunning = false;
  }
}

const PERF01_COLD_KEY = 'perf01-public-throwaway-key-v1';
let perf01ColdPreparing = false;
let perf01ColdOpen = false;

function perf01ColdName(chats: 1_000 | 10_000): 'perf01-cold-1000.db' | 'perf01-cold-10000.db' {
  if (chats === 1_000) return 'perf01-cold-1000.db';
  if (chats === 10_000) return 'perf01-cold-10000.db';
  throw new RangeError('PERF-01 cold fixture scale is invalid.');
}

/** The caller chooses the exact disposable fixture; the real account DB is never selected here. */
export function deletePerf01ColdFixture(chats: 1_000 | 10_000): void {
  if (!__DEV__) throw new Error('PERF-01 cold fixture is development-only.');
  if (perf01ColdPreparing || perf01ColdOpen) {
    throw new Error('PERF-01 cold fixture is still in use.');
  }
  deleteThrowawayDatabase(perf01ColdName(chats));
}

/** Seed once, close the handle, and retain only this fixed disposable file across process death. */
export async function preparePerf01ColdFixture(chats: 1_000 | 10_000): Promise<void> {
  if (!__DEV__) throw new Error('PERF-01 cold fixture is development-only.');
  if (perf01ColdPreparing || perf01ColdOpen || perf02BenchmarkRunning) {
    throw new Error('Another inbox fixture operation is running.');
  }
  const name = perf01ColdName(chats);
  perf01ColdPreparing = true;
  let prepared = false;
  try {
    deleteThrowawayDatabase(name);
    const opened = openThrowawayDatabase(name, PERF01_COLD_KEY, false);
    try {
      await opened.execute('PRAGMA foreign_keys = ON');
      await migrateThrowawayDatabase(opened);
      const database = throwawayDrizzle(opened);
      await seedDeviceInboxBenchmarkFixture(database, chats);
      const counts = rowsOf(
        await opened.execute(
          'SELECT (SELECT COUNT(*) FROM chats) AS chats, (SELECT COUNT(*) FROM messages) AS messages',
        ),
      );
      if (Number(counts[0]?.chats) !== chats || Number(counts[0]?.messages) !== chats * 4) {
        throw new Error('PERF-01 cold fixture row counts are invalid.');
      }
      if (rowsOf(await opened.execute('PRAGMA foreign_key_check')).length !== 0) {
        throw new Error('PERF-01 cold fixture has a foreign-key violation.');
      }
    } finally {
      closeThrowawayDatabase(opened);
    }
    prepared = true;
  } finally {
    perf01ColdPreparing = false;
    if (!prepared) deletePerf01ColdFixture(chats);
  }
}

export type Perf01ColdFixtureSource = Pick<
  Perf02RenderFixtureSource,
  'key' | 'query' | 'subscribe'
>;

export interface Perf01ColdFixtureHandle {
  readonly openedAtMs: number;
  readonly openMs: number;
  readonly source: Perf01ColdFixtureSource;
  readonly close: () => Promise<void>;
}

/** Open read-only after process restart. No validation query precedes the timed first page. */
export function openPerf01ColdFixture(chats: 1_000 | 10_000): Perf01ColdFixtureHandle {
  if (!__DEV__) throw new Error('PERF-01 cold fixture is development-only.');
  if (perf01ColdPreparing || perf01ColdOpen || perf02BenchmarkRunning) {
    throw new Error('Another inbox fixture operation is running.');
  }
  const name = perf01ColdName(chats);
  const openedAtMs = performance.now();
  const opened = openThrowawayDatabase(name, PERF01_COLD_KEY, true);
  let database: AppDatabase;
  try {
    database = throwawayDrizzle(opened);
  } catch (cause) {
    closeThrowawayDatabase(opened);
    throw cause;
  }
  const openMs = performance.now() - openedAtMs;
  perf01ColdOpen = true;
  let closed = false;
  let closing: Promise<void> | undefined;
  const inFlight = new Set<Promise<unknown>>();
  const source: Perf01ColdFixtureSource = {
    key: `perf01-cold-${chats}`,
    query: (request) => {
      if (closed) return Promise.reject(new Error('PERF-01 cold fixture is closed.'));
      if (
        request.limit !== 50 ||
        request.archive !== 'active' ||
        request.sender !== 'any' ||
        request.countUnknown
      ) {
        return Promise.reject(new Error('PERF-01 cold fixture received an unexpected query.'));
      }
      const task = listChatsForInboxPage(database, {
        limit: request.limit,
        archive: request.archive,
        sender: request.sender,
        filters: request.filters,
      }).then((page) => ({ ...page, unknownCount: 0 }));
      inFlight.add(task);
      void task.then(
        () => inFlight.delete(task),
        () => inFlight.delete(task),
      );
      return task;
    },
    subscribe: () => () => undefined,
  };
  return {
    openedAtMs,
    openMs,
    source,
    close: () => {
      if (closing) return closing;
      closed = true;
      closing = Promise.allSettled(inFlight).then(() => {
        try {
          closeThrowawayDatabase(opened);
        } finally {
          perf01ColdOpen = false;
        }
      });
      return closing;
    },
  };
}
