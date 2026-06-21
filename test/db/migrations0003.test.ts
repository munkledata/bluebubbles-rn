import { runMigrations, type SqlRunner } from '@db/migrate';
import { createTestDb } from '../support/testDb';

describe('migration 0003 (handle avatar + contact_id)', () => {
  it('adds avatar and contact_id to handles', async () => {
    const { raw } = await createTestDb();
    const cols = (raw.prepare('PRAGMA table_info(handles)').all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    expect(cols).toContain('avatar');
    expect(cols).toContain('contact_id');
  });

  it('is idempotent', async () => {
    const { raw } = await createTestDb();
    const runner: SqlRunner = {
      async exec(sql, params) {
        raw.prepare(sql).run(...((params as unknown[]) ?? []));
      },
      async query(sql, params) {
        return raw.prepare(sql).all(...((params as unknown[]) ?? [])) as never[];
      },
    };
    expect(await runMigrations(runner)).toEqual([]);
  });
});
