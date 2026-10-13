import { readFileSync } from 'node:fs';

/**
 * The newest migration, for Node scripts that cannot import the app's TypeScript. It is read from
 * migration-registry.json, which test/db/migrationHead.test.ts ties to src/db/migrationHead.ts and
 * MIGRATIONS, so adding a migration needs no edits here.
 */
const registry = JSON.parse(
  readFileSync(new URL('./migration-registry.json', import.meta.url), 'utf8'),
);
const newest = registry.allocations?.at(-1);
if (!newest || !Number.isSafeInteger(newest.number) || typeof newest.name !== 'string') {
  throw new Error('scripts/migration-registry.json has no newest migration allocation.');
}

export const MIGRATION_COUNT = newest.number;
export const MIGRATION_HEAD = newest.name;
