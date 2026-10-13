import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MIGRATION_COUNT, MIGRATION_HEAD } from '@db/migrationHead';
import { MIGRATIONS } from '@db/migrations';

const registry = JSON.parse(
  readFileSync(path.join(__dirname, '../../scripts/migration-registry.json'), 'utf8'),
) as { allocations: Array<{ number: number; name: string }> };

describe('the pinned migration head', () => {
  it('names the last migration in MIGRATIONS and counts them all', () => {
    expect(MIGRATIONS.at(-1)?.name).toBe(MIGRATION_HEAD);
    expect(MIGRATIONS).toHaveLength(MIGRATION_COUNT);
  });

  it('matches the newest allocation in scripts/migration-registry.json', () => {
    expect(registry.allocations.at(-1)).toMatchObject({
      number: MIGRATION_COUNT,
      name: MIGRATION_HEAD,
    });
  });
});
