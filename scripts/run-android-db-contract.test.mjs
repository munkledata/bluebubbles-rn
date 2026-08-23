import assert from 'node:assert/strict';
import test from 'node:test';

import {
  APP_PACKAGE,
  buildPrivacySafeArtifact,
  CONTRACT_CHECKS,
  CONTRACT_FAILURE_CODES,
  CONTRACT_MARKER_PREFIX,
  CONTRACT_MIGRATION_COUNT,
  CONTRACT_MIGRATION_HEAD,
  CONTRACT_SCHEMA,
  extractContractResult,
  HarnessError,
  logsAfterBoundary,
  parseAdbDevices,
  parseTargetMetadata,
  selectAdbDevice,
  validateContractResult,
  waitForContractResult,
} from './run-android-db-contract.mjs';

function checks(overrides = {}) {
  return Object.fromEntries(CONTRACT_CHECKS.map((name) => [name, overrides[name] ?? true]));
}

function result(overrides = {}) {
  return {
    schema: CONTRACT_SCHEMA,
    suite: 'android-db-contract',
    status: 'pass',
    migrationCount: CONTRACT_MIGRATION_COUNT,
    migrationHead: CONTRACT_MIGRATION_HEAD,
    checks: checks(),
    ...overrides,
  };
}

function failedResult(overrides = {}) {
  return result({
    status: 'fail',
    checks: checks({ rollback: false }),
    failureCode: 'rollback',
    ...overrides,
  });
}

function marker(value = result()) {
  return `${CONTRACT_MARKER_PREFIX}${JSON.stringify(value)}`;
}

const target = {
  versionName: '0.1.40',
  versionCode: 52,
  androidApi: 35,
  abi: 'arm64-v8a',
};

test('parses adb device state without requiring adb', () => {
  assert.deepEqual(
    parseAdbDevices(
      'List of devices attached\nemulator-5554\tdevice product:sdk\nprivate-serial\tunauthorized\n',
    ),
    [
      { serial: 'emulator-5554', state: 'device' },
      { serial: 'private-serial', state: 'unauthorized' },
    ],
  );
  assert.equal(
    selectAdbDevice(
      [
        { serial: 'ready', state: 'device' },
        { serial: 'offline', state: 'offline' },
      ],
      undefined,
    ),
    'ready',
  );
});

test('requires ANDROID_SERIAL when more than one ready device exists', () => {
  const devices = [
    { serial: 'one', state: 'device' },
    { serial: 'two', state: 'device' },
  ];
  assert.throws(
    () => selectAdbDevice(devices, undefined),
    (error) => error instanceof HarnessError && error.code === 'multiple-ready-devices',
  );
  assert.equal(selectAdbDevice(devices, 'two'), 'two');
});

test('extracts only allowlisted target metadata from Android output', () => {
  assert.deepEqual(
    parseTargetMetadata({
      packageDump:
        'Packages:\n  Package [private]:\n    userId=12345\n    versionCode=52 minSdk=24\n    versionName=0.1.40\n    dataDir=/private/path',
      androidApi: '35\n',
      abi: 'arm64-v8a\n',
    }),
    target,
  );
  assert.throws(
    () =>
      parseTargetMetadata({ packageDump: 'versionName=private value', androidApi: 35, abi: '' }),
    (error) => error instanceof HarnessError && error.code === 'invalid-target-metadata',
  );
});

test('extracts one finite marker from surrounding logcat text', () => {
  assert.deepEqual(extractContractResult(`unrelated line\n${marker()}\nanother line`), result());
  assert.equal(extractContractResult('unrelated line only'), undefined);
});

test('accepts markers only after the current non-destructive logcat boundary', () => {
  const boundary = 'GATOR_DB_CONTRACT_BOUNDARY_00000000-0000-4000-8000-000000000000';
  const current = logsAfterBoundary(`old ${marker()}\n${boundary}\nnew ${marker()}`, boundary);
  assert.deepEqual(extractContractResult(current), result());
  assert.throws(
    () => logsAfterBoundary(`old ${marker()}`, boundary),
    (error) => error instanceof HarnessError && error.code === 'log-boundary-missing',
  );
});

test('rejects malformed and duplicate markers', () => {
  assert.throws(
    () => extractContractResult(`${CONTRACT_MARKER_PREFIX}{not-json}`),
    (error) => error instanceof HarnessError && error.code === 'invalid-contract-marker',
  );
  assert.throws(
    () => extractContractResult(`${marker()}\n${marker()}`),
    (error) => error instanceof HarnessError && error.code === 'duplicate-contract-marker',
  );
});

test('rejects stale V1 and V2 markers immediately without parsing their payload', () => {
  for (const prefix of ['GATOR_DB_CONTRACT_V1 ', 'GATOR_DB_CONTRACT_V2 ']) {
    const stale = `${prefix}{private-or-malformed-payload}`;
    assert.throws(
      () => extractContractResult(stale),
      (error) => error instanceof HarnessError && error.code === 'stale-contract-marker',
    );
    assert.throws(
      () => extractContractResult(`${stale}\n${marker()}`),
      (error) => error instanceof HarnessError && error.code === 'stale-contract-marker',
    );
  }
});

test('pins the exact top-level and boolean check schema', () => {
  assert.equal(CONTRACT_MARKER_PREFIX, 'GATOR_DB_CONTRACT_V3 ');
  assert.equal(CONTRACT_SCHEMA, 3);
  assert.deepEqual(CONTRACT_CHECKS, [
    'encryptedOpen',
    'wrongKeyRejected',
    'migrationRollback',
    'migrationRetry',
    'migrationLedger',
    'migrationData',
    'fts5',
    'integrity',
    'idempotent',
    'rollback',
    'syncReactive',
    'asyncReactive',
    'rawReactive',
    'rekey',
    'newKeyReopen',
    'oldKeyRejected',
    'historicalProvenance',
    'historical0024',
    'historical0027',
    'historical0029',
    'historicalReadOnly',
    'historicalWrongKeyRejected',
    'historicalData',
    'historicalFts5',
    'historicalIntegrity',
    'historicalIdempotent',
    'historicalCleanup',
    'cleanup',
  ]);
  assert.deepEqual(validateContractResult(result()), result());
  assert.throws(
    () => validateContractResult({ ...result(), error: 'private native details' }),
    /finite contract/,
  );
  assert.throws(
    () => validateContractResult(result({ checks: { ...checks(), encryptedOpen: 'yes' } })),
    /must be boolean/,
  );
  const partial = checks();
  delete partial.rekey;
  assert.throws(() => validateContractResult(result({ checks: partial })), /finite contract/);
  assert.throws(
    () => validateContractResult(failedResult({ failureCode: 'raw native error' })),
    /failureCode is not part of the finite contract/,
  );
  assert.throws(
    () => validateContractResult(result({ migrationCount: 37 })),
    /migration count or head/,
  );
  assert.throws(
    () => validateContractResult(result({ migrationHead: '0037_old_head' })),
    /migration count or head/,
  );
  assert.deepEqual(CONTRACT_FAILURE_CODES, [
    'key-generation',
    'pre-cleanup',
    'encrypted-open',
    'migration-rollback',
    'wrong-key-not-rejected',
    'correct-key-reopen',
    'migration-retry',
    'migration-ledger',
    'migration-data',
    'fts5',
    'integrity',
    'idempotent',
    'rollback',
    'sync-reactive',
    'async-reactive',
    'raw-reactive',
    'rekey',
    'new-key-reopen',
    'old-key-not-rejected',
    'historical-provenance',
    'historical-pre-cleanup',
    'historical-0024-fixture',
    'historical-0024-read-only',
    'historical-0024-wrong-key-not-rejected',
    'historical-0024-migration',
    'historical-0024-data',
    'historical-0024-fts5',
    'historical-0024-integrity',
    'historical-0024-idempotent',
    'historical-0027-fixture',
    'historical-0027-read-only',
    'historical-0027-wrong-key-not-rejected',
    'historical-0027-migration',
    'historical-0027-data',
    'historical-0027-fts5',
    'historical-0027-integrity',
    'historical-0027-idempotent',
    'historical-cleanup',
    'cleanup',
    'internal',
  ]);
});

test('requires status to agree with all check booleans', () => {
  assert.throws(
    () => validateContractResult(result({ checks: checks({ rollback: false }) })),
    (error) => error instanceof HarnessError && error.code === 'inconsistent-contract-marker',
  );
  assert.deepEqual(
    validateContractResult(
      failedResult({ checks: checks({ rollback: false, rawReactive: false }) }),
    ),
    failedResult({ checks: checks({ rollback: false, rawReactive: false }) }),
  );
});

test('failed artifact retains only the finite failure code', () => {
  const artifact = buildPrivacySafeArtifact(
    failedResult({ failureCode: 'raw-reactive' }),
    target,
    new Date('2026-08-19T12:34:56.000Z'),
  );
  assert.equal(artifact.status, 'fail');
  assert.equal(artifact.failureCode, 'raw-reactive');
  assert.equal(Object.hasOwn(artifact, 'error'), false);
});

test('retained artifact is rebuilt from an allowlist and contains no device or raw-log data', () => {
  const artifact = buildPrivacySafeArtifact(result(), target, new Date('2026-08-19T12:34:56.000Z'));
  assert.deepEqual(artifact, {
    schema: CONTRACT_SCHEMA,
    suite: 'android-db-contract',
    recordedAt: '2026-08-19T12:34:56.000Z',
    package: APP_PACKAGE,
    target,
    status: 'pass',
    migrationCount: CONTRACT_MIGRATION_COUNT,
    migrationHead: CONTRACT_MIGRATION_HEAD,
    checks: checks(),
  });
  assert.equal(Object.hasOwn(artifact, 'serial'), false);
  assert.equal(Object.hasOwn(artifact.target, 'serial'), false);
  assert.equal(Object.hasOwn(artifact.target, 'model'), false);
  assert.equal(Object.hasOwn(artifact, 'rawLogcat'), false);
  assert.equal(Object.hasOwn(artifact, 'devicePath'), false);
  assert.equal(Object.hasOwn(artifact, 'encryptionKey'), false);
});

test('bounded result polling succeeds with injected host fakes', async () => {
  let clock = 0;
  let reads = 0;
  const observed = await waitForContractResult({
    timeoutMs: 1_000,
    pollMs: 100,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    readLogs: async () => (++reads === 3 ? marker() : ''),
    isProcessAlive: async () => true,
  });
  assert.deepEqual(observed, result());
  assert.equal(reads, 3);
});

test('bounded result polling reports process exit and timeout without adb', async () => {
  await assert.rejects(
    waitForContractResult({
      timeoutMs: 1_000,
      now: () => 0,
      sleep: async () => {},
      readLogs: async () => '',
      isProcessAlive: async () => false,
    }),
    (error) => error instanceof HarnessError && error.code === 'app-process-exited',
  );

  let clock = 0;
  await assert.rejects(
    waitForContractResult({
      timeoutMs: 200,
      pollMs: 100,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      readLogs: async () => '',
      isProcessAlive: async () => true,
    }),
    (error) => error instanceof HarnessError && error.code === 'contract-result-timeout',
  );
});
