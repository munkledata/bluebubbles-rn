/**
 * Real-DB ownership coverage for the search-text maintenance pass.
 *
 * The ordinary service suite deliberately mocks the transaction wrapper. These cases use the
 * real process-wide queue and one SQLite connection so an uncommitted neighbouring write is
 * observable in exactly the same way as it is through op-sqlite's shared handle.
 */
const mockGetDatabase = jest.fn();
const mockGetRawDatabase = jest.fn();

jest.mock('@db/database', () => ({
  getDatabase: (...args: unknown[]) => mockGetDatabase(...args) as unknown,
  getRawDatabase: (...args: unknown[]) => mockGetRawDatabase(...args) as unknown,
  initDatabase: jest.fn(),
}));
jest.mock('@db/key', () => ({ resolveDbKey: jest.fn(), rotateDbKey: jest.fn() }));
jest.mock('@/services/clients', () => ({ vault: { __vault: true } }));

import type Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { kvGet } from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { runSearchTextBackfillOnce } from '@/services/databaseControl';
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
import { createTestDb } from '../support/testDb';

const SEARCH_BACKFILL_FLAG = 'maintenance.searchTextBackfill.v1';

type ExecuteKind = 'page' | 'update' | 'trailing' | 'other';

interface ExecuteResult {
  rows: Array<Record<string, unknown>>;
  rowsAffected: number;
}

interface RawAdapterHooks {
  before?: (kind: ExecuteKind, params: unknown[]) => void | Promise<void>;
  after?: (kind: ExecuteKind, params: unknown[], result: ExecuteResult) => void | Promise<void>;
  failed?: (kind: ExecuteKind, error: unknown) => void;
}

function executeKind(statement: string): ExecuteKind {
  if (statement.includes('SELECT id, attributed_body AS ab')) return 'page';
  if (statement.includes('UPDATE messages') && statement.includes('SET text = CASE')) {
    return 'update';
  }
  if (statement.includes('SELECT id') && statement.includes('LIMIT 1')) return 'trailing';
  return 'other';
}

function rawAdapter(raw: Database.Database, hooks: RawAdapterHooks = {}) {
  return {
    async execute(statement: string, params: unknown[] = []): Promise<ExecuteResult> {
      const kind = executeKind(statement);
      await hooks.before?.(kind, params);
      try {
        const prepared = raw.prepare(statement);
        const result: ExecuteResult = prepared.reader
          ? { rows: prepared.all(...params) as Array<Record<string, unknown>>, rowsAffected: 0 }
          : { rows: [], rowsAffected: prepared.run(...params).changes };
        await hooks.after?.(kind, params, result);
        return result;
      } catch (error) {
        hooks.failed?.(kind, error);
        throw error;
      }
    },
  };
}

function countSqlValues(chunk: unknown): number {
  if (chunk && typeof chunk === 'object') {
    const queryChunks = (chunk as { queryChunks?: unknown[] }).queryChunks;
    if (Array.isArray(queryChunks)) {
      return queryChunks.reduce<number>((total, nested) => total + countSqlValues(nested), 0);
    }
    return 0;
  }
  return typeof chunk === 'number' || typeof chunk === 'string' ? 1 : 0;
}

function sqlText(chunk: unknown): string {
  if (!chunk || typeof chunk !== 'object') return '';
  const queryChunks = (chunk as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(queryChunks)) return queryChunks.map(sqlText).join('');
  const value = (chunk as { value?: unknown }).value;
  return Array.isArray(value)
    ? value.filter((part): part is string => typeof part === 'string').join('')
    : '';
}

/** Observe the context-owned Drizzle UPDATE while preserving the real database implementation. */
function transactionDbAdapter(db: AppDatabase, hooks: RawAdapterHooks): AppDatabase {
  return new Proxy(db as object, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property === 'all' && typeof value === 'function') {
        return async (query: unknown): Promise<Array<Record<string, unknown>>> => {
          const statement = sqlText(query);
          if (!statement.includes('UPDATE messages') || !statement.includes('SET text = CASE')) {
            return value.call(target, query) as Promise<Array<Record<string, unknown>>>;
          }
          const params = Array.from({ length: countSqlValues(query) });
          await hooks.before?.('update', params);
          try {
            const rows = (await value.call(target, query)) as Array<Record<string, unknown>>;
            const result = { rows, rowsAffected: rows.length };
            await hooks.after?.('update', params, result);
            return rows;
          } catch (error) {
            hooks.failed?.('update', error);
            throw error;
          }
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as AppDatabase;
}

function attributedBody(text: string): string {
  return JSON.stringify([{ string: text, runs: [] }]);
}

function seedLegacyMessages(
  raw: Database.Database,
  bodies: string[],
): Array<{ id: number; text: string }> {
  const chat = raw.prepare(`INSERT INTO chats (guid) VALUES ('search-owner-chat')`).run();
  const chatId = Number(chat.lastInsertRowid);
  const insert = raw.prepare(
    `INSERT INTO messages (guid, chat_id, text, attributed_body, date_created)
     VALUES (?, ?, '', ?, ?)`,
  );
  return bodies.map((body, index) => {
    const info = insert.run(`search-owner-${index + 1}`, chatId, attributedBody(body), index + 1);
    return { id: Number(info.lastInsertRowid), text: body };
  });
}

function storedText(raw: Database.Database, id: number): string | null {
  return (
    (
      raw.prepare('SELECT text FROM messages WHERE id = ?').get(id) as
        { text: string | null } | undefined
    )?.text ?? null
  );
}

function allStoredText(raw: Database.Database): Array<{ id: number; text: string | null }> {
  return raw.prepare('SELECT id, text FROM messages ORDER BY id ASC').all() as Array<{
    id: number;
    text: string | null;
  }>;
}

type Outcome<T> = { kind: 'fulfilled'; value: T } | { kind: 'rejected'; error: unknown };

function observe<T>(promise: Promise<T>): { outcome: Promise<Outcome<T>>; settled: () => boolean } {
  let didSettle = false;
  const outcome = promise.then<Outcome<T>, Outcome<T>>(
    (value) => ({ kind: 'fulfilled', value }),
    (error: unknown) => ({ kind: 'rejected', error }),
  );
  void outcome.then(() => {
    didSettle = true;
  });
  return { outcome, settled: () => didSettle };
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${description}`);
}

function errorMessages(error: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const record = current as { message?: unknown; cause?: unknown };
    if (typeof record.message === 'string') messages.push(record.message);
    current = record.cause;
  }
  return messages;
}

let previousDev: boolean | undefined;

beforeEach(() => {
  previousDev = (globalThis as { __DEV__?: boolean }).__DEV__;
  (globalThis as { __DEV__?: boolean }).__DEV__ = true;
  resumeRealtimeDeliveries();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  mockGetDatabase.mockReset();
  mockGetRawDatabase.mockReset();
});

afterEach(async () => {
  await pauseRealtimeDeliveries();
  resumeRealtimeDeliveries();
  (globalThis as { __DEV__?: boolean }).__DEV__ = previousDev;
  jest.restoreAllMocks();
});

describe('runSearchTextBackfillOnce — real transaction owner', () => {
  it('revalidates a dirty page after its neighbour rolls back, so no earlier row is skipped', async () => {
    const { db, raw } = await createTestDb();
    const fixtures = seedLegacyMessages(
      raw,
      Array.from({ length: 51 }, (_, index) => `legacy body ${index + 1}`),
    );
    const temporarilyHidden = fixtures[24]!;
    const makeUndecodable = raw.prepare('UPDATE messages SET attributed_body = ? WHERE id = ?');
    for (const fixture of fixtures) {
      if (fixture.id !== temporarilyHidden.id) makeUndecodable.run('{malformed json', fixture.id);
    }
    const updateBatchSizes: number[] = [];
    let firstPageRows: Array<Record<string, unknown>> | undefined;
    let firstPageDidStart = false;
    let pageReads = 0;
    mockGetDatabase.mockReturnValue(
      transactionDbAdapter(db, {
        after: (kind, params) => {
          if (kind === 'update') updateBatchSizes.push(params.length / 5);
        },
      }),
    );
    mockGetRawDatabase.mockReturnValue(
      rawAdapter(raw, {
        after: (kind, params, result) => {
          if (kind === 'page') {
            pageReads += 1;
            if (pageReads === 1) {
              firstPageRows = result.rows;
              firstPageDidStart = true;
            }
          }
        },
      }),
    );

    let signalNeighbourStarted!: () => void;
    const neighbourStarted = new Promise<void>((resolve) => {
      signalNeighbourStarted = resolve;
    });
    let releaseNeighbour!: () => void;
    const neighbourHeld = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const neighbour = observe(
      withDbTransaction(db, async () => {
        raw
          .prepare('UPDATE messages SET text = ? WHERE id = ?')
          .run('temporary neighbour text', temporarilyHidden.id);
        signalNeighbourStarted();
        await neighbourHeld;
        throw new Error('search backfill neighbour rollback');
      }),
    );
    let backfill: ReturnType<typeof observe<void>> | undefined;
    let observationError: unknown;

    try {
      await neighbourStarted;
      backfill = observe(runSearchTextBackfillOnce(captureRealtimeDeliveryLease()));
      await waitFor(() => firstPageDidStart, 'the dirty preliminary page');
      expect(firstPageRows).toHaveLength(50);
      expect(firstPageRows?.some((row) => row.id === temporarilyHidden.id)).toBe(false);
      expect(firstPageRows?.at(-1)?.id).toBe(fixtures.at(-1)?.id);
      expect(pageReads).toBe(1);
      expect(backfill.settled()).toBe(false);
      expect(storedText(raw, temporarilyHidden.id)).toBe('temporary neighbour text');
      expect(await kvGet(db, SEARCH_BACKFILL_FLAG)).toBeNull();
    } catch (error) {
      observationError = error;
    } finally {
      releaseNeighbour();
    }

    try {
      const [neighbourResult, backfillResult] = await Promise.all([
        neighbour.outcome,
        backfill?.outcome ?? Promise.resolve({ kind: 'fulfilled', value: undefined } as const),
      ]);
      if (observationError) throw observationError;
      expect(neighbourResult.kind).toBe('rejected');
      if (neighbourResult.kind === 'rejected') {
        expect(errorMessages(neighbourResult.error)).toContain(
          'search backfill neighbour rollback',
        );
      }
      expect(backfillResult.kind).toBe('fulfilled');
      // The dirty preliminary page contained only undecodable rows. Revalidation must therefore
      // happen even when there is no UPDATE to issue; otherwise the sole decodable row is skipped.
      expect(updateBatchSizes).toEqual([1]);
      expect(allStoredText(raw)).toEqual(
        fixtures.map((fixture) => ({
          id: fixture.id,
          text: fixture.id === temporarilyHidden.id ? fixture.text : '',
        })),
      );
      expect(await kvGet(db, SEARCH_BACKFILL_FLAG)).toBe('done');
      expect(raw.inTransaction).toBe(false);
    } finally {
      releaseNeighbour();
      await Promise.allSettled([neighbour.outcome, ...(backfill ? [backfill.outcome] : [])]);
      raw.close();
    }
  });

  it('awaits the real update, rolls its failure back, releases the queue, and retries', async () => {
    const { db, raw } = await createTestDb();
    const fixtures = seedLegacyMessages(raw, ['first legacy body', 'second legacy body']);
    const target = fixtures[1]!;
    let updateDidFinish = false;
    let releaseUpdate!: () => void;
    const updateHeld = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    let updateGateConsumed = false;
    mockGetDatabase.mockReturnValue(
      transactionDbAdapter(db, {
        before: (kind) => {
          if (kind !== 'update' || updateGateConsumed) return;
          updateGateConsumed = true;
          // Change one compared source after the guarded page re-read but before the CASE update.
          // RETURNING reports 1/2 rows, so the owner rejects and rolls both that partial text write
          // and this same-transaction body mutation back.
          raw
            .prepare('UPDATE messages SET attributed_body = ? WHERE id = ?')
            .run(attributedBody('changed inside owner'), target.id);
        },
        after: async (kind) => {
          if (kind !== 'update' || updateDidFinish) return;
          updateDidFinish = true;
          await updateHeld;
        },
      }),
    );
    mockGetRawDatabase.mockReturnValue(rawAdapter(raw));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const backfill = observe(runSearchTextBackfillOnce(captureRealtimeDeliveryLease()));
    let successorStarted = false;
    let successor: ReturnType<typeof observe<void>> | undefined;
    let observationError: unknown;

    try {
      await waitFor(() => updateDidFinish, 'the partial guarded update');
      successor = observe(
        withDbTransaction(db, async () => {
          successorStarted = true;
          await db.run(sql`INSERT INTO kv (key, value) VALUES ('search.owner.successor', 'ok')`);
        }),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(raw.inTransaction).toBe(true);
      expect(backfill.settled()).toBe(false);
      expect(successorStarted).toBe(false);
      expect(allStoredText(raw).map((row) => row.text)).toEqual(['first legacy body', '']);
      expect(
        (
          raw
            .prepare('SELECT attributed_body AS body FROM messages WHERE id = ?')
            .get(target.id) as { body: string } | undefined
        )?.body,
      ).toBe(attributedBody('changed inside owner'));
      expect(await kvGet(db, SEARCH_BACKFILL_FLAG)).toBeNull();
    } catch (error) {
      observationError = error;
    } finally {
      releaseUpdate();
    }

    try {
      const [backfillResult, successorResult] = await Promise.all([
        backfill.outcome,
        successor?.outcome ?? Promise.resolve({ kind: 'fulfilled', value: undefined } as const),
      ]);
      if (observationError) throw observationError;
      expect(backfillResult.kind).toBe('fulfilled');
      expect(successorResult.kind).toBe('fulfilled');
      expect(allStoredText(raw).map((row) => row.text)).toEqual(['', '']);
      expect(
        (
          raw
            .prepare('SELECT attributed_body AS body FROM messages WHERE id = ?')
            .get(target.id) as { body: string } | undefined
        )?.body,
      ).toBe(attributedBody(target.text));
      expect(await kvGet(db, SEARCH_BACKFILL_FLAG)).toBeNull();
      expect(await kvGet(db, 'search.owner.successor')).toBe('ok');
      expect(raw.inTransaction).toBe(false);

      await Promise.resolve();
      await runSearchTextBackfillOnce(captureRealtimeDeliveryLease());
      expect(allStoredText(raw)).toEqual(
        fixtures.map((fixture) => ({ id: fixture.id, text: fixture.text })),
      );
      expect(await kvGet(db, SEARCH_BACKFILL_FLAG)).toBe('done');
      expect(warn).toHaveBeenCalledWith(
        '[search] search-text backfill skipped',
        expect.objectContaining({
          message: 'search-text source changed before its guarded update',
        }),
      );
    } finally {
      releaseUpdate();
      await Promise.allSettled([backfill.outcome, ...(successor ? [successor.outcome] : [])]);
      warn.mockRestore();
      raw.close();
    }
  });

  it('rejects a queued stale lease before BEGIN, then lets a fresh lease repair the row', async () => {
    const { db, raw } = await createTestDb();
    const fixtures = seedLegacyMessages(raw, ['revoked legacy body']);
    let firstPageDidStart = false;
    let pageReads = 0;
    mockGetDatabase.mockReturnValue(db);
    mockGetRawDatabase.mockReturnValue(
      rawAdapter(raw, {
        after: (kind) => {
          if (kind !== 'page') return;
          pageReads += 1;
          if (pageReads === 1) firstPageDidStart = true;
        },
      }),
    );

    let signalNeighbourStarted!: () => void;
    const neighbourStarted = new Promise<void>((resolve) => {
      signalNeighbourStarted = resolve;
    });
    let releaseNeighbour!: () => void;
    const neighbourHeld = new Promise<void>((resolve) => {
      releaseNeighbour = resolve;
    });
    const neighbour = observe(
      withDbTransaction(db, async () => {
        await db.run(sql`INSERT INTO kv (key, value) VALUES ('search.owner.revoked', 'phantom')`);
        signalNeighbourStarted();
        await neighbourHeld;
        throw new Error('search revoked neighbour rollback');
      }),
    );
    let backfill: ReturnType<typeof observe<void>> | undefined;
    let pause: ReturnType<typeof observe<void>> | undefined;
    let observationError: unknown;

    try {
      await neighbourStarted;
      backfill = observe(runSearchTextBackfillOnce(captureRealtimeDeliveryLease()));
      await waitFor(() => firstPageDidStart, 'the revoked preliminary page');
      await new Promise<void>((resolve) => setImmediate(resolve));
      pause = observe(pauseRealtimeDeliveries());
      await Promise.resolve();
      expect(pause.settled()).toBe(false);
      expect(backfill.settled()).toBe(false);
      expect(pageReads).toBe(1);
      expect(storedText(raw, fixtures[0]!.id)).toBe('');
      expect(await kvGet(db, SEARCH_BACKFILL_FLAG)).toBeNull();
    } catch (error) {
      observationError = error;
    } finally {
      releaseNeighbour();
    }

    try {
      const [neighbourResult, backfillResult, pauseResult] = await Promise.all([
        neighbour.outcome,
        backfill?.outcome ?? Promise.resolve({ kind: 'fulfilled', value: undefined } as const),
        pause?.outcome ?? Promise.resolve({ kind: 'fulfilled', value: undefined } as const),
      ]);
      if (observationError) throw observationError;
      expect(neighbourResult.kind).toBe('rejected');
      expect(backfillResult.kind).toBe('fulfilled');
      expect(pauseResult.kind).toBe('fulfilled');
      expect(pageReads).toBe(1);
      expect(storedText(raw, fixtures[0]!.id)).toBe('');
      expect(await kvGet(db, SEARCH_BACKFILL_FLAG)).toBeNull();
      expect(await kvGet(db, 'search.owner.revoked')).toBeNull();
      expect(raw.inTransaction).toBe(false);

      resumeRealtimeDeliveries();
      await runSearchTextBackfillOnce(captureRealtimeDeliveryLease());
      expect(storedText(raw, fixtures[0]!.id)).toBe(fixtures[0]!.text);
      expect(await kvGet(db, SEARCH_BACKFILL_FLAG)).toBe('done');
    } finally {
      releaseNeighbour();
      await Promise.allSettled([
        neighbour.outcome,
        ...(backfill ? [backfill.outcome] : []),
        ...(pause ? [pause.outcome] : []),
      ]);
      raw.close();
    }
  });
});
