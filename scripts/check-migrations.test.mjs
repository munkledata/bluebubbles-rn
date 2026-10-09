import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUDITED_BASELINE_HEAD,
  extractMigrationNames,
  validateMigrationState,
} from './check-migrations.mjs';

const baseline = Array.from({ length: 29 }, (_, index) => {
  const number = index + 1;
  return number === 29
    ? AUDITED_BASELINE_HEAD
    : `${String(number).padStart(4, '0')}_migration_${number}`;
});
const registry = {
  baselineHead: AUDITED_BASELINE_HEAD,
  shippedHead: AUDITED_BASELINE_HEAD,
  allocations: [],
};

test('extracts migration names and accepts the recorded baseline', () => {
  assert.deepEqual(extractMigrationNames("[{ name: '0001_init' }, { name: '0002_add_chat' }]"), [
    '0001_init',
    '0002_add_chat',
  ]);
  assert.deepEqual(validateMigrationState({ names: baseline, registry }), []);
});

test('rejects a gap or duplicate migration name', () => {
  const invalidNames = [...baseline];
  invalidNames[1] = invalidNames[2];
  const errors = validateMigrationState({
    names: invalidNames,
    registry,
  });
  assert.ok(errors.some((error) => error.includes('unique')));
  assert.ok(errors.some((error) => error.includes('out of sequence')));
});

test('rejects a distant allocation that has no matching migration', () => {
  const errors = validateMigrationState({
    names: baseline,
    registry: {
      ...registry,
      allocations: [
        {
          number: 30,
          name: '0030_reserved',
          task: 'TASK-1',
          branchPr: 'feature/task-1',
          status: 'prepared',
          upgradeTest: 'test/db/migrations/0030_reserved.test.ts',
          schemaEvidence: 'N/A: no schema mirror',
          cacheWipeEvidence: 'N/A: no persistent rows',
        },
      ],
    },
  });
  assert.ok(errors.some((error) => error.includes('distant reservations are forbidden')));
});

test('requires allocation and review evidence for every post-baseline migration', () => {
  const unregistered = validateMigrationState({
    names: [...baseline, '0030_new_table'],
    registry,
  });
  assert.ok(unregistered.some((error) => error.includes('no merge-time allocation')));

  const registered = validateMigrationState({
    names: [...baseline, '0030_new_table'],
    registry: {
      ...registry,
      allocations: [
        {
          number: 30,
          name: '0030_new_table',
          task: 'TASK-1',
          branchPr: 'feature/task-1',
          status: 'prepared',
          upgradeTest: 'test/db/migrations/0030_new_table.test.ts',
          schemaEvidence: 'src/db/schema.ts',
          cacheWipeEvidence: 'test/db/clearLocalCache.test.ts',
        },
      ],
    },
    evidenceExists: () => true,
  });
  assert.deepEqual(registered, []);
});

test('cannot bless an unreviewed migration by advancing the registry baseline', () => {
  const unreviewedName = '0030_unreviewed';
  const errors = validateMigrationState({
    names: [...baseline, unreviewedName],
    registry: { baselineHead: unreviewedName, allocations: [] },
  });

  assert.ok(errors.some((error) => error.includes('audited immutable baseline')));
  assert.ok(errors.some((error) => error.includes('no merge-time allocation')));
});

test('requires shippedHead to name a migration at or after the audited baseline', () => {
  for (const shippedHead of [undefined, '0028_migration_28', '0031_not_written']) {
    const errors = validateMigrationState({
      names: baseline,
      registry: { ...registry, shippedHead },
    });
    assert.ok(
      errors.some((error) => error.includes('shippedHead must name a migration')),
      `shippedHead ${String(shippedHead)} must be rejected`,
    );
  }
});

test('freezes shipped migrations with a recorded SQL fingerprint', () => {
  const allocation = {
    number: 30,
    name: '0030_new_table',
    task: 'TASK-1',
    branchPr: 'feature/task-1',
    status: 'prepared',
    upgradeTest: 'test/db/migrations/0030_new_table.test.ts',
    schemaEvidence: 'src/db/schema.ts',
    cacheWipeEvidence: 'test/db/clearLocalCache.test.ts',
  };
  const check = (shippedHead, extra = {}) =>
    validateMigrationState({
      names: [...baseline, '0030_new_table'],
      registry: { ...registry, shippedHead, allocations: [{ ...allocation, ...extra }] },
      evidenceExists: () => true,
    });

  // Not shipped yet: no fingerprint is needed while the migration is still being written.
  assert.deepEqual(check(AUDITED_BASELINE_HEAD), []);
  // Shipped: the fingerprint is mandatory and must be well formed.
  assert.ok(check('0030_new_table').some((error) => error.includes('must record sqlSha256')));
  assert.ok(
    check('0030_new_table', { sqlSha256: 'ABC' }).some((error) =>
      error.includes('64 lowercase hexadecimal'),
    ),
  );
  assert.deepEqual(check('0030_new_table', { sqlSha256: 'a'.repeat(64) }), []);
});
