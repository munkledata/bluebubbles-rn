import Database from 'better-sqlite3';
import { runMigrations, type SqlRunner } from '@db/migrate';

function createRunner(raw: Database.Database, stopBefore: { value: '0030' | '0031' }): SqlRunner {
  return {
    async exec(statement, params) {
      if (
        stopBefore.value === '0030' &&
        statement.includes('CREATE TABLE attachment_cache_entries')
      ) {
        throw new Error('test stop before migration 0030');
      }
      if (stopBefore.value === '0031' && statement.includes('CREATE TABLE incoming_event_queue')) {
        throw new Error('test stop before migration 0031');
      }
      raw.prepare(statement).run(...((params as unknown[]) ?? []));
    },
    async query(statement, params) {
      return raw.prepare(statement).all(...((params as unknown[]) ?? [])) as never[];
    },
  };
}

describe('migration 0030_attachment_cache_entries', () => {
  it('upgrades 0029 data without guessing ownership and creates the constrained ledger indexes', async () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    try {
      const stopBefore: { value: '0030' | '0031' } = { value: '0030' };
      const runner = createRunner(raw, stopBefore);

      // Run the real migrator through the audited 0029 baseline, then stop at the first 0030
      // statement. The failed 0030 transaction rolls back; all earlier migrations remain applied.
      await expect(runMigrations(runner)).rejects.toThrow('test stop before migration 0030');
      const baselineHead = raw
        .prepare('SELECT name FROM _migrations ORDER BY rowid DESC LIMIT 1')
        .get() as { name: string };
      expect(baselineHead.name).toBe('0029_chats_deleted_at');
      raw
        .prepare(`INSERT INTO attachments (guid, local_path) VALUES (?, ?)`)
        .run('existing-attachment', 'file:///existing/attachment.jpg');

      // Apply exactly 0030, then stop before the next migration. This keeps the historical
      // upgrade test stable as new migrations are appended to the real list.
      stopBefore.value = '0031';
      await expect(runMigrations(runner)).rejects.toThrow('test stop before migration 0031');
      expect(raw.prepare('SELECT name FROM _migrations ORDER BY rowid DESC LIMIT 1').get()).toEqual(
        { name: '0030_attachment_cache_entries' },
      );

      const columns = raw.prepare('PRAGMA table_info(attachment_cache_entries)').all() as {
        name: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }[];
      expect(columns.map((column) => column.name)).toEqual([
        'path',
        'bytes',
        'last_used_at',
        'state',
        'attempts',
        'next_retry_at',
      ]);
      expect(columns.find((column) => column.name === 'path')).toEqual(
        expect.objectContaining({ notnull: 1, pk: 1 }),
      );
      for (const required of ['bytes', 'last_used_at', 'state', 'attempts', 'next_retry_at']) {
        expect(columns.find((column) => column.name === required)?.notnull).toBe(1);
      }
      expect(columns.find((column) => column.name === 'state')?.dflt_value).toBe("'active'");
      expect(columns.find((column) => column.name === 'attempts')?.dflt_value).toBe('0');
      expect(columns.find((column) => column.name === 'next_retry_at')?.dflt_value).toBe('0');

      const lruColumns = raw
        .prepare('PRAGMA index_info(attachment_cache_entries_state_lru_idx)')
        .all()
        .map((row) => (row as { name: string }).name);
      expect(lruColumns).toEqual(['state', 'last_used_at', 'path']);
      const pathIndex = raw
        .prepare(
          `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'attachments_local_path_idx'`,
        )
        .get() as { sql: string };
      expect(pathIndex.sql).toContain('WHERE local_path IS NOT NULL');
      expect(
        raw
          .prepare('PRAGMA index_info(attachments_local_path_idx)')
          .all()
          .map((row) => (row as { name: string }).name),
      ).toEqual(['local_path']);
      expect(raw.prepare('PRAGMA foreign_key_list(attachment_cache_entries)').all()).toEqual([]);

      // SQL cannot tell an app-owned cache file from an outgoing/user-owned path, so migration
      // deliberately starts empty and leaves adoption to the exact-root native scan in slice 3.
      expect(raw.prepare('SELECT COUNT(*) AS count FROM attachment_cache_entries').get()).toEqual({
        count: 0,
      });
      expect(
        raw
          .prepare(`SELECT local_path AS localPath FROM attachments WHERE guid = ?`)
          .get('existing-attachment'),
      ).toEqual({ localPath: 'file:///existing/attachment.jpg' });

      const insert = raw.prepare(
        `INSERT INTO attachment_cache_entries (path, bytes, last_used_at) VALUES (?, ?, ?)`,
      );
      insert.run('file:///cache/valid.jpg', 10, 100);
      expect(
        raw
          .prepare(
            `SELECT state, attempts, next_retry_at AS nextRetryAt
                     FROM attachment_cache_entries WHERE path = ?`,
          )
          .get('file:///cache/valid.jpg'),
      ).toEqual({ state: 'active', attempts: 0, nextRetryAt: 0 });
      expect(() => insert.run('file:///cache/valid.jpg', 20, 200)).toThrow(/UNIQUE/);
      expect(() => insert.run('', 10, 100)).toThrow(/CHECK/);
      expect(() => insert.run('file:///cache/negative.jpg', -1, 100)).toThrow(/CHECK/);
      expect(() => insert.run('file:///cache/bad-time.jpg', 1, -1)).toThrow(/CHECK/);
      expect(() =>
        raw
          .prepare(
            `INSERT INTO attachment_cache_entries (path, bytes, last_used_at, state)
             VALUES (?, ?, ?, ?)`,
          )
          .run('file:///cache/reserved.jpg', 1, 100, 'reserved'),
      ).not.toThrow();
      expect(() =>
        raw
          .prepare(`INSERT INTO attachments (guid, local_path) VALUES (?, ?) `)
          .run('reserved-insert', 'file:///cache/reserved.jpg'),
      ).toThrow(/attachment cache path is not active/);
      raw
        .prepare(`INSERT INTO attachments (guid, local_path) VALUES (?, NULL)`)
        .run('reserved-update');
      expect(() =>
        raw
          .prepare(`UPDATE attachments SET local_path = ? WHERE guid = ?`)
          .run('file:///cache/reserved.jpg', 'reserved-update'),
      ).toThrow(/attachment cache path is not active/);
      expect(() =>
        raw
          .prepare(
            `INSERT INTO attachment_cache_entries (path, bytes, last_used_at, state)
             VALUES (?, ?, ?, ?)`,
          )
          .run('file:///cache/retiring.jpg', 1, 100, 'retiring'),
      ).not.toThrow();
      expect(() =>
        raw
          .prepare(`INSERT INTO attachments (guid, local_path) VALUES (?, ?) `)
          .run('retiring-insert', 'file:///cache/retiring.jpg'),
      ).toThrow(/attachment cache path is not active/);
      raw
        .prepare(`INSERT INTO attachments (guid, local_path) VALUES (?, NULL)`)
        .run('retiring-update');
      expect(() =>
        raw
          .prepare(`UPDATE attachments SET local_path = ? WHERE guid = ?`)
          .run('file:///cache/retiring.jpg', 'retiring-update'),
      ).toThrow(/attachment cache path is not active/);
      // The guards are state-specific: an active ledger path remains a valid ordinary reference.
      expect(() =>
        raw
          .prepare(`INSERT INTO attachments (guid, local_path) VALUES (?, ?) `)
          .run('active-insert', 'file:///cache/valid.jpg'),
      ).not.toThrow();
      expect(() =>
        raw
          .prepare(
            `INSERT INTO attachment_cache_entries (path, bytes, last_used_at, state)
             VALUES (?, ?, ?, ?)`,
          )
          .run('file:///cache/bad-state.jpg', 1, 100, 'deleted'),
      ).toThrow(/CHECK/);
      expect(() =>
        raw
          .prepare(
            `INSERT INTO attachment_cache_entries
               (path, bytes, last_used_at, attempts, next_retry_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run('file:///cache/bad-attempts.jpg', 1, 100, -1, 0),
      ).toThrow(/CHECK/);
      expect(() =>
        raw
          .prepare(
            `INSERT INTO attachment_cache_entries
               (path, bytes, last_used_at, attempts, next_retry_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run('file:///cache/bad-retry.jpg', 1, 100, 0, -1),
      ).toThrow(/CHECK/);
    } finally {
      raw.close();
    }
  });
});
