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

const backupRestoreWaveChecks = {
  plaintextNearLimit: true,
  bb2Envelope: true,
  nativeSeal: true,
  nativeOpen: true,
  lateFaultObserved: true,
  kvRolledBack: true,
  themesRolledBack: true,
  chatRolledBack: true,
  foldersRolledBack: true,
  tempTablesCleaned: true,
  retrySucceeded: true,
  successorWrite: true,
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

describe('runDbBackupRestoreSelfTest', () => {
  beforeEach(() => {
    jest.resetModules();
    mockOpen.mockReset();
    mockDrizzle.mockReset();
    mockRunMigrations.mockReset();
    mockRunMigrations.mockResolvedValue(migrationNames);
  });

  function installBackupHarness(closeFails = false) {
    const preCleanup = cleanupHandle();
    const active = nativeHandle(async (statement) => {
      if (statement === 'SELECT name FROM _migrations ORDER BY name') {
        return { rows: migrationNames.map((name) => ({ name })) };
      }
      return { rows: [] };
    });
    const reopened = nativeHandle(async (statement) => {
      if (statement === 'PRAGMA foreign_keys') return { rows: [{ foreign_keys: 1 }] };
      if (statement === 'PRAGMA integrity_check') {
        return { rows: [{ integrity_check: 'ok' }] };
      }
      return { rows: [] };
    });
    if (closeFails) {
      reopened.close.mockImplementation(() => {
        throw new Error('private close diagnostic');
      });
    }
    const finalCleanup = cleanupHandle();
    const handles = [preCleanup, active, reopened, finalCleanup];
    let next = 0;
    mockOpen.mockImplementation(() => {
      const handle = handles[next];
      if (!handle) throw new Error(`unexpected database open ${next + 1}`);
      next += 1;
      return handle;
    });
    return { active, finalCleanup, preCleanup, reopened };
  }

  it('runs the wave only on one fixed encrypted disposable file, then closes and deletes it', async () => {
    const harness = installBackupHarness();
    const appDatabase = { kind: 'adapted-backup-restore-database' };
    mockDrizzle.mockReturnValue(appDatabase);
    const { runDbBackupRestoreSelfTest } = await import('@db/database');
    const runWave = jest.fn(async (db) => {
      expect(db).toBe(appDatabase);
      return backupRestoreWaveChecks;
    });

    await expect(runDbBackupRestoreSelfTest(runWave)).resolves.toEqual({
      status: 'pass',
      checks: {
        preCleanup: true,
        encryptedOpen: true,
        migrationLedger: true,
        ...backupRestoreWaveChecks,
        foreignKeys: true,
        integrity: true,
        databaseClosed: true,
        databaseCleanup: true,
      },
    });
    expect(mockOpen.mock.calls.map(([options]) => options)).toEqual([
      { name: 'driver-backup-restore-selftest.db' },
      {
        name: 'driver-backup-restore-selftest.db',
        encryptionKey: 'backup-02-public-throwaway-key-v1',
      },
      {
        name: 'driver-backup-restore-selftest.db',
        encryptionKey: 'backup-02-public-throwaway-key-v1',
        readOnly: true,
      },
      { name: 'driver-backup-restore-selftest.db' },
    ]);
    expect(runWave).toHaveBeenCalledTimes(1);
    expect(harness.active.close).toHaveBeenCalledTimes(1);
    expect(harness.reopened.close).toHaveBeenCalledTimes(1);
    expect(harness.preCleanup.delete).toHaveBeenCalledTimes(1);
    expect(harness.finalCleanup.delete).toHaveBeenCalledTimes(1);
  });

  it('keeps a close failure finite and prevents an all-true failure marker', async () => {
    installBackupHarness(true);
    mockDrizzle.mockReturnValue({});
    const { runDbBackupRestoreSelfTest } = await import('@db/database');

    const result = await runDbBackupRestoreSelfTest(async () => backupRestoreWaveChecks);

    expect(result).toMatchObject({
      status: 'fail',
      failureCode: 'database-closed',
      checks: { integrity: true, databaseClosed: false, databaseCleanup: true },
    });
    expect(JSON.stringify(result)).not.toContain('private close diagnostic');
  });
});
