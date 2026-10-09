/**
 * Shipped migrations must never be edited. A phone that already ran a migration has it recorded in
 * `_migrations` and never runs it again, so an edit only reaches fresh installs and quietly makes
 * them differ from upgraded phones. Change the schema with a NEW migration instead.
 *
 * scripts/migration-registry.json records the SHA-256 of each shipped migration's exact
 * { name, statements } (the same digest test/db/dbHistoricalMigrationContract.test.ts uses);
 * `npm run check:migrations` requires one for every migration through `shippedHead`.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MIGRATIONS, type Migration } from '@db/migrations';

interface RegistryAllocation {
  name: string;
  sqlSha256?: string;
}

const registry = JSON.parse(
  readFileSync(path.join(__dirname, '../../scripts/migration-registry.json'), 'utf8'),
) as { shippedHead: string; allocations: RegistryAllocation[] };

function fingerprint(migration: Migration): string {
  return createHash('sha256').update(JSON.stringify(migration), 'utf8').digest('hex');
}

const frozen = registry.allocations.filter(
  (allocation): allocation is Required<RegistryAllocation> => allocation.sqlSha256 !== undefined,
);

describe('shipped migrations are never edited', () => {
  it('fingerprints every registered migration through the shipped head', () => {
    expect(frozen.map((allocation) => allocation.name)).toContain(registry.shippedHead);
  });

  it.each(frozen.map((allocation) => [allocation.name, allocation.sqlSha256]))(
    '%s still matches the SQL that shipped',
    (name, expected) => {
      const migration = MIGRATIONS.find((candidate) => candidate.name === name);
      expect(migration).toBeDefined();
      expect(migration && fingerprint(migration)).toBe(expected);
    },
  );
});
