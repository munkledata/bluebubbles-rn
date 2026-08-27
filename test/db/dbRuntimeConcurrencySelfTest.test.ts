const mockOpen = jest.fn();
const mockDrizzle = jest.fn();
const mockRunMigrations = jest.fn();

jest.mock('@op-engineering/op-sqlite', () => ({ open: mockOpen }));
jest.mock('drizzle-orm/op-sqlite', () => ({ drizzle: mockDrizzle }));
jest.mock('@db/migrate', () => ({ runMigrations: mockRunMigrations }));

const migrationNames = (
  jest.requireActual('@db/migrations') as typeof import('@db/migrations')
).MIGRATIONS.map((migration) => migration.name);

const waveChecks = {
  rollbackIsolation: true,
  syncChunks: true,
  liveMessages: true,
  attachmentConstruction: true,
  uploadOutsideDbOwner: true,
  rekeyExclusive: true,
  queuedWritersBlocked: true,
  rekeyApplied: true,
  queuedWritersResumed: true,
  uploadSettlement: true,
  queueDrained: true,
  sentinelCommit: true,
} as const;

function cleanupHandle(deleteFails = false) {
  return {
    close: jest.fn(),
    delete: jest.fn(() => {
      if (deleteFails) throw new Error('private cleanup path');
    }),
  };
}

function nativeHandle(
  execute: (statement: string, params?: unknown[]) => Promise<{ rows: unknown[] }>,
) {
  return {
    close: jest.fn(),
    delete: jest.fn(),
    execute: jest.fn(execute),
    executeRaw: jest.fn(),
    executeSync: jest.fn(),
    flushPendingReactiveQueries: jest.fn(),
  };
}

function installNativeHarness(
  options: { finalDeleteFails?: boolean; waveFailsBeforeReopen?: boolean } = {},
) {
  let rekeyApplied = false;
  const preCleanup = cleanupHandle();
  const active = nativeHandle(async (statement) => {
    if (statement === 'SELECT name FROM _migrations ORDER BY name') {
      return { rows: migrationNames.map((name) => ({ name })) };
    }
    if (statement === "PRAGMA rekey = 'db-02c-public-throwaway-key-b-v1'") {
      rekeyApplied = true;
    }
    return { rows: [] };
  });
  const rekeyed = nativeHandle(async (statement) => {
    if (!rekeyApplied) throw new Error('new key unavailable');
    if (statement === 'SELECT value FROM kv WHERE key = ?') {
      return { rows: [{ value: 'committed' }] };
    }
    if (statement === 'PRAGMA integrity_check') {
      return { rows: [{ integrity_check: 'ok' }] };
    }
    return { rows: [] };
  });
  const oldKey = nativeHandle(async () => {
    throw new Error('private SQLCipher diagnostic');
  });
  const finalCleanup = cleanupHandle(options.finalDeleteFails);
  const handles = options.waveFailsBeforeReopen
    ? [preCleanup, active, finalCleanup]
    : [preCleanup, active, rekeyed, oldKey, finalCleanup];
  let next = 0;
  mockOpen.mockImplementation(() => {
    const handle = handles[next];
    if (!handle) throw new Error(`unexpected database open ${next + 1}`);
    next += 1;
    return handle;
  });
  return { active, finalCleanup, oldKey, preCleanup, rekeyed };
}

describe('runDbRuntimeConcurrencySelfTest', () => {
  beforeEach(() => {
    jest.resetModules();
    mockOpen.mockReset();
    mockDrizzle.mockReset();
    mockRunMigrations.mockReset();
    mockRunMigrations.mockResolvedValue(migrationNames);
  });

  it('runs the finite wave on one fixed encrypted file and proves the rekeyed reopen', async () => {
    const harness = installNativeHarness();
    const appDatabase = { kind: 'adapted-disposable-database' };
    mockDrizzle.mockReturnValue(appDatabase);
    const { runDbRuntimeConcurrencySelfTest } = await import('@db/database');
    const runWave = jest.fn(async (db, options) => {
      expect(db).toBe(appDatabase);
      await options.rawRekey();
      return waveChecks;
    });

    await expect(runDbRuntimeConcurrencySelfTest(runWave)).resolves.toEqual({
      status: 'pass',
      checks: {
        preCleanup: true,
        encryptedOpen: true,
        migrationLedger: true,
        ...waveChecks,
        newKeyReopen: true,
        oldKeyRejected: true,
        integrity: true,
        databaseCleanup: true,
      },
    });

    expect(mockOpen.mock.calls.map(([options]) => options)).toEqual([
      { name: 'driver-runtime-concurrency-selftest.db' },
      {
        name: 'driver-runtime-concurrency-selftest.db',
        encryptionKey: 'db-02c-public-throwaway-key-a-v1',
      },
      {
        name: 'driver-runtime-concurrency-selftest.db',
        encryptionKey: 'db-02c-public-throwaway-key-b-v1',
        readOnly: true,
      },
      {
        name: 'driver-runtime-concurrency-selftest.db',
        encryptionKey: 'db-02c-public-throwaway-key-a-v1',
        readOnly: true,
      },
      { name: 'driver-runtime-concurrency-selftest.db' },
    ]);
    expect(mockRunMigrations).toHaveBeenCalledTimes(1);
    expect(runWave).toHaveBeenCalledTimes(1);
    expect(harness.active.execute).toHaveBeenCalledWith(
      "PRAGMA rekey = 'db-02c-public-throwaway-key-b-v1'",
    );
    expect(harness.active.close).toHaveBeenCalledTimes(1);
    expect(harness.rekeyed.close).toHaveBeenCalledTimes(1);
    expect(harness.oldKey.close).toHaveBeenCalledTimes(1);
    expect(harness.preCleanup.delete).toHaveBeenCalledTimes(1);
    expect(harness.finalCleanup.delete).toHaveBeenCalledTimes(1);
  });

  it('returns a finite internal failure and still deletes the disposable file', async () => {
    const harness = installNativeHarness({ waveFailsBeforeReopen: true });
    mockDrizzle.mockReturnValue({});
    const { runDbRuntimeConcurrencySelfTest } = await import('@db/database');

    const result = await runDbRuntimeConcurrencySelfTest(async () => {
      throw new Error('private native path and key');
    });

    expect(result).toMatchObject({ status: 'fail', failureCode: 'internal' });
    expect(JSON.stringify(result)).not.toContain('private native path and key');
    expect(result.checks.databaseCleanup).toBe(true);
    expect(harness.active.close).toHaveBeenCalledTimes(1);
    expect(harness.finalCleanup.delete).toHaveBeenCalledTimes(1);
  });

  it('makes final disposable-file cleanup failure authoritative', async () => {
    installNativeHarness({ finalDeleteFails: true });
    mockDrizzle.mockReturnValue({});
    const { runDbRuntimeConcurrencySelfTest } = await import('@db/database');

    const result = await runDbRuntimeConcurrencySelfTest(async (_db, options) => {
      await options.rawRekey();
      return waveChecks;
    });

    expect(result).toMatchObject({
      status: 'fail',
      failureCode: 'database-cleanup',
      checks: { databaseCleanup: false },
    });
    expect(JSON.stringify(result)).not.toContain('private cleanup path');
  });
});
