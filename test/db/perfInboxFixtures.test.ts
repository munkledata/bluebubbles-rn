/**
 * Characterization of the DEV-only PERF-01/PERF-02 inbox fixtures (P6.5 stage 1). Every native
 * open (with its exact options), statement, subscription, flush, close and delete is logged in
 * order, so moving this code behind the throwaway-database doorway must reproduce it call for call.
 */
const mockOpen = jest.fn();
const mockDrizzle = jest.fn();
const mockRunMigrations = jest.fn();
const mockSeed = jest.fn();
const mockRunFixture = jest.fn();
const mockBump = jest.fn();
const mockListChats = jest.fn();
const mockCountChats = jest.fn();

jest.mock('@op-engineering/op-sqlite', () => ({ open: mockOpen }));
jest.mock('drizzle-orm/op-sqlite', () => ({ drizzle: mockDrizzle }));
jest.mock('@db/migrate', () => ({ runMigrations: mockRunMigrations }));
jest.mock('@db/performance/deviceInboxBenchmark', () => ({
  seedDeviceInboxBenchmarkFixture: mockSeed,
  runDeviceInboxBenchmarkFixture: mockRunFixture,
  bumpDeviceInboxBenchmarkFixture: mockBump,
}));
jest.mock('@db/repositories/chatQueries', () => ({
  ...jest.requireActual<typeof import('@db/repositories/chatQueries')>(
    '@db/repositories/chatQueries',
  ),
  listChatsForInboxPage: mockListChats,
  countChatsForInbox: mockCountChats,
}));

// eslint-disable-next-line import/first
import {
  deletePerf01ColdFixture,
  openPerf01ColdFixture,
  preparePerf01ColdFixture,
  runPerf02DeviceInboxBenchmark,
} from '@db/database';

const log: string[] = [];
let fixtureRows = { chats: 1_000, messages: 4_000 };

function nativeHandle(label: string) {
  return {
    execute: jest.fn(async (statement: string) => {
      log.push(`${label}.execute ${statement}`);
      if (statement.startsWith('SELECT (SELECT COUNT(*) FROM chats)'))
        return { rows: [fixtureRows] };
      if (statement.startsWith('EXPLAIN QUERY PLAN'))
        return { rows: [{ detail: ' SCAN  chats ' }] };
      return { rows: [] };
    }),
    reactiveExecute: jest.fn(
      (spec: { query: string; fireOn: Array<{ table: string }>; callback: () => void }) => {
        log.push(
          `${label}.reactiveExecute ${spec.query} ${spec.fireOn.map((t) => t.table).join(',')}`,
        );
        return () => log.push(`${label}.unsubscribe`);
      },
    ),
    flushPendingReactiveQueries: jest.fn(async () => {
      log.push(`${label}.flush`);
    }),
    close: jest.fn(() => log.push(`${label}.close`)),
    delete: jest.fn(() => log.push(`${label}.delete`)),
  };
}

beforeEach(() => {
  // The PERF entry points check React Native's development flag at call time.
  (globalThis as { __DEV__?: boolean }).__DEV__ = true;
  log.length = 0;
  fixtureRows = { chats: 1_000, messages: 4_000 };
  let opened = 0;
  mockOpen.mockReset().mockImplementation((options: Record<string, unknown>) => {
    opened += 1;
    log.push(`open ${JSON.stringify(options)}`);
    return nativeHandle(`h${opened}`);
  });
  mockDrizzle
    .mockReset()
    .mockImplementation((_adapter: unknown, config?: { logger?: { logQuery: unknown } }) => {
      log.push(`drizzle ${config?.logger ? 'logger' : 'plain'}`);
      return { config };
    });
  mockRunMigrations.mockReset().mockImplementation(async () => {
    log.push('migrate');
  });
  mockSeed.mockReset().mockImplementation(async (_db: unknown, chats: number) => {
    log.push(`seed ${chats}`);
  });
  mockRunFixture
    .mockReset()
    .mockImplementation(
      async (
        db: { config: { logger: { logQuery(statement: string, params: unknown[]): void } } },
        chats: number,
        capturePlan: <T>(run: () => Promise<T>) => Promise<{ result: T; plan: string[] }>,
      ) => {
        log.push(`measure ${chats}`);
        const captured = await capturePlan(async () => {
          db.config.logger.logQuery('SELECT * FROM chats', [chats]);
          return 'page';
        });
        log.push(`plan ${captured.result} ${captured.plan.join('|')}`);
        return { chats };
      },
    );
  mockBump.mockReset().mockImplementation(async (_db: unknown, chats: number, revision: number) => {
    log.push(`bump ${chats} ${revision}`);
  });
  mockListChats.mockReset().mockImplementation(async () => {
    log.push('listChatsForInboxPage');
    return { rows: [], hasMore: false };
  });
  mockCountChats.mockReset().mockImplementation(async () => {
    log.push('countChatsForInbox');
    return 7;
  });
});

it('PERF-02 measurement keeps its exact native lifecycle per scale', async () => {
  await expect(runPerf02DeviceInboxBenchmark()).resolves.toEqual([
    { chats: 1_000 },
    { chats: 10_000 },
  ]);
  expect(log).toEqual([
    'open {"name":"perf02-inbox-benchmark.db"}',
    'h1.delete',
    'open {"name":"perf02-inbox-benchmark.db","encryptionKey":"perf02-public-throwaway-key-v1"}',
    'h2.execute PRAGMA foreign_keys = ON',
    'migrate',
    'drizzle logger',
    'measure 1000',
    'h2.execute EXPLAIN QUERY PLAN SELECT * FROM chats',
    'plan page SCAN chats',
    'h2.flush',
    'h2.close',
    'open {"name":"perf02-inbox-benchmark.db"}',
    'h3.delete',
    'open {"name":"perf02-inbox-benchmark.db"}',
    'h4.delete',
    'open {"name":"perf02-inbox-benchmark.db","encryptionKey":"perf02-public-throwaway-key-v1"}',
    'h5.execute PRAGMA foreign_keys = ON',
    'migrate',
    'drizzle logger',
    'measure 10000',
    'h5.execute EXPLAIN QUERY PLAN SELECT * FROM chats',
    'plan page SCAN chats',
    'h5.flush',
    'h5.close',
    'open {"name":"perf02-inbox-benchmark.db"}',
    'h6.delete',
  ]);
});

it('PERF-02 display mode serves, validates and cleans up its fixture source', async () => {
  const seen: string[] = [];
  await runPerf02DeviceInboxBenchmark(async (source, chats) => {
    seen.push(`${source.key} ${chats}`);
    const filters = { unread: false } as never;
    await expect(
      source.query({ limit: 50, archive: 'active', sender: 'any', filters, countUnknown: true }),
    ).resolves.toEqual({ rows: [], hasMore: false, unknownCount: 7 });
    await expect(
      source.query({ limit: 0, archive: 'active', sender: 'any', filters, countUnknown: false }),
    ).rejects.toThrow('PERF-02 fixture page limit is out of range.');
    expect(() => source.subscribe(['messages'], () => undefined)).toThrow(
      'PERF-02 fixture subscription has unexpected tables.',
    );
    const release = source.subscribe(['messages', 'chats', 'chat_handles', 'handles'], () => {
      seen.push('notified');
    });
    await source.bump(3);
    release();
  });
  expect(seen).toEqual(['perf02-disposable-1000 1000', 'perf02-disposable-10000 10000']);
  expect(log).toEqual([
    'open {"name":"perf02-inbox-benchmark.db"}',
    'h1.delete',
    'open {"name":"perf02-inbox-benchmark.db","encryptionKey":"perf02-public-throwaway-key-v1"}',
    'h2.execute PRAGMA foreign_keys = ON',
    'migrate',
    'drizzle logger',
    'seed 1000',
    'h2.reactiveExecute SELECT 1 messages,chats,chat_handles,handles',
    'listChatsForInboxPage',
    'countChatsForInbox',
    'bump 1000 3',
    'h2.flush',
    'h2.unsubscribe',
    'h2.close',
    'open {"name":"perf02-inbox-benchmark.db"}',
    'h3.delete',
    'open {"name":"perf02-inbox-benchmark.db"}',
    'h4.delete',
    'open {"name":"perf02-inbox-benchmark.db","encryptionKey":"perf02-public-throwaway-key-v1"}',
    'h5.execute PRAGMA foreign_keys = ON',
    'migrate',
    'drizzle logger',
    'seed 10000',
    'h5.reactiveExecute SELECT 1 messages,chats,chat_handles,handles',
    'listChatsForInboxPage',
    'countChatsForInbox',
    'bump 10000 3',
    'h5.flush',
    'h5.unsubscribe',
    'h5.close',
    'open {"name":"perf02-inbox-benchmark.db"}',
    'h6.delete',
  ]);
});

it('PERF-02 refuses a second run while one is active', async () => {
  let finishDisplay: () => void = () => undefined;
  const running = runPerf02DeviceInboxBenchmark(
    () =>
      new Promise<void>((resolve) => {
        finishDisplay = resolve;
      }),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  await expect(runPerf02DeviceInboxBenchmark()).rejects.toThrow(
    'PERF-02 benchmark is already running.',
  );
  await expect(preparePerf01ColdFixture(1_000)).rejects.toThrow(
    'Another inbox fixture operation is running.',
  );
  finishDisplay();
  await new Promise<void>((resolve) => setImmediate(resolve));
  finishDisplay();
  await running;
});

it('PERF-01 prepare seeds, verifies and closes its fixed fixture', async () => {
  await preparePerf01ColdFixture(1_000);
  expect(log).toEqual([
    'open {"name":"perf01-cold-1000.db"}',
    'h1.delete',
    'open {"name":"perf01-cold-1000.db","encryptionKey":"perf01-public-throwaway-key-v1"}',
    'h2.execute PRAGMA foreign_keys = ON',
    'migrate',
    'drizzle plain',
    'seed 1000',
    'h2.execute SELECT (SELECT COUNT(*) FROM chats) AS chats, (SELECT COUNT(*) FROM messages) AS messages',
    'h2.execute PRAGMA foreign_key_check',
    'h2.close',
  ]);

  log.length = 0;
  fixtureRows = { chats: 999, messages: 4_000 };
  await expect(preparePerf01ColdFixture(1_000)).rejects.toThrow(
    'PERF-01 cold fixture row counts are invalid.',
  );
  expect(log).toEqual([
    'open {"name":"perf01-cold-1000.db"}',
    'h3.delete',
    'open {"name":"perf01-cold-1000.db","encryptionKey":"perf01-public-throwaway-key-v1"}',
    'h4.execute PRAGMA foreign_keys = ON',
    'migrate',
    'drizzle plain',
    'seed 1000',
    'h4.execute SELECT (SELECT COUNT(*) FROM chats) AS chats, (SELECT COUNT(*) FROM messages) AS messages',
    'h4.close',
    'open {"name":"perf01-cold-1000.db"}',
    'h5.delete',
  ]);
});

it('PERF-01 opens read-only, validates queries and blocks other fixture work until closed', async () => {
  const handle = openPerf01ColdFixture(10_000);
  expect(handle.source.key).toBe('perf01-cold-10000');
  const filters = { unread: false } as never;
  await expect(
    handle.source.query({
      limit: 50,
      archive: 'active',
      sender: 'any',
      filters,
      countUnknown: false,
    }),
  ).resolves.toEqual({ rows: [], hasMore: false, unknownCount: 0 });
  await expect(
    handle.source.query({
      limit: 20,
      archive: 'active',
      sender: 'any',
      filters,
      countUnknown: false,
    }),
  ).rejects.toThrow('PERF-01 cold fixture received an unexpected query.');
  expect(() => deletePerf01ColdFixture(10_000)).toThrow('PERF-01 cold fixture is still in use.');
  await expect(preparePerf01ColdFixture(1_000)).rejects.toThrow(
    'Another inbox fixture operation is running.',
  );
  expect(() => openPerf01ColdFixture(1_000)).toThrow('Another inbox fixture operation is running.');
  await handle.close();
  deletePerf01ColdFixture(10_000);
  expect(log).toEqual([
    'open {"name":"perf01-cold-10000.db","encryptionKey":"perf01-public-throwaway-key-v1","readOnly":true}',
    'drizzle plain',
    'listChatsForInboxPage',
    'h1.close',
    'open {"name":"perf01-cold-10000.db"}',
    'h2.delete',
  ]);
});

it('every PERF entry point refuses to run outside a development build', async () => {
  const globals = globalThis as { __DEV__?: boolean };
  const previous = globals.__DEV__;
  globals.__DEV__ = false;
  try {
    expect(() => deletePerf01ColdFixture(1_000)).toThrow(
      'PERF-01 cold fixture is development-only.',
    );
    await expect(preparePerf01ColdFixture(1_000)).rejects.toThrow(
      'PERF-01 cold fixture is development-only.',
    );
    expect(() => openPerf01ColdFixture(1_000)).toThrow('PERF-01 cold fixture is development-only.');
    await expect(runPerf02DeviceInboxBenchmark()).rejects.toThrow(
      'PERF-02 benchmark is development-only.',
    );
  } finally {
    globals.__DEV__ = previous;
  }
  expect(mockOpen).not.toHaveBeenCalled();
});
