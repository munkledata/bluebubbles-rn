#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  APP_ACTIVITY,
  APP_PACKAGE,
  HarnessError,
  parseAdbDevices,
  parseTargetMetadata,
  selectAdbDevice,
} from './run-android-db-contract.mjs';

export const RELAUNCH_MARKER_PREFIX = 'GATOR_DB_RELAUNCH_V1 ';
export const RELAUNCH_SUITE = 'android-db-relaunch';
export const RELAUNCH_SCHEMA = 1;
export const RELAUNCH_MIGRATION_COUNT = 39;
export const RELAUNCH_MIGRATION_HEAD = '0039_message_error_message';
export const PREPARE_CHECKS = Object.freeze([
  'requestValid',
  'preCleanup',
  'encryptedOpen',
  'migrationRollback',
  'partialLedger',
  'continuitySentinel',
  'readyStatePersisted',
]);
export const RESUME_CHECKS = Object.freeze([
  'requestValid',
  'phaseValid',
  'readOnlyContinuityOpen',
  'sameFileState',
  'partialLedger',
  'continuitySentinel',
  'migrationRetry',
  'migrationLedger',
  'integrity',
  'idempotent',
  'databaseCleanup',
  'stateCleanup',
]);
export const RELAUNCH_FAILURE_CODES = Object.freeze([
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
export const WAL_WRITE_DEATH_MARKER_PREFIX = 'GATOR_DB_WAL_WRITE_DEATH_V1 ';
export const WAL_WRITE_DEATH_SUITE = 'android-db-wal-write-death';
export const WAL_WRITE_DEATH_SCHEMA = 1;
export const WAL_WRITE_DEATH_PREPARE_CHECKS = Object.freeze([
  'requestValid',
  'preCleanup',
  'encryptedOpen',
  'walMode',
  'baselineCommitted',
  'walCheckpointTruncated',
  'writeTransactionOpen',
  'uncommittedCanaryWritten',
  'readyStatePersisted',
]);
export const WAL_WRITE_DEATH_RESUME_CHECKS = Object.freeze([
  'requestValid',
  'phaseValid',
  'readOnlyRecoveryOpen',
  'walMode',
  'baselinePresent',
  'uncommittedAbsent',
  'integrity',
  'foreignKeys',
  'recoveryCommit',
  'reopenPersistence',
  'databaseCleanup',
  'stateCleanup',
]);
export const WAL_WRITE_DEATH_HOST_CHECKS = Object.freeze([
  'processAAlive',
  'walGrew',
  'processCrashed',
  'processChanged',
  'privateStateClean',
]);
export const WAL_WRITE_DEATH_FAILURE_CODES = Object.freeze([
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
export const ACTIVE_MIGRATION_DEATH_MARKER_PREFIX = 'GATOR_DB_ACTIVE_MIGRATION_DEATH_V1 ';
export const ACTIVE_MIGRATION_DEATH_SUITE = 'android-db-active-migration-death';
export const ACTIVE_MIGRATION_DEATH_SCHEMA = 1;
export const ACTIVE_MIGRATION_DEATH_PREPARE_CHECKS = Object.freeze([
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
export const ACTIVE_MIGRATION_DEATH_RESUME_CHECKS = Object.freeze([
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
export const ACTIVE_MIGRATION_DEATH_HOST_CHECKS = Object.freeze([
  'processAAlive',
  'walGrewBeforeCrash',
  'processCrashed',
  'walPresentAfterCrash',
  'processChanged',
  'privateStateClean',
]);
export const ACTIVE_MIGRATION_DEATH_FAILURE_CODES = Object.freeze([
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
export const RUNTIME_CONCURRENCY_MARKER_PREFIX = 'GATOR_DB_RUNTIME_CONCURRENCY_V1 ';
export const RUNTIME_CONCURRENCY_SUITE = 'android-db-runtime-concurrency';
export const RUNTIME_CONCURRENCY_SCHEMA = 1;
export const RUNTIME_CONCURRENCY_CHECKS = Object.freeze([
  'requestValid',
  'runStatePersisted',
  'preCleanup',
  'encryptedOpen',
  'migrationLedger',
  'rollbackIsolation',
  'syncChunks',
  'liveMessages',
  'attachmentConstruction',
  'uploadOutsideDbOwner',
  'rekeyExclusive',
  'queuedWritersBlocked',
  'rekeyApplied',
  'queuedWritersResumed',
  'uploadSettlement',
  'queueDrained',
  'sentinelCommit',
  'newKeyReopen',
  'oldKeyRejected',
  'integrity',
  'databaseCleanup',
  'stateCleanup',
]);
export const RUNTIME_CONCURRENCY_HOST_CHECKS = Object.freeze([
  'processAlive',
  'processStopped',
  'privateStateClean',
]);
export const RUNTIME_CONCURRENCY_FAILURE_CODES = Object.freeze([
  'request-invalid',
  'phase-invalid',
  'interrupted-run',
  'orphaned-state',
  'run-state',
  'pre-cleanup',
  'encrypted-open',
  'migration-ledger',
  'rollback-isolation',
  'sync-chunks',
  'live-messages',
  'attachment-construction',
  'upload-outside-db-owner',
  'rekey-exclusive',
  'queued-writers-blocked',
  'rekey-applied',
  'queued-writers-resumed',
  'upload-settlement',
  'queue-drained',
  'sentinel-commit',
  'new-key-reopen',
  'old-key-rejected',
  'integrity',
  'database-cleanup',
  'state-cleanup',
  'internal',
]);

const DEV_CLIENT_URL =
  'exp+bluegreengatorappsmessages://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081';
const METRO_STATUS_URL = 'http://127.0.0.1:8081/status';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_DIR = resolve(ROOT, 'android/app/build/reports/db-relaunch');
const WAL_WRITE_DEATH_REPORT_DIR = resolve(ROOT, 'android/app/build/reports/db-wal-write-death');
const ACTIVE_MIGRATION_DEATH_REPORT_DIR = resolve(
  ROOT,
  'android/app/build/reports/db-active-migration-death',
);
const REQUEST_FILE = 'files/.gator-db-relaunch-request-v1';
const WAL_WRITE_DEATH_REQUEST_FILE = 'files/.gator-db-wal-write-death-request-v1';
const ACTIVE_MIGRATION_DEATH_REQUEST_FILE = 'files/.gator-db-active-migration-death-request-v1';
const RUNTIME_CONCURRENCY_REQUEST_FILE = 'files/.gator-db-runtime-concurrency-request-v1';
export const MIGRATION_RELAUNCH_PRIVATE_TEST_FILES = Object.freeze([
  REQUEST_FILE,
  'files/.gator-db-relaunch-preparing-v1',
  'files/.gator-db-relaunch-ready-v1',
  'files/.gator-db-relaunch-resuming-v1',
  'databases/driver-relaunch-selftest.db',
  'databases/driver-relaunch-selftest.db-journal',
  'databases/driver-relaunch-selftest.db-wal',
  'databases/driver-relaunch-selftest.db-shm',
]);
export const WAL_WRITE_DEATH_PRIVATE_TEST_FILES = Object.freeze([
  WAL_WRITE_DEATH_REQUEST_FILE,
  'files/.gator-db-wal-write-death-preparing-v1',
  'files/.gator-db-wal-write-death-ready-v1',
  'files/.gator-db-wal-write-death-resuming-v1',
  'databases/driver-wal-write-death-selftest.db',
  'databases/driver-wal-write-death-selftest.db-journal',
  'databases/driver-wal-write-death-selftest.db-wal',
  'databases/driver-wal-write-death-selftest.db-shm',
]);
export const ACTIVE_MIGRATION_DEATH_PRIVATE_TEST_FILES = Object.freeze([
  ACTIVE_MIGRATION_DEATH_REQUEST_FILE,
  'files/.gator-db-active-migration-death-preparing-v1',
  'files/.gator-db-active-migration-death-ready-v1',
  'files/.gator-db-active-migration-death-resuming-v1',
  'databases/driver-active-migration-death-selftest.db',
  'databases/driver-active-migration-death-selftest.db-journal',
  'databases/driver-active-migration-death-selftest.db-wal',
  'databases/driver-active-migration-death-selftest.db-shm',
]);
export const RUNTIME_CONCURRENCY_PRIVATE_TEST_FILES = Object.freeze([
  RUNTIME_CONCURRENCY_REQUEST_FILE,
  'files/.gator-db-runtime-concurrency-running-v1',
  'databases/driver-runtime-concurrency-selftest.db',
  'databases/driver-runtime-concurrency-selftest.db-journal',
  'databases/driver-runtime-concurrency-selftest.db-wal',
  'databases/driver-runtime-concurrency-selftest.db-shm',
]);
export const RELAUNCH_PRIVATE_TEST_FILES = Object.freeze([
  ...MIGRATION_RELAUNCH_PRIVATE_TEST_FILES,
  ...WAL_WRITE_DEATH_PRIVATE_TEST_FILES,
  ...ACTIVE_MIGRATION_DEATH_PRIVATE_TEST_FILES,
  ...RUNTIME_CONCURRENCY_PRIVATE_TEST_FILES,
]);
export const CREATE_RELAUNCH_REQUEST_ADB_ARGS = Object.freeze([
  'shell',
  'run-as',
  APP_PACKAGE,
  'touch',
  REQUEST_FILE,
]);
export const CREATE_WAL_WRITE_DEATH_REQUEST_ADB_ARGS = Object.freeze([
  'shell',
  'run-as',
  APP_PACKAGE,
  'touch',
  WAL_WRITE_DEATH_REQUEST_FILE,
]);
export const CREATE_ACTIVE_MIGRATION_DEATH_REQUEST_ADB_ARGS = Object.freeze([
  'shell',
  'run-as',
  APP_PACKAGE,
  'touch',
  ACTIVE_MIGRATION_DEATH_REQUEST_FILE,
]);
export const CREATE_RUNTIME_CONCURRENCY_REQUEST_ADB_ARGS = Object.freeze([
  'shell',
  'run-as',
  APP_PACKAGE,
  'touch',
  RUNTIME_CONCURRENCY_REQUEST_FILE,
]);
export const READ_WAL_WRITE_DEATH_SIZE_ADB_ARGS = Object.freeze([
  'shell',
  'run-as',
  APP_PACKAGE,
  'stat',
  '-c',
  '%s',
  'databases/driver-wal-write-death-selftest.db-wal',
]);
export const READ_ACTIVE_MIGRATION_DEATH_WAL_SIZE_ADB_ARGS = Object.freeze([
  'shell',
  'run-as',
  APP_PACKAGE,
  'stat',
  '-c',
  '%s',
  'databases/driver-active-migration-death-selftest.db-wal',
]);
export const CLEANUP_RELAUNCH_STATE_ADB_ARGS = Object.freeze([
  'shell',
  'run-as',
  APP_PACKAGE,
  'rm',
  '-f',
  ...RELAUNCH_PRIVATE_TEST_FILES,
]);
export const LAUNCH_APP_ADB_ARGS = Object.freeze([
  'shell',
  'am',
  'start',
  '-a',
  'android.intent.action.VIEW',
  '-d',
  DEV_CLIENT_URL,
  '-n',
  APP_ACTIVITY,
]);
const COMMAND_TIMEOUT_MS = 20_000;
const LAUNCH_TIMEOUT_MS = 30_000;
const MARKER_TIMEOUT_MS = 120_000;
const PROCESS_TIMEOUT_MS = 10_000;
const POLL_MS = 250;
const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_MARKER_JSON_CHARS = 4_096;
const LOGCAT_BOUNDARY_PREFIX = 'GATOR_DB_RELAUNCH_BOUNDARY_';
const SINGLE_PROCESS_MARKER_PREFIXES = Object.freeze([
  'GATOR_DB_CONTRACT_V1 ',
  'GATOR_DB_CONTRACT_V2 ',
  'GATOR_DB_CONTRACT_V3 ',
]);
const FORBIDDEN_RELAUNCH_MARKER_PREFIXES = Object.freeze([
  ...SINGLE_PROCESS_MARKER_PREFIXES,
  WAL_WRITE_DEATH_MARKER_PREFIX,
  ACTIVE_MIGRATION_DEATH_MARKER_PREFIX,
  RUNTIME_CONCURRENCY_MARKER_PREFIX,
]);
const FORBIDDEN_WAL_WRITE_DEATH_MARKER_PREFIXES = Object.freeze([
  ...SINGLE_PROCESS_MARKER_PREFIXES,
  RELAUNCH_MARKER_PREFIX,
  ACTIVE_MIGRATION_DEATH_MARKER_PREFIX,
  RUNTIME_CONCURRENCY_MARKER_PREFIX,
]);
const FORBIDDEN_ACTIVE_MIGRATION_DEATH_MARKER_PREFIXES = Object.freeze([
  ...SINGLE_PROCESS_MARKER_PREFIXES,
  RELAUNCH_MARKER_PREFIX,
  WAL_WRITE_DEATH_MARKER_PREFIX,
  RUNTIME_CONCURRENCY_MARKER_PREFIX,
]);
const FORBIDDEN_RUNTIME_CONCURRENCY_MARKER_PREFIXES = Object.freeze([
  ...SINGLE_PROCESS_MARKER_PREFIXES,
  RELAUNCH_MARKER_PREFIX,
  WAL_WRITE_DEATH_MARKER_PREFIX,
  ACTIVE_MIGRATION_DEATH_MARKER_PREFIX,
]);

function compactToolOutput(value, serial) {
  let safe = String(value ?? '');
  if (serial) safe = safe.replaceAll(serial, '[device]');
  safe = safe.replace(/\/(?:Users|home)\/[^\s:]+/g, '[local-path]');
  for (const path of RELAUNCH_PRIVATE_TEST_FILES) {
    safe = safe.replaceAll(path, '[private-test-file]');
  }
  safe = safe.replace(/\/proc\/\d+\/stat/g, '[process-stat]');
  safe = safe.replace(/\b\d{2,}\b/g, '[number]');
  return safe.replace(/\s+/g, ' ').trim().slice(0, 300);
}

export function isMissingProcessResult(result) {
  return (
    result.status === 1 &&
    !String(result.stdout ?? '').trim() &&
    !String(result.stderr ?? '').trim()
  );
}

function runCommand(command, args, options = {}) {
  const {
    code = 'command-failed',
    label = command,
    serial,
    timeoutMs = COMMAND_TIMEOUT_MS,
    allowMissingProcess = false,
  } = options;
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    timeout: timeoutMs,
  });
  if (result.error) {
    const detail = compactToolOutput(result.error.message, serial);
    throw new HarnessError(code, `${label} failed${detail ? `: ${detail}` : ''}`);
  }
  if (allowMissingProcess && isMissingProcessResult(result)) return undefined;
  if (result.status !== 0) {
    const detail = compactToolOutput(result.stderr || result.stdout, serial);
    throw new HarnessError(
      code,
      `${label} failed with exit ${String(result.status)}${detail ? `: ${detail}` : ''}`,
    );
  }
  return result.stdout.trim();
}

function runAdb(serial, args, options = {}) {
  return runCommand('adb', ['-s', serial, ...args], { ...options, serial });
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HarnessError('invalid-relaunch-marker', `${label} must be an object.`);
  }
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new HarnessError(
      'invalid-relaunch-marker',
      `${label} fields do not match the finite contract.`,
    );
  }
}

function validateChecks(value, names, label) {
  assertPlainObject(value, label);
  assertExactKeys(value, names, label);
  return Object.fromEntries(
    names.map((name) => {
      if (typeof value[name] !== 'boolean') {
        throw new HarnessError('invalid-relaunch-marker', `${label} ${name} must be boolean.`);
      }
      return [name, value[name]];
    }),
  );
}

function validateFailureCode(value) {
  if (!RELAUNCH_FAILURE_CODES.includes(value)) {
    throw new HarnessError(
      'invalid-relaunch-marker',
      'Relaunch failureCode is not part of the finite contract.',
    );
  }
  return value;
}

export function validateRelaunchMarker(value) {
  assertPlainObject(value, 'Relaunch marker');
  if (value.schema !== RELAUNCH_SCHEMA || value.suite !== RELAUNCH_SUITE) {
    throw new HarnessError('invalid-relaunch-marker', 'Relaunch marker identity is invalid.');
  }

  if (value.phase === 'prepare') {
    if (value.status !== 'ready' && value.status !== 'fail') {
      throw new HarnessError('invalid-relaunch-marker', 'Prepare status must be ready or fail.');
    }
    assertExactKeys(
      value,
      value.status === 'ready'
        ? ['schema', 'suite', 'status', 'phase', 'checks']
        : ['schema', 'suite', 'status', 'phase', 'checks', 'failureCode'],
      'Prepare marker',
    );
    const checks = validateChecks(value.checks, PREPARE_CHECKS, 'Prepare checks');
    const allPassed = Object.values(checks).every(Boolean);
    if ((value.status === 'ready') !== allPassed) {
      throw new HarnessError(
        'inconsistent-relaunch-marker',
        'Prepare status does not agree with its check booleans.',
      );
    }
    return {
      schema: RELAUNCH_SCHEMA,
      suite: RELAUNCH_SUITE,
      status: value.status,
      phase: 'prepare',
      checks,
      ...(value.status === 'fail' ? { failureCode: validateFailureCode(value.failureCode) } : {}),
    };
  }

  if (value.phase !== 'resume' && value.phase !== 'recovery') {
    throw new HarnessError('invalid-relaunch-marker', 'Relaunch marker phase is invalid.');
  }
  if (value.status !== 'pass' && value.status !== 'fail') {
    throw new HarnessError('invalid-relaunch-marker', 'Final status must be pass or fail.');
  }
  if (value.phase === 'recovery' && value.status !== 'fail') {
    throw new HarnessError('invalid-relaunch-marker', 'Recovery is a failure-only relaunch phase.');
  }
  assertExactKeys(
    value,
    value.status === 'pass'
      ? ['schema', 'suite', 'status', 'phase', 'migrationCount', 'migrationHead', 'checks']
      : [
          'schema',
          'suite',
          'status',
          'phase',
          'migrationCount',
          'migrationHead',
          'checks',
          'failureCode',
        ],
    'Final marker',
  );
  if (
    value.migrationCount !== RELAUNCH_MIGRATION_COUNT ||
    value.migrationHead !== RELAUNCH_MIGRATION_HEAD
  ) {
    throw new HarnessError(
      'invalid-relaunch-marker',
      'Final migration count or head does not match the reviewed contract.',
    );
  }
  const checks = validateChecks(value.checks, RESUME_CHECKS, 'Final checks');
  const allPassed = Object.values(checks).every(Boolean);
  if ((value.status === 'pass') !== allPassed) {
    throw new HarnessError(
      'inconsistent-relaunch-marker',
      'Final status does not agree with its check booleans.',
    );
  }
  return {
    schema: RELAUNCH_SCHEMA,
    suite: RELAUNCH_SUITE,
    status: value.status,
    phase: value.phase,
    migrationCount: RELAUNCH_MIGRATION_COUNT,
    migrationHead: RELAUNCH_MIGRATION_HEAD,
    checks,
    ...(value.status === 'fail' ? { failureCode: validateFailureCode(value.failureCode) } : {}),
  };
}

function validateWalWriteDeathFailureCode(value) {
  if (!WAL_WRITE_DEATH_FAILURE_CODES.includes(value)) {
    throw new HarnessError(
      'invalid-wal-write-death-marker',
      'Active-WAL failureCode is not part of the finite contract.',
    );
  }
  return value;
}

export function validateWalWriteDeathMarker(value) {
  assertPlainObject(value, 'Active-WAL marker');
  if (value.schema !== WAL_WRITE_DEATH_SCHEMA || value.suite !== WAL_WRITE_DEATH_SUITE) {
    throw new HarnessError(
      'invalid-wal-write-death-marker',
      'Active-WAL marker identity is invalid.',
    );
  }

  if (value.phase === 'prepare') {
    if (value.status !== 'ready' && value.status !== 'fail') {
      throw new HarnessError(
        'invalid-wal-write-death-marker',
        'Active-WAL prepare status must be ready or fail.',
      );
    }
    assertExactKeys(
      value,
      value.status === 'ready'
        ? ['schema', 'suite', 'status', 'phase', 'checks']
        : ['schema', 'suite', 'status', 'phase', 'checks', 'failureCode'],
      'Active-WAL prepare marker',
    );
    const checks = validateChecks(
      value.checks,
      WAL_WRITE_DEATH_PREPARE_CHECKS,
      'Active-WAL prepare checks',
    );
    const allPassed = Object.values(checks).every(Boolean);
    if ((value.status === 'ready') !== allPassed) {
      throw new HarnessError(
        'inconsistent-wal-write-death-marker',
        'Active-WAL prepare status does not agree with its check booleans.',
      );
    }
    return {
      schema: WAL_WRITE_DEATH_SCHEMA,
      suite: WAL_WRITE_DEATH_SUITE,
      status: value.status,
      phase: 'prepare',
      checks,
      ...(value.status === 'fail'
        ? { failureCode: validateWalWriteDeathFailureCode(value.failureCode) }
        : {}),
    };
  }

  if (value.phase !== 'resume' && value.phase !== 'recovery') {
    throw new HarnessError('invalid-wal-write-death-marker', 'Active-WAL marker phase is invalid.');
  }
  if (value.status !== 'pass' && value.status !== 'fail') {
    throw new HarnessError(
      'invalid-wal-write-death-marker',
      'Active-WAL final status must be pass or fail.',
    );
  }
  if (value.phase === 'recovery' && value.status !== 'fail') {
    throw new HarnessError(
      'invalid-wal-write-death-marker',
      'Recovery is a failure-only active-WAL phase.',
    );
  }
  assertExactKeys(
    value,
    value.status === 'pass'
      ? ['schema', 'suite', 'status', 'phase', 'checks']
      : ['schema', 'suite', 'status', 'phase', 'checks', 'failureCode'],
    'Active-WAL final marker',
  );
  const checks = validateChecks(
    value.checks,
    WAL_WRITE_DEATH_RESUME_CHECKS,
    'Active-WAL final checks',
  );
  const allPassed = Object.values(checks).every(Boolean);
  if ((value.status === 'pass') !== allPassed) {
    throw new HarnessError(
      'inconsistent-wal-write-death-marker',
      'Active-WAL final status does not agree with its check booleans.',
    );
  }
  return {
    schema: WAL_WRITE_DEATH_SCHEMA,
    suite: WAL_WRITE_DEATH_SUITE,
    status: value.status,
    phase: value.phase,
    checks,
    ...(value.status === 'fail'
      ? { failureCode: validateWalWriteDeathFailureCode(value.failureCode) }
      : {}),
  };
}

function validateActiveMigrationDeathFailureCode(value) {
  if (!ACTIVE_MIGRATION_DEATH_FAILURE_CODES.includes(value)) {
    throw new HarnessError(
      'invalid-active-migration-death-marker',
      'Active-migration failureCode is not part of the finite contract.',
    );
  }
  return value;
}

export function validateActiveMigrationDeathMarker(value) {
  assertPlainObject(value, 'Active-migration marker');
  if (
    value.schema !== ACTIVE_MIGRATION_DEATH_SCHEMA ||
    value.suite !== ACTIVE_MIGRATION_DEATH_SUITE
  ) {
    throw new HarnessError(
      'invalid-active-migration-death-marker',
      'Active-migration marker identity is invalid.',
    );
  }

  if (value.phase === 'prepare') {
    if (value.status !== 'ready' && value.status !== 'fail') {
      throw new HarnessError(
        'invalid-active-migration-death-marker',
        'Active-migration prepare status must be ready or fail.',
      );
    }
    assertExactKeys(
      value,
      value.status === 'ready'
        ? ['schema', 'suite', 'status', 'phase', 'checks']
        : ['schema', 'suite', 'status', 'phase', 'checks', 'failureCode'],
      'Active-migration prepare marker',
    );
    const checks = validateChecks(
      value.checks,
      ACTIVE_MIGRATION_DEATH_PREPARE_CHECKS,
      'Active-migration prepare checks',
    );
    const allPassed = Object.values(checks).every(Boolean);
    if ((value.status === 'ready') !== allPassed) {
      throw new HarnessError(
        'inconsistent-active-migration-death-marker',
        'Active-migration prepare status does not agree with its check booleans.',
      );
    }
    return {
      schema: ACTIVE_MIGRATION_DEATH_SCHEMA,
      suite: ACTIVE_MIGRATION_DEATH_SUITE,
      status: value.status,
      phase: 'prepare',
      checks,
      ...(value.status === 'fail'
        ? { failureCode: validateActiveMigrationDeathFailureCode(value.failureCode) }
        : {}),
    };
  }

  if (value.phase !== 'resume' && value.phase !== 'recovery') {
    throw new HarnessError(
      'invalid-active-migration-death-marker',
      'Active-migration marker phase is invalid.',
    );
  }
  if (value.status !== 'pass' && value.status !== 'fail') {
    throw new HarnessError(
      'invalid-active-migration-death-marker',
      'Active-migration final status must be pass or fail.',
    );
  }
  if (value.phase === 'recovery' && value.status !== 'fail') {
    throw new HarnessError(
      'invalid-active-migration-death-marker',
      'Recovery is a failure-only active-migration phase.',
    );
  }
  assertExactKeys(
    value,
    value.status === 'pass'
      ? ['schema', 'suite', 'status', 'phase', 'migrationCount', 'migrationHead', 'checks']
      : [
          'schema',
          'suite',
          'status',
          'phase',
          'migrationCount',
          'migrationHead',
          'checks',
          'failureCode',
        ],
    'Active-migration final marker',
  );
  if (
    value.migrationCount !== RELAUNCH_MIGRATION_COUNT ||
    value.migrationHead !== RELAUNCH_MIGRATION_HEAD
  ) {
    throw new HarnessError(
      'invalid-active-migration-death-marker',
      'Active-migration count or head does not match the reviewed contract.',
    );
  }
  const checks = validateChecks(
    value.checks,
    ACTIVE_MIGRATION_DEATH_RESUME_CHECKS,
    'Active-migration final checks',
  );
  const allPassed = Object.values(checks).every(Boolean);
  if ((value.status === 'pass') !== allPassed) {
    throw new HarnessError(
      'inconsistent-active-migration-death-marker',
      'Active-migration final status does not agree with its check booleans.',
    );
  }
  return {
    schema: ACTIVE_MIGRATION_DEATH_SCHEMA,
    suite: ACTIVE_MIGRATION_DEATH_SUITE,
    status: value.status,
    phase: value.phase,
    migrationCount: RELAUNCH_MIGRATION_COUNT,
    migrationHead: RELAUNCH_MIGRATION_HEAD,
    checks,
    ...(value.status === 'fail'
      ? { failureCode: validateActiveMigrationDeathFailureCode(value.failureCode) }
      : {}),
  };
}

function assertRuntimeConcurrencyPlainObject(
  value,
  label,
  code = 'invalid-runtime-concurrency-marker',
) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HarnessError(code, `${label} must be an object.`);
  }
}

function assertRuntimeConcurrencyExactKeys(
  value,
  expected,
  label,
  code = 'invalid-runtime-concurrency-marker',
) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new HarnessError(code, `${label} fields do not match the finite contract.`);
  }
}

function validateRuntimeConcurrencyFailureCode(value) {
  if (!RUNTIME_CONCURRENCY_FAILURE_CODES.includes(value)) {
    throw new HarnessError(
      'invalid-runtime-concurrency-marker',
      'Runtime-concurrency failureCode is not part of the finite contract.',
    );
  }
  return value;
}

/** Validate one terminal, privacy-bounded runtime-concurrency marker. */
export function validateRuntimeConcurrencyMarker(value) {
  assertRuntimeConcurrencyPlainObject(value, 'Runtime-concurrency marker');
  if (value.schema !== RUNTIME_CONCURRENCY_SCHEMA || value.suite !== RUNTIME_CONCURRENCY_SUITE) {
    throw new HarnessError(
      'invalid-runtime-concurrency-marker',
      'Runtime-concurrency marker identity is invalid.',
    );
  }
  if (value.status !== 'pass' && value.status !== 'fail') {
    throw new HarnessError(
      'invalid-runtime-concurrency-marker',
      'Runtime-concurrency status must be pass or fail.',
    );
  }
  assertRuntimeConcurrencyExactKeys(
    value,
    value.status === 'pass'
      ? ['schema', 'suite', 'status', 'migrationCount', 'migrationHead', 'checks']
      : ['schema', 'suite', 'status', 'migrationCount', 'migrationHead', 'checks', 'failureCode'],
    'Runtime-concurrency marker',
  );
  if (
    value.migrationCount !== RELAUNCH_MIGRATION_COUNT ||
    value.migrationHead !== RELAUNCH_MIGRATION_HEAD
  ) {
    throw new HarnessError(
      'invalid-runtime-concurrency-marker',
      'Runtime-concurrency migration count or head does not match the reviewed contract.',
    );
  }
  assertRuntimeConcurrencyPlainObject(value.checks, 'Runtime-concurrency checks');
  assertRuntimeConcurrencyExactKeys(
    value.checks,
    RUNTIME_CONCURRENCY_CHECKS,
    'Runtime-concurrency checks',
  );
  const checks = Object.fromEntries(
    RUNTIME_CONCURRENCY_CHECKS.map((name) => {
      if (typeof value.checks[name] !== 'boolean') {
        throw new HarnessError(
          'invalid-runtime-concurrency-marker',
          `Runtime-concurrency check ${name} must be boolean.`,
        );
      }
      return [name, value.checks[name]];
    }),
  );
  const allPassed = Object.values(checks).every(Boolean);
  if ((value.status === 'pass') !== allPassed) {
    throw new HarnessError(
      'inconsistent-runtime-concurrency-marker',
      'Runtime-concurrency status does not agree with its check booleans.',
    );
  }
  return {
    schema: RUNTIME_CONCURRENCY_SCHEMA,
    suite: RUNTIME_CONCURRENCY_SUITE,
    status: value.status,
    migrationCount: RELAUNCH_MIGRATION_COUNT,
    migrationHead: RELAUNCH_MIGRATION_HEAD,
    checks,
    ...(value.status === 'fail'
      ? { failureCode: validateRuntimeConcurrencyFailureCode(value.failureCode) }
      : {}),
  };
}

function parseThreadtimeLine(line) {
  const match =
    /^\s*\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+\s+(\d+)\s+\d+\s+[VDIWEF]\s+[^:]+:\s?(.*)$/.exec(line);
  return match ? { pid: match[1], message: match[2] } : undefined;
}

/** Extract and validate the complete, ordered marker prefix from a bounded logcat snapshot. */
export function extractRelaunchMarkers(logText, expectedPids = []) {
  const payloads = [];
  for (const line of String(logText).split(/\r?\n/)) {
    if (FORBIDDEN_RELAUNCH_MARKER_PREFIXES.some((prefix) => line.includes(prefix))) {
      throw new HarnessError(
        'wrong-db-contract-marker',
        'The single-process DB contract ran during the exclusive relaunch lane.',
      );
    }
    if (!line.includes(RELAUNCH_MARKER_PREFIX)) continue;
    const parsedLine = parseThreadtimeLine(line);
    if (!parsedLine) {
      throw new HarnessError(
        'invalid-marker-process',
        'Relaunch marker did not include a valid threadtime process identity.',
      );
    }
    const markerIndex = parsedLine.message.indexOf(RELAUNCH_MARKER_PREFIX);
    if (markerIndex < 0) continue;
    const markerPid = parsedLine.pid;
    const expectedPid = expectedPids[payloads.length];
    if (expectedPid !== undefined && markerPid !== expectedPid) {
      throw new HarnessError(
        'wrong-marker-process',
        'Relaunch marker was emitted by the wrong app process.',
      );
    }
    const payload = parsedLine.message.slice(markerIndex + RELAUNCH_MARKER_PREFIX.length).trim();
    if (!payload || payload.length > MAX_MARKER_JSON_CHARS) {
      throw new HarnessError(
        'invalid-relaunch-marker',
        'Relaunch marker payload is empty or too large.',
      );
    }
    payloads.push(payload);
  }
  if (payloads.length > 2) {
    throw new HarnessError('duplicate-relaunch-marker', 'Too many relaunch markers were emitted.');
  }

  const markers = payloads.map((payload) => {
    try {
      return validateRelaunchMarker(JSON.parse(payload));
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      throw new HarnessError('invalid-relaunch-marker', 'Relaunch marker is not valid JSON.');
    }
  });
  if (markers.length === 0) return markers;
  const first = markers[0];
  if (first.phase !== 'prepare') {
    throw new HarnessError('invalid-relaunch-sequence', 'The first marker must be prepare.');
  }
  if (first.status === 'fail' && markers.length !== 1) {
    throw new HarnessError(
      'invalid-relaunch-sequence',
      'A failed prepare marker must be terminal.',
    );
  }
  if (markers.length === 2) {
    if (first.status !== 'ready' || markers[1].phase === 'prepare') {
      throw new HarnessError(
        'invalid-relaunch-sequence',
        'Final marker must follow exactly one ready prepare marker.',
      );
    }
  }
  return markers;
}

/** Extract and validate the complete, ordered active-WAL marker prefix. */
export function extractWalWriteDeathMarkers(logText, expectedPids = []) {
  const payloads = [];
  for (const line of String(logText).split(/\r?\n/)) {
    if (FORBIDDEN_WAL_WRITE_DEATH_MARKER_PREFIXES.some((prefix) => line.includes(prefix))) {
      throw new HarnessError(
        'wrong-db-contract-marker',
        'Another DB contract ran during the exclusive active-WAL lane.',
      );
    }
    if (!line.includes(WAL_WRITE_DEATH_MARKER_PREFIX)) continue;
    const parsedLine = parseThreadtimeLine(line);
    if (!parsedLine) {
      throw new HarnessError(
        'invalid-marker-process',
        'Active-WAL marker did not include a valid threadtime process identity.',
      );
    }
    const markerIndex = parsedLine.message.indexOf(WAL_WRITE_DEATH_MARKER_PREFIX);
    if (markerIndex < 0) continue;
    const markerPid = parsedLine.pid;
    const expectedPid = expectedPids[payloads.length];
    if (expectedPid !== undefined && markerPid !== expectedPid) {
      throw new HarnessError(
        'wrong-marker-process',
        'Active-WAL marker was emitted by the wrong app process.',
      );
    }
    const payload = parsedLine.message
      .slice(markerIndex + WAL_WRITE_DEATH_MARKER_PREFIX.length)
      .trim();
    if (!payload || payload.length > MAX_MARKER_JSON_CHARS) {
      throw new HarnessError(
        'invalid-wal-write-death-marker',
        'Active-WAL marker payload is empty or too large.',
      );
    }
    payloads.push(payload);
  }
  if (payloads.length > 2) {
    throw new HarnessError(
      'duplicate-wal-write-death-marker',
      'Too many active-WAL markers were emitted.',
    );
  }

  const markers = payloads.map((payload) => {
    try {
      return validateWalWriteDeathMarker(JSON.parse(payload));
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      throw new HarnessError(
        'invalid-wal-write-death-marker',
        'Active-WAL marker is not valid JSON.',
      );
    }
  });
  if (markers.length === 0) return markers;
  const first = markers[0];
  if (first.phase !== 'prepare') {
    throw new HarnessError(
      'invalid-wal-write-death-sequence',
      'The first active-WAL marker must be prepare.',
    );
  }
  if (first.status === 'fail' && markers.length !== 1) {
    throw new HarnessError(
      'invalid-wal-write-death-sequence',
      'A failed active-WAL prepare marker must be terminal.',
    );
  }
  if (markers.length === 2) {
    if (first.status !== 'ready' || markers[1].phase === 'prepare') {
      throw new HarnessError(
        'invalid-wal-write-death-sequence',
        'Active-WAL final marker must follow exactly one ready prepare marker.',
      );
    }
  }
  return markers;
}

/** Extract and validate the complete, ordered active-migration marker prefix. */
export function extractActiveMigrationDeathMarkers(logText, expectedPids = []) {
  const payloads = [];
  for (const line of String(logText).split(/\r?\n/)) {
    if (FORBIDDEN_ACTIVE_MIGRATION_DEATH_MARKER_PREFIXES.some((prefix) => line.includes(prefix))) {
      throw new HarnessError(
        'wrong-db-contract-marker',
        'Another DB contract ran during the exclusive active-migration lane.',
      );
    }
    if (!line.includes(ACTIVE_MIGRATION_DEATH_MARKER_PREFIX)) continue;
    const parsedLine = parseThreadtimeLine(line);
    if (!parsedLine) {
      throw new HarnessError(
        'invalid-marker-process',
        'Active-migration marker did not include a valid threadtime process identity.',
      );
    }
    const markerIndex = parsedLine.message.indexOf(ACTIVE_MIGRATION_DEATH_MARKER_PREFIX);
    if (markerIndex < 0) continue;
    const markerPid = parsedLine.pid;
    const expectedPid = expectedPids[payloads.length];
    if (expectedPid !== undefined && markerPid !== expectedPid) {
      throw new HarnessError(
        'wrong-marker-process',
        'Active-migration marker was emitted by the wrong app process.',
      );
    }
    const payload = parsedLine.message
      .slice(markerIndex + ACTIVE_MIGRATION_DEATH_MARKER_PREFIX.length)
      .trim();
    if (!payload || payload.length > MAX_MARKER_JSON_CHARS) {
      throw new HarnessError(
        'invalid-active-migration-death-marker',
        'Active-migration marker payload is empty or too large.',
      );
    }
    payloads.push(payload);
  }
  if (payloads.length > 2) {
    throw new HarnessError(
      'duplicate-active-migration-death-marker',
      'Too many active-migration markers were emitted.',
    );
  }

  const markers = payloads.map((payload) => {
    try {
      return validateActiveMigrationDeathMarker(JSON.parse(payload));
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      throw new HarnessError(
        'invalid-active-migration-death-marker',
        'Active-migration marker is not valid JSON.',
      );
    }
  });
  if (markers.length === 0) return markers;
  const first = markers[0];
  if (first.phase !== 'prepare') {
    throw new HarnessError(
      'invalid-active-migration-death-sequence',
      'The first active-migration marker must be prepare.',
    );
  }
  if (first.status === 'fail' && markers.length !== 1) {
    throw new HarnessError(
      'invalid-active-migration-death-sequence',
      'A failed active-migration prepare marker must be terminal.',
    );
  }
  if (markers.length === 2) {
    if (first.status !== 'ready' || markers[1].phase === 'prepare') {
      throw new HarnessError(
        'invalid-active-migration-death-sequence',
        'Active-migration final marker must follow exactly one ready prepare marker.',
      );
    }
  }
  return markers;
}

/** Extract one terminal runtime-concurrency marker from its exclusive process lane. */
export function extractRuntimeConcurrencyMarkers(logText, expectedPids = []) {
  const payloads = [];
  for (const line of String(logText).split(/\r?\n/)) {
    if (FORBIDDEN_RUNTIME_CONCURRENCY_MARKER_PREFIXES.some((prefix) => line.includes(prefix))) {
      throw new HarnessError(
        'wrong-db-contract-marker',
        'Another DB contract ran during the exclusive runtime-concurrency lane.',
      );
    }
    if (!line.includes(RUNTIME_CONCURRENCY_MARKER_PREFIX)) continue;
    const parsedLine = parseThreadtimeLine(line);
    if (!parsedLine) {
      throw new HarnessError(
        'invalid-marker-process',
        'Runtime-concurrency marker did not include a valid threadtime process identity.',
      );
    }
    const markerIndex = parsedLine.message.indexOf(RUNTIME_CONCURRENCY_MARKER_PREFIX);
    if (markerIndex < 0) continue;
    const expectedPid = expectedPids[payloads.length];
    if (expectedPid !== undefined && parsedLine.pid !== expectedPid) {
      throw new HarnessError(
        'wrong-marker-process',
        'Runtime-concurrency marker was emitted by the wrong app process.',
      );
    }
    const payload = parsedLine.message
      .slice(markerIndex + RUNTIME_CONCURRENCY_MARKER_PREFIX.length)
      .trim();
    if (!payload || payload.length > MAX_MARKER_JSON_CHARS) {
      throw new HarnessError(
        'invalid-runtime-concurrency-marker',
        'Runtime-concurrency marker payload is empty or too large.',
      );
    }
    payloads.push(payload);
  }
  if (payloads.length > 1) {
    throw new HarnessError(
      'duplicate-runtime-concurrency-marker',
      'Too many runtime-concurrency markers were emitted.',
    );
  }
  return payloads.map((payload) => {
    try {
      return validateRuntimeConcurrencyMarker(JSON.parse(payload));
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      throw new HarnessError(
        'invalid-runtime-concurrency-marker',
        'Runtime-concurrency marker is not valid JSON.',
      );
    }
  });
}

export function logsAfterRelaunchBoundary(logText, boundary) {
  if (!boundary.startsWith(LOGCAT_BOUNDARY_PREFIX)) {
    throw new HarnessError('invalid-log-boundary', 'The DB relaunch log boundary is invalid.');
  }
  const lines = String(logText).split(/\r?\n/);
  const indexes = lines.flatMap((line, index) =>
    parseThreadtimeLine(line)?.message.trim() === boundary ? [index] : [],
  );
  if (indexes.length !== 1) {
    throw new HarnessError(
      'log-boundary-missing',
      'The current DB relaunch log boundary is missing or duplicated.',
    );
  }
  return lines.slice(indexes[0] + 1).join('\n');
}

export function parseProcessStartTicks(statText) {
  const text = String(statText).trim();
  const closeParen = text.lastIndexOf(')');
  if (!/^\d+ \(/.test(text) || closeParen < 3) return undefined;
  const fieldsFromState = text
    .slice(closeParen + 1)
    .trim()
    .split(/\s+/);
  const startTicks = fieldsFromState[19];
  return /^\d+$/.test(startTicks ?? '') ? startTicks : undefined;
}

export function parseSingleProcessPid(pidofOutput) {
  if (pidofOutput === undefined || pidofOutput === null) return undefined;
  const values = String(pidofOutput).trim().split(/\s+/).filter(Boolean);
  if (values.length === 0) return undefined;
  if (values.length !== 1 || !/^\d+$/.test(values[0])) {
    throw new HarnessError(
      'invalid-process-identity',
      'Gator must have exactly one numeric main-process ID.',
    );
  }
  return values[0];
}

function sameProcessIdentity(left, right) {
  if (!left || !right || left.pid !== right.pid) return false;
  if (left.startTicks && right.startTicks) return left.startTicks === right.startTicks;
  return true;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitForProcess(getProcessIdentity, options = {}) {
  const {
    timeoutMs = PROCESS_TIMEOUT_MS,
    pollMs = POLL_MS,
    now = Date.now,
    sleep = delay,
  } = options;
  const deadline = now() + timeoutMs;
  while (now() <= deadline) {
    const identity = await getProcessIdentity();
    if (identity) return identity;
    await sleep(pollMs);
  }
  throw new HarnessError(
    'app-process-missing',
    'Gator did not create an app process after launch.',
  );
}

export async function waitForNoProcess(getProcessIdentity, options = {}) {
  const {
    timeoutMs = PROCESS_TIMEOUT_MS,
    pollMs = POLL_MS,
    now = Date.now,
    sleep = delay,
  } = options;
  const deadline = now() + timeoutMs;
  while (now() <= deadline) {
    if (!(await getProcessIdentity())) return;
    await sleep(pollMs);
  }
  throw new HarnessError(
    'app-process-still-running',
    'Gator still has an app process after the required process stop.',
  );
}

async function waitForMarkerCount({
  readLogs,
  getProcessIdentity,
  expectedIdentity,
  markerProcessIds,
  extractMarkers = extractRelaunchMarkers,
  count,
  timeoutMs = MARKER_TIMEOUT_MS,
  pollMs = POLL_MS,
  now = Date.now,
  sleep = delay,
}) {
  const deadline = now() + timeoutMs;
  while (now() <= deadline) {
    const markers = extractMarkers(await readLogs(), markerProcessIds);
    if (markers[0]?.status === 'fail' || markers.length === count) {
      if (!sameProcessIdentity(await getProcessIdentity(), expectedIdentity)) {
        throw new HarnessError(
          'app-process-exited',
          'The Gator process changed while emitting its expected relaunch marker.',
        );
      }
      return markers;
    }
    if (markers.length > count) {
      throw new HarnessError(
        'unexpected-relaunch-marker',
        'A relaunch marker arrived before the required process transition.',
      );
    }
    if (!sameProcessIdentity(await getProcessIdentity(), expectedIdentity)) {
      throw new HarnessError(
        'app-process-exited',
        'The Gator process changed before emitting its expected relaunch marker.',
      );
    }
    await sleep(pollMs);
  }
  throw new HarnessError(
    'relaunch-result-timeout',
    `No expected DB relaunch marker arrived within ${String(timeoutMs)} ms.`,
  );
}

async function waitForRuntimeConcurrencyMarker({
  readLogs,
  getProcessIdentity,
  expectedIdentity,
  timeoutMs = MARKER_TIMEOUT_MS,
  pollMs = POLL_MS,
  now = Date.now,
  sleep = delay,
}) {
  const deadline = now() + timeoutMs;
  while (now() <= deadline) {
    const markers = extractRuntimeConcurrencyMarkers(await readLogs(), [expectedIdentity.pid]);
    if (markers.length === 1) return markers[0];
    if (!sameProcessIdentity(await getProcessIdentity(), expectedIdentity)) {
      throw new HarnessError(
        'app-process-exited',
        'The Gator process changed before emitting its runtime-concurrency marker.',
      );
    }
    await sleep(pollMs);
  }
  throw new HarnessError(
    'runtime-concurrency-result-timeout',
    `No runtime-concurrency marker arrived within ${String(timeoutMs)} ms.`,
  );
}

/** Dependency-injected lifecycle proof; host unit tests never need adb or an Android device. */
export async function executeRelaunchSequence(operations, timing = {}) {
  const { resetTestState, createRequest, launchApp, stopApp, readLogs, getProcessIdentity } =
    operations;
  let primaryError;
  let outcome;
  try {
    await resetTestState();
    await createRequest();
    await launchApp();
    const processA = await waitForProcess(getProcessIdentity, timing);
    const prepareMarkers = await waitForMarkerCount({
      readLogs,
      getProcessIdentity,
      expectedIdentity: processA,
      markerProcessIds: [processA.pid],
      count: 1,
      ...timing,
    });
    const ready = prepareMarkers[0];
    if (ready.status === 'fail') {
      outcome = {
        ready,
        final: undefined,
        hostChecks: { processAAlive: true, processStopped: false, processChanged: false },
      };
      return outcome;
    }

    if (!sameProcessIdentity(await getProcessIdentity(), processA)) {
      throw new HarnessError(
        'process-a-not-alive',
        'The first Gator process was not alive immediately before force-stop.',
      );
    }
    await stopApp();
    await waitForNoProcess(getProcessIdentity, timing);
    await launchApp();
    const processB = await waitForProcess(getProcessIdentity, timing);
    if (processB.pid === processA.pid) {
      throw new HarnessError(
        'process-not-changed',
        'The second launch reused the first process ID; true process replacement was not proved.',
      );
    }
    const markers = await waitForMarkerCount({
      readLogs,
      getProcessIdentity,
      expectedIdentity: processB,
      markerProcessIds: [processA.pid, processB.pid],
      count: 2,
      ...timing,
    });
    outcome = {
      ready: markers[0],
      final: markers[1],
      hostChecks: { processAAlive: true, processStopped: true, processChanged: true },
    };
    return outcome;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await resetTestState();
    } catch (cleanupError) {
      if (!primaryError) throw cleanupError;
    }
  }
}

export function createCrashAppAdbArgs(pid) {
  if (!/^\d+$/.test(String(pid))) {
    throw new HarnessError(
      'invalid-process-identity',
      'The crash target must be one exact numeric app-process ID.',
    );
  }
  return ['shell', 'am', 'crash', String(pid)];
}

export function walFileGrewBeyondHeader(sizeText) {
  const normalized = String(sizeText).trim();
  if (!/^\d+$/.test(normalized)) {
    throw new HarnessError('wal-size-invalid', 'The active-WAL size probe was not numeric.');
  }
  return BigInt(normalized) > 32n;
}

export function createPrivateFileAbsenceAdbArgs(path) {
  if (!RELAUNCH_PRIVATE_TEST_FILES.includes(path)) {
    throw new HarnessError(
      'invalid-private-test-file',
      'The private-file probe target is outside the fixed disposable allowlist.',
    );
  }
  return ['shell', 'run-as', APP_PACKAGE, 'test', '!', '-e', path];
}

/** Dependency-injected active-WAL death proof; unit tests never need adb or an Android device. */
export async function executeWalWriteDeathSequence(operations, timing = {}) {
  const {
    resetTestState,
    createRequest,
    launchApp,
    crashApp,
    readLogs,
    getProcessIdentity,
    proveWalGrew,
    verifyPrivateStateClean,
  } = operations;
  let primaryError;
  let outcome;
  try {
    await resetTestState();
    await createRequest();
    await launchApp();
    const processA = await waitForProcess(getProcessIdentity, timing);
    const prepareMarkers = await waitForMarkerCount({
      readLogs,
      getProcessIdentity,
      expectedIdentity: processA,
      markerProcessIds: [processA.pid],
      extractMarkers: extractWalWriteDeathMarkers,
      count: 1,
      ...timing,
    });
    const ready = prepareMarkers[0];
    if (ready.status === 'fail') {
      outcome = {
        ready,
        final: undefined,
        hostChecks: {
          processAAlive: true,
          walGrew: false,
          processCrashed: false,
          processChanged: false,
          privateStateClean: false,
        },
      };
      return outcome;
    }

    if (!sameProcessIdentity(await getProcessIdentity(), processA)) {
      throw new HarnessError(
        'process-a-not-alive',
        'The first Gator process was not alive before the active-WAL proof.',
      );
    }
    if ((await proveWalGrew()) !== true) {
      throw new HarnessError(
        'wal-not-grown',
        'The active WAL did not grow beyond its fixed header before process death.',
      );
    }
    if (!sameProcessIdentity(await getProcessIdentity(), processA)) {
      throw new HarnessError(
        'process-a-not-alive',
        'The first Gator process changed during the active-WAL proof.',
      );
    }

    await crashApp(processA.pid);
    await waitForNoProcess(getProcessIdentity, timing);
    await launchApp();
    const processB = await waitForProcess(getProcessIdentity, timing);
    if (processB.pid === processA.pid) {
      throw new HarnessError(
        'process-not-changed',
        'The second launch reused the crashed process ID; replacement was not proved.',
      );
    }
    const markers = await waitForMarkerCount({
      readLogs,
      getProcessIdentity,
      expectedIdentity: processB,
      markerProcessIds: [processA.pid, processB.pid],
      extractMarkers: extractWalWriteDeathMarkers,
      count: 2,
      ...timing,
    });
    const privateStateClean = (await verifyPrivateStateClean()) === true;
    outcome = {
      ready: markers[0],
      final: markers[1],
      hostChecks: {
        processAAlive: true,
        walGrew: true,
        processCrashed: true,
        processChanged: true,
        privateStateClean,
      },
    };
    return outcome;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await resetTestState();
    } catch (cleanupError) {
      if (!primaryError) throw cleanupError;
    }
  }
}

/** Dependency-injected active-migration transaction proof; unit tests never need adb. */
export async function executeActiveMigrationDeathSequence(operations, timing = {}) {
  const {
    resetTestState,
    createRequest,
    launchApp,
    crashApp,
    readLogs,
    getProcessIdentity,
    proveWalGrewBeforeCrash,
    proveWalPresentAfterCrash,
    verifyPrivateStateClean,
  } = operations;
  let primaryError;
  let outcome;
  try {
    await resetTestState();
    await createRequest();
    await launchApp();
    const processA = await waitForProcess(getProcessIdentity, timing);
    const prepareMarkers = await waitForMarkerCount({
      readLogs,
      getProcessIdentity,
      expectedIdentity: processA,
      markerProcessIds: [processA.pid],
      extractMarkers: extractActiveMigrationDeathMarkers,
      count: 1,
      ...timing,
    });
    const ready = prepareMarkers[0];
    if (ready.status === 'fail') {
      outcome = {
        ready,
        final: undefined,
        hostChecks: {
          processAAlive: true,
          walGrewBeforeCrash: false,
          processCrashed: false,
          walPresentAfterCrash: false,
          processChanged: false,
          privateStateClean: false,
        },
      };
      return outcome;
    }

    if (!sameProcessIdentity(await getProcessIdentity(), processA)) {
      throw new HarnessError(
        'process-a-not-alive',
        'The first Gator process was not alive before the active-migration proof.',
      );
    }
    if ((await proveWalGrewBeforeCrash()) !== true) {
      throw new HarnessError(
        'wal-not-grown',
        'The active-migration WAL did not grow beyond its header before process death.',
      );
    }
    if (!sameProcessIdentity(await getProcessIdentity(), processA)) {
      throw new HarnessError(
        'process-a-not-alive',
        'The first Gator process changed during the active-migration proof.',
      );
    }

    await crashApp(processA.pid);
    await waitForNoProcess(getProcessIdentity, timing);
    if ((await proveWalPresentAfterCrash()) !== true) {
      throw new HarnessError(
        'wal-not-present-after-crash',
        'The uncommitted migration WAL was not present after the no-process gap.',
      );
    }
    await launchApp();
    const processB = await waitForProcess(getProcessIdentity, timing);
    if (processB.pid === processA.pid) {
      throw new HarnessError(
        'process-not-changed',
        'The second launch reused the crashed process ID; replacement was not proved.',
      );
    }
    const markers = await waitForMarkerCount({
      readLogs,
      getProcessIdentity,
      expectedIdentity: processB,
      markerProcessIds: [processA.pid, processB.pid],
      extractMarkers: extractActiveMigrationDeathMarkers,
      count: 2,
      ...timing,
    });
    const privateStateClean = (await verifyPrivateStateClean()) === true;
    outcome = {
      ready: markers[0],
      final: markers[1],
      hostChecks: {
        processAAlive: true,
        walGrewBeforeCrash: true,
        processCrashed: true,
        walPresentAfterCrash: true,
        processChanged: true,
        privateStateClean,
      },
    };
    return outcome;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await resetTestState();
    } catch (cleanupError) {
      if (!primaryError) throw cleanupError;
    }
  }
}

/** Dependency-injected one-launch runtime-concurrency proof; host tests never need adb. */
export async function executeRuntimeConcurrencySequence(operations, timing = {}) {
  const {
    resetTestState,
    createRequest,
    launchApp,
    stopApp,
    readLogs,
    getProcessIdentity,
    verifyPrivateStateClean,
  } = operations;
  let primaryError;
  let processStopped = false;
  try {
    await resetTestState();
    await createRequest();
    await launchApp();
    const processIdentity = await waitForProcess(getProcessIdentity, timing);
    const result = await waitForRuntimeConcurrencyMarker({
      readLogs,
      getProcessIdentity,
      expectedIdentity: processIdentity,
      ...timing,
    });
    if (!sameProcessIdentity(await getProcessIdentity(), processIdentity)) {
      throw new HarnessError(
        'app-process-exited',
        'The Gator process changed while emitting its runtime-concurrency marker.',
      );
    }
    if ((await verifyPrivateStateClean()) !== true) {
      throw new HarnessError(
        'runtime-concurrency-state-remained',
        'Disposable runtime-concurrency state remained before fallback cleanup.',
      );
    }
    await stopApp();
    await waitForNoProcess(getProcessIdentity, timing);
    processStopped = true;
    const finalMarkers = extractRuntimeConcurrencyMarkers(await readLogs(), [processIdentity.pid]);
    if (finalMarkers.length !== 1 || JSON.stringify(finalMarkers[0]) !== JSON.stringify(result)) {
      throw new HarnessError(
        'runtime-concurrency-result-changed',
        'The sealed runtime-concurrency log did not retain exactly one matching result.',
      );
    }
    return {
      result,
      hostChecks: { processAlive: true, processStopped: true, privateStateClean: true },
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let finalizationError;
    if (!processStopped) {
      try {
        await stopApp();
      } catch (error) {
        finalizationError = error;
      }
    }
    try {
      await resetTestState();
    } catch (error) {
      finalizationError ??= error;
    }
    if (!primaryError && finalizationError) throw finalizationError;
  }
}

export function buildPrivacySafeArtifact(outcome, target, recordedAt = new Date()) {
  const ready = validateRelaunchMarker(outcome.ready);
  const final = outcome.final ? validateRelaunchMarker(outcome.final) : undefined;
  if (
    ready.phase !== 'prepare' ||
    (final ? ready.status !== 'ready' || final.phase === 'prepare' : ready.status !== 'fail')
  ) {
    throw new HarnessError(
      'invalid-relaunch-artifact',
      'Artifact input is not an exact terminal relaunch sequence.',
    );
  }
  assertPlainObject(outcome.hostChecks, 'Host checks');
  assertExactKeys(
    outcome.hostChecks,
    ['processAAlive', 'processStopped', 'processChanged'],
    'Host checks',
  );
  const hostChecks = Object.fromEntries(
    ['processAAlive', 'processStopped', 'processChanged'].map((name) => {
      if (typeof outcome.hostChecks[name] !== 'boolean') {
        throw new HarnessError('invalid-relaunch-artifact', `Host check ${name} must be boolean.`);
      }
      return [name, outcome.hostChecks[name]];
    }),
  );
  const expectedHostSuccess = Boolean(final);
  if (Object.values(hostChecks).every(Boolean) !== expectedHostSuccess) {
    throw new HarnessError(
      'invalid-relaunch-artifact',
      'Host checks do not agree with the observed relaunch sequence.',
    );
  }
  const safeTarget = parseTargetMetadata({
    packageDump: `versionCode=${String(target.versionCode)}\nversionName=${target.versionName}`,
    androidApi: target.androidApi,
    abi: target.abi,
  });
  const terminal = final ?? ready;
  return {
    schema: RELAUNCH_SCHEMA,
    suite: RELAUNCH_SUITE,
    recordedAt: recordedAt.toISOString(),
    package: APP_PACKAGE,
    target: safeTarget,
    status: terminal.status,
    phase: terminal.phase,
    readyChecks: ready.checks,
    ...(final
      ? {
          migrationCount: final.migrationCount,
          migrationHead: final.migrationHead,
          finalChecks: final.checks,
        }
      : {}),
    hostChecks,
    ...(terminal.status === 'fail' ? { failureCode: terminal.failureCode } : {}),
  };
}

export function buildWalWriteDeathPrivacySafeArtifact(outcome, target, recordedAt = new Date()) {
  const ready = validateWalWriteDeathMarker(outcome.ready);
  const final = outcome.final ? validateWalWriteDeathMarker(outcome.final) : undefined;
  if (
    ready.phase !== 'prepare' ||
    (final ? ready.status !== 'ready' || final.phase === 'prepare' : ready.status !== 'fail')
  ) {
    throw new HarnessError(
      'invalid-wal-write-death-artifact',
      'Artifact input is not an exact terminal active-WAL sequence.',
    );
  }
  assertPlainObject(outcome.hostChecks, 'Active-WAL host checks');
  assertExactKeys(outcome.hostChecks, WAL_WRITE_DEATH_HOST_CHECKS, 'Active-WAL host checks');
  const hostChecks = Object.fromEntries(
    WAL_WRITE_DEATH_HOST_CHECKS.map((name) => {
      if (typeof outcome.hostChecks[name] !== 'boolean') {
        throw new HarnessError(
          'invalid-wal-write-death-artifact',
          `Active-WAL host check ${name} must be boolean.`,
        );
      }
      return [name, outcome.hostChecks[name]];
    }),
  );
  const expectedHostChecks = final
    ? Object.fromEntries(WAL_WRITE_DEATH_HOST_CHECKS.map((name) => [name, true]))
    : {
        processAAlive: true,
        walGrew: false,
        processCrashed: false,
        processChanged: false,
        privateStateClean: false,
      };
  if (WAL_WRITE_DEATH_HOST_CHECKS.some((name) => hostChecks[name] !== expectedHostChecks[name])) {
    throw new HarnessError(
      'invalid-wal-write-death-artifact',
      'Active-WAL host checks do not agree with the observed process-death sequence.',
    );
  }
  const safeTarget = parseTargetMetadata({
    packageDump: `versionCode=${String(target.versionCode)}\nversionName=${target.versionName}`,
    androidApi: target.androidApi,
    abi: target.abi,
  });
  const terminal = final ?? ready;
  return {
    schema: WAL_WRITE_DEATH_SCHEMA,
    suite: WAL_WRITE_DEATH_SUITE,
    recordedAt: recordedAt.toISOString(),
    package: APP_PACKAGE,
    target: safeTarget,
    status: terminal.status,
    phase: terminal.phase,
    readyChecks: ready.checks,
    ...(final ? { finalChecks: final.checks } : {}),
    hostChecks,
    ...(terminal.status === 'fail' ? { failureCode: terminal.failureCode } : {}),
  };
}

export function buildActiveMigrationDeathPrivacySafeArtifact(
  outcome,
  target,
  recordedAt = new Date(),
) {
  const ready = validateActiveMigrationDeathMarker(outcome.ready);
  const final = outcome.final ? validateActiveMigrationDeathMarker(outcome.final) : undefined;
  if (
    ready.phase !== 'prepare' ||
    (final ? ready.status !== 'ready' || final.phase === 'prepare' : ready.status !== 'fail')
  ) {
    throw new HarnessError(
      'invalid-active-migration-death-artifact',
      'Artifact input is not an exact terminal active-migration sequence.',
    );
  }
  assertPlainObject(outcome.hostChecks, 'Active-migration host checks');
  assertExactKeys(
    outcome.hostChecks,
    ACTIVE_MIGRATION_DEATH_HOST_CHECKS,
    'Active-migration host checks',
  );
  const hostChecks = Object.fromEntries(
    ACTIVE_MIGRATION_DEATH_HOST_CHECKS.map((name) => {
      if (typeof outcome.hostChecks[name] !== 'boolean') {
        throw new HarnessError(
          'invalid-active-migration-death-artifact',
          `Active-migration host check ${name} must be boolean.`,
        );
      }
      return [name, outcome.hostChecks[name]];
    }),
  );
  const expectedHostChecks = final
    ? Object.fromEntries(ACTIVE_MIGRATION_DEATH_HOST_CHECKS.map((name) => [name, true]))
    : {
        processAAlive: true,
        walGrewBeforeCrash: false,
        processCrashed: false,
        walPresentAfterCrash: false,
        processChanged: false,
        privateStateClean: false,
      };
  if (
    ACTIVE_MIGRATION_DEATH_HOST_CHECKS.some((name) => hostChecks[name] !== expectedHostChecks[name])
  ) {
    throw new HarnessError(
      'invalid-active-migration-death-artifact',
      'Active-migration host checks do not agree with the observed process-death sequence.',
    );
  }
  const safeTarget = parseTargetMetadata({
    packageDump: `versionCode=${String(target.versionCode)}\nversionName=${target.versionName}`,
    androidApi: target.androidApi,
    abi: target.abi,
  });
  const terminal = final ?? ready;
  return {
    schema: ACTIVE_MIGRATION_DEATH_SCHEMA,
    suite: ACTIVE_MIGRATION_DEATH_SUITE,
    recordedAt: recordedAt.toISOString(),
    package: APP_PACKAGE,
    target: safeTarget,
    status: terminal.status,
    phase: terminal.phase,
    readyChecks: ready.checks,
    ...(final
      ? {
          migrationCount: final.migrationCount,
          migrationHead: final.migrationHead,
          finalChecks: final.checks,
        }
      : {}),
    hostChecks,
    ...(terminal.status === 'fail' ? { failureCode: terminal.failureCode } : {}),
  };
}

export function buildRuntimeConcurrencyPrivacySafeArtifact(
  outcome,
  target,
  recordedAt = new Date(),
) {
  const result = validateRuntimeConcurrencyMarker(outcome.result);
  assertRuntimeConcurrencyPlainObject(
    outcome.hostChecks,
    'Runtime-concurrency host checks',
    'invalid-runtime-concurrency-artifact',
  );
  assertRuntimeConcurrencyExactKeys(
    outcome.hostChecks,
    RUNTIME_CONCURRENCY_HOST_CHECKS,
    'Runtime-concurrency host checks',
    'invalid-runtime-concurrency-artifact',
  );
  const hostChecks = Object.fromEntries(
    RUNTIME_CONCURRENCY_HOST_CHECKS.map((name) => {
      if (typeof outcome.hostChecks[name] !== 'boolean') {
        throw new HarnessError(
          'invalid-runtime-concurrency-artifact',
          `Runtime-concurrency host check ${name} must be boolean.`,
        );
      }
      return [name, outcome.hostChecks[name]];
    }),
  );
  if (RUNTIME_CONCURRENCY_HOST_CHECKS.some((name) => hostChecks[name] !== true)) {
    throw new HarnessError(
      'invalid-runtime-concurrency-artifact',
      'Runtime-concurrency host checks do not prove the terminal one-launch sequence.',
    );
  }
  const safeTarget = parseTargetMetadata({
    packageDump: `versionCode=${String(target.versionCode)}\nversionName=${target.versionName}`,
    androidApi: target.androidApi,
    abi: target.abi,
  });
  return {
    schema: RUNTIME_CONCURRENCY_SCHEMA,
    suite: RUNTIME_CONCURRENCY_SUITE,
    recordedAt: recordedAt.toISOString(),
    package: APP_PACKAGE,
    target: safeTarget,
    status: result.status,
    migrationCount: result.migrationCount,
    migrationHead: result.migrationHead,
    checks: result.checks,
    hostChecks,
    ...(result.status === 'fail' ? { failureCode: result.failureCode } : {}),
  };
}

function reportPath(recordedAt) {
  const stamp = recordedAt.toISOString().replace(/[:.]/g, '-');
  return resolve(REPORT_DIR, `android-db-relaunch-${stamp}.json`);
}

function writeArtifact(outcome, target, recordedAt = new Date()) {
  const artifact = buildPrivacySafeArtifact(outcome, target, recordedAt);
  const path = reportPath(recordedAt);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return path;
}

function walWriteDeathReportPath(recordedAt) {
  const stamp = recordedAt.toISOString().replace(/[:.]/g, '-');
  return resolve(WAL_WRITE_DEATH_REPORT_DIR, `android-db-wal-write-death-${stamp}.json`);
}

function writeWalWriteDeathArtifact(outcome, target, recordedAt = new Date()) {
  const artifact = buildWalWriteDeathPrivacySafeArtifact(outcome, target, recordedAt);
  const path = walWriteDeathReportPath(recordedAt);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  return path;
}

function activeMigrationDeathReportPath(recordedAt) {
  const stamp = recordedAt.toISOString().replace(/[:.]/g, '-');
  return resolve(
    ACTIVE_MIGRATION_DEATH_REPORT_DIR,
    `android-db-active-migration-death-${stamp}.json`,
  );
}

function writeActiveMigrationDeathArtifact(outcome, target, recordedAt = new Date()) {
  const artifact = buildActiveMigrationDeathPrivacySafeArtifact(outcome, target, recordedAt);
  const path = activeMigrationDeathReportPath(recordedAt);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  return path;
}

function checkMetro(timeoutMs = 3_000) {
  return new Promise((resolveCheck, rejectCheck) => {
    const request = get(METRO_STATUS_URL, (response) => {
      response.setEncoding('utf8');
      let body = '';
      response.on('data', (chunk) => {
        body = `${body}${chunk}`.slice(0, 256);
      });
      response.on('end', () => {
        if (response.statusCode === 200 && body.trim() === 'packager-status:running') {
          resolveCheck();
          return;
        }
        rejectCheck(
          new HarnessError(
            'metro-unavailable',
            'Metro did not return packager-status:running on 127.0.0.1:8081.',
          ),
        );
      });
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(
        new HarnessError('metro-unavailable', 'Metro did not respond on 127.0.0.1:8081.'),
      );
    });
    request.on('error', (error) => {
      rejectCheck(
        error instanceof HarnessError
          ? error
          : new HarnessError(
              'metro-unavailable',
              'Metro is not running on 127.0.0.1:8081; start it with npm start -- --dev-client.',
            ),
      );
    });
  });
}

function currentProcessIdentity(serial) {
  const pid = parseSingleProcessPid(
    runAdb(serial, ['shell', 'pidof', APP_PACKAGE], {
      code: 'process-lookup-failed',
      label: 'Gator process lookup',
      allowMissingProcess: true,
    }),
  );
  if (pid === undefined) return undefined;
  let startTicks;
  try {
    const stat = runAdb(serial, ['shell', 'run-as', APP_PACKAGE, 'cat', `/proc/${pid}/stat`], {
      code: 'process-stat-failed',
      label: 'Gator process identity check',
    });
    startTicks = parseProcessStartTicks(stat);
  } catch {
    // Android may restrict /proc even to the same UID. The exact PID transition remains required.
  }
  return { pid, ...(startTicks ? { startTicks } : {}) };
}

function launchApp(serial) {
  runAdb(serial, LAUNCH_APP_ADB_ARGS, {
    code: 'app-launch-failed',
    label: 'Gator DEV launch',
    timeoutMs: LAUNCH_TIMEOUT_MS,
  });
}

function stopApp(serial) {
  runAdb(serial, ['shell', 'am', 'force-stop', APP_PACKAGE], {
    code: 'app-stop-failed',
    label: 'Gator force-stop',
  });
}

function crashApp(serial, pid) {
  runAdb(serial, createCrashAppAdbArgs(pid), {
    code: 'app-crash-failed',
    label: 'Exact Gator process crash',
  });
}

function proveWalFileGrew(
  serial,
  adbArgs = READ_WAL_WRITE_DEATH_SIZE_ADB_ARGS,
  label = 'Active-WAL growth check',
) {
  const sizeText = runAdb(serial, adbArgs, {
    code: 'wal-size-probe-failed',
    label,
  });
  return walFileGrewBeyondHeader(sizeText);
}

function privateTestFileAbsent(serial, path) {
  const result = spawnSync('adb', ['-s', serial, ...createPrivateFileAbsenceAdbArgs(path)], {
    encoding: 'utf8',
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    timeout: COMMAND_TIMEOUT_MS,
  });
  if (result.error) {
    const detail = compactToolOutput(result.error.message, serial);
    throw new HarnessError(
      'private-state-probe-failed',
      `Private-state absence probe failed${detail ? `: ${detail}` : ''}`,
    );
  }
  if (result.status === 0) return true;
  if (
    result.status === 1 &&
    !String(result.stdout ?? '').trim() &&
    !String(result.stderr ?? '').trim()
  ) {
    return false;
  }
  const detail = compactToolOutput(result.stderr || result.stdout, serial);
  throw new HarnessError(
    'private-state-probe-failed',
    `Private-state absence probe failed with exit ${String(result.status)}${
      detail ? `: ${detail}` : ''
    }`,
  );
}

function privateTestStateClean(serial, files) {
  let clean = true;
  for (const path of files) {
    if (!privateTestFileAbsent(serial, path)) clean = false;
  }
  return clean;
}

function resetTestState(serial) {
  stopApp(serial);
  runAdb(serial, CLEANUP_RELAUNCH_STATE_ADB_ARGS, {
    code: 'test-cleanup-failed',
    label: 'DB relaunch private-state cleanup',
  });
  if (!privateTestStateClean(serial, RELAUNCH_PRIVATE_TEST_FILES)) {
    throw new HarnessError(
      'test-cleanup-unconfirmed',
      'Fixed disposable DB relaunch state remained after exact fallback cleanup.',
    );
  }
}

export async function runAndroidDbRelaunch() {
  runCommand('adb', ['version'], { code: 'adb-unavailable', label: 'adb' });
  const deviceOutput = runCommand('adb', ['devices'], {
    code: 'adb-devices-failed',
    label: 'adb devices',
  });
  const serial = selectAdbDevice(parseAdbDevices(deviceOutput), process.env.ANDROID_SERIAL);
  const installedPath = runAdb(serial, ['shell', 'pm', 'path', APP_PACKAGE], {
    code: 'app-not-installed',
    label: 'Installed Gator package check',
  });
  if (!installedPath.startsWith('package:')) {
    throw new HarnessError('app-not-installed', 'The Gator Android package is not installed.');
  }
  const target = parseTargetMetadata({
    packageDump: runAdb(serial, ['shell', 'dumpsys', 'package', APP_PACKAGE], {
      code: 'target-metadata-unavailable',
      label: 'Installed Gator version check',
    }),
    androidApi: runAdb(serial, ['shell', 'getprop', 'ro.build.version.sdk'], {
      code: 'target-metadata-unavailable',
      label: 'Android API check',
    }),
    abi: runAdb(serial, ['shell', 'getprop', 'ro.product.cpu.abi'], {
      code: 'target-metadata-unavailable',
      label: 'Android ABI check',
    }),
  });
  runAdb(serial, ['shell', 'run-as', APP_PACKAGE, 'true'], {
    code: 'app-not-debuggable',
    label: 'Debuggable Gator package check',
  });
  await checkMetro();
  runAdb(serial, ['reverse', 'tcp:8081', 'tcp:8081'], {
    code: 'adb-reverse-failed',
    label: 'adb reverse for Metro',
  });

  const logBoundary = `${LOGCAT_BOUNDARY_PREFIX}${randomUUID()}`;
  runAdb(serial, ['shell', 'log', '-p', 'i', '-t', 'GatorDbHarness', logBoundary], {
    code: 'log-boundary-failed',
    label: 'DB relaunch log boundary',
  });
  const outcome = await executeRelaunchSequence({
    resetTestState: () => resetTestState(serial),
    createRequest: () =>
      runAdb(serial, CREATE_RELAUNCH_REQUEST_ADB_ARGS, {
        code: 'request-create-failed',
        label: 'DB relaunch request creation',
      }),
    launchApp: () => launchApp(serial),
    stopApp: () => stopApp(serial),
    readLogs: () =>
      logsAfterRelaunchBoundary(
        runAdb(
          serial,
          ['logcat', '-d', '-v', 'threadtime', 'GatorDbHarness:I', 'ReactNativeJS:I', '*:S'],
          { code: 'logcat-read-failed', label: 'filtered Gator logcat' },
        ),
        logBoundary,
      ),
    getProcessIdentity: () => currentProcessIdentity(serial),
  });

  const path = writeArtifact(outcome, target);
  const terminal = outcome.final ?? outcome.ready;
  if (terminal.status !== 'pass') {
    throw new HarnessError(
      'relaunch-contract-failed',
      `Android DB relaunch contract failed [${terminal.failureCode}]. Safe artifact: ${path}`,
    );
  }
  return { path, outcome };
}

export async function runAndroidDbWalWriteDeath() {
  runCommand('adb', ['version'], { code: 'adb-unavailable', label: 'adb' });
  const deviceOutput = runCommand('adb', ['devices'], {
    code: 'adb-devices-failed',
    label: 'adb devices',
  });
  const serial = selectAdbDevice(parseAdbDevices(deviceOutput), process.env.ANDROID_SERIAL);
  const installedPath = runAdb(serial, ['shell', 'pm', 'path', APP_PACKAGE], {
    code: 'app-not-installed',
    label: 'Installed Gator package check',
  });
  if (!installedPath.startsWith('package:')) {
    throw new HarnessError('app-not-installed', 'The Gator Android package is not installed.');
  }
  const target = parseTargetMetadata({
    packageDump: runAdb(serial, ['shell', 'dumpsys', 'package', APP_PACKAGE], {
      code: 'target-metadata-unavailable',
      label: 'Installed Gator version check',
    }),
    androidApi: runAdb(serial, ['shell', 'getprop', 'ro.build.version.sdk'], {
      code: 'target-metadata-unavailable',
      label: 'Android API check',
    }),
    abi: runAdb(serial, ['shell', 'getprop', 'ro.product.cpu.abi'], {
      code: 'target-metadata-unavailable',
      label: 'Android ABI check',
    }),
  });
  runAdb(serial, ['shell', 'run-as', APP_PACKAGE, 'true'], {
    code: 'app-not-debuggable',
    label: 'Debuggable Gator package check',
  });
  await checkMetro();
  runAdb(serial, ['reverse', 'tcp:8081', 'tcp:8081'], {
    code: 'adb-reverse-failed',
    label: 'adb reverse for Metro',
  });

  const logBoundary = `${LOGCAT_BOUNDARY_PREFIX}${randomUUID()}`;
  runAdb(serial, ['shell', 'log', '-p', 'i', '-t', 'GatorDbHarness', logBoundary], {
    code: 'log-boundary-failed',
    label: 'Active-WAL log boundary',
  });
  const outcome = await executeWalWriteDeathSequence({
    resetTestState: () => resetTestState(serial),
    createRequest: () =>
      runAdb(serial, CREATE_WAL_WRITE_DEATH_REQUEST_ADB_ARGS, {
        code: 'request-create-failed',
        label: 'Active-WAL request creation',
      }),
    launchApp: () => launchApp(serial),
    crashApp: (pid) => crashApp(serial, pid),
    proveWalGrew: () => proveWalFileGrew(serial),
    verifyPrivateStateClean: () =>
      privateTestStateClean(serial, WAL_WRITE_DEATH_PRIVATE_TEST_FILES),
    readLogs: () =>
      logsAfterRelaunchBoundary(
        runAdb(
          serial,
          ['logcat', '-d', '-v', 'threadtime', 'GatorDbHarness:I', 'ReactNativeJS:I', '*:S'],
          { code: 'logcat-read-failed', label: 'filtered Gator logcat' },
        ),
        logBoundary,
      ),
    getProcessIdentity: () => currentProcessIdentity(serial),
  });

  const path = writeWalWriteDeathArtifact(outcome, target);
  const terminal = outcome.final ?? outcome.ready;
  if (terminal.status !== 'pass') {
    throw new HarnessError(
      'wal-write-death-contract-failed',
      `Android active-WAL write-death contract failed [${terminal.failureCode}]. Safe artifact: ${path}`,
    );
  }
  return { path, outcome };
}

export async function runAndroidDbActiveMigrationDeath() {
  runCommand('adb', ['version'], { code: 'adb-unavailable', label: 'adb' });
  const deviceOutput = runCommand('adb', ['devices'], {
    code: 'adb-devices-failed',
    label: 'adb devices',
  });
  const serial = selectAdbDevice(parseAdbDevices(deviceOutput), process.env.ANDROID_SERIAL);
  const installedPath = runAdb(serial, ['shell', 'pm', 'path', APP_PACKAGE], {
    code: 'app-not-installed',
    label: 'Installed Gator package check',
  });
  if (!installedPath.startsWith('package:')) {
    throw new HarnessError('app-not-installed', 'The Gator Android package is not installed.');
  }
  const target = parseTargetMetadata({
    packageDump: runAdb(serial, ['shell', 'dumpsys', 'package', APP_PACKAGE], {
      code: 'target-metadata-unavailable',
      label: 'Installed Gator version check',
    }),
    androidApi: runAdb(serial, ['shell', 'getprop', 'ro.build.version.sdk'], {
      code: 'target-metadata-unavailable',
      label: 'Android API check',
    }),
    abi: runAdb(serial, ['shell', 'getprop', 'ro.product.cpu.abi'], {
      code: 'target-metadata-unavailable',
      label: 'Android ABI check',
    }),
  });
  runAdb(serial, ['shell', 'run-as', APP_PACKAGE, 'true'], {
    code: 'app-not-debuggable',
    label: 'Debuggable Gator package check',
  });
  await checkMetro();
  runAdb(serial, ['reverse', 'tcp:8081', 'tcp:8081'], {
    code: 'adb-reverse-failed',
    label: 'adb reverse for Metro',
  });

  const logBoundary = `${LOGCAT_BOUNDARY_PREFIX}${randomUUID()}`;
  runAdb(serial, ['shell', 'log', '-p', 'i', '-t', 'GatorDbHarness', logBoundary], {
    code: 'log-boundary-failed',
    label: 'Active-migration log boundary',
  });
  const proveActiveMigrationWal = () =>
    proveWalFileGrew(
      serial,
      READ_ACTIVE_MIGRATION_DEATH_WAL_SIZE_ADB_ARGS,
      'Active-migration WAL growth check',
    );
  const outcome = await executeActiveMigrationDeathSequence({
    resetTestState: () => resetTestState(serial),
    createRequest: () =>
      runAdb(serial, CREATE_ACTIVE_MIGRATION_DEATH_REQUEST_ADB_ARGS, {
        code: 'request-create-failed',
        label: 'Active-migration request creation',
      }),
    launchApp: () => launchApp(serial),
    crashApp: (pid) => crashApp(serial, pid),
    proveWalGrewBeforeCrash: proveActiveMigrationWal,
    proveWalPresentAfterCrash: proveActiveMigrationWal,
    verifyPrivateStateClean: () =>
      privateTestStateClean(serial, ACTIVE_MIGRATION_DEATH_PRIVATE_TEST_FILES),
    readLogs: () =>
      logsAfterRelaunchBoundary(
        runAdb(
          serial,
          ['logcat', '-d', '-v', 'threadtime', 'GatorDbHarness:I', 'ReactNativeJS:I', '*:S'],
          { code: 'logcat-read-failed', label: 'filtered Gator logcat' },
        ),
        logBoundary,
      ),
    getProcessIdentity: () => currentProcessIdentity(serial),
  });

  const path = writeActiveMigrationDeathArtifact(outcome, target);
  const terminal = outcome.final ?? outcome.ready;
  if (terminal.status !== 'pass') {
    throw new HarnessError(
      'active-migration-death-contract-failed',
      `Android active-migration death contract failed [${terminal.failureCode}]. Safe artifact: ${path}`,
    );
  }
  return { path, outcome };
}

export async function main(args = process.argv.slice(2)) {
  const mode = args[0];
  if (
    args.length > 1 ||
    (mode !== undefined &&
      mode !== '--active-wal-write-death' &&
      mode !== '--active-migration-death')
  ) {
    throw new HarnessError(
      'invalid-harness-arguments',
      'Use no argument for migration relaunch, --active-wal-write-death for active WAL, or --active-migration-death for active migration.',
    );
  }
  let path;
  let label;
  if (mode === '--active-wal-write-death') {
    ({ path } = await runAndroidDbWalWriteDeath());
    label = 'Android active-WAL write-death';
  } else if (mode === '--active-migration-death') {
    ({ path } = await runAndroidDbActiveMigrationDeath());
    label = 'Android active-migration death';
  } else {
    ({ path } = await runAndroidDbRelaunch());
    label = 'Android DB relaunch';
  }
  process.stdout.write(`${label} PASS\nSafe artifact: ${path}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const code = error instanceof HarnessError ? error.code : 'unexpected-harness-error';
    const message = error instanceof Error ? error.message : 'Unknown harness failure.';
    process.stderr.write(`Android DB relaunch harness failed [${code}]: ${message}\n`);
    process.exitCode = 1;
  });
}
