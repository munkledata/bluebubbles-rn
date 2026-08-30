import { createHash } from 'node:crypto';

const mockOpen = jest.fn();
const mockGetRandomBytes = jest.fn();
const mockDigestStringAsync = jest.fn();
const mockRunMigrations = jest.fn();

jest.mock('@op-engineering/op-sqlite', () => ({ open: mockOpen }));
jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: mockDigestStringAsync,
  getRandomBytes: mockGetRandomBytes,
}));
jest.mock('@db/migrate', () => ({ runMigrations: mockRunMigrations }));

let runDbDriverSelfTest: typeof import('@db/database').runDbDriverSelfTest;

const migrationNames = (
  jest.requireActual('@db/migrations') as typeof import('@db/migrations')
).MIGRATIONS.map((migration) => migration.name);
const partialMigrationNames = migrationNames.slice(0, 29);
const tailMigrationNames = migrationNames.slice(29);
const validReactionBefore =
  '{"targetGuid":"driver-contract-target","reaction":2000,"selectedMessageText":"discard","nested":{"keep":"preserved"}}';
const validReactionAfter =
  '{"targetGuid":"driver-contract-target","reaction":2000,"nested":{"keep":"preserved"}}';
const malformedReaction = '{"selectedMessageText":';
const nonReactionControl = '{"selectedMessageText":"preserve","body":"message-control"}';

type ReactiveCallback = (response: unknown) => void;

interface DriverHarnessOptions {
  wrongKeyAccepted?: boolean;
  rolledBackTablePresent?: boolean;
  wrongMigrationError?: boolean;
  postRekeyFtsMissing?: boolean;
  reactiveValueOverride?: string;
  reactiveValueOverrideFlush?: number;
  finalDeleteFails?: boolean;
  historicalReadOnlyAltered?: boolean;
  historicalTailMismatch?: boolean;
  historicalWrongKeyAccepted?: boolean;
  historicalFinalDeleteFails?: boolean;
}

interface DriverState {
  value: string;
  rollbackValue: string | undefined;
  subscribers: Set<ReactiveCallback>;
  pendingSubscribers: Set<ReactiveCallback>;
  flushCount: number;
  migrationsComplete: boolean;
  ftsTerm: string | undefined;
}

function cleanupHandle(deleteFails = false) {
  return {
    close: jest.fn(),
    delete: jest.fn(() => {
      if (deleteFails) throw new Error('simulated cleanup failure');
    }),
  };
}

function scheduledRows(complete: boolean): Array<Record<string, unknown>> {
  return [
    {
      server_id: null,
      chat_guid: 'driver-contract-local-pending',
      status: 'pending',
      attempts: 4,
    },
    {
      server_id: null,
      chat_guid: 'driver-contract-local-sending',
      status: complete ? 'uncertain' : 'sending',
      attempts: complete ? 5 : 2,
    },
    {
      server_id: 7,
      chat_guid: 'driver-contract-server-sending',
      status: 'sending',
      attempts: 3,
    },
  ];
}

function outgoingRows(complete: boolean): Array<Record<string, unknown>> {
  return [
    {
      temp_guid: 'driver-contract-message-control',
      kind: 'message',
      payload: nonReactionControl,
    },
    {
      temp_guid: 'driver-contract-reaction-malformed',
      kind: 'reaction',
      payload: malformedReaction,
    },
    {
      temp_guid: 'driver-contract-reaction-valid',
      kind: 'reaction',
      payload: complete ? validReactionAfter : validReactionBefore,
    },
  ];
}

function dataHandle(
  state: DriverState,
  options: {
    rejectRead?: boolean;
    rolledBackTablePresent?: boolean;
    reactiveValueOverride?: string;
    reactiveValueOverrideFlush?: number;
    persistentFtsMissing?: boolean;
  } = {},
) {
  const markReactiveUpdate = (): void => {
    for (const callback of state.subscribers) state.pendingSubscribers.add(callback);
  };
  const execute = jest.fn(async (statement: string, params: unknown[] = []) => {
    if (options.rejectRead) throw new Error('simulated wrong key');
    const normalized = statement.replace(/\s+/g, ' ').trim().toLowerCase();

    if (normalized === 'begin immediate') {
      state.rollbackValue = state.value;
      return { rows: [] };
    }
    if (normalized === 'rollback') {
      if (state.rollbackValue !== undefined) state.value = state.rollbackValue;
      state.rollbackValue = undefined;
      return { rows: [] };
    }
    if (normalized === 'commit') {
      state.rollbackValue = undefined;
      return { rows: [] };
    }
    if (normalized.includes("set display_name = 'rolled-back'")) {
      state.value = 'rolled-back';
      markReactiveUpdate();
      return { rows: [], rowsAffected: 1 };
    }
    if (normalized.startsWith('update handles set display_name = ?')) {
      state.value = String(params[0]);
      markReactiveUpdate();
      return { rows: [], rowsAffected: 1 };
    }
    if (normalized === 'pragma foreign_keys') return { rows: [{ foreign_keys: 1 }] };
    if (normalized === 'pragma foreign_key_check') return { rows: [] };
    if (normalized === 'pragma integrity_check') return { rows: [{ integrity_check: 'ok' }] };
    if (normalized.startsWith('pragma foreign_keys =')) return { rows: [] };
    if (normalized.startsWith('select count(*) from sqlite_master')) {
      return { rows: [{ count: 2 }] };
    }
    if (normalized.includes("type = 'index'") && normalized.includes('state_lru_idx')) {
      return { rows: [{ tbl_name: 'driver_contract_migration_conflict' }] };
    }
    if (
      normalized.includes("type = 'table'") &&
      normalized.includes("name = 'attachment_cache_entries'")
    ) {
      return {
        rows: options.rolledBackTablePresent ? [{ name: 'attachment_cache_entries' }] : [],
      };
    }
    if (normalized === 'select name from _migrations order by name') {
      const names = state.migrationsComplete ? migrationNames : partialMigrationNames;
      return { rows: names.map((name) => ({ name })) };
    }
    if (normalized === 'select id from chats where guid = ?') return { rows: [{ id: 41 }] };
    if (normalized.startsWith('select guid, date_deleted from messages')) {
      return {
        rows: [
          { guid: 'driver-contract-deleted', date_deleted: 1234 },
          { guid: 'driver-contract-visible', date_deleted: null },
        ],
      };
    }
    if (normalized.startsWith('select level, message, created_at from error_reports')) {
      return {
        rows: [{ level: 'error', message: 'driver contract safe error', created_at: 1 }],
      };
    }
    if (normalized === 'select id from error_reports') return { rows: [] };
    if (normalized.startsWith('select server_id, chat_guid, status, attempts')) {
      return { rows: scheduledRows(state.migrationsComplete) };
    }
    if (normalized.startsWith('select key, value from kv')) {
      return {
        rows: state.migrationsComplete
          ? [{ key: 'privacy.redactedMode.extra', value: 'preserved' }]
          : [
              { key: 'privacy.redactedMode', value: 'retired' },
              { key: 'privacy.redactedMode.extra', value: 'preserved' },
            ],
      };
    }
    if (normalized.startsWith('select temp_guid, kind, payload from outgoing_queue')) {
      return { rows: outgoingRows(state.migrationsComplete) };
    }
    if (normalized.startsWith('select guid, date_deleted from message_deletion_ledger')) {
      return { rows: [{ guid: 'driver-contract-deleted', date_deleted: 1234 }] };
    }
    if (normalized === 'select id from messages where guid = ?') return { rows: [{ id: 73 }] };
    if (normalized.includes('from messages_fts') && normalized.includes('orangesentinel')) {
      return { rows: state.ftsTerm === 'orangesentinel' ? [{ rowid: 73 }] : [] };
    }
    if (normalized.includes('from messages_fts') && normalized.includes('violetsentinel')) {
      return { rows: state.ftsTerm === 'violetsentinel' ? [{ rowid: 73 }] : [] };
    }
    if (normalized.includes('from messages_fts') && normalized.includes('persistentsentinel')) {
      return { rows: options.persistentFtsMissing ? [] : [{ rowid: 72 }] };
    }
    if (normalized.startsWith('update messages set text = ?')) {
      state.ftsTerm = String(params[0]);
      return { rows: [], rowsAffected: 1 };
    }
    if (normalized.startsWith('delete from messages where guid = ?')) {
      state.ftsTerm = undefined;
      return { rows: [], rowsAffected: 1 };
    }
    if (normalized.includes('from handles where id = 1')) {
      return { rows: [{ id: 1, display_name: state.value }] };
    }
    if (normalized.startsWith('insert into handles')) {
      state.value = 'seed';
      return { rows: [], rowsAffected: 1 };
    }
    if (normalized.startsWith('insert into messages') && params[0] === 'driver-contract-fts') {
      state.ftsTerm = String(params[2]);
      return { rows: [], rowsAffected: 1 };
    }
    if (
      normalized.startsWith('create table driver_contract_migration_conflict') ||
      normalized.startsWith('create index attachment_cache_entries_state_lru_idx') ||
      normalized.startsWith('drop index attachment_cache_entries_state_lru_idx') ||
      normalized.startsWith('drop table driver_contract_migration_conflict') ||
      normalized.startsWith('insert into chats') ||
      normalized.startsWith('insert into messages') ||
      normalized.startsWith('insert into error_reports') ||
      normalized.startsWith('insert into scheduled_messages') ||
      normalized.startsWith('insert into kv') ||
      normalized.startsWith('insert into outgoing_queue') ||
      normalized.startsWith('pragma rekey')
    ) {
      return { rows: [], rowsAffected: 1 };
    }
    throw new Error(`unexpected self-test SQL: ${statement}`);
  });

  return {
    close: jest.fn(),
    delete: jest.fn(),
    execute,
    executeSync: jest.fn((_statement: string, params: unknown[] = []) => {
      state.value = String(params[0]);
      markReactiveUpdate();
      return {
        rows: [{ id: 1, display_name: state.value }],
        rowsAffected: 1,
      };
    }),
    executeRaw: jest.fn(async (_statement: string, params: unknown[] = []) => {
      state.value = String(params[0]);
      markReactiveUpdate();
      return {
        rawRows: [[1, state.value]],
        columnNames: ['id', 'display_name'],
        rowsAffected: 1,
      };
    }),
    flushPendingReactiveQueries: jest.fn(async () => {
      state.flushCount += 1;
      const displayName =
        state.flushCount === (options.reactiveValueOverrideFlush ?? 3)
          ? (options.reactiveValueOverride ?? state.value)
          : state.value;
      const pending = [...state.pendingSubscribers];
      state.pendingSubscribers.clear();
      for (const callback of pending) callback({ rows: [{ display_name: displayName }] });
    }),
    reactiveExecute: jest.fn(({ callback }: { callback: ReactiveCallback }) => {
      state.subscribers.add(callback);
      return jest.fn(() => state.subscribers.delete(callback));
    }),
  };
}

interface HistoricalState {
  count: 24 | 27;
  upgraded: boolean;
  ftsTerm?: string;
}

function historicalRows(state: HistoricalState) {
  const prefix = `driver-history-${String(state.count).padStart(4, '0')}`;
  const persistentToken = `driverhistory${String(state.count).padStart(4, '0')}persistentsentinel`;
  const associatedGuid =
    !state.upgraded && state.count === 24 ? `p:0/${prefix}-target` : `${prefix}-target`;
  return { associatedGuid, persistentToken, prefix };
}

function historicalHandle(
  state: HistoricalState,
  options: { rejectReads?: boolean; alterContinuity?: boolean } = {},
) {
  const execute = jest.fn(async (statement: string, params: unknown[] = []) => {
    if (options.rejectReads) throw new Error('simulated historical wrong key');
    const normalized = statement.replace(/\s+/g, ' ').trim().toLowerCase();
    const { associatedGuid, persistentToken, prefix } = historicalRows(state);
    const selectedGuid = String(params[0] ?? '');

    if (normalized === 'pragma foreign_keys') return { rows: [{ foreign_keys: 1 }] };
    if (normalized === 'pragma foreign_key_check') return { rows: [] };
    if (normalized === 'pragma integrity_check') return { rows: [{ integrity_check: 'ok' }] };
    if (normalized.startsWith('pragma foreign_keys =')) return { rows: [] };
    if (normalized === 'pragma table_info(scheduled_messages)') {
      return { rows: [{ name: 'recurrence' }] };
    }
    if (normalized === 'pragma table_info(messages)') {
      return { rows: state.count === 27 ? [{ name: 'payload_data' }] : [] };
    }
    if (normalized === 'pragma table_info(chats)') return { rows: [] };
    if (normalized === 'select count(*) from sqlite_master') return { rows: [{ count: 1 }] };
    if (normalized === 'select name from _migrations order by name') {
      const names = state.upgraded ? migrationNames : migrationNames.slice(0, state.count);
      return { rows: names.map((name) => ({ name })) };
    }
    if (
      normalized.includes("type = 'trigger'") &&
      normalized.includes('driver_history_stop_after_reviewed_head')
    ) {
      return { rows: [] };
    }
    if (
      normalized.includes("type = 'table'") &&
      normalized.includes("name in ('error_reports', 'attachment_cache_entries')")
    ) {
      return { rows: state.count === 27 ? [{ name: 'error_reports' }] : [] };
    }
    if (normalized === 'select id from chats where guid = ?')
      return { rows: [{ id: state.count }] };
    if (normalized.startsWith('select guid, text, date_deleted, associated_message_guid')) {
      return {
        rows: options.alterContinuity
          ? []
          : [
              {
                guid: `${prefix}-deleted`,
                text: persistentToken,
                date_deleted: state.count * 100,
                associated_message_guid: associatedGuid,
              },
            ],
      };
    }
    if (normalized.startsWith('select guid, associated_message_guid from messages')) {
      return { rows: [{ guid: `${prefix}-deleted`, associated_message_guid: associatedGuid }] };
    }
    if (normalized.startsWith('select level, message, created_at from error_reports')) {
      return {
        rows: [
          {
            level: 'error',
            message: `${prefix} safe historical diagnostic`,
            created_at: state.count,
          },
        ],
      };
    }
    if (normalized.startsWith('select guid, date_deleted from message_deletion_ledger')) {
      return { rows: [{ guid: `${prefix}-deleted`, date_deleted: state.count * 100 }] };
    }
    if (normalized === 'select id from error_reports') return { rows: [] };
    if (normalized.startsWith('select server_id, chat_guid, status, attempts')) {
      return {
        rows: [
          {
            server_id: null,
            chat_guid: `${prefix}-local-pending`,
            status: 'pending',
            attempts: 4,
          },
          {
            server_id: null,
            chat_guid: `${prefix}-local-sending`,
            status: state.upgraded ? 'uncertain' : 'sending',
            attempts: state.upgraded ? 5 : 2,
          },
          {
            server_id: state.count,
            chat_guid: `${prefix}-server-sending`,
            status: 'sending',
            attempts: 3,
          },
        ],
      };
    }
    if (normalized.startsWith('select key, value from kv')) {
      return {
        rows: state.upgraded
          ? [{ key: `${prefix}.preserved`, value: 'preserved' }]
          : [
              { key: `${prefix}.preserved`, value: 'preserved' },
              { key: 'privacy.redactedMode', value: 'retired' },
            ],
      };
    }
    if (normalized.startsWith('select temp_guid, kind, payload from outgoing_queue')) {
      const validBefore = `{"targetGuid":"${prefix}-target","reaction":2000,"selectedMessageText":"discard","nested":{"keep":"preserved"}}`;
      const validAfter = `{"targetGuid":"${prefix}-target","reaction":2000,"nested":{"keep":"preserved"}}`;
      return {
        rows: [
          {
            temp_guid: `${prefix}-message-control`,
            kind: 'message',
            payload: '{"selectedMessageText":"preserve","body":"message-control"}',
          },
          {
            temp_guid: `${prefix}-reaction-malformed`,
            kind: 'reaction',
            payload: '{"selectedMessageText":',
          },
          {
            temp_guid: `${prefix}-reaction-valid`,
            kind: 'reaction',
            payload: state.upgraded ? validAfter : validBefore,
          },
        ],
      };
    }
    if (normalized.includes('join messages') && normalized.includes('messages_fts match ?')) {
      return { rows: [{ rowid: state.count }] };
    }
    if (normalized === 'select id from messages where guid = ?') {
      return { rows: [{ id: state.count + 100 }] };
    }
    if (normalized.startsWith('select rowid from messages_fts where messages_fts match ?')) {
      return { rows: state.ftsTerm === selectedGuid ? [{ rowid: state.count + 100 }] : [] };
    }
    if (normalized.startsWith('insert into messages (guid, chat_id, text) select')) {
      state.ftsTerm = String(params[1]);
      return { rows: [], rowsAffected: 1 };
    }
    if (normalized.startsWith('update messages set text = ?')) {
      state.ftsTerm = String(params[0]);
      return { rows: [], rowsAffected: 1 };
    }
    if (normalized.startsWith('delete from messages where guid = ?')) {
      state.ftsTerm = undefined;
      return { rows: [], rowsAffected: 1 };
    }
    if (
      normalized.startsWith('create table if not exists _migrations') ||
      normalized.startsWith('create trigger driver_history_stop_after_reviewed_head') ||
      normalized.startsWith('drop trigger driver_history_stop_after_reviewed_head') ||
      normalized.startsWith('insert into chats') ||
      normalized.startsWith('insert into messages') ||
      normalized.startsWith('insert into error_reports') ||
      normalized.startsWith('insert into scheduled_messages') ||
      normalized.startsWith('insert into kv') ||
      normalized.startsWith('insert into outgoing_queue')
    ) {
      return { rows: [], rowsAffected: 1 };
    }
    throw new Error(`unexpected historical self-test SQL: ${statement}`);
  });
  return { close: jest.fn(), delete: jest.fn(), execute };
}

function installHistoricalHarness(
  options: {
    alterReadOnly0024?: boolean;
    tailMismatch0024?: boolean;
    wrongKeyAccepted0024?: boolean;
    finalDeleteFails?: boolean;
  } = {},
) {
  const state0024: HistoricalState = { count: 24, upgraded: false };
  const state0027: HistoricalState = { count: 27, upgraded: false };
  mockRunMigrations
    .mockRejectedValueOnce(new Error('db-03b2a-stop-after-reviewed-head'))
    .mockImplementationOnce(async () => {
      state0024.upgraded = true;
      const tail = migrationNames.slice(24);
      return options.tailMismatch0024 ? tail.slice().reverse() : tail;
    })
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(new Error('db-03b2a-stop-after-reviewed-head'))
    .mockImplementationOnce(async () => {
      state0027.upgraded = true;
      return migrationNames.slice(27);
    })
    .mockResolvedValueOnce([]);

  const preCleanup0024 = cleanupHandle();
  const prepared0024 = historicalHandle(state0024);
  const wrongKey0024 = historicalHandle(state0024, {
    rejectReads: !options.wrongKeyAccepted0024,
  });
  const readOnly0024 = historicalHandle(state0024, {
    alterContinuity: options.alterReadOnly0024,
  });
  const reopened0024 = historicalHandle(state0024);
  const preCleanup0027 = cleanupHandle();
  const prepared0027 = historicalHandle(state0027);
  const wrongKey0027 = historicalHandle(state0027, { rejectReads: true });
  const readOnly0027 = historicalHandle(state0027);
  const reopened0027 = historicalHandle(state0027);
  const finalCleanup = cleanupHandle(options.finalDeleteFails);
  return {
    finalCleanup,
    handles: [
      preCleanup0024,
      prepared0024,
      wrongKey0024,
      readOnly0024,
      reopened0024,
      preCleanup0027,
      prepared0027,
      wrongKey0027,
      readOnly0027,
      reopened0027,
      finalCleanup,
    ],
    prepared0024,
    prepared0027,
    readOnly0024,
    readOnly0027,
    reopened0024,
    reopened0027,
  };
}

function installDriverHarness(options: DriverHarnessOptions = {}) {
  const state: DriverState = {
    value: '',
    rollbackValue: undefined,
    subscribers: new Set(),
    pendingSubscribers: new Set(),
    flushCount: 0,
    migrationsComplete: false,
    ftsTerm: undefined,
  };
  mockRunMigrations
    .mockRejectedValueOnce(
      new Error(
        options.wrongMigrationError
          ? 'simulated unrelated migration failure'
          : 'index attachment_cache_entries_state_lru_idx already exists',
      ),
    )
    .mockImplementationOnce(async () => {
      state.migrationsComplete = true;
      return tailMigrationNames;
    })
    .mockResolvedValueOnce([]);

  const preCleanup = cleanupHandle();
  const initial = dataHandle(state, { rolledBackTablePresent: options.rolledBackTablePresent });
  const wrongKey = dataHandle(state, { rejectRead: !options.wrongKeyAccepted });
  const reopened = dataHandle(state, {
    ...(options.reactiveValueOverride === undefined
      ? {}
      : {
          reactiveValueOverride: options.reactiveValueOverride,
          reactiveValueOverrideFlush: options.reactiveValueOverrideFlush,
        }),
  });
  const rekeyed = dataHandle(state, { persistentFtsMissing: options.postRekeyFtsMissing });
  const oldKey = dataHandle(state, { rejectRead: true });
  const finalCleanup = cleanupHandle(options.finalDeleteFails);
  const reachesHistory =
    !options.rolledBackTablePresent &&
    !options.wrongMigrationError &&
    !options.wrongKeyAccepted &&
    options.reactiveValueOverride === undefined &&
    !options.postRekeyFtsMissing;
  const historical = reachesHistory
    ? installHistoricalHarness({
        alterReadOnly0024: options.historicalReadOnlyAltered,
        tailMismatch0024: options.historicalTailMismatch,
        wrongKeyAccepted0024: options.historicalWrongKeyAccepted,
        finalDeleteFails: options.historicalFinalDeleteFails,
      })
    : undefined;
  const handles =
    options.rolledBackTablePresent || options.wrongMigrationError
      ? [preCleanup, initial, finalCleanup]
      : options.wrongKeyAccepted
        ? [preCleanup, initial, wrongKey, finalCleanup]
        : options.reactiveValueOverride !== undefined
          ? [preCleanup, initial, wrongKey, reopened, finalCleanup]
          : options.postRekeyFtsMissing
            ? [preCleanup, initial, wrongKey, reopened, rekeyed, finalCleanup]
            : [
                preCleanup,
                initial,
                wrongKey,
                reopened,
                rekeyed,
                oldKey,
                ...(historical?.handles ?? []),
                finalCleanup,
              ];
  let next = 0;
  mockOpen.mockImplementation(() => {
    const handle = handles[next];
    if (!handle) throw new Error(`unexpected database open ${next + 1}`);
    next += 1;
    return handle;
  });
  return { finalCleanup, historical, initial, oldKey, preCleanup, reopened, rekeyed, wrongKey };
}

function openedOptions(): Array<{ name: string; encryptionKey?: string; readOnly?: boolean }> {
  return mockOpen.mock.calls.map(
    (call) => call[0] as { name: string; encryptionKey?: string; readOnly?: boolean },
  );
}

const passingChecks = {
  encryptedOpen: true,
  wrongKeyRejected: true,
  migrationRollback: true,
  migrationRetry: true,
  migrationLedger: true,
  migrationData: true,
  fts5: true,
  integrity: true,
  idempotent: true,
  rollback: true,
  syncReactive: true,
  asyncReactive: true,
  rawReactive: true,
  rekey: true,
  newKeyReopen: true,
  oldKeyRejected: true,
  historicalProvenance: true,
  historical0024: true,
  historical0027: true,
  historical0029: true,
  historicalReadOnly: true,
  historicalWrongKeyRejected: true,
  historicalData: true,
  historicalFts5: true,
  historicalIntegrity: true,
  historicalIdempotent: true,
  historicalCleanup: true,
  cleanup: true,
} as const;

describe('runDbDriverSelfTest', () => {
  beforeAll(async () => {
    ({ runDbDriverSelfTest } = await import('@db/database'));
  });

  beforeEach(() => {
    mockOpen.mockReset();
    mockGetRandomBytes.mockReset();
    mockDigestStringAsync.mockReset();
    mockRunMigrations.mockReset();
    mockDigestStringAsync.mockImplementation(async (_algorithm: string, value: string) =>
      createHash('sha256').update(value, 'utf8').digest('hex'),
    );
    mockGetRandomBytes
      .mockReturnValueOnce(new Uint8Array(32).fill(0x11))
      .mockReturnValueOnce(new Uint8Array(32).fill(0x22));
  });

  it('proves migration rollback/retry, production FTS, and all adapter routes on one fixed file', async () => {
    const harness = installDriverHarness();

    await expect(runDbDriverSelfTest()).resolves.toEqual({
      schema: 3,
      suite: 'android-db-contract',
      status: 'pass',
      migrationCount: 44,
      migrationHead: '0044_custom_folder_unread_badge',
      checks: passingChecks,
    });

    const keyA = '11'.repeat(32);
    const keyB = '22'.repeat(32);
    expect(openedOptions()).toEqual([
      { name: 'driver-selftest.db' },
      { name: 'driver-selftest.db', encryptionKey: keyA },
      { name: 'driver-selftest.db', encryptionKey: keyB },
      { name: 'driver-selftest.db', encryptionKey: keyA },
      { name: 'driver-selftest.db', encryptionKey: keyB },
      { name: 'driver-selftest.db', encryptionKey: keyA },
      { name: 'driver-history-selftest.db' },
      {
        name: 'driver-history-selftest.db',
        encryptionKey: 'db-03b2a-public-throwaway-key-v1',
      },
      {
        name: 'driver-history-selftest.db',
        encryptionKey: 'db-03b2a-wrong-public-throwaway-key-v1',
        readOnly: true,
      },
      {
        name: 'driver-history-selftest.db',
        encryptionKey: 'db-03b2a-public-throwaway-key-v1',
        readOnly: true,
      },
      {
        name: 'driver-history-selftest.db',
        encryptionKey: 'db-03b2a-public-throwaway-key-v1',
      },
      { name: 'driver-history-selftest.db' },
      {
        name: 'driver-history-selftest.db',
        encryptionKey: 'db-03b2a-public-throwaway-key-v1',
      },
      {
        name: 'driver-history-selftest.db',
        encryptionKey: 'db-03b2a-wrong-public-throwaway-key-v1',
        readOnly: true,
      },
      {
        name: 'driver-history-selftest.db',
        encryptionKey: 'db-03b2a-public-throwaway-key-v1',
        readOnly: true,
      },
      {
        name: 'driver-history-selftest.db',
        encryptionKey: 'db-03b2a-public-throwaway-key-v1',
      },
      { name: 'driver-history-selftest.db' },
      { name: 'driver-selftest.db' },
    ]);
    expect(mockRunMigrations).toHaveBeenCalledTimes(9);
    for (const [runner] of mockRunMigrations.mock.calls) {
      expect(runner).toEqual({ exec: expect.any(Function), query: expect.any(Function) });
    }
    expect(harness.initial.execute).toHaveBeenCalledWith(
      expect.stringContaining('CREATE INDEX attachment_cache_entries_state_lru_idx'),
    );
    expect(harness.initial.execute).toHaveBeenCalledWith(
      expect.stringContaining("name = 'attachment_cache_entries'"),
    );
    expect(harness.reopened.execute).toHaveBeenCalledWith(
      'DROP INDEX attachment_cache_entries_state_lru_idx',
    );
    expect(harness.reopened.execute).toHaveBeenCalledWith(
      'DROP TABLE driver_contract_migration_conflict',
    );
    expect(harness.preCleanup.delete).toHaveBeenCalledTimes(1);
    expect(harness.finalCleanup.delete).toHaveBeenCalledTimes(1);
    expect(harness.initial.close).toHaveBeenCalledTimes(1);
    expect(harness.wrongKey.close).toHaveBeenCalledTimes(1);
    expect(harness.reopened.close).toHaveBeenCalledTimes(1);
    expect(harness.rekeyed.close).toHaveBeenCalledTimes(1);
    expect(harness.oldKey.close).toHaveBeenCalledTimes(1);
    expect(harness.historical?.prepared0024.execute).toHaveBeenCalledWith(
      expect.stringContaining("WHEN NEW.name = '0025_error_reports'"),
    );
    expect(harness.historical?.prepared0027.execute).toHaveBeenCalledWith(
      expect.stringContaining("WHEN NEW.name = '0028_chats_marked_unread_at'"),
    );
    expect(harness.historical?.readOnly0024.close).toHaveBeenCalledTimes(1);
    expect(harness.historical?.readOnly0027.close).toHaveBeenCalledTimes(1);
    expect(harness.historical?.reopened0024.close).toHaveBeenCalledTimes(1);
    expect(harness.historical?.reopened0027.close).toHaveBeenCalledTimes(1);
    expect(harness.historical?.finalCleanup.delete).toHaveBeenCalledTimes(1);
    expect(mockDigestStringAsync).toHaveBeenCalledTimes(3);
    expect(harness.reopened.executeSync).toHaveBeenCalledTimes(1);
    expect(harness.reopened.executeRaw).toHaveBeenCalledTimes(1);
    expect(harness.reopened.flushPendingReactiveQueries).toHaveBeenCalledTimes(5);
    expect(harness.reopened.reactiveExecute).toHaveBeenCalledTimes(5);
    expect(harness.reopened.execute).toHaveBeenCalledWith('BEGIN IMMEDIATE', []);
    expect(harness.reopened.execute).toHaveBeenCalledWith('COMMIT', []);
    expect(harness.reopened.execute).toHaveBeenCalledWith('ROLLBACK', []);
  });

  it('fails before opening a historical fixture when a reviewed prefix digest drifts', async () => {
    installDriverHarness();
    mockDigestStringAsync.mockResolvedValueOnce('0'.repeat(64));

    await expect(runDbDriverSelfTest()).resolves.toMatchObject({
      schema: 3,
      status: 'fail',
      checks: {
        historical0029: true,
        historicalProvenance: false,
        historicalCleanup: true,
        cleanup: true,
      },
      failureCode: 'historical-provenance',
    });
    expect(mockDigestStringAsync).toHaveBeenCalledTimes(1);
    expect(openedOptions().every(({ name }) => name !== 'gator.db')).toBe(true);
  });

  it('rejects a readable historical wrong key before the continuity reopen', async () => {
    installDriverHarness({ historicalWrongKeyAccepted: true });

    await expect(runDbDriverSelfTest()).resolves.toMatchObject({
      schema: 3,
      status: 'fail',
      checks: {
        historicalProvenance: true,
        historicalWrongKeyRejected: false,
        historicalReadOnly: false,
        historicalCleanup: true,
        cleanup: true,
      },
      failureCode: 'historical-0024-wrong-key-not-rejected',
    });
  });

  it('fails before the historical read-write open when read-only continuity changed', async () => {
    installDriverHarness({ historicalReadOnlyAltered: true });

    await expect(runDbDriverSelfTest()).resolves.toMatchObject({
      schema: 3,
      status: 'fail',
      checks: {
        historicalProvenance: true,
        historicalReadOnly: false,
        historical0024: false,
        historicalCleanup: true,
        cleanup: true,
      },
      failureCode: 'historical-0024-read-only',
    });
  });

  it('requires the exact ordered historical migration tail', async () => {
    installDriverHarness({ historicalTailMismatch: true });

    await expect(runDbDriverSelfTest()).resolves.toMatchObject({
      schema: 3,
      status: 'fail',
      checks: {
        historicalProvenance: true,
        historical0024: false,
        historicalCleanup: true,
        cleanup: true,
      },
      failureCode: 'historical-0024-migration',
    });
  });

  it('keeps a finite historical cleanup failure distinct from main-file cleanup', async () => {
    installDriverHarness({ historicalFinalDeleteFails: true });

    await expect(runDbDriverSelfTest()).resolves.toMatchObject({
      schema: 3,
      status: 'fail',
      checks: {
        historical0024: true,
        historical0027: true,
        historicalCleanup: false,
        cleanup: true,
      },
      failureCode: 'historical-cleanup',
    });
  });

  it('fails before close when the partial 0030 table survived the per-migration rollback', async () => {
    const harness = installDriverHarness({ rolledBackTablePresent: true });

    await expect(runDbDriverSelfTest()).resolves.toMatchObject({
      schema: 3,
      status: 'fail',
      checks: { encryptedOpen: true, migrationRollback: false, cleanup: true },
      failureCode: 'migration-rollback',
    });
    expect(harness.initial.close).toHaveBeenCalledTimes(1);
    expect(mockRunMigrations).toHaveBeenCalledTimes(1);
    expect(openedOptions().every(({ name }) => name === 'driver-selftest.db')).toBe(true);
  });

  it('does not mislabel an unrelated migration rejection as the deliberate 0030 conflict', async () => {
    installDriverHarness({ wrongMigrationError: true });

    await expect(runDbDriverSelfTest()).resolves.toMatchObject({
      schema: 3,
      status: 'fail',
      checks: { encryptedOpen: true, migrationRollback: false, cleanup: true },
      failureCode: 'migration-rollback',
    });
    expect(mockRunMigrations).toHaveBeenCalledTimes(1);
  });

  it('fails closed with a finite code when the wrong key can read the migrated file', async () => {
    installDriverHarness({ wrongKeyAccepted: true });

    await expect(runDbDriverSelfTest()).resolves.toMatchObject({
      schema: 3,
      status: 'fail',
      checks: {
        encryptedOpen: true,
        migrationRollback: true,
        wrongKeyRejected: false,
        cleanup: true,
      },
      failureCode: 'wrong-key-not-rejected',
    });
    expect(openedOptions().every(({ name }) => name === 'driver-selftest.db')).toBe(true);
  });

  it('fails the exact reactive route after migration checks without leaking callback data', async () => {
    const harness = installDriverHarness({ reactiveValueOverride: 'unexpected' });

    await expect(runDbDriverSelfTest()).resolves.toMatchObject({
      schema: 3,
      suite: 'android-db-contract',
      status: 'fail',
      checks: {
        migrationRollback: true,
        migrationRetry: true,
        migrationLedger: true,
        migrationData: true,
        fts5: true,
        integrity: true,
        idempotent: true,
        rollback: true,
        syncReactive: false,
        cleanup: true,
      },
      failureCode: 'sync-reactive',
    });
    const unsubscribe = harness.reopened.reactiveExecute.mock.results[2]?.value as jest.Mock;
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(harness.reopened.close).toHaveBeenCalledTimes(1);
  });

  it('fails new-key reopen when the production FTS index does not survive rekey', async () => {
    installDriverHarness({ postRekeyFtsMissing: true });

    await expect(runDbDriverSelfTest()).resolves.toMatchObject({
      schema: 3,
      status: 'fail',
      checks: { fts5: true, rekey: true, newKeyReopen: false, cleanup: true },
      failureCode: 'new-key-reopen',
    });
  });

  it('overrides an otherwise passing run when exact final deletion fails', async () => {
    const harness = installDriverHarness({ finalDeleteFails: true });

    await expect(runDbDriverSelfTest()).resolves.toMatchObject({
      schema: 3,
      suite: 'android-db-contract',
      status: 'fail',
      migrationCount: 44,
      migrationHead: '0044_custom_folder_unread_badge',
      checks: { oldKeyRejected: true, cleanup: false },
      failureCode: 'cleanup',
    });
    expect(harness.finalCleanup.close).toHaveBeenCalledTimes(1);
  });
});
