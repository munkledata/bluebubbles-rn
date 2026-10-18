/**
 * The throwaway-database doorway (P6.5): the only way a DEV harness outside database.ts reaches a
 * database. It must refuse the real account database and every unlisted name, refuse outside a
 * development build, build the native options itself, and accept back only handles it opened.
 */
const mockOpen = jest.fn();
const mockDrizzle = jest.fn();
const mockRunMigrations = jest.fn();

jest.mock('@op-engineering/op-sqlite', () => ({ open: mockOpen }));
jest.mock('drizzle-orm/op-sqlite', () => ({ drizzle: mockDrizzle }));
jest.mock('@db/migrate', () => ({ runMigrations: mockRunMigrations }));

// eslint-disable-next-line import/first
import {
  closeThrowawayDatabase,
  deleteThrowawayDatabase,
  migrateThrowawayDatabase,
  openThrowawayDatabase,
  throwawayDrizzle,
  type ThrowawayDatabase,
  type ThrowawayDatabaseName,
} from '@db/database';

function nativeHandle() {
  return {
    execute: jest.fn(async () => ({ rows: [] })),
    reactiveExecute: jest.fn(),
    flushPendingReactiveQueries: jest.fn(),
    close: jest.fn(),
    delete: jest.fn(),
  };
}

beforeEach(() => {
  (globalThis as { __DEV__?: boolean }).__DEV__ = true;
  mockOpen.mockReset().mockImplementation(() => nativeHandle());
  mockDrizzle.mockReset().mockImplementation(() => ({}));
  mockRunMigrations.mockReset().mockResolvedValue(undefined);
});

it('opens only with the two reviewed option shapes', () => {
  openThrowawayDatabase('perf02-inbox-benchmark.db', 'public-key', false);
  openThrowawayDatabase('perf01-cold-1000.db', 'public-key', true);
  expect(mockOpen.mock.calls.map(([options]) => options)).toEqual([
    { name: 'perf02-inbox-benchmark.db', encryptionKey: 'public-key' },
    { name: 'perf01-cold-1000.db', encryptionKey: 'public-key', readOnly: true },
  ]);
  expect(Object.keys(mockOpen.mock.calls[0]![0] as object)).toEqual(['name', 'encryptionKey']);
});

it('refuses the real account database and every unlisted name', () => {
  for (const name of ['gator.db', 'scratch.db', '../gator.db', 'PERF02-INBOX-BENCHMARK.DB']) {
    const unlisted = name as ThrowawayDatabaseName;
    expect(() => openThrowawayDatabase(unlisted, 'public-key', false)).toThrow(
      'Throwaway database name is not approved.',
    );
    expect(() => deleteThrowawayDatabase(unlisted)).toThrow(
      'Throwaway database name is not approved.',
    );
  }
  expect(mockOpen).not.toHaveBeenCalled();
});

it('refuses everything outside a development build', () => {
  (globalThis as { __DEV__?: boolean }).__DEV__ = false;
  expect(() => openThrowawayDatabase('perf01-cold-10000.db', 'public-key', true)).toThrow(
    'Throwaway databases are development-only.',
  );
  expect(() => deleteThrowawayDatabase('perf01-cold-10000.db')).toThrow(
    'Throwaway databases are development-only.',
  );
  expect(mockOpen).not.toHaveBeenCalled();
});

it('deletes through a name-only native handle', () => {
  const handle = nativeHandle();
  mockOpen.mockReturnValueOnce(handle);
  deleteThrowawayDatabase('perf02-inbox-benchmark.db');
  expect(mockOpen).toHaveBeenCalledWith({ name: 'perf02-inbox-benchmark.db' });
  expect(handle.delete).toHaveBeenCalledTimes(1);
});

it('migrates, wraps and closes only a handle it opened and has not closed', async () => {
  const forged = nativeHandle() as unknown as ThrowawayDatabase;
  await expect(migrateThrowawayDatabase(forged)).rejects.toThrow('Not an open throwaway database.');
  expect(() => throwawayDrizzle(forged)).toThrow('Not an open throwaway database.');
  expect(() => closeThrowawayDatabase(forged)).toThrow('Not an open throwaway database.');

  const db = openThrowawayDatabase('perf02-inbox-benchmark.db', 'public-key', false);
  await migrateThrowawayDatabase(db);
  expect(mockRunMigrations).toHaveBeenCalledTimes(1);
  const queryLogger = { logQuery: jest.fn() };
  throwawayDrizzle(db, queryLogger);
  throwawayDrizzle(db);
  expect(mockDrizzle.mock.calls.map(([, config]) => config)).toEqual([
    { logger: queryLogger },
    { logger: undefined },
  ]);

  closeThrowawayDatabase(db);
  const native = mockOpen.mock.results[0]!.value as ReturnType<typeof nativeHandle>;
  expect(native.close).toHaveBeenCalledTimes(1);
  await expect(migrateThrowawayDatabase(db)).rejects.toThrow('Not an open throwaway database.');
  expect(() => closeThrowawayDatabase(db)).toThrow('Not an open throwaway database.');
  expect(mockRunMigrations).toHaveBeenCalledTimes(1);
});
