import { runMigrations, type SqlRunner } from '@db/migrate';
import { createTestDb } from '../support/testDb';

describe('migrations', () => {
  it('creates all expected tables and the FTS table', async () => {
    const { raw } = await createTestDb();
    const names = raw
      .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name`)
      .all()
      .map((r) => (r as { name: string }).name);

    for (const t of [
      'attachments',
      'chats',
      'chat_handles',
      'contacts',
      'handles',
      'messages',
      'messages_fts',
      'outgoing_queue',
      'scheduled_messages',
      'sync_markers',
      'themes',
      'kv',
      '_migrations',
    ]) {
      expect(names).toContain(t);
    }
  });

  it('seeds the singleton sync_markers row', async () => {
    const { raw } = await createTestDb();
    const count = raw.prepare(`SELECT COUNT(*) c FROM sync_markers`).get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('is idempotent (re-running applies nothing new)', async () => {
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
    expect(ran).toEqual([]); // already applied
  });
});
