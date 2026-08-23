import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACTIVE_MIGRATION_DEATH_FAILURE_CODES,
  ACTIVE_MIGRATION_DEATH_HOST_CHECKS,
  ACTIVE_MIGRATION_DEATH_MARKER_PREFIX,
  ACTIVE_MIGRATION_DEATH_PREPARE_CHECKS,
  ACTIVE_MIGRATION_DEATH_PRIVATE_TEST_FILES,
  ACTIVE_MIGRATION_DEATH_RESUME_CHECKS,
  buildActiveMigrationDeathPrivacySafeArtifact,
  buildPrivacySafeArtifact,
  buildWalWriteDeathPrivacySafeArtifact,
  CLEANUP_RELAUNCH_STATE_ADB_ARGS,
  createCrashAppAdbArgs,
  createPrivateFileAbsenceAdbArgs,
  CREATE_ACTIVE_MIGRATION_DEATH_REQUEST_ADB_ARGS,
  CREATE_RELAUNCH_REQUEST_ADB_ARGS,
  CREATE_WAL_WRITE_DEATH_REQUEST_ADB_ARGS,
  executeActiveMigrationDeathSequence,
  executeRelaunchSequence,
  executeWalWriteDeathSequence,
  extractActiveMigrationDeathMarkers,
  extractRelaunchMarkers,
  extractWalWriteDeathMarkers,
  isMissingProcessResult,
  LAUNCH_APP_ADB_ARGS,
  logsAfterRelaunchBoundary,
  MIGRATION_RELAUNCH_PRIVATE_TEST_FILES,
  parseProcessStartTicks,
  parseSingleProcessPid,
  PREPARE_CHECKS,
  READ_ACTIVE_MIGRATION_DEATH_WAL_SIZE_ADB_ARGS,
  READ_WAL_WRITE_DEATH_SIZE_ADB_ARGS,
  RELAUNCH_FAILURE_CODES,
  RELAUNCH_MARKER_PREFIX,
  RELAUNCH_MIGRATION_COUNT,
  RELAUNCH_MIGRATION_HEAD,
  RELAUNCH_PRIVATE_TEST_FILES,
  RESUME_CHECKS,
  validateActiveMigrationDeathMarker,
  validateRelaunchMarker,
  validateWalWriteDeathMarker,
  WAL_WRITE_DEATH_FAILURE_CODES,
  WAL_WRITE_DEATH_HOST_CHECKS,
  WAL_WRITE_DEATH_MARKER_PREFIX,
  WAL_WRITE_DEATH_PREPARE_CHECKS,
  WAL_WRITE_DEATH_PRIVATE_TEST_FILES,
  WAL_WRITE_DEATH_RESUME_CHECKS,
  walFileGrewBeyondHeader,
  waitForNoProcess,
} from './run-android-db-relaunch.mjs';
import { APP_ACTIVITY, APP_PACKAGE, HarnessError } from './run-android-db-contract.mjs';

function checks(names, overrides = {}) {
  return Object.fromEntries(names.map((name) => [name, overrides[name] ?? true]));
}

function ready(overrides = {}) {
  return {
    schema: 1,
    suite: 'android-db-relaunch',
    status: 'ready',
    phase: 'prepare',
    checks: checks(PREPARE_CHECKS),
    ...overrides,
  };
}

function finalResult(overrides = {}) {
  return {
    schema: 1,
    suite: 'android-db-relaunch',
    status: 'pass',
    phase: 'resume',
    migrationCount: RELAUNCH_MIGRATION_COUNT,
    migrationHead: RELAUNCH_MIGRATION_HEAD,
    checks: checks(RESUME_CHECKS),
    ...overrides,
  };
}

function marker(value) {
  return `${RELAUNCH_MARKER_PREFIX}${JSON.stringify(value)}`;
}

function logMessage(message, pid = '101') {
  return `08-19 19:00:00.123 ${pid.padStart(5)} 5678 I ReactNativeJS: ${message}`;
}

function loggedMarker(value, pid = '101') {
  return logMessage(marker(value), pid);
}

function failingPrepare(overrides = {}) {
  return ready({
    status: 'fail',
    checks: checks(PREPARE_CHECKS, { encryptedOpen: false }),
    failureCode: 'encrypted-open',
    ...overrides,
  });
}

function failingFinal(overrides = {}) {
  return finalResult({
    status: 'fail',
    checks: checks(RESUME_CHECKS, { integrity: false }),
    failureCode: 'integrity',
    ...overrides,
  });
}

function walWriteDeathReady(overrides = {}) {
  return {
    schema: 1,
    suite: 'android-db-wal-write-death',
    status: 'ready',
    phase: 'prepare',
    checks: checks(WAL_WRITE_DEATH_PREPARE_CHECKS),
    ...overrides,
  };
}

function walWriteDeathFinal(overrides = {}) {
  return {
    schema: 1,
    suite: 'android-db-wal-write-death',
    status: 'pass',
    phase: 'resume',
    checks: checks(WAL_WRITE_DEATH_RESUME_CHECKS),
    ...overrides,
  };
}

function walWriteDeathMarker(value) {
  return `${WAL_WRITE_DEATH_MARKER_PREFIX}${JSON.stringify(value)}`;
}

function loggedWalWriteDeathMarker(value, pid = '101') {
  return logMessage(walWriteDeathMarker(value), pid);
}

function failingWalWriteDeathPrepare(overrides = {}) {
  return walWriteDeathReady({
    status: 'fail',
    checks: checks(WAL_WRITE_DEATH_PREPARE_CHECKS, { walCheckpointTruncated: false }),
    failureCode: 'wal-checkpoint',
    ...overrides,
  });
}

function failingWalWriteDeathFinal(overrides = {}) {
  return walWriteDeathFinal({
    status: 'fail',
    checks: checks(WAL_WRITE_DEATH_RESUME_CHECKS, { uncommittedAbsent: false }),
    failureCode: 'recovered-state',
    ...overrides,
  });
}

function activeMigrationDeathReady(overrides = {}) {
  return {
    schema: 1,
    suite: 'android-db-active-migration-death',
    status: 'ready',
    phase: 'prepare',
    checks: checks(ACTIVE_MIGRATION_DEATH_PREPARE_CHECKS),
    ...overrides,
  };
}

function activeMigrationDeathFinal(overrides = {}) {
  return {
    schema: 1,
    suite: 'android-db-active-migration-death',
    status: 'pass',
    phase: 'resume',
    migrationCount: RELAUNCH_MIGRATION_COUNT,
    migrationHead: RELAUNCH_MIGRATION_HEAD,
    checks: checks(ACTIVE_MIGRATION_DEATH_RESUME_CHECKS),
    ...overrides,
  };
}

function activeMigrationDeathMarker(value) {
  return `${ACTIVE_MIGRATION_DEATH_MARKER_PREFIX}${JSON.stringify(value)}`;
}

function loggedActiveMigrationDeathMarker(value, pid = '101') {
  return logMessage(activeMigrationDeathMarker(value), pid);
}

function failingActiveMigrationDeathPrepare(overrides = {}) {
  return activeMigrationDeathReady({
    status: 'fail',
    checks: checks(ACTIVE_MIGRATION_DEATH_PREPARE_CHECKS, {
      migrationPrefixPrepared: false,
    }),
    failureCode: 'migration-prefix',
    ...overrides,
  });
}

function failingActiveMigrationDeathFinal(overrides = {}) {
  return activeMigrationDeathFinal({
    status: 'fail',
    checks: checks(ACTIVE_MIGRATION_DEATH_RESUME_CHECKS, {
      uncommittedMigrationAbsent: false,
    }),
    failureCode: 'uncommitted-migration-absent',
    ...overrides,
  });
}

const target = {
  versionName: '0.1.40',
  versionCode: 52,
  androidApi: 35,
  abi: 'arm64-v8a',
};

test('pins zero-byte request creation and exact non-glob cleanup targets', () => {
  assert.deepEqual(MIGRATION_RELAUNCH_PRIVATE_TEST_FILES, [
    'files/.gator-db-relaunch-request-v1',
    'files/.gator-db-relaunch-preparing-v1',
    'files/.gator-db-relaunch-ready-v1',
    'files/.gator-db-relaunch-resuming-v1',
    'databases/driver-relaunch-selftest.db',
    'databases/driver-relaunch-selftest.db-journal',
    'databases/driver-relaunch-selftest.db-wal',
    'databases/driver-relaunch-selftest.db-shm',
  ]);
  assert.deepEqual(WAL_WRITE_DEATH_PRIVATE_TEST_FILES, [
    'files/.gator-db-wal-write-death-request-v1',
    'files/.gator-db-wal-write-death-preparing-v1',
    'files/.gator-db-wal-write-death-ready-v1',
    'files/.gator-db-wal-write-death-resuming-v1',
    'databases/driver-wal-write-death-selftest.db',
    'databases/driver-wal-write-death-selftest.db-journal',
    'databases/driver-wal-write-death-selftest.db-wal',
    'databases/driver-wal-write-death-selftest.db-shm',
  ]);
  assert.deepEqual(ACTIVE_MIGRATION_DEATH_PRIVATE_TEST_FILES, [
    'files/.gator-db-active-migration-death-request-v1',
    'files/.gator-db-active-migration-death-preparing-v1',
    'files/.gator-db-active-migration-death-ready-v1',
    'files/.gator-db-active-migration-death-resuming-v1',
    'databases/driver-active-migration-death-selftest.db',
    'databases/driver-active-migration-death-selftest.db-journal',
    'databases/driver-active-migration-death-selftest.db-wal',
    'databases/driver-active-migration-death-selftest.db-shm',
  ]);
  assert.deepEqual(RELAUNCH_PRIVATE_TEST_FILES, [
    ...MIGRATION_RELAUNCH_PRIVATE_TEST_FILES,
    ...WAL_WRITE_DEATH_PRIVATE_TEST_FILES,
    ...ACTIVE_MIGRATION_DEATH_PRIVATE_TEST_FILES,
  ]);
  assert.equal(RELAUNCH_PRIVATE_TEST_FILES.length, 24);
  assert.deepEqual(CREATE_RELAUNCH_REQUEST_ADB_ARGS, [
    'shell',
    'run-as',
    APP_PACKAGE,
    'touch',
    'files/.gator-db-relaunch-request-v1',
  ]);
  assert.deepEqual(CREATE_WAL_WRITE_DEATH_REQUEST_ADB_ARGS, [
    'shell',
    'run-as',
    APP_PACKAGE,
    'touch',
    'files/.gator-db-wal-write-death-request-v1',
  ]);
  assert.deepEqual(CREATE_ACTIVE_MIGRATION_DEATH_REQUEST_ADB_ARGS, [
    'shell',
    'run-as',
    APP_PACKAGE,
    'touch',
    'files/.gator-db-active-migration-death-request-v1',
  ]);
  assert.deepEqual(CLEANUP_RELAUNCH_STATE_ADB_ARGS, [
    'shell',
    'run-as',
    APP_PACKAGE,
    'rm',
    '-f',
    ...RELAUNCH_PRIVATE_TEST_FILES,
  ]);
  assert.equal(CREATE_RELAUNCH_REQUEST_ADB_ARGS.includes('sh'), false);
  assert.equal(CREATE_WAL_WRITE_DEATH_REQUEST_ADB_ARGS.includes('sh'), false);
  assert.equal(CREATE_ACTIVE_MIGRATION_DEATH_REQUEST_ADB_ARGS.includes('sh'), false);
  assert.equal(CLEANUP_RELAUNCH_STATE_ADB_ARGS.includes('sh'), false);
  assert.equal(CLEANUP_RELAUNCH_STATE_ADB_ARGS.includes('*'), false);
  assert.equal(CLEANUP_RELAUNCH_STATE_ADB_ARGS.includes('gator.db'), false);
});

test('pins exact WAL stat, process crash, and private-file absence argv', () => {
  assert.deepEqual(LAUNCH_APP_ADB_ARGS, [
    'shell',
    'am',
    'start',
    '-a',
    'android.intent.action.VIEW',
    '-d',
    'exp+bluegreengatorappsmessages://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081',
    '-n',
    APP_ACTIVITY,
  ]);
  assert.equal(LAUNCH_APP_ADB_ARGS.includes('-W'), false);
  assert.deepEqual(READ_WAL_WRITE_DEATH_SIZE_ADB_ARGS, [
    'shell',
    'run-as',
    APP_PACKAGE,
    'stat',
    '-c',
    '%s',
    'databases/driver-wal-write-death-selftest.db-wal',
  ]);
  assert.deepEqual(READ_ACTIVE_MIGRATION_DEATH_WAL_SIZE_ADB_ARGS, [
    'shell',
    'run-as',
    APP_PACKAGE,
    'stat',
    '-c',
    '%s',
    'databases/driver-active-migration-death-selftest.db-wal',
  ]);
  assert.deepEqual(createCrashAppAdbArgs('101'), ['shell', 'am', 'crash', '101']);
  assert.deepEqual(
    createPrivateFileAbsenceAdbArgs('databases/driver-wal-write-death-selftest.db-shm'),
    [
      'shell',
      'run-as',
      APP_PACKAGE,
      'test',
      '!',
      '-e',
      'databases/driver-wal-write-death-selftest.db-shm',
    ],
  );
  assert.deepEqual(
    createPrivateFileAbsenceAdbArgs('databases/driver-active-migration-death-selftest.db-shm'),
    [
      'shell',
      'run-as',
      APP_PACKAGE,
      'test',
      '!',
      '-e',
      'databases/driver-active-migration-death-selftest.db-shm',
    ],
  );
  assert.throws(() => createCrashAppAdbArgs('101 202'), /one exact numeric/);
  assert.throws(() => createPrivateFileAbsenceAdbArgs('databases/gator.db'), /allowlist/);
  assert.equal(walFileGrewBeyondHeader('33\n'), true);
  assert.equal(walFileGrewBeyondHeader('32'), false);
  assert.throws(() => walFileGrewBeyondHeader('private-size'), /not numeric/);
});

test('pins the exact prepare READY schema', () => {
  assert.deepEqual(validateRelaunchMarker(ready()), ready());
  assert.throws(
    () => validateRelaunchMarker({ ...ready(), token: 'must-not-exist' }),
    /finite contract/,
  );
  assert.throws(
    () => validateRelaunchMarker(ready({ checks: { ...checks(PREPARE_CHECKS), extra: true } })),
    /finite contract/,
  );
  assert.throws(
    () =>
      validateRelaunchMarker(
        ready({ checks: checks(PREPARE_CHECKS, { continuitySentinel: false }) }),
      ),
    (error) => error instanceof HarnessError && error.code === 'inconsistent-relaunch-marker',
  );
});

test('pins prepare failures to the same check shape and finite code', () => {
  assert.deepEqual(validateRelaunchMarker(failingPrepare()), failingPrepare());
  assert.throws(
    () => validateRelaunchMarker(failingPrepare({ failureCode: 'raw native failure' })),
    /finite contract/,
  );
  assert.throws(
    () => validateRelaunchMarker({ ...failingPrepare(), migrationCount: 38 }),
    /finite contract/,
  );
});

test('pins the exact resume result schema and migration identity', () => {
  assert.deepEqual(validateRelaunchMarker(finalResult()), finalResult());
  assert.deepEqual(validateRelaunchMarker(failingFinal()), failingFinal());
  assert.throws(
    () => validateRelaunchMarker(finalResult({ migrationCount: 37 })),
    /migration count or head/,
  );
  assert.throws(
    () => validateRelaunchMarker(finalResult({ migrationHead: '0037_old' })),
    /migration count or head/,
  );
  assert.throws(
    () => validateRelaunchMarker({ ...finalResult(), rawLog: 'private' }),
    /finite contract/,
  );
});

test('accepts recovery only as a finite failure', () => {
  assert.deepEqual(
    validateRelaunchMarker(failingFinal({ phase: 'recovery', failureCode: 'interrupted-resume' })),
    failingFinal({ phase: 'recovery', failureCode: 'interrupted-resume' }),
  );
  assert.throws(() => validateRelaunchMarker(finalResult({ phase: 'recovery' })), /failure-only/);
});

test('pins the complete failure-code allowlist', () => {
  assert.deepEqual(RELAUNCH_FAILURE_CODES, [
    'request-invalid',
    'phase-invalid',
    'interrupted-prepare',
    'interrupted-resume',
    'orphaned-state',
    'pre-cleanup',
    'encrypted-open',
    'migration-rollback',
    'ready-state',
    'read-only-continuity-open',
    'same-file-state',
    'migration-retry',
    'migration-ledger',
    'integrity',
    'idempotent',
    'database-cleanup',
    'state-cleanup',
    'internal',
  ]);
});

test('pins the finite active-WAL marker schemas and failure-code allowlist', () => {
  assert.deepEqual(validateWalWriteDeathMarker(walWriteDeathReady()), walWriteDeathReady());
  assert.deepEqual(validateWalWriteDeathMarker(walWriteDeathFinal()), walWriteDeathFinal());
  assert.deepEqual(
    validateWalWriteDeathMarker(failingWalWriteDeathPrepare()),
    failingWalWriteDeathPrepare(),
  );
  assert.deepEqual(
    validateWalWriteDeathMarker(failingWalWriteDeathFinal()),
    failingWalWriteDeathFinal(),
  );
  assert.throws(
    () => validateWalWriteDeathMarker({ ...walWriteDeathReady(), walBytes: 99 }),
    /finite contract/,
  );
  assert.throws(
    () =>
      validateWalWriteDeathMarker(
        walWriteDeathFinal({ checks: { ...checks(WAL_WRITE_DEATH_RESUME_CHECKS), extra: true } }),
      ),
    /finite contract/,
  );
  assert.throws(
    () =>
      validateWalWriteDeathMarker(failingWalWriteDeathFinal({ failureCode: 'raw native failure' })),
    /finite contract/,
  );
  assert.deepEqual(WAL_WRITE_DEATH_FAILURE_CODES, [
    'request-invalid',
    'phase-invalid',
    'interrupted-prepare',
    'interrupted-resume',
    'orphaned-state',
    'pre-cleanup',
    'encrypted-open',
    'wal-mode',
    'baseline-commit',
    'wal-checkpoint',
    'write-transaction',
    'uncommitted-canary',
    'ready-state',
    'read-only-recovery-open',
    'recovered-state',
    'integrity',
    'foreign-keys',
    'recovery-commit',
    'reopen-persistence',
    'database-cleanup',
    'state-cleanup',
    'internal',
  ]);
  assert.deepEqual(WAL_WRITE_DEATH_HOST_CHECKS, [
    'processAAlive',
    'walGrew',
    'processCrashed',
    'processChanged',
    'privateStateClean',
  ]);
});

test('pins the exact active-migration 11/15/6 schemas and failure-code allowlist', () => {
  assert.deepEqual(ACTIVE_MIGRATION_DEATH_PREPARE_CHECKS, [
    'requestValid',
    'preCleanup',
    'encryptedOpen',
    'walMode',
    'migrationPrefixPrepared',
    'baselineCommitted',
    'walCheckpointTruncated',
    'migrationTransactionOpen',
    'migrationWriteApplied',
    'migrationLedgerPending',
    'readyStatePersisted',
  ]);
  assert.deepEqual(ACTIVE_MIGRATION_DEATH_RESUME_CHECKS, [
    'requestValid',
    'phaseValid',
    'readOnlyRecoveryOpen',
    'walMode',
    'migrationPrefixPreserved',
    'uncommittedMigrationAbsent',
    'integrity',
    'foreignKeys',
    'migrationRetry',
    'migrationLedger',
    'migrationData',
    'idempotent',
    'reopenPersistence',
    'databaseCleanup',
    'stateCleanup',
  ]);
  assert.deepEqual(
    validateActiveMigrationDeathMarker(activeMigrationDeathReady()),
    activeMigrationDeathReady(),
  );
  assert.deepEqual(
    validateActiveMigrationDeathMarker(activeMigrationDeathFinal()),
    activeMigrationDeathFinal(),
  );
  assert.deepEqual(
    validateActiveMigrationDeathMarker(failingActiveMigrationDeathPrepare()),
    failingActiveMigrationDeathPrepare(),
  );
  assert.deepEqual(
    validateActiveMigrationDeathMarker(failingActiveMigrationDeathFinal()),
    failingActiveMigrationDeathFinal(),
  );
  assert.throws(
    () =>
      validateActiveMigrationDeathMarker({
        ...activeMigrationDeathReady(),
        walBytes: 99,
      }),
    /finite contract/,
  );
  assert.throws(
    () =>
      validateActiveMigrationDeathMarker(
        activeMigrationDeathFinal({
          checks: { ...checks(ACTIVE_MIGRATION_DEATH_RESUME_CHECKS), extra: true },
        }),
      ),
    /finite contract/,
  );
  assert.throws(
    () =>
      validateActiveMigrationDeathMarker(
        activeMigrationDeathReady({
          checks: checks(ACTIVE_MIGRATION_DEATH_PREPARE_CHECKS, {
            migrationWriteApplied: false,
          }),
        }),
      ),
    (error) =>
      error instanceof HarnessError && error.code === 'inconsistent-active-migration-death-marker',
  );
  assert.throws(
    () => validateActiveMigrationDeathMarker(activeMigrationDeathFinal({ migrationCount: 37 })),
    /count or head/,
  );
  assert.throws(
    () =>
      validateActiveMigrationDeathMarker(
        failingActiveMigrationDeathFinal({ failureCode: 'raw native failure' }),
      ),
    /finite contract/,
  );
  assert.deepEqual(ACTIVE_MIGRATION_DEATH_FAILURE_CODES, [
    'request-invalid',
    'phase-invalid',
    'interrupted-prepare',
    'interrupted-resume',
    'orphaned-state',
    'pre-cleanup',
    'encrypted-open',
    'wal-mode',
    'migration-prefix',
    'baseline-commit',
    'wal-checkpoint',
    'migration-transaction',
    'ready-state',
    'read-only-recovery-open',
    'migration-prefix-preserved',
    'uncommitted-migration-absent',
    'integrity',
    'foreign-keys',
    'migration-retry',
    'migration-ledger',
    'migration-data',
    'idempotent',
    'reopen-persistence',
    'database-cleanup',
    'state-cleanup',
    'internal',
  ]);
  assert.deepEqual(ACTIVE_MIGRATION_DEATH_HOST_CHECKS, [
    'processAAlive',
    'walGrewBeforeCrash',
    'processCrashed',
    'walPresentAfterCrash',
    'processChanged',
    'privateStateClean',
  ]);
});

test('extracts active-WAL markers only from their exact process sequence', () => {
  assert.deepEqual(
    extractWalWriteDeathMarkers(loggedWalWriteDeathMarker(walWriteDeathReady()), ['101']),
    [walWriteDeathReady()],
  );
  assert.deepEqual(
    extractWalWriteDeathMarkers(
      `${loggedWalWriteDeathMarker(walWriteDeathReady(), '101')}\n${loggedWalWriteDeathMarker(walWriteDeathFinal(), '202')}`,
      ['101', '202'],
    ),
    [walWriteDeathReady(), walWriteDeathFinal()],
  );
  assert.throws(
    () =>
      extractWalWriteDeathMarkers(loggedWalWriteDeathMarker(walWriteDeathReady(), '999'), ['101']),
    (error) => error instanceof HarnessError && error.code === 'wrong-marker-process',
  );
  assert.throws(
    () => extractWalWriteDeathMarkers(loggedMarker(ready())),
    (error) => error instanceof HarnessError && error.code === 'wrong-db-contract-marker',
  );
  for (const prefix of [
    'GATOR_DB_CONTRACT_V1 ',
    'GATOR_DB_CONTRACT_V2 ',
    'GATOR_DB_CONTRACT_V3 ',
  ]) {
    assert.throws(
      () => extractWalWriteDeathMarkers(logMessage(`${prefix}{}`)),
      (error) => error instanceof HarnessError && error.code === 'wrong-db-contract-marker',
    );
  }
});

test('extracts PID-bound active-migration markers and rejects every cross-lane prefix', () => {
  assert.deepEqual(
    extractActiveMigrationDeathMarkers(
      loggedActiveMigrationDeathMarker(activeMigrationDeathReady(), '101'),
      ['101'],
    ),
    [activeMigrationDeathReady()],
  );
  assert.deepEqual(
    extractActiveMigrationDeathMarkers(
      `${loggedActiveMigrationDeathMarker(activeMigrationDeathReady(), '101')}\n${loggedActiveMigrationDeathMarker(activeMigrationDeathFinal(), '202')}`,
      ['101', '202'],
    ),
    [activeMigrationDeathReady(), activeMigrationDeathFinal()],
  );
  assert.throws(
    () =>
      extractActiveMigrationDeathMarkers(
        loggedActiveMigrationDeathMarker(activeMigrationDeathReady(), '999'),
        ['101'],
      ),
    (error) => error instanceof HarnessError && error.code === 'wrong-marker-process',
  );

  for (const forbiddenLog of [
    loggedMarker(ready()),
    loggedWalWriteDeathMarker(walWriteDeathReady()),
    ...['GATOR_DB_CONTRACT_V1 ', 'GATOR_DB_CONTRACT_V2 ', 'GATOR_DB_CONTRACT_V3 '].map((prefix) =>
      logMessage(`${prefix}{}`),
    ),
  ]) {
    assert.throws(
      () => extractActiveMigrationDeathMarkers(forbiddenLog),
      (error) => error instanceof HarnessError && error.code === 'wrong-db-contract-marker',
    );
  }
  assert.throws(
    () => extractRelaunchMarkers(loggedActiveMigrationDeathMarker(activeMigrationDeathReady())),
    (error) => error instanceof HarnessError && error.code === 'wrong-db-contract-marker',
  );
  assert.throws(
    () =>
      extractWalWriteDeathMarkers(loggedActiveMigrationDeathMarker(activeMigrationDeathReady())),
    (error) => error instanceof HarnessError && error.code === 'wrong-db-contract-marker',
  );
});

test('extracts only exact READY then final marker sequences', () => {
  assert.deepEqual(extractRelaunchMarkers(`noise\n${loggedMarker(ready())}`), [ready()]);
  assert.deepEqual(
    extractRelaunchMarkers(
      `${loggedMarker(ready(), '101')}\n${loggedMarker(finalResult(), '202')}`,
    ),
    [ready(), finalResult()],
  );
  assert.throws(
    () => extractRelaunchMarkers(loggedMarker(finalResult())),
    (error) => error instanceof HarnessError && error.code === 'invalid-relaunch-sequence',
  );
  assert.throws(
    () =>
      extractRelaunchMarkers(
        `${loggedMarker(failingPrepare())}\n${loggedMarker(failingFinal(), '202')}`,
      ),
    /terminal/,
  );
  assert.throws(
    () =>
      extractRelaunchMarkers(
        `${loggedMarker(ready())}\n${loggedMarker(finalResult(), '202')}\n${loggedMarker(finalResult(), '202')}`,
      ),
    (error) => error instanceof HarnessError && error.code === 'duplicate-relaunch-marker',
  );
});

test('rejects malformed, oversized, and unknown marker content', () => {
  assert.throws(
    () => extractRelaunchMarkers(logMessage(`${RELAUNCH_MARKER_PREFIX}{not-json}`)),
    /valid JSON/,
  );
  assert.throws(
    () => extractRelaunchMarkers(logMessage(`${RELAUNCH_MARKER_PREFIX}${'x'.repeat(4_097)}`)),
    /too large/,
  );
  assert.throws(
    () => extractRelaunchMarkers(marker(ready())),
    (error) => error instanceof HarnessError && error.code === 'invalid-marker-process',
  );
  assert.throws(
    () => validateRelaunchMarker({ ...ready(), suite: 'other' }),
    /identity is invalid/,
  );
});

test('rejects every single-process database marker in the exclusive relaunch lane', () => {
  for (const prefix of [
    'GATOR_DB_CONTRACT_V1 ',
    'GATOR_DB_CONTRACT_V2 ',
    'GATOR_DB_CONTRACT_V3 ',
  ]) {
    assert.throws(
      () => extractRelaunchMarkers(logMessage(`${prefix}{}`)),
      (error) => error instanceof HarnessError && error.code === 'wrong-db-contract-marker',
    );
  }
});

test('accepts markers only after one current relaunch boundary', () => {
  const boundary = 'GATOR_DB_RELAUNCH_BOUNDARY_00000000-0000-4000-8000-000000000000';
  const current = logsAfterRelaunchBoundary(
    `${loggedMarker(ready())}\n${logMessage(boundary, '999')}\n${loggedMarker(ready())}`,
    boundary,
  );
  assert.deepEqual(extractRelaunchMarkers(current), [ready()]);
  assert.throws(
    () => logsAfterRelaunchBoundary(loggedMarker(ready()), boundary),
    (error) => error instanceof HarnessError && error.code === 'log-boundary-missing',
  );
});

test('parses Linux process start ticks without retaining the rest of proc stat', () => {
  const fields3Through21 = ['S', ...Array.from({ length: 18 }, (_, index) => String(index + 3))];
  assert.equal(
    parseProcessStartTicks(`123 (name with ) parenthesis) ${fields3Through21.join(' ')} 987654 0`),
    '987654',
  );
  assert.equal(parseProcessStartTicks('not proc stat'), undefined);
});

test('plain pidof parsing rejects multiple or nonnumeric process identities', () => {
  assert.equal(parseSingleProcessPid('101\n'), '101');
  assert.equal(parseSingleProcessPid(''), undefined);
  assert.equal(parseSingleProcessPid(undefined), undefined);
  assert.throws(
    () => parseSingleProcessPid('101 202'),
    (error) => error instanceof HarnessError && error.code === 'invalid-process-identity',
  );
  assert.throws(() => parseSingleProcessPid('not-a-pid'), /exactly one numeric/);
});

test('only an empty pidof exit maps to an observed missing process', () => {
  assert.equal(isMissingProcessResult({ status: 1, stdout: '', stderr: '' }), true);
  assert.equal(
    isMissingProcessResult({ status: 1, stdout: '', stderr: 'adb transport failed' }),
    false,
  );
  assert.equal(isMissingProcessResult({ status: 1, stdout: '101', stderr: '' }), false);
  assert.equal(isMissingProcessResult({ status: 0, stdout: '', stderr: '' }), false);
});

test('marker process IDs must match phase A then phase B', () => {
  assert.deepEqual(extractRelaunchMarkers(loggedMarker(ready(), '101'), ['101']), [ready()]);
  assert.throws(
    () => extractRelaunchMarkers(loggedMarker(ready(), '999'), ['101']),
    (error) => error instanceof HarnessError && error.code === 'wrong-marker-process',
  );
  assert.throws(
    () =>
      extractRelaunchMarkers(
        `${loggedMarker(ready(), '101')}\n${loggedMarker(finalResult(), '999')}`,
        ['101', '202'],
      ),
    (error) => error instanceof HarnessError && error.code === 'wrong-marker-process',
  );
});

test('runs two launches across an observed no-process gap and always cleans up', async () => {
  const calls = [];
  let launchCount = 0;
  let identity;
  const processA = { pid: '101', startTicks: '1001' };
  const processB = { pid: '202', startTicks: '2002' };
  const outcome = await executeRelaunchSequence({
    resetTestState: async () => {
      calls.push('reset');
      identity = undefined;
    },
    createRequest: async () => calls.push('request'),
    launchApp: async () => {
      launchCount += 1;
      calls.push(`launch-${String(launchCount)}`);
      identity = launchCount === 1 ? processA : processB;
    },
    stopApp: async () => {
      calls.push('stop');
      identity = undefined;
    },
    readLogs: async () =>
      launchCount === 1
        ? loggedMarker(ready(), '101')
        : `${loggedMarker(ready(), '101')}\n${loggedMarker(finalResult(), '202')}`,
    getProcessIdentity: async () => identity,
  });
  assert.deepEqual(outcome, {
    ready: ready(),
    final: finalResult(),
    hostChecks: { processAAlive: true, processStopped: true, processChanged: true },
  });
  assert.deepEqual(calls, ['reset', 'request', 'launch-1', 'stop', 'launch-2', 'reset']);
});

test('crashes exact process A only after WAL growth, then proves process B and pre-fallback cleanup', async () => {
  const calls = [];
  let launchCount = 0;
  let identity;
  const processA = { pid: '101', startTicks: '1001' };
  const processB = { pid: '202', startTicks: '2002' };
  const outcome = await executeWalWriteDeathSequence({
    resetTestState: async () => {
      calls.push('reset');
      identity = undefined;
    },
    createRequest: async () => calls.push('request'),
    launchApp: async () => {
      launchCount += 1;
      calls.push(`launch-${String(launchCount)}`);
      identity = launchCount === 1 ? processA : processB;
    },
    proveWalGrew: async () => {
      calls.push('wal-grown');
      assert.deepEqual(identity, processA);
      return true;
    },
    crashApp: async (pid) => {
      calls.push(`crash-${pid}`);
      identity = undefined;
    },
    readLogs: async () => {
      calls.push(`logs-${String(launchCount)}`);
      return launchCount === 1
        ? loggedWalWriteDeathMarker(walWriteDeathReady(), '101')
        : `${loggedWalWriteDeathMarker(walWriteDeathReady(), '101')}\n${loggedWalWriteDeathMarker(walWriteDeathFinal(), '202')}`;
    },
    getProcessIdentity: async () => identity,
    verifyPrivateStateClean: async () => {
      calls.push('private-state-clean');
      return true;
    },
  });

  assert.deepEqual(outcome, {
    ready: walWriteDeathReady(),
    final: walWriteDeathFinal(),
    hostChecks: {
      processAAlive: true,
      walGrew: true,
      processCrashed: true,
      processChanged: true,
      privateStateClean: true,
    },
  });
  assert.deepEqual(calls, [
    'reset',
    'request',
    'launch-1',
    'logs-1',
    'wal-grown',
    'crash-101',
    'launch-2',
    'logs-2',
    'private-state-clean',
    'reset',
  ]);
});

test('does not crash process A when physical WAL growth is unproved', async () => {
  let identity;
  let crashes = 0;
  let resets = 0;
  await assert.rejects(
    executeWalWriteDeathSequence({
      resetTestState: async () => {
        resets += 1;
        identity = undefined;
      },
      createRequest: async () => {},
      launchApp: async () => {
        identity = { pid: '101', startTicks: '1001' };
      },
      proveWalGrew: async () => false,
      crashApp: async () => {
        crashes += 1;
      },
      readLogs: async () => loggedWalWriteDeathMarker(walWriteDeathReady(), '101'),
      getProcessIdentity: async () => identity,
      verifyPrivateStateClean: async () => true,
    }),
    (error) => error instanceof HarnessError && error.code === 'wal-not-grown',
  );
  assert.equal(crashes, 0);
  assert.equal(resets, 2);
});

test('surfaces exact process-crash failure and still runs verified fallback cleanup', async () => {
  let identity;
  let crashTarget;
  let resets = 0;
  await assert.rejects(
    executeWalWriteDeathSequence({
      resetTestState: async () => {
        resets += 1;
        identity = undefined;
      },
      createRequest: async () => {},
      launchApp: async () => {
        identity = { pid: '101', startTicks: '1001' };
      },
      proveWalGrew: async () => true,
      crashApp: async (pid) => {
        crashTarget = pid;
        throw new HarnessError('app-crash-failed', 'simulated exact crash failure');
      },
      readLogs: async () => loggedWalWriteDeathMarker(walWriteDeathReady(), '101'),
      getProcessIdentity: async () => identity,
      verifyPrivateStateClean: async () => true,
    }),
    (error) => error instanceof HarnessError && error.code === 'app-crash-failed',
  );
  assert.equal(crashTarget, '101');
  assert.equal(resets, 2);
});

test('checks active-migration WAL before and after exact process A crash, then binds final to B', async () => {
  const calls = [];
  let launchCount = 0;
  let identity;
  const processA = { pid: '101', startTicks: '1001' };
  const processB = { pid: '202', startTicks: '2002' };
  const outcome = await executeActiveMigrationDeathSequence({
    resetTestState: async () => {
      calls.push('reset');
      identity = undefined;
    },
    createRequest: async () => calls.push('request'),
    launchApp: async () => {
      launchCount += 1;
      calls.push(`launch-${String(launchCount)}`);
      identity = launchCount === 1 ? processA : processB;
    },
    proveWalGrewBeforeCrash: async () => {
      calls.push('wal-before-crash');
      assert.deepEqual(identity, processA);
      return true;
    },
    crashApp: async (pid) => {
      calls.push(`crash-${pid}`);
      identity = undefined;
    },
    proveWalPresentAfterCrash: async () => {
      calls.push('wal-after-crash');
      assert.equal(identity, undefined);
      return true;
    },
    readLogs: async () => {
      calls.push(`logs-${String(launchCount)}`);
      return launchCount === 1
        ? loggedActiveMigrationDeathMarker(activeMigrationDeathReady(), '101')
        : `${loggedActiveMigrationDeathMarker(activeMigrationDeathReady(), '101')}\n${loggedActiveMigrationDeathMarker(activeMigrationDeathFinal(), '202')}`;
    },
    getProcessIdentity: async () => identity,
    verifyPrivateStateClean: async () => {
      calls.push('private-state-clean');
      return true;
    },
  });

  assert.deepEqual(outcome, {
    ready: activeMigrationDeathReady(),
    final: activeMigrationDeathFinal(),
    hostChecks: {
      processAAlive: true,
      walGrewBeforeCrash: true,
      processCrashed: true,
      walPresentAfterCrash: true,
      processChanged: true,
      privateStateClean: true,
    },
  });
  assert.deepEqual(calls, [
    'reset',
    'request',
    'launch-1',
    'logs-1',
    'wal-before-crash',
    'crash-101',
    'wal-after-crash',
    'launch-2',
    'logs-2',
    'private-state-clean',
    'reset',
  ]);
});

test('does not launch process B when the post-crash migration WAL proof fails', async () => {
  let identity;
  let launchCount = 0;
  let postCrashChecks = 0;
  let privateStateChecks = 0;
  let resets = 0;

  await assert.rejects(
    executeActiveMigrationDeathSequence({
      resetTestState: async () => {
        resets += 1;
        identity = undefined;
      },
      createRequest: async () => {},
      launchApp: async () => {
        launchCount += 1;
        identity = { pid: launchCount === 1 ? '101' : '202' };
      },
      proveWalGrewBeforeCrash: async () => true,
      crashApp: async () => {
        identity = undefined;
      },
      proveWalPresentAfterCrash: async () => {
        postCrashChecks += 1;
        assert.equal(identity, undefined);
        return false;
      },
      readLogs: async () => loggedActiveMigrationDeathMarker(activeMigrationDeathReady(), '101'),
      getProcessIdentity: async () => identity,
      verifyPrivateStateClean: async () => {
        privateStateChecks += 1;
        return true;
      },
    }),
    (error) => error instanceof HarnessError && error.code === 'wal-not-present-after-crash',
  );

  assert.equal(launchCount, 1);
  assert.equal(postCrashChecks, 1);
  assert.equal(privateStateChecks, 0);
  assert.equal(resets, 2);
});

test('rejects PID reuse even when process start ticks differ and still cleans up', async () => {
  let launchCount = 0;
  let identity;
  let resets = 0;
  await assert.rejects(
    executeRelaunchSequence({
      resetTestState: async () => {
        resets += 1;
        identity = undefined;
      },
      createRequest: async () => {},
      launchApp: async () => {
        launchCount += 1;
        identity = { pid: '101', startTicks: launchCount === 1 ? '1001' : '2002' };
      },
      stopApp: async () => {
        identity = undefined;
      },
      readLogs: async () => loggedMarker(ready(), '101'),
      getProcessIdentity: async () => identity,
    }),
    (error) => error instanceof HarnessError && error.code === 'process-not-changed',
  );
  assert.equal(resets, 2);
});

test('rejects a process that dies before READY and still cleans up', async () => {
  let identity = { pid: '101', startTicks: '1001' };
  let resets = 0;
  let reads = 0;
  await assert.rejects(
    executeRelaunchSequence({
      resetTestState: async () => {
        resets += 1;
        identity = undefined;
      },
      createRequest: async () => {},
      launchApp: async () => {
        identity = { pid: '101', startTicks: '1001' };
      },
      stopApp: async () => {},
      readLogs: async () => {
        reads += 1;
        identity = undefined;
        return '';
      },
      getProcessIdentity: async () => identity,
    }),
    (error) => error instanceof HarnessError && error.code === 'app-process-exited',
  );
  assert.equal(reads, 1);
  assert.equal(resets, 2);
});

test('rechecks process identity immediately when accepting READY', async () => {
  let identity;
  let resets = 0;
  await assert.rejects(
    executeRelaunchSequence({
      resetTestState: async () => {
        resets += 1;
        identity = undefined;
      },
      createRequest: async () => {},
      launchApp: async () => {
        identity = { pid: '101', startTicks: '1001' };
      },
      stopApp: async () => {},
      readLogs: async () => {
        identity = { pid: '202', startTicks: '2002' };
        return loggedMarker(ready(), '101');
      },
      getProcessIdentity: async () => identity,
    }),
    (error) => error instanceof HarnessError && error.code === 'app-process-exited',
  );
  assert.equal(resets, 2);
});

test('bounded no-process polling fails closed', async () => {
  let clock = 0;
  await assert.rejects(
    waitForNoProcess(async () => ({ pid: '101' }), {
      timeoutMs: 200,
      pollMs: 100,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    }),
    (error) => error instanceof HarnessError && error.code === 'app-process-still-running',
  );
});

test('retained artifact is a finite allowlist with no process, serial, token, path, or logs', () => {
  const artifact = buildPrivacySafeArtifact(
    {
      ready: ready(),
      final: finalResult(),
      hostChecks: { processAAlive: true, processStopped: true, processChanged: true },
      serial: 'private-device',
      pid: '101',
      startTicks: '1001',
      token: 'secret',
      path: '/private/path',
      rawLogs: marker(finalResult()),
    },
    { ...target, serial: 'private-device', model: 'private-model' },
    new Date('2026-08-19T12:34:56.000Z'),
  );
  assert.deepEqual(artifact, {
    schema: 1,
    suite: 'android-db-relaunch',
    recordedAt: '2026-08-19T12:34:56.000Z',
    package: APP_PACKAGE,
    target,
    status: 'pass',
    phase: 'resume',
    readyChecks: checks(PREPARE_CHECKS),
    migrationCount: RELAUNCH_MIGRATION_COUNT,
    migrationHead: RELAUNCH_MIGRATION_HEAD,
    finalChecks: checks(RESUME_CHECKS),
    hostChecks: { processAAlive: true, processStopped: true, processChanged: true },
  });
  const retained = JSON.stringify(artifact);
  for (const forbidden of [
    'private-device',
    'private-model',
    '101',
    '1001',
    'secret',
    '/private/path',
    RELAUNCH_MARKER_PREFIX,
  ]) {
    assert.equal(retained.includes(forbidden), false);
  }
});

test('active-WAL artifact retains booleans only, with no PID, size, path, key, or logs', () => {
  const artifact = buildWalWriteDeathPrivacySafeArtifact(
    {
      ready: walWriteDeathReady(),
      final: walWriteDeathFinal(),
      hostChecks: {
        processAAlive: true,
        walGrew: true,
        processCrashed: true,
        processChanged: true,
        privateStateClean: true,
      },
      serial: 'private-device',
      pid: '101',
      walSize: 99999,
      path: '/private/path',
      key: 'private-key',
      rawLogs: walWriteDeathMarker(walWriteDeathFinal()),
    },
    { ...target, serial: 'private-device', model: 'private-model' },
    new Date('2026-08-20T12:34:56.000Z'),
  );
  assert.deepEqual(artifact, {
    schema: 1,
    suite: 'android-db-wal-write-death',
    recordedAt: '2026-08-20T12:34:56.000Z',
    package: APP_PACKAGE,
    target,
    status: 'pass',
    phase: 'resume',
    readyChecks: checks(WAL_WRITE_DEATH_PREPARE_CHECKS),
    finalChecks: checks(WAL_WRITE_DEATH_RESUME_CHECKS),
    hostChecks: {
      processAAlive: true,
      walGrew: true,
      processCrashed: true,
      processChanged: true,
      privateStateClean: true,
    },
  });
  const retained = JSON.stringify(artifact);
  for (const forbidden of [
    'private-device',
    'private-model',
    '101',
    '99999',
    '/private/path',
    'private-key',
    WAL_WRITE_DEATH_MARKER_PREFIX,
  ]) {
    assert.equal(retained.includes(forbidden), false);
  }
});

test('active-migration artifact is exact and rejects every false terminal host check', () => {
  const passingHostChecks = checks(ACTIVE_MIGRATION_DEATH_HOST_CHECKS);
  const artifact = buildActiveMigrationDeathPrivacySafeArtifact(
    {
      ready: activeMigrationDeathReady(),
      final: activeMigrationDeathFinal(),
      hostChecks: passingHostChecks,
      serial: 'private-device',
      pid: '101',
      walSizeBeforeCrash: 99998,
      walSizeAfterCrash: 99999,
      path: '/private/path',
      key: 'private-key',
      rawLogs: activeMigrationDeathMarker(activeMigrationDeathFinal()),
    },
    { ...target, serial: 'private-device', model: 'private-model' },
    new Date('2026-08-21T12:34:56.000Z'),
  );
  assert.deepEqual(artifact, {
    schema: 1,
    suite: 'android-db-active-migration-death',
    recordedAt: '2026-08-21T12:34:56.000Z',
    package: APP_PACKAGE,
    target,
    status: 'pass',
    phase: 'resume',
    readyChecks: checks(ACTIVE_MIGRATION_DEATH_PREPARE_CHECKS),
    migrationCount: RELAUNCH_MIGRATION_COUNT,
    migrationHead: RELAUNCH_MIGRATION_HEAD,
    finalChecks: checks(ACTIVE_MIGRATION_DEATH_RESUME_CHECKS),
    hostChecks: passingHostChecks,
  });
  const retained = JSON.stringify(artifact);
  for (const forbidden of [
    'private-device',
    'private-model',
    '101',
    '99998',
    '99999',
    '/private/path',
    'private-key',
    ACTIVE_MIGRATION_DEATH_MARKER_PREFIX,
  ]) {
    assert.equal(retained.includes(forbidden), false);
  }

  for (const falseCheck of ACTIVE_MIGRATION_DEATH_HOST_CHECKS) {
    assert.throws(
      () =>
        buildActiveMigrationDeathPrivacySafeArtifact(
          {
            ready: activeMigrationDeathReady(),
            final: activeMigrationDeathFinal(),
            hostChecks: checks(ACTIVE_MIGRATION_DEATH_HOST_CHECKS, {
              [falseCheck]: false,
            }),
          },
          target,
        ),
      /host checks do not agree/i,
    );
  }
});

test('active-WAL artifact rejects unproved pre-fallback cleanup', () => {
  assert.throws(
    () =>
      buildWalWriteDeathPrivacySafeArtifact(
        {
          ready: walWriteDeathReady(),
          final: walWriteDeathFinal(),
          hostChecks: {
            processAAlive: true,
            walGrew: true,
            processCrashed: true,
            processChanged: true,
            privateStateClean: false,
          },
        },
        target,
      ),
    /host checks do not agree/i,
  );
});

test('active-WAL prepare failure artifact invents no crash or resume evidence', () => {
  const artifact = buildWalWriteDeathPrivacySafeArtifact(
    {
      ready: failingWalWriteDeathPrepare(),
      final: undefined,
      hostChecks: {
        processAAlive: true,
        walGrew: false,
        processCrashed: false,
        processChanged: false,
        privateStateClean: false,
      },
    },
    target,
    new Date('2026-08-20T12:34:56.000Z'),
  );
  assert.equal(artifact.status, 'fail');
  assert.equal(artifact.phase, 'prepare');
  assert.equal(artifact.failureCode, 'wal-checkpoint');
  assert.equal(Object.hasOwn(artifact, 'finalChecks'), false);
});

test('prepare failure artifact remains finite without invented resume evidence', () => {
  const artifact = buildPrivacySafeArtifact(
    {
      ready: failingPrepare(),
      final: undefined,
      hostChecks: { processAAlive: true, processStopped: false, processChanged: false },
    },
    target,
    new Date('2026-08-19T12:34:56.000Z'),
  );
  assert.equal(artifact.status, 'fail');
  assert.equal(artifact.phase, 'prepare');
  assert.equal(artifact.failureCode, 'encrypted-open');
  assert.equal(Object.hasOwn(artifact, 'finalChecks'), false);
  assert.equal(Object.hasOwn(artifact, 'migrationCount'), false);
});

test('artifact construction rejects nonterminal or internally inconsistent sequences', () => {
  assert.throws(
    () =>
      buildPrivacySafeArtifact(
        {
          ready: ready(),
          final: undefined,
          hostChecks: { processAAlive: true, processStopped: false, processChanged: false },
        },
        target,
      ),
    /exact terminal relaunch sequence/,
  );
  assert.throws(
    () =>
      buildPrivacySafeArtifact(
        {
          ready: ready(),
          final: finalResult(),
          hostChecks: { processAAlive: true, processStopped: true, processChanged: false },
        },
        target,
      ),
    /Host checks do not agree/,
  );
});
