import { readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations, type SqlRunner } from '@db/migrate';
import { MIGRATIONS } from '@db/migrations';
import { createTestDb } from '../support/testDb';

describe('migrations', () => {
  it('creates all expected tables and the FTS table', async () => {
    const { raw } = await createTestDb();
    const names = raw
      .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name`)
      .all()
      .map((r) => (r as { name: string }).name);

    for (const t of [
      'attachment_cache_entries',
      'attachments',
      'chats',
      'chat_handles',
      'contacts',
      'custom_folder_members',
      'custom_folders',
      'error_reports',
      'handles',
      'incoming_event_queue',
      'message_deletion_ledger',
      'message_guid_aliases',
      'messages',
      'messages_fts',
      'outgoing_queue',
      'reminders',
      'scheduled_messages',
      'sync_markers',
      'themes',
      'url_previews',
      'kv',
      '_migrations',
    ]) {
      expect(names).toContain(t);
    }
  });

  /**
   * The `messages_fts` virtual table in 0001_init only compiles on-device when op-sqlite is
   * built WITH FTS5 — which happens ONLY because of the `"op-sqlite": { "fts5": true }` flag in
   * package.json. better-sqlite3 (this suite's driver) ships FTS5 unconditionally, so deleting
   * that flag leaves every test here GREEN while every real device fails to open its DB with
   * `no such module: fts5`. Assert the flag from the test so the divergence can't ship silently.
   */
  it('package.json keeps the op-sqlite fts5 (and sqlcipher) build flags that messages_fts needs', () => {
    const pkg = JSON.parse(
      readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(pkg['op-sqlite']).toEqual(expect.objectContaining({ fts5: true, sqlcipher: true }));
    // …and the migration that depends on it is still the one creating the FTS table.
    const init = MIGRATIONS.find((m) => m.name === '0001_init');
    expect(init?.statements.some((s) => s.includes('USING fts5('))).toBe(true);
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

  /**
   * Each migration is wrapped in BEGIN/COMMIT with a ROLLBACK on failure (src/db/migrate.ts).
   * Without that, a migration that dies halfway leaves its earlier statements committed AND
   * unrecorded — so the retry re-runs them and blows up with "table already exists", wedging
   * the app permanently. Simulated with a runner that throws on one chosen statement.
   */
  describe('atomicity (a failed migration rolls back and is not recorded)', () => {
    // 0025 is a two-statement migration: CREATE TABLE then CREATE INDEX. Fail on the second so
    // the first has really executed inside the transaction.
    const FAIL_ON = 'CREATE INDEX error_reports_retry_idx';

    function runnerFor(raw: Database.Database, shouldFail: { value: boolean }): SqlRunner {
      return {
        async exec(sql, params) {
          if (shouldFail.value && sql.includes(FAIL_ON)) throw new Error('boom');
          raw.prepare(sql).run(...((params as unknown[]) ?? []));
        },
        async query(sql, params) {
          return raw.prepare(sql).all(...((params as unknown[]) ?? [])) as never[];
        },
      };
    }

    it('rolls back the partial migration and leaves it unapplied, then a retry succeeds', async () => {
      const raw = new Database(':memory:');
      try {
        const shouldFail = { value: true };
        const runner = runnerFor(raw, shouldFail);

        await expect(runMigrations(runner)).rejects.toThrow('boom');

        // The CREATE TABLE from the same migration was rolled back …
        const table = raw
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='error_reports'")
          .get();
        expect(table).toBeUndefined();
        // … and 0025 is NOT recorded as applied, while the migrations before it are.
        const applied = (
          raw.prepare('SELECT name FROM _migrations').all() as { name: string }[]
        ).map((r) => r.name);
        expect(applied).not.toContain('0025_error_reports');
        expect(applied).toContain('0024_scheduled_recurrence');
        // No transaction is left dangling (a stuck BEGIN would make this throw).
        expect(raw.inTransaction).toBe(false);

        // The retry is the whole point: it must NOT fail with "table already exists".
        shouldFail.value = false;
        const ran = await runMigrations(runner);
        expect(ran[0]).toBe('0025_error_reports');
        expect(ran).toContain(MIGRATIONS[MIGRATIONS.length - 1]!.name);
        expect(
          raw
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='index' AND name='error_reports_retry_idx'",
            )
            .get(),
        ).toBeTruthy();
      } finally {
        raw.close();
      }
    });
  });
});
