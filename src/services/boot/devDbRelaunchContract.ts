import { File, Paths } from 'expo-file-system';
import { logger } from '@core/secure';
import {
  cleanupDbActiveMigrationDeathSelfTestDatabase,
  cleanupDbActiveWalWriteDeathSelfTestDatabase,
  cleanupDbProcessRelaunchSelfTestDatabase,
  cleanupDbRuntimeConcurrencySelfTestDatabase,
  prepareDbActiveMigrationDeathSelfTest,
  prepareDbActiveWalWriteDeathSelfTest,
  prepareDbProcessRelaunchSelfTest,
  resumeDbActiveMigrationDeathSelfTest,
  resumeDbActiveWalWriteDeathSelfTest,
  resumeDbProcessRelaunchSelfTest,
  runDbRuntimeConcurrencySelfTest,
  type DbActiveMigrationDeathPrepareChecks,
  type DbActiveMigrationDeathPrepareFailureCode,
  type DbActiveMigrationDeathResumeFailureCode,
  type DbActiveMigrationDeathResumeResult,
  type DbActiveWalWriteDeathPrepareChecks,
  type DbActiveWalWriteDeathPrepareFailureCode,
  type DbActiveWalWriteDeathResumeFailureCode,
  type DbActiveWalWriteDeathResumeResult,
  type DbProcessRelaunchPrepareChecks,
  type DbProcessRelaunchPrepareFailureCode,
  type DbProcessRelaunchResumeFailureCode,
  type DbProcessRelaunchResumeResult,
  type DbRuntimeConcurrencyDatabaseChecks,
  type DbRuntimeConcurrencyDatabaseFailureCode,
  type DbRuntimeConcurrencyDatabaseResult,
} from '@db/database';
import { runDbRuntimeConcurrencyWave } from '@/services/boot/dbRuntimeConcurrencyWave';

const DB_RELAUNCH_MARKER_PREFIX = 'GATOR_DB_RELAUNCH_V1 ';
const DB_WAL_WRITE_DEATH_MARKER_PREFIX = 'GATOR_DB_WAL_WRITE_DEATH_V1 ';
const DB_ACTIVE_MIGRATION_DEATH_MARKER_PREFIX = 'GATOR_DB_ACTIVE_MIGRATION_DEATH_V1 ';
const DB_RUNTIME_CONCURRENCY_MARKER_PREFIX = 'GATOR_DB_RUNTIME_CONCURRENCY_V1 ';
const DB_RELAUNCH_REQUEST_FILE = '.gator-db-relaunch-request-v1';
const DB_WAL_WRITE_DEATH_REQUEST_FILE = '.gator-db-wal-write-death-request-v1';
const DB_ACTIVE_MIGRATION_DEATH_REQUEST_FILE = '.gator-db-active-migration-death-request-v1';
const DB_RUNTIME_CONCURRENCY_REQUEST_FILE = '.gator-db-runtime-concurrency-request-v1';
const DB_RUNTIME_CONCURRENCY_RUNNING_FILE = '.gator-db-runtime-concurrency-running-v1';
const DB_RELAUNCH_PREPARING_FILE = '.gator-db-relaunch-preparing-v1';
const DB_RELAUNCH_READY_FILE = '.gator-db-relaunch-ready-v1';
const DB_RELAUNCH_RESUMING_FILE = '.gator-db-relaunch-resuming-v1';
const DB_WAL_WRITE_DEATH_PREPARING_FILE = '.gator-db-wal-write-death-preparing-v1';
const DB_WAL_WRITE_DEATH_READY_FILE = '.gator-db-wal-write-death-ready-v1';
const DB_WAL_WRITE_DEATH_RESUMING_FILE = '.gator-db-wal-write-death-resuming-v1';
const DB_ACTIVE_MIGRATION_DEATH_PREPARING_FILE = '.gator-db-active-migration-death-preparing-v1';
const DB_ACTIVE_MIGRATION_DEATH_READY_FILE = '.gator-db-active-migration-death-ready-v1';
const DB_ACTIVE_MIGRATION_DEATH_RESUMING_FILE = '.gator-db-active-migration-death-resuming-v1';
const DB_RELAUNCH_MIGRATION_COUNT = 43 as const;
const DB_RELAUNCH_MIGRATION_HEAD = '0043_custom_folders' as const;
const WAIT_FOR_HOST_PROCESS_KILL = new Promise<never>(() => undefined);

type DbRelaunchMarkerFileName =
  | typeof DB_RELAUNCH_REQUEST_FILE
  | typeof DB_WAL_WRITE_DEATH_REQUEST_FILE
  | typeof DB_ACTIVE_MIGRATION_DEATH_REQUEST_FILE
  | typeof DB_RUNTIME_CONCURRENCY_REQUEST_FILE
  | typeof DB_RUNTIME_CONCURRENCY_RUNNING_FILE
  | typeof DB_RELAUNCH_PREPARING_FILE
  | typeof DB_RELAUNCH_READY_FILE
  | typeof DB_RELAUNCH_RESUMING_FILE
  | typeof DB_WAL_WRITE_DEATH_PREPARING_FILE
  | typeof DB_WAL_WRITE_DEATH_READY_FILE
  | typeof DB_WAL_WRITE_DEATH_RESUMING_FILE
  | typeof DB_ACTIVE_MIGRATION_DEATH_PREPARING_FILE
  | typeof DB_ACTIVE_MIGRATION_DEATH_READY_FILE
  | typeof DB_ACTIVE_MIGRATION_DEATH_RESUMING_FILE;

interface DbRelaunchPrepareMarkerChecks extends DbProcessRelaunchPrepareChecks {
  requestValid: boolean;
  readyStatePersisted: boolean;
}

interface DbRelaunchFinalMarkerChecks {
  requestValid: boolean;
  phaseValid: boolean;
  readOnlyContinuityOpen: boolean;
  sameFileState: boolean;
  partialLedger: boolean;
  continuitySentinel: boolean;
  migrationRetry: boolean;
  migrationLedger: boolean;
  integrity: boolean;
  idempotent: boolean;
  databaseCleanup: boolean;
  stateCleanup: boolean;
}

interface DbWalWriteDeathPrepareMarkerChecks extends DbActiveWalWriteDeathPrepareChecks {
  requestValid: boolean;
  readyStatePersisted: boolean;
}

interface DbWalWriteDeathFinalMarkerChecks {
  requestValid: boolean;
  phaseValid: boolean;
  readOnlyRecoveryOpen: boolean;
  walMode: boolean;
  baselinePresent: boolean;
  uncommittedAbsent: boolean;
  integrity: boolean;
  foreignKeys: boolean;
  recoveryCommit: boolean;
  reopenPersistence: boolean;
  databaseCleanup: boolean;
  stateCleanup: boolean;
}

interface DbActiveMigrationDeathPrepareMarkerChecks extends DbActiveMigrationDeathPrepareChecks {
  requestValid: boolean;
  readyStatePersisted: boolean;
}

interface DbActiveMigrationDeathFinalMarkerChecks {
  requestValid: boolean;
  phaseValid: boolean;
  readOnlyRecoveryOpen: boolean;
  walMode: boolean;
  migrationPrefixPreserved: boolean;
  uncommittedMigrationAbsent: boolean;
  integrity: boolean;
  foreignKeys: boolean;
  migrationRetry: boolean;
  migrationLedger: boolean;
  migrationData: boolean;
  idempotent: boolean;
  reopenPersistence: boolean;
  databaseCleanup: boolean;
  stateCleanup: boolean;
}

interface DbRuntimeConcurrencyMarkerChecks extends DbRuntimeConcurrencyDatabaseChecks {
  requestValid: boolean;
  runStatePersisted: boolean;
  stateCleanup: boolean;
}

export type DbRelaunchFailureCode =
  | DbProcessRelaunchPrepareFailureCode
  | DbProcessRelaunchResumeFailureCode
  | 'request-invalid'
  | 'phase-invalid'
  | 'interrupted-prepare'
  | 'interrupted-resume'
  | 'orphaned-state'
  | 'ready-state'
  | 'state-cleanup';

export type DbWalWriteDeathFailureCode =
  | DbActiveWalWriteDeathPrepareFailureCode
  | DbActiveWalWriteDeathResumeFailureCode
  | 'request-invalid'
  | 'phase-invalid'
  | 'interrupted-prepare'
  | 'interrupted-resume'
  | 'orphaned-state'
  | 'ready-state'
  | 'state-cleanup';

export type DbActiveMigrationDeathFailureCode =
  | DbActiveMigrationDeathPrepareFailureCode
  | DbActiveMigrationDeathResumeFailureCode
  | 'request-invalid'
  | 'phase-invalid'
  | 'interrupted-prepare'
  | 'interrupted-resume'
  | 'orphaned-state'
  | 'ready-state'
  | 'state-cleanup';

export type DbRuntimeConcurrencyFailureCode =
  | DbRuntimeConcurrencyDatabaseFailureCode
  | 'request-invalid'
  | 'phase-invalid'
  | 'interrupted-run'
  | 'orphaned-state'
  | 'run-state'
  | 'state-cleanup';

type DbRelaunchPrepareMarker =
  | {
      schema: 1;
      suite: 'android-db-relaunch';
      status: 'ready';
      phase: 'prepare';
      checks: DbRelaunchPrepareMarkerChecks;
    }
  | {
      schema: 1;
      suite: 'android-db-relaunch';
      status: 'fail';
      phase: 'prepare';
      checks: DbRelaunchPrepareMarkerChecks;
      failureCode: DbRelaunchFailureCode;
    };

type DbRelaunchFinalMarker =
  | {
      schema: 1;
      suite: 'android-db-relaunch';
      status: 'pass';
      phase: 'resume';
      migrationCount: typeof DB_RELAUNCH_MIGRATION_COUNT;
      migrationHead: typeof DB_RELAUNCH_MIGRATION_HEAD;
      checks: DbRelaunchFinalMarkerChecks;
    }
  | {
      schema: 1;
      suite: 'android-db-relaunch';
      status: 'fail';
      phase: 'resume' | 'recovery';
      migrationCount: typeof DB_RELAUNCH_MIGRATION_COUNT;
      migrationHead: typeof DB_RELAUNCH_MIGRATION_HEAD;
      checks: DbRelaunchFinalMarkerChecks;
      failureCode: DbRelaunchFailureCode;
    };

type DbWalWriteDeathPrepareMarker =
  | {
      schema: 1;
      suite: 'android-db-wal-write-death';
      status: 'ready';
      phase: 'prepare';
      checks: DbWalWriteDeathPrepareMarkerChecks;
    }
  | {
      schema: 1;
      suite: 'android-db-wal-write-death';
      status: 'fail';
      phase: 'prepare';
      checks: DbWalWriteDeathPrepareMarkerChecks;
      failureCode: DbWalWriteDeathFailureCode;
    };

type DbWalWriteDeathFinalMarker =
  | {
      schema: 1;
      suite: 'android-db-wal-write-death';
      status: 'pass';
      phase: 'resume';
      checks: DbWalWriteDeathFinalMarkerChecks;
    }
  | {
      schema: 1;
      suite: 'android-db-wal-write-death';
      status: 'fail';
      phase: 'resume' | 'recovery';
      checks: DbWalWriteDeathFinalMarkerChecks;
      failureCode: DbWalWriteDeathFailureCode;
    };

type DbActiveMigrationDeathPrepareMarker =
  | {
      schema: 1;
      suite: 'android-db-active-migration-death';
      status: 'ready';
      phase: 'prepare';
      checks: DbActiveMigrationDeathPrepareMarkerChecks;
    }
  | {
      schema: 1;
      suite: 'android-db-active-migration-death';
      status: 'fail';
      phase: 'prepare';
      checks: DbActiveMigrationDeathPrepareMarkerChecks;
      failureCode: DbActiveMigrationDeathFailureCode;
    };

type DbActiveMigrationDeathFinalMarker =
  | {
      schema: 1;
      suite: 'android-db-active-migration-death';
      status: 'pass';
      phase: 'resume';
      migrationCount: typeof DB_RELAUNCH_MIGRATION_COUNT;
      migrationHead: typeof DB_RELAUNCH_MIGRATION_HEAD;
      checks: DbActiveMigrationDeathFinalMarkerChecks;
    }
  | {
      schema: 1;
      suite: 'android-db-active-migration-death';
      status: 'fail';
      phase: 'resume' | 'recovery';
      migrationCount: typeof DB_RELAUNCH_MIGRATION_COUNT;
      migrationHead: typeof DB_RELAUNCH_MIGRATION_HEAD;
      checks: DbActiveMigrationDeathFinalMarkerChecks;
      failureCode: DbActiveMigrationDeathFailureCode;
    };

type DbRuntimeConcurrencyMarker =
  | {
      schema: 1;
      suite: 'android-db-runtime-concurrency';
      status: 'pass';
      migrationCount: typeof DB_RELAUNCH_MIGRATION_COUNT;
      migrationHead: typeof DB_RELAUNCH_MIGRATION_HEAD;
      checks: DbRuntimeConcurrencyMarkerChecks;
    }
  | {
      schema: 1;
      suite: 'android-db-runtime-concurrency';
      status: 'fail';
      migrationCount: typeof DB_RELAUNCH_MIGRATION_COUNT;
      migrationHead: typeof DB_RELAUNCH_MIGRATION_HEAD;
      checks: DbRuntimeConcurrencyMarkerChecks;
      failureCode: DbRuntimeConcurrencyFailureCode;
    };

type MarkerPresence = 'absent' | 'zero-byte' | 'invalid';

interface DurableMarkerSnapshot {
  request: MarkerPresence;
  walWriteDeathRequest: MarkerPresence;
  activeMigrationDeathRequest: MarkerPresence;
  runtimeConcurrencyRequest: MarkerPresence;
  runtimeConcurrencyRunning: MarkerPresence;
  preparing: MarkerPresence;
  ready: MarkerPresence;
  resuming: MarkerPresence;
  walWriteDeathPreparing: MarkerPresence;
  walWriteDeathReady: MarkerPresence;
  walWriteDeathResuming: MarkerPresence;
  activeMigrationDeathPreparing: MarkerPresence;
  activeMigrationDeathReady: MarkerPresence;
  activeMigrationDeathResuming: MarkerPresence;
}

type DbRelaunchScenario =
  | 'migration-relaunch'
  | 'active-wal-write-death'
  | 'active-migration-death'
  | 'runtime-concurrency';
type DbRelaunchStateFailureCode =
  | 'request-invalid'
  | 'phase-invalid'
  | 'interrupted-prepare'
  | 'interrupted-resume'
  | 'orphaned-state'
  | 'internal';
type DbAnyRelaunchStateFailureCode = DbRelaunchStateFailureCode | 'interrupted-run';

type DbRelaunchStartMode =
  | { kind: 'none' }
  | { kind: 'prepare'; scenario: DbRelaunchScenario }
  | { kind: 'resume'; scenario: DbRelaunchScenario }
  | {
      kind: 'recovery';
      scenario: DbRelaunchScenario;
      failureCode: DbAnyRelaunchStateFailureCode;
      requestValid: boolean;
    };

function markerFile(name: DbRelaunchMarkerFileName): File {
  return new File(Paths.document, name);
}

function markerPresence(name: DbRelaunchMarkerFileName): MarkerPresence {
  const info = markerFile(name).info();
  if (!info.exists) return 'absent';
  return info.size === 0 ? 'zero-byte' : 'invalid';
}

function inspectDurableMarkers(): DurableMarkerSnapshot {
  return {
    request: markerPresence(DB_RELAUNCH_REQUEST_FILE),
    walWriteDeathRequest: markerPresence(DB_WAL_WRITE_DEATH_REQUEST_FILE),
    activeMigrationDeathRequest: markerPresence(DB_ACTIVE_MIGRATION_DEATH_REQUEST_FILE),
    runtimeConcurrencyRequest: markerPresence(DB_RUNTIME_CONCURRENCY_REQUEST_FILE),
    runtimeConcurrencyRunning: markerPresence(DB_RUNTIME_CONCURRENCY_RUNNING_FILE),
    preparing: markerPresence(DB_RELAUNCH_PREPARING_FILE),
    ready: markerPresence(DB_RELAUNCH_READY_FILE),
    resuming: markerPresence(DB_RELAUNCH_RESUMING_FILE),
    walWriteDeathPreparing: markerPresence(DB_WAL_WRITE_DEATH_PREPARING_FILE),
    walWriteDeathReady: markerPresence(DB_WAL_WRITE_DEATH_READY_FILE),
    walWriteDeathResuming: markerPresence(DB_WAL_WRITE_DEATH_RESUMING_FILE),
    activeMigrationDeathPreparing: markerPresence(DB_ACTIVE_MIGRATION_DEATH_PREPARING_FILE),
    activeMigrationDeathReady: markerPresence(DB_ACTIVE_MIGRATION_DEATH_READY_FILE),
    activeMigrationDeathResuming: markerPresence(DB_ACTIVE_MIGRATION_DEATH_RESUMING_FILE),
  };
}

function classifyRuntimeConcurrencyState(
  request: MarkerPresence,
  running: MarkerPresence,
): DbRelaunchStartMode {
  if (request === 'invalid' || running === 'invalid') {
    return {
      kind: 'recovery',
      scenario: 'runtime-concurrency',
      failureCode: request === 'invalid' ? 'request-invalid' : 'phase-invalid',
      requestValid: request === 'zero-byte',
    };
  }
  if (request === 'absent') {
    return {
      kind: 'recovery',
      scenario: 'runtime-concurrency',
      failureCode: 'orphaned-state',
      requestValid: false,
    };
  }
  if (running === 'zero-byte') {
    return {
      kind: 'recovery',
      scenario: 'runtime-concurrency',
      failureCode: 'interrupted-run',
      requestValid: true,
    };
  }
  return { kind: 'prepare', scenario: 'runtime-concurrency' };
}

function runtimeConcurrencyRecoveryFailureCode(
  failureCode: DbAnyRelaunchStateFailureCode,
): DbRuntimeConcurrencyFailureCode {
  if (
    failureCode === 'request-invalid' ||
    failureCode === 'phase-invalid' ||
    failureCode === 'interrupted-run' ||
    failureCode === 'orphaned-state' ||
    failureCode === 'internal'
  ) {
    return failureCode;
  }
  return 'phase-invalid';
}

function standardRelaunchRecoveryFailureCode(
  failureCode: DbAnyRelaunchStateFailureCode,
): DbRelaunchStateFailureCode {
  return failureCode === 'interrupted-run' ? 'phase-invalid' : failureCode;
}

function classifyScenarioState(
  scenario: DbRelaunchScenario,
  request: MarkerPresence,
  preparing: MarkerPresence,
  ready: MarkerPresence,
  resuming: MarkerPresence,
): DbRelaunchStartMode {
  if ([request, preparing, ready, resuming].includes('invalid')) {
    return {
      kind: 'recovery',
      scenario,
      failureCode: request === 'invalid' ? 'request-invalid' : 'phase-invalid',
      requestValid: request === 'zero-byte',
    };
  }

  const hasRequest = request === 'zero-byte';
  const hasPreparing = preparing === 'zero-byte';
  const hasReady = ready === 'zero-byte';
  const hasResuming = resuming === 'zero-byte';

  if (!hasRequest) {
    return {
      kind: 'recovery',
      scenario,
      failureCode: 'orphaned-state',
      requestValid: false,
    };
  }
  if (!hasPreparing && !hasReady && !hasResuming) return { kind: 'prepare', scenario };
  if (hasPreparing && hasReady && !hasResuming) return { kind: 'resume', scenario };
  if (hasPreparing && !hasReady && !hasResuming) {
    return {
      kind: 'recovery',
      scenario,
      failureCode: 'interrupted-prepare',
      requestValid: true,
    };
  }
  if (hasPreparing && hasReady && hasResuming) {
    return {
      kind: 'recovery',
      scenario,
      failureCode: 'interrupted-resume',
      requestValid: true,
    };
  }
  return { kind: 'recovery', scenario, failureCode: 'phase-invalid', requestValid: true };
}

function classifyStartMode(snapshot: DurableMarkerSnapshot): DbRelaunchStartMode {
  const relaunchState = [
    snapshot.request,
    snapshot.preparing,
    snapshot.ready,
    snapshot.resuming,
  ] as const;
  const walWriteDeathState = [
    snapshot.walWriteDeathRequest,
    snapshot.walWriteDeathPreparing,
    snapshot.walWriteDeathReady,
    snapshot.walWriteDeathResuming,
  ] as const;
  const activeMigrationDeathState = [
    snapshot.activeMigrationDeathRequest,
    snapshot.activeMigrationDeathPreparing,
    snapshot.activeMigrationDeathReady,
    snapshot.activeMigrationDeathResuming,
  ] as const;
  const runtimeConcurrencyState = [
    snapshot.runtimeConcurrencyRequest,
    snapshot.runtimeConcurrencyRunning,
  ] as const;
  const hasRelaunchState = relaunchState.some((presence) => presence !== 'absent');
  const hasWalWriteDeathState = walWriteDeathState.some((presence) => presence !== 'absent');
  const hasActiveMigrationDeathState = activeMigrationDeathState.some(
    (presence) => presence !== 'absent',
  );
  const hasRuntimeConcurrencyState = runtimeConcurrencyState.some(
    (presence) => presence !== 'absent',
  );
  const activeScenarioCount = [
    hasRelaunchState,
    hasWalWriteDeathState,
    hasActiveMigrationDeathState,
    hasRuntimeConcurrencyState,
  ].filter(Boolean).length;

  if (activeScenarioCount === 0) return { kind: 'none' };
  if (activeScenarioCount > 1) {
    return {
      kind: 'recovery',
      scenario: hasRuntimeConcurrencyState
        ? 'runtime-concurrency'
        : hasActiveMigrationDeathState
          ? 'active-migration-death'
          : 'active-wal-write-death',
      failureCode: 'phase-invalid',
      requestValid: false,
    };
  }
  if (hasRuntimeConcurrencyState) {
    return classifyRuntimeConcurrencyState(...runtimeConcurrencyState);
  }
  if (hasWalWriteDeathState) {
    return classifyScenarioState('active-wal-write-death', ...walWriteDeathState);
  }
  if (hasActiveMigrationDeathState) {
    return classifyScenarioState('active-migration-death', ...activeMigrationDeathState);
  }
  return classifyScenarioState('migration-relaunch', ...relaunchState);
}

function createZeroByteMarker(name: DbRelaunchMarkerFileName): void {
  const file = markerFile(name);
  if (file.info().exists) throw new Error('durable DB relaunch marker already exists');
  try {
    file.create();
  } catch (error) {
    const info = file.info();
    if (info.exists && info.size === 0) return;
    throw error;
  }
  const info = file.info();
  if (!info.exists || info.size !== 0) {
    throw new Error('durable DB relaunch marker was not created atomically');
  }
}

function deleteMarkerIfPresent(name: DbRelaunchMarkerFileName): boolean {
  try {
    const file = markerFile(name);
    if (file.info().exists) file.delete();
    return !file.info().exists;
  } catch {
    return false;
  }
}

/**
 * Remove durable state only after the disposable database is gone.
 *
 * The request is deleted first. If the process dies during later marker deletion, the next launch
 * sees orphaned phase files and cleans them instead of mistaking the state for a fresh request.
 */
function cleanupDurableMarkers(): boolean {
  if (!deleteMarkerIfPresent(DB_RELAUNCH_REQUEST_FILE)) return false;
  if (!deleteMarkerIfPresent(DB_WAL_WRITE_DEATH_REQUEST_FILE)) return false;
  if (!deleteMarkerIfPresent(DB_ACTIVE_MIGRATION_DEATH_REQUEST_FILE)) return false;
  if (!deleteMarkerIfPresent(DB_RUNTIME_CONCURRENCY_REQUEST_FILE)) return false;
  const resuming = deleteMarkerIfPresent(DB_RELAUNCH_RESUMING_FILE);
  const ready = deleteMarkerIfPresent(DB_RELAUNCH_READY_FILE);
  const preparing = deleteMarkerIfPresent(DB_RELAUNCH_PREPARING_FILE);
  const walWriteDeathResuming = deleteMarkerIfPresent(DB_WAL_WRITE_DEATH_RESUMING_FILE);
  const walWriteDeathReady = deleteMarkerIfPresent(DB_WAL_WRITE_DEATH_READY_FILE);
  const walWriteDeathPreparing = deleteMarkerIfPresent(DB_WAL_WRITE_DEATH_PREPARING_FILE);
  const activeMigrationDeathResuming = deleteMarkerIfPresent(
    DB_ACTIVE_MIGRATION_DEATH_RESUMING_FILE,
  );
  const activeMigrationDeathReady = deleteMarkerIfPresent(DB_ACTIVE_MIGRATION_DEATH_READY_FILE);
  const activeMigrationDeathPreparing = deleteMarkerIfPresent(
    DB_ACTIVE_MIGRATION_DEATH_PREPARING_FILE,
  );
  const runtimeConcurrencyRunning = deleteMarkerIfPresent(DB_RUNTIME_CONCURRENCY_RUNNING_FILE);
  return (
    resuming &&
    ready &&
    preparing &&
    walWriteDeathResuming &&
    walWriteDeathReady &&
    walWriteDeathPreparing &&
    activeMigrationDeathResuming &&
    activeMigrationDeathReady &&
    activeMigrationDeathPreparing &&
    runtimeConcurrencyRunning
  );
}

function emptyPrepareMarkerChecks(): DbRelaunchPrepareMarkerChecks {
  return {
    requestValid: false,
    preCleanup: false,
    encryptedOpen: false,
    migrationRollback: false,
    partialLedger: false,
    continuitySentinel: false,
    readyStatePersisted: false,
  };
}

function emptyFinalMarkerChecks(): DbRelaunchFinalMarkerChecks {
  return {
    requestValid: false,
    phaseValid: false,
    readOnlyContinuityOpen: false,
    sameFileState: false,
    partialLedger: false,
    continuitySentinel: false,
    migrationRetry: false,
    migrationLedger: false,
    integrity: false,
    idempotent: false,
    databaseCleanup: false,
    stateCleanup: false,
  };
}

function emptyWalWriteDeathPrepareMarkerChecks(): DbWalWriteDeathPrepareMarkerChecks {
  return {
    requestValid: false,
    preCleanup: false,
    encryptedOpen: false,
    walMode: false,
    baselineCommitted: false,
    walCheckpointTruncated: false,
    writeTransactionOpen: false,
    uncommittedCanaryWritten: false,
    readyStatePersisted: false,
  };
}

function emptyWalWriteDeathFinalMarkerChecks(): DbWalWriteDeathFinalMarkerChecks {
  return {
    requestValid: false,
    phaseValid: false,
    readOnlyRecoveryOpen: false,
    walMode: false,
    baselinePresent: false,
    uncommittedAbsent: false,
    integrity: false,
    foreignKeys: false,
    recoveryCommit: false,
    reopenPersistence: false,
    databaseCleanup: false,
    stateCleanup: false,
  };
}

function emptyActiveMigrationDeathPrepareMarkerChecks(): DbActiveMigrationDeathPrepareMarkerChecks {
  return {
    requestValid: false,
    preCleanup: false,
    encryptedOpen: false,
    walMode: false,
    migrationPrefixPrepared: false,
    baselineCommitted: false,
    walCheckpointTruncated: false,
    migrationTransactionOpen: false,
    migrationWriteApplied: false,
    migrationLedgerPending: false,
    readyStatePersisted: false,
  };
}

function emptyActiveMigrationDeathFinalMarkerChecks(): DbActiveMigrationDeathFinalMarkerChecks {
  return {
    requestValid: false,
    phaseValid: false,
    readOnlyRecoveryOpen: false,
    walMode: false,
    migrationPrefixPreserved: false,
    uncommittedMigrationAbsent: false,
    integrity: false,
    foreignKeys: false,
    migrationRetry: false,
    migrationLedger: false,
    migrationData: false,
    idempotent: false,
    reopenPersistence: false,
    databaseCleanup: false,
    stateCleanup: false,
  };
}

type MutableDbRuntimeConcurrencyMarkerChecks = {
  -readonly [K in keyof DbRuntimeConcurrencyMarkerChecks]: DbRuntimeConcurrencyMarkerChecks[K];
};

function emptyRuntimeConcurrencyMarkerChecks(): MutableDbRuntimeConcurrencyMarkerChecks {
  return {
    requestValid: false,
    runStatePersisted: false,
    preCleanup: false,
    encryptedOpen: false,
    migrationLedger: false,
    rollbackIsolation: false,
    syncChunks: false,
    liveMessages: false,
    attachmentConstruction: false,
    uploadOutsideDbOwner: false,
    rekeyExclusive: false,
    queuedWritersBlocked: false,
    rekeyApplied: false,
    queuedWritersResumed: false,
    uploadSettlement: false,
    queueDrained: false,
    sentinelCommit: false,
    newKeyReopen: false,
    oldKeyRejected: false,
    integrity: false,
    databaseCleanup: false,
    stateCleanup: false,
  };
}

function logPrepareMarker(marker: DbRelaunchPrepareMarker): void {
  logger.info(`${DB_RELAUNCH_MARKER_PREFIX}${JSON.stringify(marker)}`);
}

function logFinalMarker(marker: DbRelaunchFinalMarker): void {
  logger.info(`${DB_RELAUNCH_MARKER_PREFIX}${JSON.stringify(marker)}`);
}

function logWalWriteDeathPrepareMarker(marker: DbWalWriteDeathPrepareMarker): void {
  logger.info(`${DB_WAL_WRITE_DEATH_MARKER_PREFIX}${JSON.stringify(marker)}`);
}

function logWalWriteDeathFinalMarker(marker: DbWalWriteDeathFinalMarker): void {
  logger.info(`${DB_WAL_WRITE_DEATH_MARKER_PREFIX}${JSON.stringify(marker)}`);
}

function logActiveMigrationDeathPrepareMarker(marker: DbActiveMigrationDeathPrepareMarker): void {
  logger.info(`${DB_ACTIVE_MIGRATION_DEATH_MARKER_PREFIX}${JSON.stringify(marker)}`);
}

function logActiveMigrationDeathFinalMarker(marker: DbActiveMigrationDeathFinalMarker): void {
  logger.info(`${DB_ACTIVE_MIGRATION_DEATH_MARKER_PREFIX}${JSON.stringify(marker)}`);
}

function logRuntimeConcurrencyMarker(marker: DbRuntimeConcurrencyMarker): void {
  logger.info(`${DB_RUNTIME_CONCURRENCY_MARKER_PREFIX}${JSON.stringify(marker)}`);
}

async function waitForHostKill(): Promise<never> {
  return WAIT_FOR_HOST_PROCESS_KILL;
}

async function finishRuntimeConcurrencyFailure(
  checks: MutableDbRuntimeConcurrencyMarkerChecks,
  failureCode: DbRuntimeConcurrencyFailureCode,
  knownDatabaseCleanup?: boolean,
): Promise<never> {
  checks.databaseCleanup = knownDatabaseCleanup ?? cleanupDbRuntimeConcurrencySelfTestDatabase();
  if (checks.databaseCleanup) checks.stateCleanup = cleanupDurableMarkers();
  const finalFailureCode: DbRuntimeConcurrencyFailureCode = !checks.databaseCleanup
    ? 'database-cleanup'
    : !checks.stateCleanup
      ? 'state-cleanup'
      : failureCode;
  logRuntimeConcurrencyMarker({
    schema: 1,
    suite: 'android-db-runtime-concurrency',
    status: 'fail',
    migrationCount: DB_RELAUNCH_MIGRATION_COUNT,
    migrationHead: DB_RELAUNCH_MIGRATION_HEAD,
    checks,
    failureCode: finalFailureCode,
  });
  return waitForHostKill();
}

async function runRuntimeConcurrencyPhase(): Promise<never> {
  const checks = emptyRuntimeConcurrencyMarkerChecks();
  checks.requestValid = true;
  try {
    createZeroByteMarker(DB_RUNTIME_CONCURRENCY_RUNNING_FILE);
    checks.runStatePersisted = true;
  } catch {
    return finishRuntimeConcurrencyFailure(checks, 'run-state');
  }

  let result: DbRuntimeConcurrencyDatabaseResult;
  try {
    result = await runDbRuntimeConcurrencySelfTest(runDbRuntimeConcurrencyWave);
  } catch {
    return finishRuntimeConcurrencyFailure(checks, 'internal');
  }
  Object.assign(checks, result.checks);
  if (checks.databaseCleanup) checks.stateCleanup = cleanupDurableMarkers();

  const failureCode: DbRuntimeConcurrencyFailureCode | undefined = !checks.databaseCleanup
    ? 'database-cleanup'
    : !checks.stateCleanup
      ? 'state-cleanup'
      : result.status === 'fail'
        ? result.failureCode
        : undefined;
  if (!failureCode && Object.values(checks).every(Boolean)) {
    logRuntimeConcurrencyMarker({
      schema: 1,
      suite: 'android-db-runtime-concurrency',
      status: 'pass',
      migrationCount: DB_RELAUNCH_MIGRATION_COUNT,
      migrationHead: DB_RELAUNCH_MIGRATION_HEAD,
      checks,
    });
  } else {
    logRuntimeConcurrencyMarker({
      schema: 1,
      suite: 'android-db-runtime-concurrency',
      status: 'fail',
      migrationCount: DB_RELAUNCH_MIGRATION_COUNT,
      migrationHead: DB_RELAUNCH_MIGRATION_HEAD,
      checks,
      failureCode: failureCode ?? 'internal',
    });
  }
  return waitForHostKill();
}

async function runRuntimeConcurrencyRecoveryPhase(
  failureCode: DbRuntimeConcurrencyFailureCode,
  requestValid: boolean,
): Promise<never> {
  const checks = emptyRuntimeConcurrencyMarkerChecks();
  checks.requestValid = requestValid;
  const relaunchCleanup = cleanupDbProcessRelaunchSelfTestDatabase();
  const walWriteDeathCleanup = cleanupDbActiveWalWriteDeathSelfTestDatabase();
  const activeMigrationDeathCleanup = cleanupDbActiveMigrationDeathSelfTestDatabase();
  const runtimeConcurrencyCleanup = cleanupDbRuntimeConcurrencySelfTestDatabase();
  checks.databaseCleanup =
    relaunchCleanup &&
    walWriteDeathCleanup &&
    activeMigrationDeathCleanup &&
    runtimeConcurrencyCleanup;
  if (checks.databaseCleanup) checks.stateCleanup = cleanupDurableMarkers();
  const finalFailureCode: DbRuntimeConcurrencyFailureCode = !checks.databaseCleanup
    ? 'database-cleanup'
    : !checks.stateCleanup
      ? 'state-cleanup'
      : failureCode;
  logRuntimeConcurrencyMarker({
    schema: 1,
    suite: 'android-db-runtime-concurrency',
    status: 'fail',
    migrationCount: DB_RELAUNCH_MIGRATION_COUNT,
    migrationHead: DB_RELAUNCH_MIGRATION_HEAD,
    checks,
    failureCode: finalFailureCode,
  });
  return waitForHostKill();
}

async function finishPrepareFailure(
  checks: DbRelaunchPrepareMarkerChecks,
  failureCode: DbRelaunchFailureCode,
  knownDatabaseCleanup?: boolean,
): Promise<never> {
  const databaseCleanup = knownDatabaseCleanup ?? cleanupDbProcessRelaunchSelfTestDatabase();
  let finalFailureCode = databaseCleanup ? failureCode : 'database-cleanup';
  if (databaseCleanup && !cleanupDurableMarkers()) finalFailureCode = 'state-cleanup';
  logPrepareMarker({
    schema: 1,
    suite: 'android-db-relaunch',
    status: 'fail',
    phase: 'prepare',
    checks,
    failureCode: finalFailureCode,
  });
  return waitForHostKill();
}

async function runPreparePhase(): Promise<never> {
  const markerChecks = emptyPrepareMarkerChecks();
  markerChecks.requestValid = true;
  try {
    createZeroByteMarker(DB_RELAUNCH_PREPARING_FILE);
  } catch {
    return finishPrepareFailure(markerChecks, 'phase-invalid');
  }

  try {
    const failure = await prepareDbProcessRelaunchSelfTest(async (databaseChecks) => {
      Object.assign(markerChecks, databaseChecks);
      createZeroByteMarker(DB_RELAUNCH_READY_FILE);
      markerChecks.readyStatePersisted = true;
      logPrepareMarker({
        schema: 1,
        suite: 'android-db-relaunch',
        status: 'ready',
        phase: 'prepare',
        checks: markerChecks,
      });
      return waitForHostKill();
    });
    Object.assign(markerChecks, failure.checks);
    return finishPrepareFailure(markerChecks, failure.failureCode, failure.databaseCleanup);
  } catch {
    return finishPrepareFailure(markerChecks, 'ready-state');
  }
}

function finalChecksFromDatabaseResult(
  result: DbProcessRelaunchResumeResult,
): DbRelaunchFinalMarkerChecks {
  return {
    requestValid: true,
    phaseValid: true,
    ...result.checks,
    stateCleanup: false,
  };
}

async function runResumePhase(): Promise<never> {
  let result: DbProcessRelaunchResumeResult;
  try {
    result = await resumeDbProcessRelaunchSelfTest(() => {
      createZeroByteMarker(DB_RELAUNCH_RESUMING_FILE);
    });
  } catch {
    const checks = emptyFinalMarkerChecks();
    checks.requestValid = true;
    checks.phaseValid = true;
    checks.databaseCleanup = cleanupDbProcessRelaunchSelfTestDatabase();
    if (checks.databaseCleanup) checks.stateCleanup = cleanupDurableMarkers();
    const failureCode: DbRelaunchFailureCode = !checks.databaseCleanup
      ? 'database-cleanup'
      : !checks.stateCleanup
        ? 'state-cleanup'
        : 'internal';
    logFinalMarker({
      schema: 1,
      suite: 'android-db-relaunch',
      status: 'fail',
      phase: 'resume',
      migrationCount: DB_RELAUNCH_MIGRATION_COUNT,
      migrationHead: DB_RELAUNCH_MIGRATION_HEAD,
      checks,
      failureCode,
    });
    return waitForHostKill();
  }

  const checks = finalChecksFromDatabaseResult(result);
  if (checks.databaseCleanup) checks.stateCleanup = cleanupDurableMarkers();
  const failureCode: DbRelaunchFailureCode | undefined = !checks.databaseCleanup
    ? 'database-cleanup'
    : !checks.stateCleanup
      ? 'state-cleanup'
      : result.status === 'fail'
        ? result.failureCode
        : undefined;

  if (!failureCode && Object.values(checks).every(Boolean)) {
    logFinalMarker({
      schema: 1,
      suite: 'android-db-relaunch',
      status: 'pass',
      phase: 'resume',
      migrationCount: DB_RELAUNCH_MIGRATION_COUNT,
      migrationHead: DB_RELAUNCH_MIGRATION_HEAD,
      checks,
    });
  } else {
    logFinalMarker({
      schema: 1,
      suite: 'android-db-relaunch',
      status: 'fail',
      phase: 'resume',
      migrationCount: DB_RELAUNCH_MIGRATION_COUNT,
      migrationHead: DB_RELAUNCH_MIGRATION_HEAD,
      checks,
      failureCode: failureCode ?? 'internal',
    });
  }
  return waitForHostKill();
}

async function runRecoveryPhase(
  failureCode: DbRelaunchFailureCode,
  requestValid: boolean,
): Promise<never> {
  const checks = emptyFinalMarkerChecks();
  checks.requestValid = requestValid;
  const relaunchCleanup = cleanupDbProcessRelaunchSelfTestDatabase();
  const walWriteDeathCleanup = cleanupDbActiveWalWriteDeathSelfTestDatabase();
  const activeMigrationDeathCleanup = cleanupDbActiveMigrationDeathSelfTestDatabase();
  const runtimeConcurrencyCleanup = cleanupDbRuntimeConcurrencySelfTestDatabase();
  checks.databaseCleanup =
    relaunchCleanup &&
    walWriteDeathCleanup &&
    activeMigrationDeathCleanup &&
    runtimeConcurrencyCleanup;
  if (checks.databaseCleanup) checks.stateCleanup = cleanupDurableMarkers();
  const finalFailureCode: DbRelaunchFailureCode = !checks.databaseCleanup
    ? 'database-cleanup'
    : !checks.stateCleanup
      ? 'state-cleanup'
      : failureCode;
  logFinalMarker({
    schema: 1,
    suite: 'android-db-relaunch',
    status: 'fail',
    phase: 'recovery',
    migrationCount: DB_RELAUNCH_MIGRATION_COUNT,
    migrationHead: DB_RELAUNCH_MIGRATION_HEAD,
    checks,
    failureCode: finalFailureCode,
  });
  return waitForHostKill();
}

async function finishWalWriteDeathPrepareFailure(
  checks: DbWalWriteDeathPrepareMarkerChecks,
  failureCode: DbWalWriteDeathFailureCode,
  knownDatabaseCleanup?: boolean,
): Promise<never> {
  const databaseCleanup = knownDatabaseCleanup ?? cleanupDbActiveWalWriteDeathSelfTestDatabase();
  let finalFailureCode = databaseCleanup ? failureCode : 'database-cleanup';
  if (databaseCleanup && !cleanupDurableMarkers()) finalFailureCode = 'state-cleanup';
  logWalWriteDeathPrepareMarker({
    schema: 1,
    suite: 'android-db-wal-write-death',
    status: 'fail',
    phase: 'prepare',
    checks,
    failureCode: finalFailureCode,
  });
  return waitForHostKill();
}

async function runWalWriteDeathPreparePhase(): Promise<never> {
  const markerChecks = emptyWalWriteDeathPrepareMarkerChecks();
  markerChecks.requestValid = true;
  try {
    createZeroByteMarker(DB_WAL_WRITE_DEATH_PREPARING_FILE);
  } catch {
    return finishWalWriteDeathPrepareFailure(markerChecks, 'phase-invalid');
  }

  try {
    const failure = await prepareDbActiveWalWriteDeathSelfTest(async (databaseChecks) => {
      Object.assign(markerChecks, databaseChecks);
      createZeroByteMarker(DB_WAL_WRITE_DEATH_READY_FILE);
      markerChecks.readyStatePersisted = true;
      logWalWriteDeathPrepareMarker({
        schema: 1,
        suite: 'android-db-wal-write-death',
        status: 'ready',
        phase: 'prepare',
        checks: markerChecks,
      });
      return waitForHostKill();
    });
    Object.assign(markerChecks, failure.checks);
    return finishWalWriteDeathPrepareFailure(
      markerChecks,
      failure.failureCode,
      failure.databaseCleanup,
    );
  } catch {
    return finishWalWriteDeathPrepareFailure(markerChecks, 'ready-state');
  }
}

function walWriteDeathFinalChecksFromDatabaseResult(
  result: DbActiveWalWriteDeathResumeResult,
): DbWalWriteDeathFinalMarkerChecks {
  return {
    requestValid: true,
    phaseValid: true,
    ...result.checks,
    stateCleanup: false,
  };
}

async function runWalWriteDeathResumePhase(): Promise<never> {
  let result: DbActiveWalWriteDeathResumeResult;
  try {
    result = await resumeDbActiveWalWriteDeathSelfTest(() => {
      createZeroByteMarker(DB_WAL_WRITE_DEATH_RESUMING_FILE);
    });
  } catch {
    const checks = emptyWalWriteDeathFinalMarkerChecks();
    checks.requestValid = true;
    checks.phaseValid = true;
    checks.databaseCleanup = cleanupDbActiveWalWriteDeathSelfTestDatabase();
    if (checks.databaseCleanup) checks.stateCleanup = cleanupDurableMarkers();
    const failureCode: DbWalWriteDeathFailureCode = !checks.databaseCleanup
      ? 'database-cleanup'
      : !checks.stateCleanup
        ? 'state-cleanup'
        : 'internal';
    logWalWriteDeathFinalMarker({
      schema: 1,
      suite: 'android-db-wal-write-death',
      status: 'fail',
      phase: 'resume',
      checks,
      failureCode,
    });
    return waitForHostKill();
  }

  const checks = walWriteDeathFinalChecksFromDatabaseResult(result);
  if (checks.databaseCleanup) checks.stateCleanup = cleanupDurableMarkers();
  const failureCode: DbWalWriteDeathFailureCode | undefined = !checks.databaseCleanup
    ? 'database-cleanup'
    : !checks.stateCleanup
      ? 'state-cleanup'
      : result.status === 'fail'
        ? result.failureCode
        : undefined;

  if (!failureCode && Object.values(checks).every(Boolean)) {
    logWalWriteDeathFinalMarker({
      schema: 1,
      suite: 'android-db-wal-write-death',
      status: 'pass',
      phase: 'resume',
      checks,
    });
  } else {
    logWalWriteDeathFinalMarker({
      schema: 1,
      suite: 'android-db-wal-write-death',
      status: 'fail',
      phase: 'resume',
      checks,
      failureCode: failureCode ?? 'internal',
    });
  }
  return waitForHostKill();
}

async function runWalWriteDeathRecoveryPhase(
  failureCode: DbWalWriteDeathFailureCode,
  requestValid: boolean,
): Promise<never> {
  const checks = emptyWalWriteDeathFinalMarkerChecks();
  checks.requestValid = requestValid;
  const relaunchCleanup = cleanupDbProcessRelaunchSelfTestDatabase();
  const walWriteDeathCleanup = cleanupDbActiveWalWriteDeathSelfTestDatabase();
  const activeMigrationDeathCleanup = cleanupDbActiveMigrationDeathSelfTestDatabase();
  const runtimeConcurrencyCleanup = cleanupDbRuntimeConcurrencySelfTestDatabase();
  checks.databaseCleanup =
    relaunchCleanup &&
    walWriteDeathCleanup &&
    activeMigrationDeathCleanup &&
    runtimeConcurrencyCleanup;
  if (checks.databaseCleanup) checks.stateCleanup = cleanupDurableMarkers();
  const finalFailureCode: DbWalWriteDeathFailureCode = !checks.databaseCleanup
    ? 'database-cleanup'
    : !checks.stateCleanup
      ? 'state-cleanup'
      : failureCode;
  logWalWriteDeathFinalMarker({
    schema: 1,
    suite: 'android-db-wal-write-death',
    status: 'fail',
    phase: 'recovery',
    checks,
    failureCode: finalFailureCode,
  });
  return waitForHostKill();
}

async function finishActiveMigrationDeathPrepareFailure(
  checks: DbActiveMigrationDeathPrepareMarkerChecks,
  failureCode: DbActiveMigrationDeathFailureCode,
  knownDatabaseCleanup?: boolean,
): Promise<never> {
  const databaseCleanup = knownDatabaseCleanup ?? cleanupDbActiveMigrationDeathSelfTestDatabase();
  let finalFailureCode = databaseCleanup ? failureCode : 'database-cleanup';
  if (databaseCleanup && !cleanupDurableMarkers()) finalFailureCode = 'state-cleanup';
  logActiveMigrationDeathPrepareMarker({
    schema: 1,
    suite: 'android-db-active-migration-death',
    status: 'fail',
    phase: 'prepare',
    checks,
    failureCode: finalFailureCode,
  });
  return waitForHostKill();
}

async function runActiveMigrationDeathPreparePhase(): Promise<never> {
  const markerChecks = emptyActiveMigrationDeathPrepareMarkerChecks();
  markerChecks.requestValid = true;
  try {
    createZeroByteMarker(DB_ACTIVE_MIGRATION_DEATH_PREPARING_FILE);
  } catch {
    return finishActiveMigrationDeathPrepareFailure(markerChecks, 'phase-invalid');
  }

  try {
    const failure = await prepareDbActiveMigrationDeathSelfTest(async (databaseChecks) => {
      Object.assign(markerChecks, databaseChecks);
      createZeroByteMarker(DB_ACTIVE_MIGRATION_DEATH_READY_FILE);
      markerChecks.readyStatePersisted = true;
      logActiveMigrationDeathPrepareMarker({
        schema: 1,
        suite: 'android-db-active-migration-death',
        status: 'ready',
        phase: 'prepare',
        checks: markerChecks,
      });
      return waitForHostKill();
    });
    Object.assign(markerChecks, failure.checks);
    return finishActiveMigrationDeathPrepareFailure(
      markerChecks,
      failure.failureCode,
      failure.databaseCleanup,
    );
  } catch {
    return finishActiveMigrationDeathPrepareFailure(markerChecks, 'ready-state');
  }
}

function activeMigrationDeathFinalChecksFromDatabaseResult(
  result: DbActiveMigrationDeathResumeResult,
): DbActiveMigrationDeathFinalMarkerChecks {
  return {
    requestValid: true,
    phaseValid: true,
    ...result.checks,
    stateCleanup: false,
  };
}

async function runActiveMigrationDeathResumePhase(): Promise<never> {
  let result: DbActiveMigrationDeathResumeResult;
  try {
    result = await resumeDbActiveMigrationDeathSelfTest(() => {
      createZeroByteMarker(DB_ACTIVE_MIGRATION_DEATH_RESUMING_FILE);
    });
  } catch {
    const checks = emptyActiveMigrationDeathFinalMarkerChecks();
    checks.requestValid = true;
    checks.phaseValid = true;
    checks.databaseCleanup = cleanupDbActiveMigrationDeathSelfTestDatabase();
    if (checks.databaseCleanup) checks.stateCleanup = cleanupDurableMarkers();
    const failureCode: DbActiveMigrationDeathFailureCode = !checks.databaseCleanup
      ? 'database-cleanup'
      : !checks.stateCleanup
        ? 'state-cleanup'
        : 'internal';
    logActiveMigrationDeathFinalMarker({
      schema: 1,
      suite: 'android-db-active-migration-death',
      status: 'fail',
      phase: 'resume',
      migrationCount: DB_RELAUNCH_MIGRATION_COUNT,
      migrationHead: DB_RELAUNCH_MIGRATION_HEAD,
      checks,
      failureCode,
    });
    return waitForHostKill();
  }

  const checks = activeMigrationDeathFinalChecksFromDatabaseResult(result);
  if (checks.databaseCleanup) checks.stateCleanup = cleanupDurableMarkers();
  const failureCode: DbActiveMigrationDeathFailureCode | undefined = !checks.databaseCleanup
    ? 'database-cleanup'
    : !checks.stateCleanup
      ? 'state-cleanup'
      : result.status === 'fail'
        ? result.failureCode
        : undefined;

  if (!failureCode && Object.values(checks).every(Boolean)) {
    logActiveMigrationDeathFinalMarker({
      schema: 1,
      suite: 'android-db-active-migration-death',
      status: 'pass',
      phase: 'resume',
      migrationCount: DB_RELAUNCH_MIGRATION_COUNT,
      migrationHead: DB_RELAUNCH_MIGRATION_HEAD,
      checks,
    });
  } else {
    logActiveMigrationDeathFinalMarker({
      schema: 1,
      suite: 'android-db-active-migration-death',
      status: 'fail',
      phase: 'resume',
      migrationCount: DB_RELAUNCH_MIGRATION_COUNT,
      migrationHead: DB_RELAUNCH_MIGRATION_HEAD,
      checks,
      failureCode: failureCode ?? 'internal',
    });
  }
  return waitForHostKill();
}

async function runActiveMigrationDeathRecoveryPhase(
  failureCode: DbActiveMigrationDeathFailureCode,
  requestValid: boolean,
): Promise<never> {
  const checks = emptyActiveMigrationDeathFinalMarkerChecks();
  checks.requestValid = requestValid;
  const relaunchCleanup = cleanupDbProcessRelaunchSelfTestDatabase();
  const walWriteDeathCleanup = cleanupDbActiveWalWriteDeathSelfTestDatabase();
  const activeMigrationDeathCleanup = cleanupDbActiveMigrationDeathSelfTestDatabase();
  const runtimeConcurrencyCleanup = cleanupDbRuntimeConcurrencySelfTestDatabase();
  checks.databaseCleanup =
    relaunchCleanup &&
    walWriteDeathCleanup &&
    activeMigrationDeathCleanup &&
    runtimeConcurrencyCleanup;
  if (checks.databaseCleanup) checks.stateCleanup = cleanupDurableMarkers();
  const finalFailureCode: DbActiveMigrationDeathFailureCode = !checks.databaseCleanup
    ? 'database-cleanup'
    : !checks.stateCleanup
      ? 'state-cleanup'
      : failureCode;
  logActiveMigrationDeathFinalMarker({
    schema: 1,
    suite: 'android-db-active-migration-death',
    status: 'fail',
    phase: 'recovery',
    migrationCount: DB_RELAUNCH_MIGRATION_COUNT,
    migrationHead: DB_RELAUNCH_MIGRATION_HEAD,
    checks,
    failureCode: finalFailureCode,
  });
  return waitForHostKill();
}

let activeDbRelaunchContract: Promise<never> | undefined;
let ordinaryBootClaimedProcess = false;

/**
 * Claim a pending DEV relaunch request synchronously, before foreground boot can touch production.
 * With no durable request/phase marker this returns `undefined` and ordinary boot is unchanged.
 */
export function startDevDbRelaunchContractIfRequested(): Promise<never> | undefined {
  if (activeDbRelaunchContract) return activeDbRelaunchContract;
  if (ordinaryBootClaimedProcess) return undefined;

  let mode: DbRelaunchStartMode;
  try {
    mode = classifyStartMode(inspectDurableMarkers());
  } catch {
    mode = {
      kind: 'recovery',
      scenario: 'migration-relaunch',
      failureCode: 'internal',
      requestValid: false,
    };
  }
  if (mode.kind === 'none') {
    // A request appearing after ordinary foreground work started must wait for a fresh process;
    // otherwise the throwaway contract could overlap the production database in this process.
    ordinaryBootClaimedProcess = true;
    return undefined;
  }

  if (mode.scenario === 'runtime-concurrency') {
    if (mode.kind === 'prepare') activeDbRelaunchContract = runRuntimeConcurrencyPhase();
    else if (mode.kind === 'recovery') {
      activeDbRelaunchContract = runRuntimeConcurrencyRecoveryPhase(
        runtimeConcurrencyRecoveryFailureCode(mode.failureCode),
        mode.requestValid,
      );
    } else {
      activeDbRelaunchContract = runRuntimeConcurrencyRecoveryPhase('phase-invalid', false);
    }
  } else if (mode.scenario === 'active-migration-death') {
    if (mode.kind === 'prepare') activeDbRelaunchContract = runActiveMigrationDeathPreparePhase();
    else if (mode.kind === 'resume') {
      activeDbRelaunchContract = runActiveMigrationDeathResumePhase();
    } else {
      activeDbRelaunchContract = runActiveMigrationDeathRecoveryPhase(
        standardRelaunchRecoveryFailureCode(mode.failureCode),
        mode.requestValid,
      );
    }
  } else if (mode.scenario === 'active-wal-write-death') {
    if (mode.kind === 'prepare') activeDbRelaunchContract = runWalWriteDeathPreparePhase();
    else if (mode.kind === 'resume') activeDbRelaunchContract = runWalWriteDeathResumePhase();
    else {
      activeDbRelaunchContract = runWalWriteDeathRecoveryPhase(
        standardRelaunchRecoveryFailureCode(mode.failureCode),
        mode.requestValid,
      );
    }
  } else if (mode.kind === 'prepare') activeDbRelaunchContract = runPreparePhase();
  else if (mode.kind === 'resume') activeDbRelaunchContract = runResumePhase();
  else {
    activeDbRelaunchContract = runRecoveryPhase(
      standardRelaunchRecoveryFailureCode(mode.failureCode),
      mode.requestValid,
    );
  }
  return activeDbRelaunchContract;
}
