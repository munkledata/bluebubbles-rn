#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_SOURCE = 'src/db/migrations.ts';
const DEFAULT_REGISTRY = 'scripts/migration-registry.json';

// This value is deliberately independent of migration-registry.json. Advancing the registry's
// baseline together with an unreviewed migration must not turn that migration into trusted history.
export const AUDITED_BASELINE_HEAD = '0029_chats_deleted_at';
const SHA256_HEX = /^[a-f0-9]{64}$/;

export function extractMigrationNames(source) {
  return [...source.matchAll(/\bname:\s*['"](\d{4}_[a-z0-9_]+)['"]/g)].map((match) => match[1]);
}

function numberOf(name) {
  return Number(name.slice(0, 4));
}

export function validateMigrationState({ names, registry, evidenceExists = () => true }) {
  const errors = [];
  const uniqueNames = new Set(names);
  if (names.length === 0) errors.push('No migrations were found.');
  if (uniqueNames.size !== names.length) errors.push('Migration names must be unique.');

  names.forEach((name, index) => {
    const expected = index + 1;
    const actual = numberOf(name);
    if (actual !== expected) {
      errors.push(
        `Migration ${name} is out of sequence: expected numeric prefix ${String(expected).padStart(4, '0')}.`,
      );
    }
  });

  const baselineHead = registry?.baselineHead;
  const baselineNumber = numberOf(AUDITED_BASELINE_HEAD);
  if (baselineHead !== AUDITED_BASELINE_HEAD) {
    errors.push(
      `Registry baselineHead must remain the audited immutable baseline ${AUDITED_BASELINE_HEAD}; received ${String(baselineHead)}.`,
    );
  }
  if (names[baselineNumber - 1] !== AUDITED_BASELINE_HEAD) {
    errors.push(`Audited baseline ${AUDITED_BASELINE_HEAD} does not match the migration source.`);
  }

  // Shipped migrations are frozen: a phone that already ran one never runs it again, so editing it
  // only makes fresh installs differ from upgraded phones. Every allocation up to shippedHead records
  // the SHA-256 of its exact { name, statements }, and test/db/shippedMigrations.test.ts compares it
  // with the code. Change the schema with a new migration instead.
  const shippedHead = registry?.shippedHead;
  const shippedNumber = typeof shippedHead === 'string' ? numberOf(shippedHead) : Number.NaN;
  if (
    typeof shippedHead !== 'string' ||
    !(shippedNumber >= baselineNumber) ||
    names[shippedNumber - 1] !== shippedHead
  ) {
    errors.push(
      `Registry shippedHead must name a migration at or after ${AUDITED_BASELINE_HEAD}; received ${String(shippedHead)}.`,
    );
  }

  const allocations = Array.isArray(registry?.allocations) ? registry.allocations : [];
  const seenNumbers = new Set();
  const seenAllocationNames = new Set();

  for (const allocation of allocations) {
    const number = allocation?.number;
    const name = allocation?.name;
    if (!Number.isInteger(number) || typeof name !== 'string') {
      errors.push('Every migration allocation needs an integer number and string name.');
      continue;
    }
    if (seenNumbers.has(number)) errors.push(`Allocation number ${number} is duplicated.`);
    if (seenAllocationNames.has(name)) errors.push(`Allocation name ${name} is duplicated.`);
    seenNumbers.add(number);
    seenAllocationNames.add(name);

    if (number <= baselineNumber) {
      errors.push(`Allocation ${name} must be newer than baseline ${AUDITED_BASELINE_HEAD}.`);
    }
    if (names[number - 1] !== name) {
      errors.push(
        `Allocation ${String(number).padStart(4, '0')} ${name} is not present at that position in migrations.ts; distant reservations are forbidden.`,
      );
    }
    if (!allocation.task || !allocation.branchPr) {
      errors.push(`Allocation ${name} must record task and branchPr.`);
    }
    if (!['prepared', 'merged'].includes(allocation.status)) {
      errors.push(`Allocation ${name} status must be prepared or merged.`);
    }
    if (allocation.sqlSha256 !== undefined && !SHA256_HEX.test(allocation.sqlSha256)) {
      errors.push(`Allocation ${name} sqlSha256 must be 64 lowercase hexadecimal characters.`);
    } else if (allocation.sqlSha256 === undefined && number <= shippedNumber) {
      errors.push(
        `Allocation ${name} has shipped (through ${shippedHead}) and must record sqlSha256.`,
      );
    }

    const expectedTest = `test/db/migrations/${name}.test.ts`;
    if (allocation.upgradeTest !== expectedTest) {
      errors.push(`Allocation ${name} must use the name-based upgrade test ${expectedTest}.`);
    }
    for (const field of ['upgradeTest', 'schemaEvidence', 'cacheWipeEvidence']) {
      const evidence = allocation[field];
      if (typeof evidence !== 'string' || !evidence) {
        errors.push(`Allocation ${name} must record ${field}.`);
      } else if (!evidence.startsWith('N/A:') && !evidenceExists(evidence)) {
        errors.push(`Allocation ${name} evidence path does not exist: ${evidence}.`);
      }
    }
  }

  for (const name of names.slice(baselineNumber)) {
    if (!seenAllocationNames.has(name)) {
      errors.push(`Migration ${name} has no merge-time allocation registry entry.`);
    }
  }

  return errors;
}

export function runMigrationCheck({ root = process.cwd(), sourcePath, registryPath } = {}) {
  const migrationsPath = resolve(root, sourcePath ?? DEFAULT_SOURCE);
  const allocationsPath = resolve(root, registryPath ?? DEFAULT_REGISTRY);
  const names = extractMigrationNames(readFileSync(migrationsPath, 'utf8'));
  const registry = JSON.parse(readFileSync(allocationsPath, 'utf8'));
  const errors = validateMigrationState({
    names,
    registry,
    evidenceExists: (path) => existsSync(resolve(root, path)),
  });
  if (errors.length > 0) throw new Error(errors.map((error) => `- ${error}`).join('\n'));
  return { count: names.length, head: names.at(-1), shippedHead: registry.shippedHead };
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  try {
    const result = runMigrationCheck();
    console.log(
      `Migration guard passed: ${result.count} sequential migrations; head ${result.head}; shipped and frozen through ${result.shippedHead}.`,
    );
  } catch (error) {
    console.error(
      `Migration guard failed:\n${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
