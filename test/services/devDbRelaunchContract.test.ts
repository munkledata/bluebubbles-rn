const mockFiles = new Map<string, number>();
const mockFileCreateFailures = new Set<string>();
const mockFileDeleteFailures = new Set<string>();
const mockFileInfoFailures = new Set<string>();
const mockFileOperations: string[] = [];

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
const mockCleanupActiveMigrationDeathDatabase = jest.fn();
const mockCleanupWalWriteDeathDatabase = jest.fn();
const mockCleanupDatabase = jest.fn();
const mockCleanupRuntimeConcurrencyDatabase = jest.fn();
const mockPrepareActiveMigrationDeathDatabase = jest.fn();
const mockPrepareWalWriteDeathDatabase = jest.fn();
const mockPrepareDatabase = jest.fn();
const mockResumeActiveMigrationDeathDatabase = jest.fn();
const mockResumeWalWriteDeathDatabase = jest.fn();
const mockResumeDatabase = jest.fn();
const mockRunRuntimeConcurrencyDatabase = jest.fn();
const mockRunRuntimeConcurrencyWave = jest.fn();

jest.mock('expo-file-system', () => ({
  Paths: { document: '/private-files' },
  File: class {
    private readonly name: string;

    constructor(...parts: unknown[]) {
      this.name = String(parts[parts.length - 1]);
    }

    info(): { exists: boolean; size?: number } {
      mockFileOperations.push(`info:${this.name}`);
      if (mockFileInfoFailures.has(this.name))
        throw new Error('simulated private-file info failure');
      const size = mockFiles.get(this.name);
      return size === undefined ? { exists: false } : { exists: true, size };
    }

    create(): void {
      mockFileOperations.push(`create:${this.name}`);
      if (mockFileCreateFailures.has(this.name)) throw new Error('simulated marker create failure');
      if (mockFiles.has(this.name)) throw new Error('marker already exists');
      mockFiles.set(this.name, 0);
    }

    delete(): void {
      mockFileOperations.push(`delete:${this.name}`);
      if (mockFileDeleteFailures.has(this.name)) throw new Error('simulated marker delete failure');
      mockFiles.delete(this.name);
    }
  },
}));
jest.mock('@core/secure', () => ({ logger: mockLogger }));
jest.mock('@/services/boot/dbRuntimeConcurrencyWave', () => ({
  runDbRuntimeConcurrencyWave: mockRunRuntimeConcurrencyWave,
}));
jest.mock('@db/database', () => ({
  cleanupDbActiveMigrationDeathSelfTestDatabase: mockCleanupActiveMigrationDeathDatabase,
  cleanupDbActiveWalWriteDeathSelfTestDatabase: mockCleanupWalWriteDeathDatabase,
  cleanupDbProcessRelaunchSelfTestDatabase: mockCleanupDatabase,
  cleanupDbRuntimeConcurrencySelfTestDatabase: mockCleanupRuntimeConcurrencyDatabase,
  prepareDbActiveMigrationDeathSelfTest: mockPrepareActiveMigrationDeathDatabase,
  prepareDbActiveWalWriteDeathSelfTest: mockPrepareWalWriteDeathDatabase,
  prepareDbProcessRelaunchSelfTest: mockPrepareDatabase,
  resumeDbActiveMigrationDeathSelfTest: mockResumeActiveMigrationDeathDatabase,
  resumeDbActiveWalWriteDeathSelfTest: mockResumeWalWriteDeathDatabase,
  resumeDbProcessRelaunchSelfTest: mockResumeDatabase,
  runDbRuntimeConcurrencySelfTest: mockRunRuntimeConcurrencyDatabase,
}));

const REQUEST = '.gator-db-relaunch-request-v1';
const WAL_WRITE_DEATH_REQUEST = '.gator-db-wal-write-death-request-v1';
const ACTIVE_MIGRATION_DEATH_REQUEST = '.gator-db-active-migration-death-request-v1';
const RUNTIME_CONCURRENCY_REQUEST = '.gator-db-runtime-concurrency-request-v1';
const RUNTIME_CONCURRENCY_RUNNING = '.gator-db-runtime-concurrency-running-v1';
const PREPARING = '.gator-db-relaunch-preparing-v1';
const READY = '.gator-db-relaunch-ready-v1';
const RESUMING = '.gator-db-relaunch-resuming-v1';
const WAL_WRITE_DEATH_PREPARING = '.gator-db-wal-write-death-preparing-v1';
const WAL_WRITE_DEATH_READY = '.gator-db-wal-write-death-ready-v1';
const WAL_WRITE_DEATH_RESUMING = '.gator-db-wal-write-death-resuming-v1';
const ACTIVE_MIGRATION_DEATH_PREPARING = '.gator-db-active-migration-death-preparing-v1';
const ACTIVE_MIGRATION_DEATH_READY = '.gator-db-active-migration-death-ready-v1';
const ACTIVE_MIGRATION_DEATH_RESUMING = '.gator-db-active-migration-death-resuming-v1';
const PREFIX = 'GATOR_DB_RELAUNCH_V1 ';
const WAL_WRITE_DEATH_PREFIX = 'GATOR_DB_WAL_WRITE_DEATH_V1 ';
const ACTIVE_MIGRATION_DEATH_PREFIX = 'GATOR_DB_ACTIVE_MIGRATION_DEATH_V1 ';
const RUNTIME_CONCURRENCY_PREFIX = 'GATOR_DB_RUNTIME_CONCURRENCY_V1 ';

const prepareChecks = {
  preCleanup: true,
  encryptedOpen: true,
  migrationRollback: true,
  partialLedger: true,
  continuitySentinel: true,
};
const resumeChecks = {
  readOnlyContinuityOpen: true,
  sameFileState: true,
  partialLedger: true,
  continuitySentinel: true,
  migrationRetry: true,
  migrationLedger: true,
  integrity: true,
  idempotent: true,
  databaseCleanup: true,
};
const walWriteDeathPrepareChecks = {
  preCleanup: true,
  encryptedOpen: true,
  walMode: true,
  baselineCommitted: true,
  walCheckpointTruncated: true,
  writeTransactionOpen: true,
  uncommittedCanaryWritten: true,
};
const walWriteDeathResumeChecks = {
  readOnlyRecoveryOpen: true,
  walMode: true,
  baselinePresent: true,
  uncommittedAbsent: true,
  integrity: true,
  foreignKeys: true,
  recoveryCommit: true,
  reopenPersistence: true,
  databaseCleanup: true,
};
const activeMigrationDeathPrepareChecks = {
  preCleanup: true,
  encryptedOpen: true,
  walMode: true,
  migrationPrefixPrepared: true,
  baselineCommitted: true,
  walCheckpointTruncated: true,
  migrationTransactionOpen: true,
  migrationWriteApplied: true,
  migrationLedgerPending: true,
};
const activeMigrationDeathResumeChecks = {
  readOnlyRecoveryOpen: true,
  walMode: true,
  migrationPrefixPreserved: true,
  uncommittedMigrationAbsent: true,
  integrity: true,
  foreignKeys: true,
  migrationRetry: true,
  migrationLedger: true,
  migrationData: true,
  idempotent: true,
  reopenPersistence: true,
  databaseCleanup: true,
};
const runtimeConcurrencyDatabaseChecks = {
  preCleanup: true,
  encryptedOpen: true,
  migrationLedger: true,
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
  newKeyReopen: true,
  oldKeyRejected: true,
  integrity: true,
  databaseCleanup: true,
};

function loadContract(): typeof import('@/services/boot/devDbRelaunchContract') {
  // Each load represents a fresh app process and therefore must get a fresh in-memory latch.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@/services/boot/devDbRelaunchContract') as typeof import('@/services/boot/devDbRelaunchContract');
}

function createExisting(...entries: Array<string | readonly [string, number]>): void {
  for (const entry of entries) {
    if (typeof entry === 'string') mockFiles.set(entry, 0);
    else mockFiles.set(entry[0], entry[1]);
  }
}

function parsedMarkers(): Array<Record<string, unknown>> {
  return mockLogger.info.mock.calls.map(([message]) => {
    expect(typeof message).toBe('string');
    expect(message).toMatch(/^GATOR_DB_RELAUNCH_V1 /);
    return JSON.parse(String(message).slice(PREFIX.length)) as Record<string, unknown>;
  });
}

function parsedWalWriteDeathMarkers(): Array<Record<string, unknown>> {
  return mockLogger.info.mock.calls.map(([message]) => {
    expect(typeof message).toBe('string');
    expect(message).toMatch(/^GATOR_DB_WAL_WRITE_DEATH_V1 /);
    return JSON.parse(String(message).slice(WAL_WRITE_DEATH_PREFIX.length)) as Record<
      string,
      unknown
    >;
  });
}

function parsedActiveMigrationDeathMarkers(): Array<Record<string, unknown>> {
  return mockLogger.info.mock.calls.map(([message]) => {
    expect(typeof message).toBe('string');
    expect(message).toMatch(/^GATOR_DB_ACTIVE_MIGRATION_DEATH_V1 /);
    return JSON.parse(String(message).slice(ACTIVE_MIGRATION_DEATH_PREFIX.length)) as Record<
      string,
      unknown
    >;
  });
}

function parsedRuntimeConcurrencyMarkers(): Array<Record<string, unknown>> {
  return mockLogger.info.mock.calls.map(([message]) => {
    expect(typeof message).toBe('string');
    expect(message).toMatch(/^GATOR_DB_RUNTIME_CONCURRENCY_V1 /);
    return JSON.parse(String(message).slice(RUNTIME_CONCURRENCY_PREFIX.length)) as Record<
      string,
      unknown
    >;
  });
}

async function flushMicrotasks(count = 12): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  mockFiles.clear();
  mockFileCreateFailures.clear();
  mockFileDeleteFailures.clear();
  mockFileInfoFailures.clear();
  mockFileOperations.length = 0;
  mockCleanupDatabase.mockReturnValue(true);
  mockCleanupWalWriteDeathDatabase.mockReturnValue(true);
  mockCleanupActiveMigrationDeathDatabase.mockReturnValue(true);
  mockCleanupRuntimeConcurrencyDatabase.mockReturnValue(true);
});

describe('DEV DB relaunch durable phase orchestration', () => {
  it('leaves ordinary DEV boot untouched when no request or phase marker exists', () => {
    const contract = loadContract();

    expect(contract.startDevDbRelaunchContractIfRequested()).toBeUndefined();
    createExisting(REQUEST);
    expect(contract.startDevDbRelaunchContractIfRequested()).toBeUndefined();
    expect(mockPrepareDatabase).not.toHaveBeenCalled();
    expect(mockResumeDatabase).not.toHaveBeenCalled();
    expect(mockCleanupDatabase).not.toHaveBeenCalled();
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it('atomically prepares once, emits the exact finite READY marker, and keeps phase state', async () => {
    createExisting(REQUEST);
    mockPrepareDatabase.mockImplementation(
      async (onPrepared: (checks: typeof prepareChecks) => Promise<never>) =>
        onPrepared(prepareChecks),
    );
    const contract = loadContract();

    const first = contract.startDevDbRelaunchContractIfRequested();
    const second = contract.startDevDbRelaunchContractIfRequested();
    await flushMicrotasks();

    expect(first).toBe(second);
    expect(mockPrepareDatabase).toHaveBeenCalledTimes(1);
    expect(mockFiles).toEqual(
      new Map([
        [REQUEST, 0],
        [PREPARING, 0],
        [READY, 0],
      ]),
    );
    expect(parsedMarkers()).toEqual([
      {
        schema: 1,
        suite: 'android-db-relaunch',
        status: 'ready',
        phase: 'prepare',
        checks: {
          requestValid: true,
          ...prepareChecks,
          readyStatePersisted: true,
        },
      },
    ]);
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('uses the same exclusive dispatcher for active-WAL prepare and emits its finite READY marker', async () => {
    createExisting(WAL_WRITE_DEATH_REQUEST);
    mockPrepareWalWriteDeathDatabase.mockImplementation(
      async (onPrepared: (checks: typeof walWriteDeathPrepareChecks) => Promise<never>) =>
        onPrepared(walWriteDeathPrepareChecks),
    );
    const contract = loadContract();

    const first = contract.startDevDbRelaunchContractIfRequested();
    const second = contract.startDevDbRelaunchContractIfRequested();
    await flushMicrotasks();

    expect(first).toBe(second);
    expect(mockPrepareWalWriteDeathDatabase).toHaveBeenCalledTimes(1);
    expect(mockPrepareDatabase).not.toHaveBeenCalled();
    expect(mockFiles).toEqual(
      new Map([
        [WAL_WRITE_DEATH_REQUEST, 0],
        [WAL_WRITE_DEATH_PREPARING, 0],
        [WAL_WRITE_DEATH_READY, 0],
      ]),
    );
    expect(parsedWalWriteDeathMarkers()).toEqual([
      {
        schema: 1,
        suite: 'android-db-wal-write-death',
        status: 'ready',
        phase: 'prepare',
        checks: {
          requestValid: true,
          ...walWriteDeathPrepareChecks,
          readyStatePersisted: true,
        },
      },
    ]);
  });

  it('uses the same exclusive dispatcher for active-migration prepare and emits its finite READY marker', async () => {
    createExisting(ACTIVE_MIGRATION_DEATH_REQUEST);
    mockPrepareActiveMigrationDeathDatabase.mockImplementation(
      async (onPrepared: (checks: typeof activeMigrationDeathPrepareChecks) => Promise<never>) =>
        onPrepared(activeMigrationDeathPrepareChecks),
    );
    const contract = loadContract();

    const first = contract.startDevDbRelaunchContractIfRequested();
    const second = contract.startDevDbRelaunchContractIfRequested();
    await flushMicrotasks();

    expect(first).toBe(second);
    expect(mockPrepareActiveMigrationDeathDatabase).toHaveBeenCalledTimes(1);
    expect(mockPrepareWalWriteDeathDatabase).not.toHaveBeenCalled();
    expect(mockPrepareDatabase).not.toHaveBeenCalled();
    expect(mockFiles).toEqual(
      new Map([
        [ACTIVE_MIGRATION_DEATH_REQUEST, 0],
        [ACTIVE_MIGRATION_DEATH_PREPARING, 0],
        [ACTIVE_MIGRATION_DEATH_READY, 0],
      ]),
    );
    expect(parsedActiveMigrationDeathMarkers()).toEqual([
      {
        schema: 1,
        suite: 'android-db-active-migration-death',
        status: 'ready',
        phase: 'prepare',
        checks: {
          requestValid: true,
          ...activeMigrationDeathPrepareChecks,
          readyStatePersisted: true,
        },
      },
    ]);
  });

  it('runs the one-launch runtime concurrency lane before ordinary boot and emits one finite PASS', async () => {
    createExisting(RUNTIME_CONCURRENCY_REQUEST);
    mockRunRuntimeConcurrencyDatabase.mockImplementation(async (runWave) => {
      expect(runWave).toBe(mockRunRuntimeConcurrencyWave);
      expect(mockFiles.get(RUNTIME_CONCURRENCY_RUNNING)).toBe(0);
      return { status: 'pass', checks: runtimeConcurrencyDatabaseChecks };
    });
    const contract = loadContract();

    const first = contract.startDevDbRelaunchContractIfRequested();
    const second = contract.startDevDbRelaunchContractIfRequested();
    await flushMicrotasks();

    expect(first).toBe(second);
    expect(mockRunRuntimeConcurrencyDatabase).toHaveBeenCalledTimes(1);
    expect(mockPrepareDatabase).not.toHaveBeenCalled();
    expect(mockFiles.size).toBe(0);
    expect(parsedRuntimeConcurrencyMarkers()).toEqual([
      {
        schema: 1,
        suite: 'android-db-runtime-concurrency',
        status: 'pass',
        migrationCount: 42,
        migrationHead: '0042_message_part_identity',
        checks: {
          requestValid: true,
          runStatePersisted: true,
          ...runtimeConcurrencyDatabaseChecks,
          stateCleanup: true,
        },
      },
    ]);
  });

  it('preserves the exact runtime wave failure while completing both cleanup layers', async () => {
    createExisting(RUNTIME_CONCURRENCY_REQUEST);
    mockRunRuntimeConcurrencyDatabase.mockResolvedValue({
      status: 'fail',
      checks: { ...runtimeConcurrencyDatabaseChecks, queuedWritersBlocked: false },
      failureCode: 'queued-writers-blocked',
    });
    const contract = loadContract();

    contract.startDevDbRelaunchContractIfRequested();
    await flushMicrotasks();

    expect(mockFiles.size).toBe(0);
    expect(parsedRuntimeConcurrencyMarkers()).toEqual([
      {
        schema: 1,
        suite: 'android-db-runtime-concurrency',
        status: 'fail',
        migrationCount: 42,
        migrationHead: '0042_message_part_identity',
        checks: {
          requestValid: true,
          runStatePersisted: true,
          ...runtimeConcurrencyDatabaseChecks,
          queuedWritersBlocked: false,
          stateCleanup: true,
        },
        failureCode: 'queued-writers-blocked',
      },
    ]);
  });

  it('recovers an interrupted runtime wave without entering either database workflow', async () => {
    createExisting(RUNTIME_CONCURRENCY_REQUEST, RUNTIME_CONCURRENCY_RUNNING);
    const contract = loadContract();

    contract.startDevDbRelaunchContractIfRequested();
    await flushMicrotasks();

    expect(mockRunRuntimeConcurrencyDatabase).not.toHaveBeenCalled();
    expect(mockPrepareDatabase).not.toHaveBeenCalled();
    expect(mockCleanupRuntimeConcurrencyDatabase).toHaveBeenCalledTimes(1);
    expect(mockCleanupDatabase).toHaveBeenCalledTimes(1);
    expect(mockCleanupWalWriteDeathDatabase).toHaveBeenCalledTimes(1);
    expect(mockCleanupActiveMigrationDeathDatabase).toHaveBeenCalledTimes(1);
    expect(mockFiles.size).toBe(0);
    expect(parsedRuntimeConcurrencyMarkers()[0]).toMatchObject({
      status: 'fail',
      failureCode: 'interrupted-run',
      checks: { requestValid: true, databaseCleanup: true, stateCleanup: true },
    });
  });

  it('maps a failed runtime running marker to run-state and never opens the database', async () => {
    createExisting(RUNTIME_CONCURRENCY_REQUEST);
    mockFileCreateFailures.add(RUNTIME_CONCURRENCY_RUNNING);
    const contract = loadContract();

    contract.startDevDbRelaunchContractIfRequested();
    await flushMicrotasks();

    expect(mockRunRuntimeConcurrencyDatabase).not.toHaveBeenCalled();
    expect(mockCleanupRuntimeConcurrencyDatabase).toHaveBeenCalledTimes(1);
    expect(mockFiles.size).toBe(0);
    expect(parsedRuntimeConcurrencyMarkers()[0]).toMatchObject({
      status: 'fail',
      failureCode: 'run-state',
      checks: {
        requestValid: true,
        runStatePersisted: false,
        databaseCleanup: true,
        stateCleanup: true,
      },
    });
  });

  it('rejects a runtime request beside another lane and cleans every fixed database', async () => {
    createExisting(RUNTIME_CONCURRENCY_REQUEST, REQUEST);
    const contract = loadContract();

    contract.startDevDbRelaunchContractIfRequested();
    await flushMicrotasks();

    expect(mockRunRuntimeConcurrencyDatabase).not.toHaveBeenCalled();
    expect(mockPrepareDatabase).not.toHaveBeenCalled();
    expect(mockCleanupRuntimeConcurrencyDatabase).toHaveBeenCalledTimes(1);
    expect(mockCleanupDatabase).toHaveBeenCalledTimes(1);
    expect(mockCleanupWalWriteDeathDatabase).toHaveBeenCalledTimes(1);
    expect(mockCleanupActiveMigrationDeathDatabase).toHaveBeenCalledTimes(1);
    expect(mockFiles.size).toBe(0);
    expect(parsedRuntimeConcurrencyMarkers()[0]).toMatchObject({
      status: 'fail',
      failureCode: 'phase-invalid',
      checks: { requestValid: false, databaseCleanup: true, stateCleanup: true },
    });
  });

  it('resumes only from ready state, arms resuming, emits PASS after exact cleanup', async () => {
    createExisting(REQUEST, PREPARING, READY);
    mockResumeDatabase.mockImplementation(async (onReadOnlyVerified: () => void) => {
      onReadOnlyVerified();
      expect(mockFiles.get(RESUMING)).toBe(0);
      return {
        status: 'pass',
        migrationCount: 42,
        migrationHead: '0042_message_part_identity',
        checks: resumeChecks,
      };
    });
    const contract = loadContract();

    contract.startDevDbRelaunchContractIfRequested();
    await flushMicrotasks();

    expect(mockResumeDatabase).toHaveBeenCalledTimes(1);
    expect(mockFiles.size).toBe(0);
    const deleteOperations = mockFileOperations.filter((operation) =>
      operation.startsWith('delete:'),
    );
    expect(deleteOperations).toEqual([
      `delete:${REQUEST}`,
      `delete:${RESUMING}`,
      `delete:${READY}`,
      `delete:${PREPARING}`,
    ]);
    expect(parsedMarkers()).toEqual([
      {
        schema: 1,
        suite: 'android-db-relaunch',
        status: 'pass',
        phase: 'resume',
        migrationCount: 42,
        migrationHead: '0042_message_part_identity',
        checks: {
          requestValid: true,
          phaseValid: true,
          ...resumeChecks,
          stateCleanup: true,
        },
      },
    ]);
  });

  it('resumes active-WAL only after read-only proof and removes its exact phase state', async () => {
    createExisting(WAL_WRITE_DEATH_REQUEST, WAL_WRITE_DEATH_PREPARING, WAL_WRITE_DEATH_READY);
    mockResumeWalWriteDeathDatabase.mockImplementation(async (onReadOnlyVerified: () => void) => {
      onReadOnlyVerified();
      expect(mockFiles.get(WAL_WRITE_DEATH_RESUMING)).toBe(0);
      return { status: 'pass', checks: walWriteDeathResumeChecks };
    });
    const contract = loadContract();

    contract.startDevDbRelaunchContractIfRequested();
    await flushMicrotasks();

    expect(mockResumeWalWriteDeathDatabase).toHaveBeenCalledTimes(1);
    expect(mockResumeDatabase).not.toHaveBeenCalled();
    expect(mockFiles.size).toBe(0);
    const deleteOperations = mockFileOperations.filter((operation) =>
      operation.startsWith('delete:'),
    );
    expect(deleteOperations).toEqual([
      `delete:${WAL_WRITE_DEATH_REQUEST}`,
      `delete:${WAL_WRITE_DEATH_RESUMING}`,
      `delete:${WAL_WRITE_DEATH_READY}`,
      `delete:${WAL_WRITE_DEATH_PREPARING}`,
    ]);
    expect(parsedWalWriteDeathMarkers()).toEqual([
      {
        schema: 1,
        suite: 'android-db-wal-write-death',
        status: 'pass',
        phase: 'resume',
        checks: {
          requestValid: true,
          phaseValid: true,
          ...walWriteDeathResumeChecks,
          stateCleanup: true,
        },
      },
    ]);
  });

  it('resumes active-migration only after read-only proof and removes its exact phase state', async () => {
    createExisting(
      ACTIVE_MIGRATION_DEATH_REQUEST,
      ACTIVE_MIGRATION_DEATH_PREPARING,
      ACTIVE_MIGRATION_DEATH_READY,
    );
    mockResumeActiveMigrationDeathDatabase.mockImplementation(
      async (onReadOnlyVerified: () => void) => {
        onReadOnlyVerified();
        expect(mockFiles.get(ACTIVE_MIGRATION_DEATH_RESUMING)).toBe(0);
        return {
          status: 'pass',
          migrationCount: 42,
          migrationHead: '0042_message_part_identity',
          checks: activeMigrationDeathResumeChecks,
        };
      },
    );
    const contract = loadContract();

    contract.startDevDbRelaunchContractIfRequested();
    await flushMicrotasks();

    expect(mockResumeActiveMigrationDeathDatabase).toHaveBeenCalledTimes(1);
    expect(mockResumeWalWriteDeathDatabase).not.toHaveBeenCalled();
    expect(mockResumeDatabase).not.toHaveBeenCalled();
    expect(mockFiles.size).toBe(0);
    const deleteOperations = mockFileOperations.filter((operation) =>
      operation.startsWith('delete:'),
    );
    expect(deleteOperations).toEqual([
      `delete:${ACTIVE_MIGRATION_DEATH_REQUEST}`,
      `delete:${ACTIVE_MIGRATION_DEATH_RESUMING}`,
      `delete:${ACTIVE_MIGRATION_DEATH_READY}`,
      `delete:${ACTIVE_MIGRATION_DEATH_PREPARING}`,
    ]);
    expect(parsedActiveMigrationDeathMarkers()).toEqual([
      {
        schema: 1,
        suite: 'android-db-active-migration-death',
        status: 'pass',
        phase: 'resume',
        migrationCount: 42,
        migrationHead: '0042_message_part_identity',
        checks: {
          requestValid: true,
          phaseValid: true,
          ...activeMigrationDeathResumeChecks,
          stateCleanup: true,
        },
      },
    ]);
  });

  it('rejects simultaneous scenario requests and cleans both fixed databases', async () => {
    createExisting(REQUEST, WAL_WRITE_DEATH_REQUEST);
    const contract = loadContract();

    contract.startDevDbRelaunchContractIfRequested();
    await flushMicrotasks();

    expect(mockPrepareDatabase).not.toHaveBeenCalled();
    expect(mockPrepareWalWriteDeathDatabase).not.toHaveBeenCalled();
    expect(mockCleanupDatabase).toHaveBeenCalledTimes(1);
    expect(mockCleanupWalWriteDeathDatabase).toHaveBeenCalledTimes(1);
    expect(mockFiles.size).toBe(0);
    expect(parsedWalWriteDeathMarkers()[0]).toMatchObject({
      status: 'fail',
      phase: 'recovery',
      failureCode: 'phase-invalid',
      checks: { requestValid: false, databaseCleanup: true, stateCleanup: true },
    });
  });

  it.each([
    {
      label: 'relaunch and active-migration requests',
      files: [REQUEST, ACTIVE_MIGRATION_DEATH_REQUEST],
    },
    {
      label: 'active-WAL and active-migration requests',
      files: [WAL_WRITE_DEATH_REQUEST, ACTIVE_MIGRATION_DEATH_REQUEST],
    },
    {
      label: 'all three requests',
      files: [REQUEST, WAL_WRITE_DEATH_REQUEST, ACTIVE_MIGRATION_DEATH_REQUEST],
    },
    {
      label: 'relaunch request with active-migration ready state',
      files: [REQUEST, ACTIVE_MIGRATION_DEATH_PREPARING, ACTIVE_MIGRATION_DEATH_READY],
    },
  ])('rejects $label and cleans all three fixed databases', async ({ files }) => {
    createExisting(...files);
    const contract = loadContract();

    contract.startDevDbRelaunchContractIfRequested();
    await flushMicrotasks();

    expect(mockPrepareDatabase).not.toHaveBeenCalled();
    expect(mockPrepareWalWriteDeathDatabase).not.toHaveBeenCalled();
    expect(mockPrepareActiveMigrationDeathDatabase).not.toHaveBeenCalled();
    expect(mockResumeDatabase).not.toHaveBeenCalled();
    expect(mockResumeWalWriteDeathDatabase).not.toHaveBeenCalled();
    expect(mockResumeActiveMigrationDeathDatabase).not.toHaveBeenCalled();
    expect(mockCleanupDatabase).toHaveBeenCalledTimes(1);
    expect(mockCleanupWalWriteDeathDatabase).toHaveBeenCalledTimes(1);
    expect(mockCleanupActiveMigrationDeathDatabase).toHaveBeenCalledTimes(1);
    expect(mockFiles.size).toBe(0);
    expect(parsedActiveMigrationDeathMarkers()[0]).toMatchObject({
      status: 'fail',
      phase: 'recovery',
      failureCode: 'phase-invalid',
      checks: { requestValid: false, databaseCleanup: true, stateCleanup: true },
    });
  });

  it('attributes an orphaned active-migration phase to its recovery and cleans all databases', async () => {
    createExisting(ACTIVE_MIGRATION_DEATH_READY);
    const contract = loadContract();

    contract.startDevDbRelaunchContractIfRequested();
    await flushMicrotasks();

    expect(mockPrepareActiveMigrationDeathDatabase).not.toHaveBeenCalled();
    expect(mockResumeActiveMigrationDeathDatabase).not.toHaveBeenCalled();
    expect(mockCleanupDatabase).toHaveBeenCalledTimes(1);
    expect(mockCleanupWalWriteDeathDatabase).toHaveBeenCalledTimes(1);
    expect(mockCleanupActiveMigrationDeathDatabase).toHaveBeenCalledTimes(1);
    expect(mockFiles.size).toBe(0);
    expect(parsedActiveMigrationDeathMarkers()[0]).toMatchObject({
      status: 'fail',
      phase: 'recovery',
      failureCode: 'orphaned-state',
      checks: { requestValid: false, databaseCleanup: true, stateCleanup: true },
    });
  });

  it('attributes an orphaned WAL phase to WAL recovery and cleans both fixed databases', async () => {
    createExisting(WAL_WRITE_DEATH_READY);
    const contract = loadContract();

    contract.startDevDbRelaunchContractIfRequested();
    await flushMicrotasks();

    expect(mockPrepareWalWriteDeathDatabase).not.toHaveBeenCalled();
    expect(mockResumeWalWriteDeathDatabase).not.toHaveBeenCalled();
    expect(mockCleanupDatabase).toHaveBeenCalledTimes(1);
    expect(mockCleanupWalWriteDeathDatabase).toHaveBeenCalledTimes(1);
    expect(mockFiles.size).toBe(0);
    expect(parsedWalWriteDeathMarkers()[0]).toMatchObject({
      status: 'fail',
      phase: 'recovery',
      failureCode: 'orphaned-state',
      checks: { requestValid: false, databaseCleanup: true, stateCleanup: true },
    });
  });

  it('rejects cross-scenario request and phase coexistence without resuming either lane', async () => {
    createExisting(REQUEST, WAL_WRITE_DEATH_PREPARING, WAL_WRITE_DEATH_READY);
    const contract = loadContract();

    contract.startDevDbRelaunchContractIfRequested();
    await flushMicrotasks();

    expect(mockResumeDatabase).not.toHaveBeenCalled();
    expect(mockResumeWalWriteDeathDatabase).not.toHaveBeenCalled();
    expect(mockCleanupDatabase).toHaveBeenCalledTimes(1);
    expect(mockCleanupWalWriteDeathDatabase).toHaveBeenCalledTimes(1);
    expect(mockFiles.size).toBe(0);
    expect(parsedWalWriteDeathMarkers()[0]).toMatchObject({
      status: 'fail',
      phase: 'recovery',
      failureCode: 'phase-invalid',
      checks: { requestValid: false, databaseCleanup: true, stateCleanup: true },
    });
  });

  it('retains durable state and emits database-cleanup when final DB cleanup failed', async () => {
    createExisting(REQUEST, PREPARING, READY);
    mockResumeDatabase.mockImplementation(async (onReadOnlyVerified: () => void) => {
      onReadOnlyVerified();
      return {
        status: 'fail',
        migrationCount: 42,
        migrationHead: '0042_message_part_identity',
        checks: { ...resumeChecks, databaseCleanup: false },
        failureCode: 'database-cleanup',
      };
    });
    const contract = loadContract();

    contract.startDevDbRelaunchContractIfRequested();
    await flushMicrotasks();

    expect(mockFiles).toEqual(
      new Map([
        [REQUEST, 0],
        [PREPARING, 0],
        [READY, 0],
        [RESUMING, 0],
      ]),
    );
    expect(parsedMarkers()[0]).toMatchObject({
      status: 'fail',
      phase: 'resume',
      failureCode: 'database-cleanup',
      checks: { databaseCleanup: false, stateCleanup: false },
    });
  });

  it('does not remove phase markers when request deletion fails', async () => {
    createExisting(REQUEST, PREPARING, READY);
    mockFileDeleteFailures.add(REQUEST);
    mockResumeDatabase.mockImplementation(async (onReadOnlyVerified: () => void) => {
      onReadOnlyVerified();
      return {
        status: 'pass',
        migrationCount: 42,
        migrationHead: '0042_message_part_identity',
        checks: resumeChecks,
      };
    });
    const contract = loadContract();

    contract.startDevDbRelaunchContractIfRequested();
    await flushMicrotasks();

    expect(mockFiles.has(REQUEST)).toBe(true);
    expect(mockFiles.has(PREPARING)).toBe(true);
    expect(mockFiles.has(READY)).toBe(true);
    expect(mockFiles.has(RESUMING)).toBe(true);
    expect(mockFileOperations).not.toContain(`delete:${READY}`);
    expect(parsedMarkers()[0]).toMatchObject({
      status: 'fail',
      failureCode: 'state-cleanup',
      checks: { databaseCleanup: true, stateCleanup: false },
    });
  });

  it.each([
    {
      label: 'interrupted prepare',
      files: [REQUEST, PREPARING],
      failureCode: 'interrupted-prepare',
      requestValid: true,
    },
    {
      label: 'interrupted resume',
      files: [REQUEST, PREPARING, READY, RESUMING],
      failureCode: 'interrupted-resume',
      requestValid: true,
    },
    {
      label: 'orphan phase',
      files: [READY],
      failureCode: 'orphaned-state',
      requestValid: false,
    },
  ])(
    'cleans $label without opening a phase workflow',
    async ({ files, failureCode, requestValid }) => {
      createExisting(...files);
      const contract = loadContract();

      contract.startDevDbRelaunchContractIfRequested();
      await flushMicrotasks();

      expect(mockCleanupDatabase).toHaveBeenCalledTimes(1);
      expect(mockPrepareDatabase).not.toHaveBeenCalled();
      expect(mockResumeDatabase).not.toHaveBeenCalled();
      expect(mockFiles.size).toBe(0);
      expect(parsedMarkers()[0]).toMatchObject({
        status: 'fail',
        phase: 'recovery',
        failureCode,
        checks: { requestValid, phaseValid: false, databaseCleanup: true, stateCleanup: true },
      });
    },
  );

  it('rejects a non-zero request and logs only finite allowlisted data', async () => {
    createExisting([REQUEST, 7]);
    const privateFailureText = 'private file failure with /data/user/0/path';
    mockCleanupDatabase.mockImplementation(() => {
      void privateFailureText;
      return true;
    });
    const contract = loadContract();

    contract.startDevDbRelaunchContractIfRequested();
    await flushMicrotasks();

    expect(parsedMarkers()[0]).toMatchObject({
      status: 'fail',
      phase: 'recovery',
      failureCode: 'request-invalid',
      checks: { requestValid: false },
    });
    expect(JSON.stringify(mockLogger.info.mock.calls)).not.toContain(privateFailureText);
    expect(JSON.stringify(mockLogger.info.mock.calls)).not.toContain('/data/');
  });

  it('maps a failed READY marker to a finite failure and removes all exact state', async () => {
    createExisting(REQUEST);
    mockFileCreateFailures.add(READY);
    mockPrepareDatabase.mockImplementation(
      async (onPrepared: (checks: typeof prepareChecks) => Promise<never>) =>
        onPrepared(prepareChecks),
    );
    const contract = loadContract();

    contract.startDevDbRelaunchContractIfRequested();
    await flushMicrotasks();

    expect(mockCleanupDatabase).toHaveBeenCalledTimes(1);
    expect(mockFiles.size).toBe(0);
    expect(parsedMarkers()[0]).toMatchObject({
      status: 'fail',
      phase: 'prepare',
      failureCode: 'ready-state',
      checks: { requestValid: true, readyStatePersisted: false },
    });
  });

  it('fails closed on an impossible or non-zero phase marker', async () => {
    createExisting(REQUEST, [READY, 4]);
    const contract = loadContract();

    contract.startDevDbRelaunchContractIfRequested();
    await flushMicrotasks();

    expect(mockPrepareDatabase).not.toHaveBeenCalled();
    expect(mockResumeDatabase).not.toHaveBeenCalled();
    expect(mockFiles.size).toBe(0);
    expect(parsedMarkers()[0]).toMatchObject({
      status: 'fail',
      phase: 'recovery',
      failureCode: 'phase-invalid',
      checks: { requestValid: true, phaseValid: false },
    });
  });

  it.each([
    { label: 'ready without preparing', files: [REQUEST, READY] },
    { label: 'resuming without prior phases', files: [REQUEST, RESUMING] },
    { label: 'resuming before ready', files: [REQUEST, PREPARING, RESUMING] },
    { label: 'ready and resuming without preparing', files: [REQUEST, READY, RESUMING] },
  ])('fails closed on zero-byte impossible state: $label', async ({ files }) => {
    createExisting(...files);
    const contract = loadContract();

    contract.startDevDbRelaunchContractIfRequested();
    await flushMicrotasks();

    expect(mockPrepareDatabase).not.toHaveBeenCalled();
    expect(mockResumeDatabase).not.toHaveBeenCalled();
    expect(mockFiles.size).toBe(0);
    expect(parsedMarkers()[0]).toMatchObject({
      status: 'fail',
      phase: 'recovery',
      failureCode: 'phase-invalid',
      checks: { requestValid: true, phaseValid: false },
    });
  });

  it('retains the request and preparing marker when prepare cleanup is unconfirmed', async () => {
    createExisting(REQUEST);
    mockPrepareDatabase.mockResolvedValue({
      status: 'fail',
      checks: {
        preCleanup: true,
        encryptedOpen: true,
        migrationRollback: false,
        partialLedger: false,
        continuitySentinel: false,
      },
      failureCode: 'migration-rollback',
      databaseCleanup: false,
    });
    const contract = loadContract();

    contract.startDevDbRelaunchContractIfRequested();
    await flushMicrotasks();

    expect(mockFiles.has(REQUEST)).toBe(true);
    expect(mockFiles.has(PREPARING)).toBe(true);
    expect(parsedMarkers()[0]).toMatchObject({
      status: 'fail',
      phase: 'prepare',
      failureCode: 'database-cleanup',
      checks: { migrationRollback: false, readyStatePersisted: false },
    });
  });

  it('keeps recovery state when the fixed database cannot be cleaned', async () => {
    createExisting(REQUEST, PREPARING);
    mockCleanupDatabase.mockReturnValue(false);
    const contract = loadContract();

    contract.startDevDbRelaunchContractIfRequested();
    await flushMicrotasks();

    expect(mockFiles.has(REQUEST)).toBe(true);
    expect(mockFiles.has(PREPARING)).toBe(true);
    expect(parsedMarkers()[0]).toMatchObject({
      status: 'fail',
      phase: 'recovery',
      failureCode: 'database-cleanup',
      checks: { databaseCleanup: false, stateCleanup: false },
    });
  });
});
