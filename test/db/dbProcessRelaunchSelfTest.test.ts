const mockOpen = jest.fn();
const mockRunMigrations = jest.fn();

jest.mock('@op-engineering/op-sqlite', () => ({ open: mockOpen }));
jest.mock('@db/migrate', () => ({ runMigrations: mockRunMigrations }));

let cleanupDbProcessRelaunchSelfTestDatabase: typeof import('@db/database').cleanupDbProcessRelaunchSelfTestDatabase;
let prepareDbProcessRelaunchSelfTest: typeof import('@db/database').prepareDbProcessRelaunchSelfTest;
let resumeDbProcessRelaunchSelfTest: typeof import('@db/database').resumeDbProcessRelaunchSelfTest;
let cleanupDbActiveWalWriteDeathSelfTestDatabase: typeof import('@db/database').cleanupDbActiveWalWriteDeathSelfTestDatabase;
let prepareDbActiveWalWriteDeathSelfTest: typeof import('@db/database').prepareDbActiveWalWriteDeathSelfTest;
let resumeDbActiveWalWriteDeathSelfTest: typeof import('@db/database').resumeDbActiveWalWriteDeathSelfTest;
let cleanupDbActiveMigrationDeathSelfTestDatabase: typeof import('@db/database').cleanupDbActiveMigrationDeathSelfTestDatabase;
let prepareDbActiveMigrationDeathSelfTest: typeof import('@db/database').prepareDbActiveMigrationDeathSelfTest;
let resumeDbActiveMigrationDeathSelfTest: typeof import('@db/database').resumeDbActiveMigrationDeathSelfTest;

const migrationNames = (
  jest.requireActual('@db/migrations') as typeof import('@db/migrations')
).MIGRATIONS.map((migration) => migration.name);
const partialMigrationNames = migrationNames.slice(0, 29);
const tailMigrationNames = migrationNames.slice(29);

const DB_NAME = 'driver-relaunch-selftest.db';
const FIXED_KEY = 'db-03b1-public-throwaway-key-v1';
const CONTINUITY_SENTINEL = 'driver-relaunch-continuity-v1';
const WAL_DB_NAME = 'driver-wal-write-death-selftest.db';
const WAL_FIXED_KEY = 'db-03b2b1-public-throwaway-key-v1';
const WAL_BASELINE = 'db-03b2b1-baseline-v1';
const WAL_RECOVERY = 'db-03b2b1-recovery-v1';
const MIGRATION_DEATH_DB_NAME = 'driver-active-migration-death-selftest.db';
const MIGRATION_DEATH_FIXED_KEY = 'db-03b2b2-public-throwaway-key-v1';
const ACTIVE_MIGRATION_TARGET = migrationNames[37] ?? '';
const ACTIVE_MIGRATION_SQL = (
  jest.requireActual('@db/migrations') as typeof import('@db/migrations')
).MIGRATIONS[37]?.statements[0];

interface RelaunchState {
  complete: boolean;
  conflictOwner?: string;
  rolledBackTablePresent?: boolean;
  sentinel?: string;
}

function cleanupHandle(deleteFails = false) {
  return {
    close: jest.fn(),
    delete: jest.fn(() => {
      if (deleteFails) throw new Error('simulated fixed-file cleanup failure');
    }),
  };
}

function databaseHandle(state: RelaunchState, rejectAllReads = false) {
  const execute = jest.fn(async (statement: string) => {
    if (rejectAllReads) throw new Error('simulated unreadable encrypted database');
    const normalized = statement.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalized === 'pragma foreign_keys') return { rows: [{ foreign_keys: 1 }] };
    if (normalized === 'pragma integrity_check') return { rows: [{ integrity_check: 'ok' }] };
    if (normalized === 'pragma foreign_key_check') return { rows: [] };
    if (normalized === 'select count(*) from sqlite_master') return { rows: [{ count: 1 }] };
    if (normalized === 'select name from _migrations order by name') {
      const names = state.complete ? migrationNames : partialMigrationNames;
      return { rows: names.map((name) => ({ name })) };
    }
    if (
      normalized.includes("type = 'table'") &&
      normalized.includes("name = 'attachment_cache_entries'")
    ) {
      return { rows: state.rolledBackTablePresent ? [{ name: 'attachment_cache_entries' }] : [] };
    }
    if (
      normalized.includes("type = 'index'") &&
      normalized.includes('attachment_cache_entries_state_lru_idx')
    ) {
      return {
        rows: [
          {
            tbl_name: state.conflictOwner ?? 'driver_relaunch_contract_state',
          },
        ],
      };
    }
    if (normalized.startsWith('select continuity_value from driver_relaunch_contract_state')) {
      return { rows: [{ continuity_value: state.sentinel ?? CONTINUITY_SENTINEL }] };
    }
    return { rows: [], rowsAffected: 1 };
  });
  return {
    execute,
    close: jest.fn(),
    delete: jest.fn(),
  };
}

interface WalWriteDeathState {
  baseline: boolean;
  canaries: number;
  recovery: boolean;
  extras?: Array<{ id: number; state: string }>;
}

function walWriteDeathHandle(
  state: WalWriteDeathState,
  rejectFirstRead = false,
  checkpointSucceeds = true,
) {
  let first = true;
  let transactionOpen = false;
  let pendingBaseline = false;
  let pendingCanaries = 0;
  let pendingRecovery = false;
  const execute = jest.fn(async (statement: string) => {
    if (rejectFirstRead && first) {
      first = false;
      throw new Error('simulated read-only recovery failure');
    }
    first = false;
    const normalized = statement.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalized === 'select count(*) from sqlite_master') return { rows: [{ count: 1 }] };
    if (normalized === 'pragma journal_mode = wal' || normalized === 'pragma journal_mode') {
      return { rows: [{ journal_mode: 'wal' }] };
    }
    if (normalized === 'pragma wal_checkpoint(truncate)') {
      return {
        rows: [
          checkpointSucceeds
            ? { busy: 0, log: 0, checkpointed: 0 }
            : { busy: 1, log: 1, checkpointed: 0 },
        ],
      };
    }
    if (normalized === 'pragma integrity_check') return { rows: [{ integrity_check: 'ok' }] };
    if (normalized === 'pragma foreign_keys') return { rows: [{ foreign_keys: 1 }] };
    if (normalized === 'pragma foreign_key_check') return { rows: [] };
    if (normalized === 'begin immediate') {
      transactionOpen = true;
      return { rows: [] };
    }
    if (normalized.startsWith('insert into driver_wal_write_death_contract (id, state, payload)')) {
      if (normalized.includes('values (1,')) pendingBaseline = true;
      else if (normalized.includes('values (2,')) pendingRecovery = true;
      return { rows: [], rowsAffected: 1 };
    }
    if (normalized.startsWith('with recursive canary')) {
      pendingCanaries = 128;
      return { rows: [], rowsAffected: 128 };
    }
    if (normalized === 'commit') {
      state.baseline ||= pendingBaseline;
      state.canaries += pendingCanaries;
      state.recovery ||= pendingRecovery;
      pendingBaseline = false;
      pendingCanaries = 0;
      pendingRecovery = false;
      transactionOpen = false;
      return { rows: [] };
    }
    if (normalized === 'rollback') {
      pendingBaseline = false;
      pendingCanaries = 0;
      pendingRecovery = false;
      transactionOpen = false;
      return { rows: [] };
    }
    if (normalized.startsWith('select id, state from driver_wal_write_death_contract')) {
      const rows: Array<{ id: number; state: string }> = [];
      if (state.baseline || pendingBaseline) rows.push({ id: 1, state: WAL_BASELINE });
      if (state.recovery || pendingRecovery) rows.push({ id: 2, state: WAL_RECOVERY });
      const visibleCanaries = state.canaries + pendingCanaries;
      for (let index = 0; index < visibleCanaries; index += 1) {
        rows.push({ id: 100 + index, state: 'uncommitted' });
      }
      rows.push(...(state.extras ?? []));
      return { rows: rows.sort((left, right) => left.id - right.id) };
    }
    return { rows: [], rowsAffected: 1 };
  });
  return {
    execute,
    close: jest.fn(),
    delete: jest.fn(),
    transactionOpen: () => transactionOpen,
  };
}

function walWriteDeathRetirementHandle(
  options: {
    checkpointSucceeds?: boolean;
    deleteModeSelected?: boolean;
    deleteModeConfirmed?: boolean;
    closeFails?: boolean;
  } = {},
) {
  const {
    checkpointSucceeds = true,
    deleteModeSelected = true,
    deleteModeConfirmed = true,
    closeFails = false,
  } = options;
  const executeSync = jest.fn((statement: string) => {
    const normalized = statement.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalized === 'pragma wal_checkpoint(truncate)') {
      return {
        rows: [
          checkpointSucceeds
            ? { busy: 0, log: 0, checkpointed: 0 }
            : { busy: 1, log: 1, checkpointed: 0 },
        ],
      };
    }
    if (normalized === 'pragma journal_mode = delete') {
      return { rows: [{ journal_mode: deleteModeSelected ? 'delete' : 'wal' }] };
    }
    if (normalized === 'pragma journal_mode') {
      return { rows: [{ journal_mode: deleteModeConfirmed ? 'delete' : 'wal' }] };
    }
    throw new Error('unexpected retirement statement');
  });
  return {
    executeSync,
    close: jest.fn(() => {
      if (closeFails) throw new Error('simulated WAL retirement close failure');
    }),
    delete: jest.fn(),
  };
}

interface ActiveMigrationFixtureRow {
  temp_guid: string;
  kind: string;
  payload: string;
}

interface ActiveMigrationState {
  ledger: string[];
  rows: ActiveMigrationFixtureRow[];
  transactionOpen: boolean;
  pendingLedger?: string;
  pendingRows: ActiveMigrationFixtureRow[];
  pendingMigration: boolean;
  extras?: ActiveMigrationFixtureRow[];
}

function activeMigrationFixtureRows(migrated: boolean): ActiveMigrationFixtureRow[] {
  const selectedMessageText = 'x'.repeat(8_192);
  const rows: ActiveMigrationFixtureRow[] = [];
  for (let index = 0; index < 128; index += 1) {
    const suffix = index.toString().padStart(3, '0');
    const payload: Record<string, unknown> = {
      targetGuid: `driver-active-migration-target-${suffix}`,
      reaction: 2000,
    };
    if (!migrated) payload.selectedMessageText = selectedMessageText;
    payload.nested = { keep: `preserved-${suffix}` };
    rows.push({
      temp_guid: `driver-active-migration-death-target-${suffix}`,
      kind: 'reaction',
      payload: JSON.stringify(payload),
    });
  }
  rows.push(
    {
      temp_guid: 'driver-active-migration-death-control-no-field',
      kind: 'reaction',
      payload: JSON.stringify({
        targetGuid: 'driver-active-migration-no-field',
        reaction: 2000,
        nested: { keep: 'no-field' },
      }),
    },
    {
      temp_guid: 'driver-active-migration-death-control-nonreaction',
      kind: 'message',
      payload: JSON.stringify({ selectedMessageText: 'preserve', body: 'message-control' }),
    },
    {
      temp_guid: 'driver-active-migration-death-control-malformed',
      kind: 'reaction',
      payload: '{"selectedMessageText":',
    },
    {
      temp_guid: 'driver-active-migration-death-control-null',
      kind: 'reaction',
      payload: JSON.stringify(
        migrated
          ? { targetGuid: 'driver-active-migration-null', reaction: 2000, nested: { keep: 'null' } }
          : {
              targetGuid: 'driver-active-migration-null',
              reaction: 2000,
              selectedMessageText: null,
              nested: { keep: 'null' },
            },
      ),
    },
    {
      temp_guid: 'driver-active-migration-death-control-empty',
      kind: 'reaction',
      payload: JSON.stringify(
        migrated
          ? {
              targetGuid: 'driver-active-migration-empty',
              reaction: 2000,
              nested: { keep: 'empty' },
            }
          : {
              targetGuid: 'driver-active-migration-empty',
              reaction: 2000,
              selectedMessageText: '',
              nested: { keep: 'empty' },
            },
      ),
    },
  );
  return rows.sort((left, right) => left.temp_guid.localeCompare(right.temp_guid));
}

function applyActiveMigration(rows: ActiveMigrationFixtureRow[]): ActiveMigrationFixtureRow[] {
  return rows.map((row) => {
    if (row.kind !== 'reaction') return { ...row };
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      return { ...row };
    }
    if (!Object.prototype.hasOwnProperty.call(payload, 'selectedMessageText')) return { ...row };
    delete payload.selectedMessageText;
    return { ...row, payload: JSON.stringify(payload) };
  });
}

function activeMigrationHandle(
  state: ActiveMigrationState,
  options: { rejectFirstRead?: boolean; checkpointSucceeds?: boolean } = {},
) {
  const { rejectFirstRead = false, checkpointSucceeds = true } = options;
  let first = true;
  const execute = jest.fn(async (statement: string, params: unknown[] = []) => {
    if (rejectFirstRead && first) {
      first = false;
      throw new Error('simulated read-only recovery failure');
    }
    first = false;
    const normalized = statement.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalized === 'select count(*) from sqlite_master') return { rows: [{ count: 1 }] };
    if (normalized === 'pragma journal_mode = wal' || normalized === 'pragma journal_mode') {
      return { rows: [{ journal_mode: 'wal' }] };
    }
    if (normalized === 'pragma wal_checkpoint(truncate)') {
      return {
        rows: [
          checkpointSucceeds
            ? { busy: 0, log: 0, checkpointed: 0 }
            : { busy: 1, log: 1, checkpointed: 0 },
        ],
      };
    }
    if (normalized === 'pragma integrity_check') return { rows: [{ integrity_check: 'ok' }] };
    if (normalized === 'pragma foreign_keys') return { rows: [{ foreign_keys: 1 }] };
    if (normalized === 'pragma foreign_key_check') return { rows: [] };
    if (
      normalized === 'select name from _migrations' ||
      normalized === 'select name from _migrations order by name'
    ) {
      const visible = state.pendingLedger ? [...state.ledger, state.pendingLedger] : state.ledger;
      return { rows: visible.map((name) => ({ name })) };
    }
    if (normalized.startsWith('select temp_guid, kind, payload from outgoing_queue')) {
      const committed = state.pendingMigration ? applyActiveMigration(state.rows) : state.rows;
      return {
        rows: [...committed, ...state.pendingRows, ...(state.extras ?? [])].sort((left, right) =>
          left.temp_guid.localeCompare(right.temp_guid),
        ),
      };
    }
    if (normalized === 'begin' || normalized === 'begin immediate') {
      if (state.transactionOpen) throw new Error('simulated nested transaction');
      state.transactionOpen = true;
      return { rows: [] };
    }
    if (normalized.startsWith('insert into _migrations')) {
      state.pendingLedger = String(params[0]);
      return { rows: [], rowsAffected: 1 };
    }
    if (
      normalized.startsWith('insert into outgoing_queue') &&
      normalized.includes("'driver-active-migration-death-chat'")
    ) {
      state.pendingRows.push({
        temp_guid: String(params[0]),
        kind: String(params[1]),
        payload: String(params[2]),
      });
      return { rows: [], rowsAffected: 1 };
    }
    if (statement === ACTIVE_MIGRATION_SQL) {
      state.pendingMigration = true;
      return { rows: [], rowsAffected: 130 };
    }
    if (normalized === 'commit') {
      if (state.pendingLedger) state.ledger.push(state.pendingLedger);
      if (state.pendingRows.length > 0) state.rows.push(...state.pendingRows);
      if (state.pendingMigration) state.rows = applyActiveMigration(state.rows);
      state.pendingLedger = undefined;
      state.pendingRows = [];
      state.pendingMigration = false;
      state.transactionOpen = false;
      return { rows: [] };
    }
    if (normalized === 'rollback') {
      state.pendingLedger = undefined;
      state.pendingRows = [];
      state.pendingMigration = false;
      state.transactionOpen = false;
      return { rows: [] };
    }
    return { rows: [], rowsAffected: 1 };
  });
  return { execute, close: jest.fn(), delete: jest.fn() };
}

async function simulateProductionMigrations(runner: {
  exec(statement: string, params?: unknown[]): Promise<void>;
  query<T = Record<string, unknown>>(statement: string, params?: unknown[]): Promise<T[]>;
}): Promise<string[]> {
  await runner.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER)',
  );
  const appliedRows = await runner.query<{ name: string }>('SELECT name FROM _migrations');
  const applied = new Set(appliedRows.map((row) => row.name));
  const migrations = (jest.requireActual('@db/migrations') as typeof import('@db/migrations'))
    .MIGRATIONS;
  const ran: string[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    await runner.exec('BEGIN');
    try {
      for (const statement of migration.statements) await runner.exec(statement);
      await runner.exec('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)', [
        migration.name,
        1,
      ]);
      await runner.exec('COMMIT');
    } catch (error) {
      await runner.exec('ROLLBACK').catch(() => undefined);
      throw error;
    }
    ran.push(migration.name);
  }
  return ran;
}

beforeAll(async () => {
  ({
    cleanupDbActiveMigrationDeathSelfTestDatabase,
    cleanupDbActiveWalWriteDeathSelfTestDatabase,
    cleanupDbProcessRelaunchSelfTestDatabase,
    prepareDbActiveMigrationDeathSelfTest,
    prepareDbActiveWalWriteDeathSelfTest,
    prepareDbProcessRelaunchSelfTest,
    resumeDbActiveMigrationDeathSelfTest,
    resumeDbActiveWalWriteDeathSelfTest,
    resumeDbProcessRelaunchSelfTest,
  } = await import('@db/database'));
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('DB-03B1 fixed process-relaunch database contract', () => {
  it('pins the exact production migration boundary used across process death', () => {
    expect(migrationNames).toHaveLength(42);
    expect(migrationNames[28]).toBe('0029_chats_deleted_at');
    expect(migrationNames[29]).toBe('0030_attachment_cache_entries');
    expect(migrationNames[37]).toBe('0038_scrub_reaction_selected_message_text');
    expect(migrationNames[38]).toBe('0039_message_error_message');
    expect(migrationNames[39]).toBe('0040_chats_pin_order');
    expect(migrationNames[40]).toBe('0041_message_balloon_bundle_id');
    expect(migrationNames[41]).toBe('0042_message_part_identity');
  });

  it('prepares exact 0001-0029 state and keeps the encrypted handle open while READY waits', async () => {
    const state: RelaunchState = { complete: false };
    const preCleanup = cleanupHandle();
    const prepared = databaseHandle(state);
    mockOpen.mockReturnValueOnce(preCleanup).mockReturnValueOnce(prepared);
    mockRunMigrations.mockRejectedValueOnce(
      new Error('index attachment_cache_entries_state_lru_idx already exists'),
    );
    const stop = new Error('test releases the never-settling READY callback');
    const onPrepared = jest.fn(async (checks: Record<string, boolean>): Promise<never> => {
      expect(checks).toEqual({
        preCleanup: true,
        encryptedOpen: true,
        migrationRollback: true,
        partialLedger: true,
        continuitySentinel: true,
      });
      expect(prepared.close).not.toHaveBeenCalled();
      throw stop;
    });

    await expect(prepareDbProcessRelaunchSelfTest(onPrepared)).rejects.toBe(stop);

    expect(mockOpen.mock.calls).toEqual([
      [{ name: DB_NAME }],
      [{ name: DB_NAME, encryptionKey: FIXED_KEY }],
    ]);
    expect(preCleanup.delete).toHaveBeenCalledTimes(1);
    expect(prepared.close).toHaveBeenCalledTimes(1);
    expect(mockRunMigrations).toHaveBeenCalledTimes(1);
    expect(onPrepared).toHaveBeenCalledTimes(1);
    expect(prepared.execute.mock.calls.map(([sql]) => String(sql))).toEqual(
      expect.arrayContaining([
        expect.stringContaining('CREATE TABLE driver_relaunch_contract_state'),
        expect.stringContaining('INSERT INTO driver_relaunch_contract_state'),
        expect.stringContaining('CREATE INDEX attachment_cache_entries_state_lru_idx'),
        'SELECT name FROM _migrations ORDER BY name',
      ]),
    );
    expect(JSON.stringify(mockOpen.mock.calls)).not.toContain('gator.db');
  });

  it('fails closed and deletes the fixed disposable file when the deliberate conflict is wrong', async () => {
    const state: RelaunchState = { complete: false };
    const preCleanup = cleanupHandle();
    const prepared = databaseHandle(state);
    const failureCleanup = cleanupHandle();
    mockOpen
      .mockReturnValueOnce(preCleanup)
      .mockReturnValueOnce(prepared)
      .mockReturnValueOnce(failureCleanup);
    mockRunMigrations.mockRejectedValueOnce(new Error('unrelated migration failure'));
    const onPrepared = jest.fn(async (): Promise<never> => new Promise(() => undefined));

    await expect(prepareDbProcessRelaunchSelfTest(onPrepared)).resolves.toEqual({
      status: 'fail',
      checks: {
        preCleanup: true,
        encryptedOpen: true,
        migrationRollback: false,
        partialLedger: false,
        continuitySentinel: false,
      },
      failureCode: 'migration-rollback',
      databaseCleanup: true,
    });
    expect(onPrepared).not.toHaveBeenCalled();
    expect(prepared.close).toHaveBeenCalledTimes(1);
    expect(failureCleanup.delete).toHaveBeenCalledTimes(1);
  });

  it('opens read-only first, proves the exact partial state, then completes and cleans', async () => {
    const state: RelaunchState = { complete: false };
    const readOnly = databaseHandle(state);
    const reopened = databaseHandle(state);
    const cleanup = cleanupHandle();
    mockOpen
      .mockReturnValueOnce(readOnly)
      .mockReturnValueOnce(reopened)
      .mockReturnValueOnce(cleanup);
    mockRunMigrations
      .mockImplementationOnce(async () => {
        state.complete = true;
        return tailMigrationNames;
      })
      .mockResolvedValueOnce([]);
    const onReadOnlyVerified = jest.fn(() => {
      expect(readOnly.close).toHaveBeenCalledTimes(1);
      expect(mockOpen).toHaveBeenCalledTimes(1);
    });

    await expect(resumeDbProcessRelaunchSelfTest(onReadOnlyVerified)).resolves.toEqual({
      status: 'pass',
      migrationCount: 42,
      migrationHead: '0042_message_part_identity',
      checks: {
        readOnlyContinuityOpen: true,
        sameFileState: true,
        partialLedger: true,
        continuitySentinel: true,
        migrationRetry: true,
        migrationLedger: true,
        integrity: true,
        idempotent: true,
        databaseCleanup: true,
      },
    });

    expect(mockOpen.mock.calls).toEqual([
      [{ name: DB_NAME, encryptionKey: FIXED_KEY, readOnly: true }],
      [{ name: DB_NAME, encryptionKey: FIXED_KEY }],
      [{ name: DB_NAME }],
    ]);
    expect(onReadOnlyVerified).toHaveBeenCalledTimes(1);
    expect(readOnly.close).toHaveBeenCalledTimes(1);
    expect(reopened.close).toHaveBeenCalledTimes(1);
    expect(cleanup.delete).toHaveBeenCalledTimes(1);
    expect(mockRunMigrations).toHaveBeenCalledTimes(2);
    const writes = reopened.execute.mock.calls.map(([sql]) => String(sql));
    expect(writes).toContain('DROP INDEX attachment_cache_entries_state_lru_idx');
    expect(writes).toContain('DROP TABLE driver_relaunch_contract_state');
  });

  it('does not use a creating encrypted open when the read-only continuity open fails', async () => {
    const cleanup = cleanupHandle();
    mockOpen.mockImplementationOnce(() => {
      throw new Error('fixed file missing');
    });
    mockOpen.mockReturnValueOnce(cleanup);
    const onReadOnlyVerified = jest.fn();

    await expect(resumeDbProcessRelaunchSelfTest(onReadOnlyVerified)).resolves.toMatchObject({
      status: 'fail',
      failureCode: 'read-only-continuity-open',
      checks: { readOnlyContinuityOpen: false, databaseCleanup: true },
    });
    expect(mockOpen.mock.calls).toEqual([
      [{ name: DB_NAME, encryptionKey: FIXED_KEY, readOnly: true }],
      [{ name: DB_NAME }],
    ]);
    expect(onReadOnlyVerified).not.toHaveBeenCalled();
    expect(mockRunMigrations).not.toHaveBeenCalled();
  });

  it('rejects a recreated or altered partial state before arming resuming or opening read-write', async () => {
    const state: RelaunchState = { complete: false, sentinel: 'different-file-state' };
    const readOnly = databaseHandle(state);
    const cleanup = cleanupHandle();
    mockOpen.mockReturnValueOnce(readOnly).mockReturnValueOnce(cleanup);
    const onReadOnlyVerified = jest.fn();

    await expect(resumeDbProcessRelaunchSelfTest(onReadOnlyVerified)).resolves.toMatchObject({
      status: 'fail',
      failureCode: 'same-file-state',
      checks: {
        readOnlyContinuityOpen: true,
        sameFileState: false,
        partialLedger: true,
        continuitySentinel: false,
        databaseCleanup: true,
      },
    });
    expect(onReadOnlyVerified).not.toHaveBeenCalled();
    expect(mockOpen).toHaveBeenCalledTimes(2);
  });

  it('treats a resuming-marker failure as a same-file failure and still cleans', async () => {
    const state: RelaunchState = { complete: false };
    const readOnly = databaseHandle(state);
    const cleanup = cleanupHandle();
    mockOpen.mockReturnValueOnce(readOnly).mockReturnValueOnce(cleanup);
    const onReadOnlyVerified = jest.fn(() => {
      throw new Error('simulated marker failure');
    });

    await expect(resumeDbProcessRelaunchSelfTest(onReadOnlyVerified)).resolves.toMatchObject({
      status: 'fail',
      failureCode: 'same-file-state',
      checks: {
        readOnlyContinuityOpen: true,
        sameFileState: false,
        partialLedger: true,
        continuitySentinel: true,
        migrationRetry: false,
        databaseCleanup: true,
      },
    });
    expect(readOnly.close).toHaveBeenCalledTimes(1);
    expect(mockOpen).toHaveBeenCalledTimes(2);
  });

  it('reports fixed-file cleanup failure without exposing a broader deletion API', () => {
    const cleanup = cleanupHandle(true);
    mockOpen.mockReturnValueOnce(cleanup);

    expect(cleanupDbProcessRelaunchSelfTestDatabase()).toBe(false);
    expect(mockOpen).toHaveBeenCalledWith({ name: DB_NAME });
    expect(cleanup.close).toHaveBeenCalledTimes(1);
  });
});

describe('DB-03B2B1 fixed active-WAL write-death database contract', () => {
  it('commits a baseline, truncates WAL, and retains a bounded uncommitted transaction at READY', async () => {
    const state: WalWriteDeathState = { baseline: false, canaries: 0, recovery: false };
    const preCleanup = cleanupHandle();
    const prepared = walWriteDeathHandle(state);
    mockOpen.mockReturnValueOnce(preCleanup).mockReturnValueOnce(prepared);
    const stop = new Error('test releases the never-settling READY callback');
    const onPrepared = jest.fn(async (checks: Record<string, boolean>): Promise<never> => {
      expect(checks).toEqual({
        preCleanup: true,
        encryptedOpen: true,
        walMode: true,
        baselineCommitted: true,
        walCheckpointTruncated: true,
        writeTransactionOpen: true,
        uncommittedCanaryWritten: true,
      });
      expect(prepared.close).not.toHaveBeenCalled();
      expect(prepared.transactionOpen()).toBe(true);
      throw stop;
    });

    await expect(prepareDbActiveWalWriteDeathSelfTest(onPrepared)).rejects.toBe(stop);

    expect(mockOpen.mock.calls).toEqual([
      [{ name: WAL_DB_NAME }],
      [{ name: WAL_DB_NAME, encryptionKey: WAL_FIXED_KEY }],
    ]);
    expect(preCleanup.delete).toHaveBeenCalledTimes(1);
    expect(prepared.close).toHaveBeenCalledTimes(1);
    expect(prepared.transactionOpen()).toBe(false);
    expect(state).toEqual({ baseline: true, canaries: 0, recovery: false });
    const statements = prepared.execute.mock.calls.map(([sql]) => String(sql));
    const checkpointIndex = statements.indexOf('PRAGMA wal_checkpoint(TRUNCATE)');
    const beginIndexes = statements.flatMap((sql, index) =>
      sql === 'BEGIN IMMEDIATE' ? [index] : [],
    );
    expect(checkpointIndex).toBeGreaterThan(beginIndexes[0] ?? Number.MAX_SAFE_INTEGER);
    expect(checkpointIndex).toBeLessThan(beginIndexes[1] ?? -1);
    expect(statements).toEqual(expect.arrayContaining([expect.stringContaining('WITH RECURSIVE')]));
    expect(JSON.stringify(mockOpen.mock.calls)).not.toContain('gator.db');
  });

  it('fails closed when the truncate checkpoint does not report exact success', async () => {
    const state: WalWriteDeathState = { baseline: false, canaries: 0, recovery: false };
    const preCleanup = cleanupHandle();
    const prepared = walWriteDeathHandle(state, false, false);
    const failureCleanup = cleanupHandle();
    mockOpen
      .mockReturnValueOnce(preCleanup)
      .mockReturnValueOnce(prepared)
      .mockReturnValueOnce(failureCleanup);
    const onPrepared = jest.fn(async (): Promise<never> => new Promise(() => undefined));

    await expect(prepareDbActiveWalWriteDeathSelfTest(onPrepared)).resolves.toMatchObject({
      status: 'fail',
      failureCode: 'wal-checkpoint',
      checks: { baselineCommitted: true, walCheckpointTruncated: false },
      databaseCleanup: true,
    });
    expect(onPrepared).not.toHaveBeenCalled();
    expect(failureCleanup.delete).toHaveBeenCalledTimes(1);
  });

  it('opens read-only first, rejects uncommitted rows, then commits and proves reopen persistence', async () => {
    const state: WalWriteDeathState = { baseline: true, canaries: 0, recovery: false };
    const readOnly = walWriteDeathHandle(state);
    const reopened = walWriteDeathHandle(state);
    const persisted = walWriteDeathHandle(state);
    const retirement = walWriteDeathRetirementHandle();
    const cleanup = cleanupHandle();
    mockOpen
      .mockReturnValueOnce(readOnly)
      .mockReturnValueOnce(reopened)
      .mockReturnValueOnce(persisted)
      .mockReturnValueOnce(retirement)
      .mockReturnValueOnce(cleanup);
    const onReadOnlyVerified = jest.fn(() => {
      expect(readOnly.close).toHaveBeenCalledTimes(1);
      expect(mockOpen).toHaveBeenCalledTimes(1);
    });

    await expect(resumeDbActiveWalWriteDeathSelfTest(onReadOnlyVerified)).resolves.toEqual({
      status: 'pass',
      checks: {
        readOnlyRecoveryOpen: true,
        walMode: true,
        baselinePresent: true,
        uncommittedAbsent: true,
        integrity: true,
        foreignKeys: true,
        recoveryCommit: true,
        reopenPersistence: true,
        databaseCleanup: true,
      },
    });

    expect(mockOpen.mock.calls).toEqual([
      [{ name: WAL_DB_NAME, encryptionKey: WAL_FIXED_KEY, readOnly: true }],
      [{ name: WAL_DB_NAME, encryptionKey: WAL_FIXED_KEY }],
      [{ name: WAL_DB_NAME, encryptionKey: WAL_FIXED_KEY, readOnly: true }],
      [{ name: WAL_DB_NAME, encryptionKey: WAL_FIXED_KEY }],
      [{ name: WAL_DB_NAME }],
    ]);
    expect(String(readOnly.execute.mock.calls[0]?.[0])).toContain('SELECT id, state');
    expect(onReadOnlyVerified).toHaveBeenCalledTimes(1);
    expect(state).toEqual({ baseline: true, canaries: 0, recovery: true });
    expect(retirement.executeSync.mock.calls.map(([sql]) => String(sql))).toEqual([
      'PRAGMA wal_checkpoint(TRUNCATE)',
      'PRAGMA journal_mode = DELETE',
      'PRAGMA journal_mode',
    ]);
    expect(persisted.close.mock.invocationCallOrder[0]).toBeLessThan(
      mockOpen.mock.invocationCallOrder[3] ?? 0,
    );
    expect(retirement.close.mock.invocationCallOrder[0]).toBeLessThan(
      cleanup.delete.mock.invocationCallOrder[0] ?? 0,
    );
    expect(cleanup.delete).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: 'truncate checkpoint is not exact',
      retirementOptions: { checkpointSucceeds: false },
      cleanupFails: false,
    },
    {
      label: 'DELETE journal mode is not selected',
      retirementOptions: { deleteModeSelected: false },
      cleanupFails: false,
    },
    {
      label: 'DELETE journal mode is not confirmed',
      retirementOptions: { deleteModeConfirmed: false },
      cleanupFails: false,
    },
    {
      label: 'retirement handle does not close',
      retirementOptions: { closeFails: true },
      cleanupFails: false,
    },
    {
      label: 'fixed main-file delete fails',
      retirementOptions: {},
      cleanupFails: true,
    },
  ])('fails cleanup after persistence when $label', async ({ retirementOptions, cleanupFails }) => {
    const state: WalWriteDeathState = { baseline: true, canaries: 0, recovery: false };
    const readOnly = walWriteDeathHandle(state);
    const reopened = walWriteDeathHandle(state);
    const persisted = walWriteDeathHandle(state);
    const retirement = walWriteDeathRetirementHandle(retirementOptions);
    const cleanup = cleanupHandle(cleanupFails);
    mockOpen
      .mockReturnValueOnce(readOnly)
      .mockReturnValueOnce(reopened)
      .mockReturnValueOnce(persisted)
      .mockReturnValueOnce(retirement)
      .mockReturnValueOnce(cleanup);

    await expect(resumeDbActiveWalWriteDeathSelfTest(jest.fn())).resolves.toMatchObject({
      status: 'fail',
      failureCode: 'database-cleanup',
      checks: { reopenPersistence: true, databaseCleanup: false },
    });

    expect(persisted.close.mock.invocationCallOrder[0]).toBeLessThan(
      mockOpen.mock.invocationCallOrder[3] ?? 0,
    );
    expect(retirement.close).toHaveBeenCalled();
    expect(cleanup.delete).toHaveBeenCalledTimes(1);
  });

  it('fails before read-write open when read-only recovery exposes an uncommitted canary', async () => {
    const state: WalWriteDeathState = { baseline: true, canaries: 1, recovery: false };
    const readOnly = walWriteDeathHandle(state);
    const cleanup = cleanupHandle();
    mockOpen.mockReturnValueOnce(readOnly).mockReturnValueOnce(cleanup);
    const onReadOnlyVerified = jest.fn();

    await expect(resumeDbActiveWalWriteDeathSelfTest(onReadOnlyVerified)).resolves.toMatchObject({
      status: 'fail',
      failureCode: 'recovered-state',
      checks: {
        readOnlyRecoveryOpen: true,
        baselinePresent: false,
        uncommittedAbsent: false,
        databaseCleanup: true,
      },
    });
    expect(onReadOnlyVerified).not.toHaveBeenCalled();
    expect(mockOpen).toHaveBeenCalledTimes(2);
  });

  it('fails before read-write open when recovered state contains any extra row', async () => {
    const state: WalWriteDeathState = {
      baseline: true,
      canaries: 0,
      recovery: false,
      extras: [{ id: 50, state: 'partial-or-corrupt' }],
    };
    const readOnly = walWriteDeathHandle(state);
    const cleanup = cleanupHandle();
    mockOpen.mockReturnValueOnce(readOnly).mockReturnValueOnce(cleanup);
    const onReadOnlyVerified = jest.fn();

    await expect(resumeDbActiveWalWriteDeathSelfTest(onReadOnlyVerified)).resolves.toMatchObject({
      status: 'fail',
      failureCode: 'recovered-state',
      checks: {
        readOnlyRecoveryOpen: true,
        baselinePresent: false,
        uncommittedAbsent: false,
        databaseCleanup: true,
      },
    });
    expect(onReadOnlyVerified).not.toHaveBeenCalled();
    expect(mockOpen).toHaveBeenCalledTimes(2);
  });

  it('exposes cleanup for only the fixed WAL-write-death main file', () => {
    const cleanup = cleanupHandle();
    mockOpen.mockReturnValueOnce(cleanup);

    expect(cleanupDbActiveWalWriteDeathSelfTestDatabase()).toBe(true);
    expect(mockOpen).toHaveBeenCalledWith({ name: WAL_DB_NAME });
    expect(JSON.stringify(mockOpen.mock.calls)).not.toContain('gator.db');
  });
});

describe('DB-03B2B2 fixed active-migration-death database contract', () => {
  function stateAtPrefix(
    rows = activeMigrationFixtureRows(false),
    extras?: ActiveMigrationFixtureRow[],
  ): ActiveMigrationState {
    return {
      ledger: migrationNames.slice(0, 37),
      rows,
      transactionOpen: false,
      pendingRows: [],
      pendingMigration: false,
      extras,
    };
  }

  beforeEach(() => {
    mockOpen.mockReset();
    mockRunMigrations.mockReset();
    mockRunMigrations.mockImplementation(simulateProductionMigrations);
  });

  it('pins the exact single-statement 0038 production migration boundary', () => {
    const migrations = (jest.requireActual('@db/migrations') as typeof import('@db/migrations'))
      .MIGRATIONS;
    expect(migrations).toHaveLength(42);
    expect(migrations[36]?.name).toBe('0037_purge_legacy_redacted_mode_setting');
    expect(migrations[37]).toEqual({
      name: '0038_scrub_reaction_selected_message_text',
      statements: [
        `UPDATE outgoing_queue
          SET payload = json_remove(payload, '$.selectedMessageText')
        WHERE kind = 'reaction'
          AND CASE
                WHEN json_valid(payload)
                  THEN json_type(payload, '$.selectedMessageText') IS NOT NULL
                ELSE 0
              END`,
      ],
    });
    expect(migrations[38]?.name).toBe('0039_message_error_message');
    expect(migrations[39]?.name).toBe('0040_chats_pin_order');
    expect(migrations[40]?.name).toBe('0041_message_balloon_bundle_id');
    expect(migrations[41]?.name).toBe('0042_message_part_identity');
  });

  it('runs the real migration boundary, enters READY before ledger COMMIT, then rolls back on callback rejection', async () => {
    const state: ActiveMigrationState = {
      ledger: [],
      rows: [],
      transactionOpen: false,
      pendingRows: [],
      pendingMigration: false,
    };
    const preCleanup = cleanupHandle();
    const prepared = activeMigrationHandle(state);
    const failureCleanup = cleanupHandle();
    mockOpen
      .mockReturnValueOnce(preCleanup)
      .mockReturnValueOnce(prepared)
      .mockReturnValueOnce(failureCleanup);
    const stop = new Error('test releases the never-settling migration READY callback');
    const onPrepared = jest.fn(async (checks: Record<string, boolean>): Promise<never> => {
      expect(checks).toEqual({
        preCleanup: true,
        encryptedOpen: true,
        walMode: true,
        migrationPrefixPrepared: true,
        baselineCommitted: true,
        walCheckpointTruncated: true,
        migrationTransactionOpen: true,
        migrationWriteApplied: true,
        migrationLedgerPending: true,
      });
      expect(state.transactionOpen).toBe(true);
      expect(state.pendingMigration).toBe(true);
      expect(state.pendingLedger).toBeUndefined();
      expect(state.ledger).toEqual(migrationNames.slice(0, 37));
      expect(prepared.close).not.toHaveBeenCalled();
      throw stop;
    });

    await expect(prepareDbActiveMigrationDeathSelfTest(onPrepared)).rejects.toBe(stop);

    expect(mockRunMigrations).toHaveBeenCalledTimes(2);
    expect(onPrepared).toHaveBeenCalledTimes(1);
    expect(state.transactionOpen).toBe(false);
    expect(state.pendingMigration).toBe(false);
    expect(state.ledger).toEqual(migrationNames.slice(0, 37));
    expect(state.rows).toEqual(activeMigrationFixtureRows(false));
    expect(prepared.close).toHaveBeenCalledTimes(1);
    expect(failureCleanup.delete).toHaveBeenCalledTimes(1);
    const statements = prepared.execute.mock.calls.map(([statement]) => String(statement));
    const targetIndex = statements.indexOf(ACTIVE_MIGRATION_SQL ?? '');
    const checkpointIndex = statements.indexOf('PRAGMA wal_checkpoint(TRUNCATE)');
    const seedCommitIndex = statements.lastIndexOf('COMMIT', checkpointIndex);
    const targetBeginIndex = statements.lastIndexOf('BEGIN', targetIndex);
    expect(targetIndex).toBeGreaterThan(-1);
    expect(seedCommitIndex).toBeGreaterThan(-1);
    expect(checkpointIndex).toBeGreaterThan(seedCommitIndex);
    expect(targetBeginIndex).toBeGreaterThan(checkpointIndex);
    expect(targetIndex).toBeGreaterThan(targetBeginIndex);
    const postTargetStatements = statements.slice(targetIndex + 1);
    expect(
      postTargetStatements.some((statement) => statement.includes('INSERT INTO _migrations')),
    ).toBe(false);
    expect(postTargetStatements).not.toContain('COMMIT');
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(JSON.stringify(mockOpen.mock.calls)).not.toContain('gator.db');
  });

  it('fails before the active migration when the post-seed WAL checkpoint is not exact', async () => {
    const state: ActiveMigrationState = {
      ledger: [],
      rows: [],
      transactionOpen: false,
      pendingRows: [],
      pendingMigration: false,
    };
    const preCleanup = cleanupHandle();
    const prepared = activeMigrationHandle(state, { checkpointSucceeds: false });
    const failureCleanup = cleanupHandle();
    mockOpen
      .mockReturnValueOnce(preCleanup)
      .mockReturnValueOnce(prepared)
      .mockReturnValueOnce(failureCleanup);
    const onPrepared = jest.fn(async (): Promise<never> => new Promise(() => undefined));

    await expect(prepareDbActiveMigrationDeathSelfTest(onPrepared)).resolves.toMatchObject({
      status: 'fail',
      failureCode: 'wal-checkpoint',
      checks: {
        migrationPrefixPrepared: true,
        baselineCommitted: true,
        walCheckpointTruncated: false,
        migrationTransactionOpen: false,
      },
      databaseCleanup: true,
    });
    expect(mockRunMigrations).toHaveBeenCalledTimes(1);
    expect(onPrepared).not.toHaveBeenCalled();
  });

  it('opens read-only first, proves exact rollback, retries 0038 plus the current tail, and retires sidecars', async () => {
    const state = stateAtPrefix();
    const readOnly = activeMigrationHandle(state);
    const reopened = activeMigrationHandle(state);
    const persisted = activeMigrationHandle(state);
    const retirement = walWriteDeathRetirementHandle();
    const cleanup = cleanupHandle();
    mockOpen
      .mockReturnValueOnce(readOnly)
      .mockReturnValueOnce(reopened)
      .mockReturnValueOnce(persisted)
      .mockReturnValueOnce(retirement)
      .mockReturnValueOnce(cleanup);
    const onReadOnlyVerified = jest.fn(() => {
      expect(readOnly.close).toHaveBeenCalledTimes(1);
      expect(mockOpen).toHaveBeenCalledTimes(1);
    });

    await expect(resumeDbActiveMigrationDeathSelfTest(onReadOnlyVerified)).resolves.toEqual({
      status: 'pass',
      migrationCount: 42,
      migrationHead: '0042_message_part_identity',
      checks: {
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
      },
    });

    expect(mockOpen.mock.calls).toEqual([
      [{ name: MIGRATION_DEATH_DB_NAME, encryptionKey: MIGRATION_DEATH_FIXED_KEY, readOnly: true }],
      [{ name: MIGRATION_DEATH_DB_NAME, encryptionKey: MIGRATION_DEATH_FIXED_KEY }],
      [{ name: MIGRATION_DEATH_DB_NAME, encryptionKey: MIGRATION_DEATH_FIXED_KEY, readOnly: true }],
      [{ name: MIGRATION_DEATH_DB_NAME, encryptionKey: MIGRATION_DEATH_FIXED_KEY }],
      [{ name: MIGRATION_DEATH_DB_NAME }],
    ]);
    expect(String(readOnly.execute.mock.calls[0]?.[0])).toContain('SELECT name FROM _migrations');
    expect(onReadOnlyVerified).toHaveBeenCalledTimes(1);
    expect(state.ledger).toEqual(migrationNames);
    expect(state.rows).toEqual(activeMigrationFixtureRows(true));
    expect(mockRunMigrations).toHaveBeenCalledTimes(2);
    expect(retirement.executeSync.mock.calls.map(([statement]) => String(statement))).toEqual([
      'PRAGMA wal_checkpoint(TRUNCATE)',
      'PRAGMA journal_mode = DELETE',
      'PRAGMA journal_mode',
    ]);
    expect(persisted.close.mock.invocationCallOrder[0]).toBeLessThan(
      mockOpen.mock.invocationCallOrder[3] ?? 0,
    );
    expect(retirement.close.mock.invocationCallOrder[0]).toBeLessThan(
      cleanup.delete.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it.each([
    {
      label: 'an extra row',
      rows: activeMigrationFixtureRows(false),
      extras: [
        {
          temp_guid: 'driver-active-migration-death-unexpected',
          kind: 'reaction',
          payload: '{}',
        },
      ],
    },
    {
      label: 'a missing row',
      rows: activeMigrationFixtureRows(false).slice(1),
      extras: undefined,
    },
    {
      label: 'already-migrated target rows',
      rows: activeMigrationFixtureRows(true),
      extras: undefined,
    },
    {
      label: 'an altered control row',
      rows: activeMigrationFixtureRows(false).map((row) =>
        row.temp_guid === 'driver-active-migration-death-control-nonreaction'
          ? { ...row, payload: '{"selectedMessageText":"changed"}' }
          : row,
      ),
      extras: undefined,
    },
  ])('fails before any read-write open when recovery contains $label', async ({ rows, extras }) => {
    const state = stateAtPrefix(rows, extras);
    const readOnly = activeMigrationHandle(state);
    const cleanup = cleanupHandle();
    mockOpen.mockReturnValueOnce(readOnly).mockReturnValueOnce(cleanup);
    const onReadOnlyVerified = jest.fn();

    await expect(resumeDbActiveMigrationDeathSelfTest(onReadOnlyVerified)).resolves.toMatchObject({
      status: 'fail',
      failureCode: 'uncommitted-migration-absent',
      checks: {
        readOnlyRecoveryOpen: true,
        migrationPrefixPreserved: true,
        uncommittedMigrationAbsent: false,
        databaseCleanup: true,
      },
    });
    expect(onReadOnlyVerified).not.toHaveBeenCalled();
    expect(mockOpen).toHaveBeenCalledTimes(2);
    expect(mockRunMigrations).not.toHaveBeenCalled();
  });

  it('fails closed without a creating read-write open when the first read-only query fails', async () => {
    const state = stateAtPrefix();
    const readOnly = activeMigrationHandle(state, { rejectFirstRead: true });
    const cleanup = cleanupHandle();
    mockOpen.mockReturnValueOnce(readOnly).mockReturnValueOnce(cleanup);
    const onReadOnlyVerified = jest.fn();

    await expect(resumeDbActiveMigrationDeathSelfTest(onReadOnlyVerified)).resolves.toMatchObject({
      status: 'fail',
      failureCode: 'read-only-recovery-open',
      checks: { readOnlyRecoveryOpen: false, databaseCleanup: true },
    });
    expect(mockOpen.mock.calls).toEqual([
      [{ name: MIGRATION_DEATH_DB_NAME, encryptionKey: MIGRATION_DEATH_FIXED_KEY, readOnly: true }],
      [{ name: MIGRATION_DEATH_DB_NAME }],
    ]);
    expect(onReadOnlyVerified).not.toHaveBeenCalled();
  });

  it('exposes cleanup for only the fixed active-migration main file', () => {
    const cleanup = cleanupHandle();
    mockOpen.mockReturnValueOnce(cleanup);

    expect(cleanupDbActiveMigrationDeathSelfTestDatabase()).toBe(true);
    expect(mockOpen).toHaveBeenCalledWith({ name: MIGRATION_DEATH_DB_NAME });
    expect(JSON.stringify(mockOpen.mock.calls)).not.toContain('gator.db');
  });
});
