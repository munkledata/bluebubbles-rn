import { runMigrations, type SqlRunner } from '@db/migrate';
import { createTestDb } from '../support/testDb';

describe('migration 0002 (edit/unsend + url previews)', () => {
  it('adds date_retracted to messages and the url_previews table', async () => {
    const { raw } = await createTestDb();
    const cols = (raw.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    expect(cols).toContain('date_retracted');
    const tables = (
      raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(tables).toContain('url_previews');
  });

  it('is idempotent — re-running applies nothing', async () => {
    const { raw } = await createTestDb();
    const runner: SqlRunner = {
      async exec(sql, params) {
        raw.prepare(sql).run(...((params as unknown[]) ?? []));
      },
      async query(sql, params) {
        return raw.prepare(sql).all(...((params as unknown[]) ?? [])) as never[];
      },
    };
    const ran = await runMigrations(runner);
    expect(ran).toEqual([]);
  });
});
