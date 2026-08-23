/**
 * Search maintenance is account-scoped DB work. These tests prove it commits in bounded pages,
 * participates in Disconnect's drain, and never records completion for a revoked generation.
 */
const mockGetDatabase = jest.fn();
const mockGetRawDatabase = jest.fn();
const mockKvGet = jest.fn();
const mockKvSet = jest.fn();
const mockKvSetWithinTransaction = jest.fn();
const mockPlainText = jest.fn();
let mockJoinedChangedRows: ((attempted: number) => number) | undefined;
let mockJoinedOnUpdate: (() => void | Promise<void>) | undefined;

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

const mockJoinedDbAll = jest.fn(async (query: unknown) => {
  const attempted = countSqlValues(query) / 5;
  const changed = mockJoinedChangedRows?.(attempted) ?? attempted;
  await mockJoinedOnUpdate?.();
  return Array.from({ length: changed }, (_, index) => ({ id: index + 1 }));
});

type CommitGuard = () => boolean;
const mockTransactionContext = Object.freeze({ __transactionContext: true });
type TransactionTask = (context: unknown) => Promise<unknown>;
type ContextTask = (db: unknown) => Promise<unknown>;
const mockRunInTransactionContext = jest.fn(
  async (context: unknown, task: ContextTask): Promise<unknown> => {
    if (context !== mockTransactionContext) throw new Error('unexpected transaction context');
    return task({ all: mockJoinedDbAll });
  },
);
const mockWithDbTransaction = jest.fn(
  async (_db: unknown, task: TransactionTask, guard?: CommitGuard): Promise<unknown> => {
    if (guard && !guard()) throw new Error('database commit guard rejected the transaction');
    const result = await task(mockTransactionContext);
    if (guard && !guard()) throw new Error('database commit guard rejected the transaction');
    return result;
  },
);

jest.mock('@db/database', () => ({
  getDatabase: (...a: unknown[]) => mockGetDatabase(...a) as unknown,
  getRawDatabase: (...a: unknown[]) => mockGetRawDatabase(...a) as unknown,
  initDatabase: jest.fn(),
}));
jest.mock('@db/key', () => ({ resolveDbKey: jest.fn(), rotateDbKey: jest.fn() }));
jest.mock('@db/repositories', () => ({
  kvGet: (...a: unknown[]) => mockKvGet(...a) as unknown,
  kvSet: (...a: unknown[]) => mockKvSet(...a) as unknown,
  kvSetWithinTransaction: (...a: unknown[]) => mockKvSetWithinTransaction(...a) as unknown,
}));
jest.mock('@db/transaction', () => ({
  runInTransactionContext: (...a: unknown[]) =>
    mockRunInTransactionContext(...(a as [unknown, ContextTask])),
  withDbTransaction: (...a: unknown[]) =>
    mockWithDbTransaction(...(a as [unknown, TransactionTask, CommitGuard?])),
}));
jest.mock('@core/richtext', () => ({
  plainTextFromAttributedBody: (...a: unknown[]) => mockPlainText(...a) as unknown,
}));
jest.mock('@/services/clients', () => ({ vault: { __vault: true } }));

// Mock registration must precede these service imports.
// eslint-disable-next-line import/first
import { runSearchTextBackfillOnce } from '@/services/databaseControl';
// eslint-disable-next-line import/first
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

const DB = { __handle: 'db' };
let previousDev: boolean | undefined;

interface BackfillRow {
  id: number;
  ab: string;
}

interface FakeRaw {
  execute: jest.Mock;
}

interface FakeRawOptions {
  changedRows?: (attempted: number) => number;
  onUpdate?: () => void | Promise<void>;
  onTrailingCheck?: (afterId: number) => BackfillRow[];
}

function makeRaw(pending: BackfillRow[], options: FakeRawOptions = {}): FakeRaw {
  mockJoinedChangedRows = options.changedRows;
  mockJoinedOnUpdate = options.onUpdate;
  return {
    execute: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('SELECT id, attributed_body')) {
        const afterId = Number(params[0] ?? 0);
        const limit = Number(params[1] ?? 50);
        return { rows: pending.filter((row) => row.id > afterId).slice(0, limit) };
      }
      if (sql.includes('SELECT id') && sql.includes('LIMIT 1')) {
        const afterId = Number(params[0] ?? 0);
        return { rows: options.onTrailingCheck?.(afterId) ?? [] };
      }
      return { rows: [] };
    }),
  };
}

beforeEach(() => {
  previousDev = (globalThis as { __DEV__?: boolean }).__DEV__;
  (globalThis as { __DEV__?: boolean }).__DEV__ = true;
  resumeRealtimeDeliveries();
  mockGetDatabase.mockReset().mockReturnValue(DB);
  mockGetRawDatabase.mockReset();
  mockKvGet.mockReset().mockResolvedValue(null);
  mockKvSet.mockReset().mockResolvedValue(undefined);
  mockKvSetWithinTransaction.mockReset().mockResolvedValue(undefined);
  mockPlainText.mockReset().mockImplementation((ab: unknown) => `decoded:${String(ab)}`);
  mockJoinedChangedRows = undefined;
  mockJoinedOnUpdate = undefined;
  mockJoinedDbAll.mockClear();
  mockRunInTransactionContext.mockClear();
  mockWithDbTransaction.mockClear();
});

afterEach(async () => {
  (globalThis as { __DEV__?: boolean }).__DEV__ = previousDev;
  await pauseRealtimeDeliveries();
  resumeRealtimeDeliveries();
  jest.restoreAllMocks();
});

describe('runSearchTextBackfillOnce', () => {
  it('writes one guarded batch and flags completion after a terminal check', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const raw = makeRaw([
      { id: 1, ab: 'a' },
      { id: 2, ab: 'b' },
    ]);
    mockGetRawDatabase.mockReturnValue(raw);

    await runSearchTextBackfillOnce(captureRealtimeDeliveryLease());

    expect(mockJoinedDbAll).toHaveBeenCalledTimes(1);
    expect(countSqlValues(mockJoinedDbAll.mock.calls[0]?.[0])).toBe(10);
    expect(raw.execute).not.toHaveBeenCalledWith(expect.stringContaining('SELECT changes()'));
    expect(mockWithDbTransaction).toHaveBeenCalledTimes(2);
    expect(mockRunInTransactionContext).toHaveBeenCalledTimes(1);
    expect(mockKvSet).not.toHaveBeenCalled();
    expect(mockKvSetWithinTransaction).toHaveBeenCalledWith(
      mockTransactionContext,
      'maintenance.searchTextBackfill.v1',
      'done',
    );
    expect(log).toHaveBeenCalledWith('[search] backfilled searchable text', { fixed: 2 });
  });

  it('does not overwrite or flag a row whose attributed body changed before commit', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = makeRaw(
      [
        { id: 1, ab: 'a' },
        { id: 2, ab: 'b' },
      ],
      { changedRows: () => 1 },
    );
    mockGetRawDatabase.mockReturnValue(raw);

    await runSearchTextBackfillOnce(captureRealtimeDeliveryLease());

    expect(mockKvSetWithinTransaction).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[search] search-text backfill skipped',
      expect.objectContaining({ message: 'search-text source changed before its guarded update' }),
    );
  });

  it('advances past undecodable rows and records completion', async () => {
    mockPlainText.mockReturnValue('');
    const raw = makeRaw([{ id: 1, ab: 'junk' }]);
    mockGetRawDatabase.mockReturnValue(raw);

    await runSearchTextBackfillOnce(captureRealtimeDeliveryLease());

    expect(
      raw.execute.mock.calls.filter((call) => String(call[0]).includes('UPDATE messages')),
    ).toEqual([]);
    expect(mockKvSetWithinTransaction).toHaveBeenCalledWith(
      mockTransactionContext,
      'maintenance.searchTextBackfill.v1',
      'done',
    );
  });

  it('is a no-op once the completion flag is set', async () => {
    mockKvGet.mockResolvedValue('done');
    const raw = makeRaw([{ id: 1, ab: 'a' }]);
    mockGetRawDatabase.mockReturnValue(raw);

    await runSearchTextBackfillOnce(captureRealtimeDeliveryLease());

    expect(raw.execute).not.toHaveBeenCalled();
    expect(mockKvSetWithinTransaction).not.toHaveBeenCalled();
  });

  it('swallows a read failure and leaves the flag unset for the next launch', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = makeRaw([{ id: 1, ab: 'a' }]);
    raw.execute.mockRejectedValue(new Error('database is locked'));
    mockGetRawDatabase.mockReturnValue(raw);

    await expect(
      runSearchTextBackfillOnce(captureRealtimeDeliveryLease()),
    ).resolves.toBeUndefined();

    expect(mockKvSetWithinTransaction).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[search] search-text backfill skipped',
      expect.objectContaining({ name: 'Error', message: 'database is locked' }),
    );
  });

  it('processes a large history in DB-only pages of at most 50 rows', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const pending = Array.from({ length: 121 }, (_, index) => ({
      id: index + 1,
      ab: `body-${index + 1}`,
    }));
    const raw = makeRaw(pending);
    mockGetRawDatabase.mockReturnValue(raw);

    await runSearchTextBackfillOnce(captureRealtimeDeliveryLease());

    expect(mockJoinedDbAll).toHaveBeenCalledTimes(3);
    expect(mockJoinedDbAll.mock.calls.map((call) => countSqlValues(call[0]) / 5)).toEqual([
      50, 50, 21,
    ]);
    expect(mockKvSetWithinTransaction).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('[search] backfilled searchable text', { fixed: 121 });
  });

  it('does no DB work for a lease that Disconnect already retired', async () => {
    const lease = captureRealtimeDeliveryLease();
    await pauseRealtimeDeliveries();

    await runSearchTextBackfillOnce(lease);

    expect(mockGetDatabase).not.toHaveBeenCalled();
    expect(mockKvSetWithinTransaction).not.toHaveBeenCalled();
  });

  it('lets Disconnect drain one admitted chunk, then prevents later chunks and completion', async () => {
    let releaseUpdate!: () => void;
    const updateStarted = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    let signalUpdateStarted!: () => void;
    const observedUpdate = new Promise<void>((resolve) => {
      signalUpdateStarted = resolve;
    });
    const raw = makeRaw(
      Array.from({ length: 70 }, (_, index) => ({ id: index + 1, ab: `body-${index + 1}` })),
      {
        onUpdate: async () => {
          signalUpdateStarted();
          await updateStarted;
        },
      },
    );
    mockGetRawDatabase.mockReturnValue(raw);
    const run = runSearchTextBackfillOnce(captureRealtimeDeliveryLease());
    await observedUpdate;

    let drainSettled = false;
    const drain = pauseRealtimeDeliveries().then(() => {
      drainSettled = true;
    });
    await Promise.resolve();
    expect(drainSettled).toBe(false);

    releaseUpdate();
    await Promise.all([run, drain]);

    expect(drainSettled).toBe(true);
    expect(mockKvSetWithinTransaction).not.toHaveBeenCalled();
    expect(mockJoinedDbAll).toHaveBeenCalledTimes(1);
  });

  it('loops when a row appears between the short page and completion check', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const pending: BackfillRow[] = [{ id: 1, ab: 'a' }];
    let trailingChecks = 0;
    const raw = makeRaw(pending, {
      onTrailingCheck: () => {
        trailingChecks += 1;
        if (trailingChecks === 1) {
          pending.push({ id: 2, ab: 'late' });
          return [{ id: 2, ab: 'late' }];
        }
        return [];
      },
    });
    mockGetRawDatabase.mockReturnValue(raw);

    await runSearchTextBackfillOnce(captureRealtimeDeliveryLease());

    expect(mockJoinedDbAll).toHaveBeenCalledTimes(2);
    expect(mockKvSetWithinTransaction).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('[search] backfilled searchable text', { fixed: 2 });
  });

  it('shares the exact in-flight Promise for the same account generation', async () => {
    let releaseRead!: () => void;
    const raw = makeRaw([]);
    raw.execute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseRead = () => resolve({ rows: [] });
        }),
    );
    mockGetRawDatabase.mockReturnValue(raw);
    const lease = captureRealtimeDeliveryLease();

    const first = runSearchTextBackfillOnce(lease);
    const second = runSearchTextBackfillOnce(lease);

    expect(second).toBe(first);
    for (let i = 0; i < 20 && releaseRead == null; i += 1) await Promise.resolve();
    expect(releaseRead).toEqual(expect.any(Function));
    releaseRead();
    await first;
    expect(mockGetDatabase).toHaveBeenCalledTimes(1);
  });
});
