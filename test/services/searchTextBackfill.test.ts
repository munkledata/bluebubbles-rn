/**
 * The one-time search-text backfill must set its "done" flag from EVIDENCE, not from having reached
 * the end of the loop.
 *
 * Why it matters: the pass runs on the ONE shared op-sqlite connection, so its plain UPDATEs join
 * whatever transaction happens to be open (see db/transaction.ts). If that transaction rolls back,
 * every row the loop "fixed" is erased — while the kv write is its own autocommit and would still
 * retire the only pass that would ever repair them. Those messages then stay permanently
 * unsearchable (FTS indexes only `text`) for any chat the user never re-opens.
 *
 * The verification deliberately checks THE IDS THE PASS WROTE, not "is the selecting query now
 * empty": rows whose attributedBody decodes to nothing stay in that result set forever, so the
 * empty-set version could never be satisfied and every launch would repeat the full table scan.
 */
const mockGetDatabase = jest.fn();
const mockGetRawDatabase = jest.fn();
const mockKvGet = jest.fn();
const mockKvSet = jest.fn();
const mockPlainText = jest.fn();

jest.mock('@db/database', () => ({
  getDatabase: (...a: unknown[]) => mockGetDatabase(...a) as unknown,
  getRawDatabase: (...a: unknown[]) => mockGetRawDatabase(...a) as unknown,
  initDatabase: jest.fn(),
}));
jest.mock('@db/key', () => ({ resolveDbKey: jest.fn(), rotateDbKey: jest.fn() }));
jest.mock('@db/repositories', () => ({
  kvGet: (...a: unknown[]) => mockKvGet(...a) as unknown,
  kvSet: (...a: unknown[]) => mockKvSet(...a) as unknown,
}));
jest.mock('@core/richtext', () => ({
  plainTextFromAttributedBody: (...a: unknown[]) => mockPlainText(...a) as unknown,
}));
jest.mock('@/services/clients', () => ({ vault: { __vault: true } }));

const DB = { __handle: 'db' };

interface FakeRaw {
  execute: jest.Mock;
  flushPendingReactiveQueries: jest.Mock;
}

/**
 * A raw handle whose SELECT of empty-text rows returns `pending`, and whose verification COUNT
 * reports `landed` ids (a set of ids that really persisted). UPDATEs are recorded.
 */
function makeRaw(pending: Array<{ id: number; ab: string }>, landed: Set<number>): FakeRaw {
  const raw: FakeRaw = {
    execute: jest.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT id, attributed_body')) return { rows: pending };
      if (sql.includes('COUNT(*)')) {
        const ids = (params ?? []) as number[];
        return { rows: [{ c: ids.filter((id) => landed.has(id)).length }] };
      }
      return { rows: [] };
    }),
    flushPendingReactiveQueries: jest.fn(),
  };
  return raw;
}

async function runBackfill(): Promise<void> {
  jest.resetModules();
  const mod = await import('@/services/databaseControl');
  await mod.runSearchTextBackfillOnce();
}

describe('runSearchTextBackfillOnce', () => {
  beforeEach(() => {
    mockGetDatabase.mockReset().mockReturnValue(DB);
    mockGetRawDatabase.mockReset();
    mockKvGet.mockReset().mockResolvedValue(null);
    mockKvSet.mockReset().mockResolvedValue(undefined);
    // Every row decodes to real text unless a test says otherwise.
    mockPlainText.mockReset().mockImplementation((ab: unknown) => `decoded:${String(ab)}`);
  });

  it('writes the rows and flags itself done when the writes are verified', async () => {
    const raw = makeRaw(
      [
        { id: 1, ab: 'a' },
        { id: 2, ab: 'b' },
      ],
      new Set([1, 2]),
    );
    mockGetRawDatabase.mockReturnValue(raw);

    await runBackfill();

    const updates = raw.execute.mock.calls.filter((c) => String(c[0]).includes('UPDATE messages'));
    expect(updates).toHaveLength(2);
    expect(raw.flushPendingReactiveQueries).toHaveBeenCalledTimes(1);
    expect(mockKvSet).toHaveBeenCalledWith(DB, 'maintenance.searchTextBackfill.v1', 'done');
  });

  it('does NOT flag itself done when its writes did not persist', async () => {
    // The pass wrote ids 1 and 2; a neighbouring transaction rolled back and only 1 survived.
    const raw = makeRaw(
      [
        { id: 1, ab: 'a' },
        { id: 2, ab: 'b' },
      ],
      new Set([1]),
    );
    mockGetRawDatabase.mockReturnValue(raw);

    await runBackfill();

    // The flag stays unset so the next launch retries — this is the whole point.
    expect(mockKvSet).not.toHaveBeenCalled();
  });

  it('flags itself done when NOTHING was writable (never re-scans forever)', async () => {
    // Rows whose attributedBody decodes to nothing stay in the selecting query's result set for
    // good. A pass that writes zero rows has nothing to verify and is legitimately complete.
    mockPlainText.mockReturnValue('');
    const raw = makeRaw([{ id: 1, ab: 'junk' }], new Set());
    mockGetRawDatabase.mockReturnValue(raw);

    await runBackfill();

    expect(raw.execute.mock.calls.filter((c) => String(c[0]).includes('UPDATE messages'))).toEqual(
      [],
    );
    expect(mockKvSet).toHaveBeenCalledWith(DB, 'maintenance.searchTextBackfill.v1', 'done');
  });

  it('is a no-op once the flag is set', async () => {
    mockKvGet.mockResolvedValue('done');
    const raw = makeRaw([{ id: 1, ab: 'a' }], new Set([1]));
    mockGetRawDatabase.mockReturnValue(raw);

    await runBackfill();

    expect(raw.execute).not.toHaveBeenCalled();
    expect(mockKvSet).not.toHaveBeenCalled();
  });

  it('swallows a failure and leaves the flag unset for the next launch', async () => {
    const raw = makeRaw([{ id: 1, ab: 'a' }], new Set([1]));
    raw.execute.mockRejectedValue(new Error('database is locked'));
    mockGetRawDatabase.mockReturnValue(raw);

    await expect(runBackfill()).resolves.toBeUndefined();
    expect(mockKvSet).not.toHaveBeenCalled();
  });
});
