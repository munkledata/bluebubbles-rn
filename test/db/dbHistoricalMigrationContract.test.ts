import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import Database from 'better-sqlite3';
import ts from 'typescript';
import { runMigrations, type SqlRunner } from '@db/migrate';
import { MIGRATIONS, type Migration } from '@db/migrations';

const REPOSITORY_ROOT = path.resolve(__dirname, '../..');
const STOP_MESSAGE = 'db-03b2a-stop-after-reviewed-head';

const REVIEWED_HISTORY = [
  {
    count: 24,
    head: '0024_scheduled_recurrence',
    next: '0025_error_reports',
    digest: 'd7cce2d30a027e90dc2bd046fea104037c04c8128099161608ec41a21ad2bfbb',
    representativeCommit: '51a513f52e22411769480ad4f2ee0c67be550565',
    representativeVersion: '0.1.20',
  },
  {
    count: 27,
    head: '0027_message_payload_data',
    next: '0028_chats_marked_unread_at',
    digest: '4874c622bc085c32cc769f532b77e91634e2be82d73997ed6fe10bdcf078205c',
    representativeCommit: 'f0167bee099afa04f79b21182cfbcefc7367be61',
    representativeVersion: '0.1.31',
  },
  {
    count: 29,
    head: '0029_chats_deleted_at',
    next: '0030_attachment_cache_entries',
    digest: '1daf75189a26297b49e5c6fc7c7d968f5d5cf87a50f0338b95eaa0ae2766c8ea',
    representativeCommit: '0564a80b572f16faf63c4d7b13c798a72451c845',
    representativeVersion: '0.1.40',
  },
] as const;

function gitText(args: string[]): string {
  return execFileSync('git', args, {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gitObject(commit: string, repositoryPath: string): string {
  return gitText(['show', `${commit}:${repositoryPath}`]);
}

function historicalMigrations(commit: string): Migration[] {
  const source = gitObject(commit, 'src/db/migrations.ts');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const loadedModule: { exports: Record<string, unknown> } = { exports: {} };
  runInNewContext(
    compiled,
    { exports: loadedModule.exports, module: loadedModule },
    { timeout: 1_000 },
  );
  const migrations = loadedModule.exports.MIGRATIONS;
  if (!Array.isArray(migrations)) throw new Error(`missing historical MIGRATIONS at ${commit}`);
  return JSON.parse(JSON.stringify(migrations)) as Migration[];
}

function digest(migrations: readonly Migration[]): string {
  return createHash('sha256').update(JSON.stringify(migrations), 'utf8').digest('hex');
}

function runnerFor(raw: Database.Database): SqlRunner {
  return {
    async exec(statement, params) {
      raw.prepare(statement).run(...((params as unknown[]) ?? []));
    },
    async query(statement, params) {
      return raw.prepare(statement).all(...((params as unknown[]) ?? [])) as never[];
    },
  };
}

function tableColumns(raw: Database.Database, table: string): string[] {
  return (raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    ({ name }) => name,
  );
}

describe('reviewed historical migration contract', () => {
  it('pins each canonical prefix to its reviewed repository object and version', () => {
    for (const history of REVIEWED_HISTORY) {
      const pkg = JSON.parse(gitObject(history.representativeCommit, 'package.json')) as {
        version?: unknown;
      };
      const migrations = historicalMigrations(history.representativeCommit);

      expect(pkg.version).toBe(history.representativeVersion);
      expect(migrations).toHaveLength(history.count);
      expect(migrations.at(-1)?.name).toBe(history.head);
      expect(migrations).toEqual(MIGRATIONS.slice(0, history.count));
      expect(digest(migrations)).toBe(history.digest);
      expect(MIGRATIONS[history.count]?.name).toBe(history.next);
    }
  });

  it.each(REVIEWED_HISTORY.slice(0, 2))(
    'uses the production runner to stop at $head, then upgrades real FTS5 data',
    async (history) => {
      const raw = new Database(':memory:');
      try {
        raw.pragma('foreign_keys = ON');
        const runner = runnerFor(raw);
        await runner.exec(
          'CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER)',
        );
        await runner.exec(`CREATE TRIGGER driver_history_stop_after_reviewed_head
          BEFORE INSERT ON _migrations
          WHEN NEW.name = '${history.next}'
          BEGIN
            SELECT RAISE(ABORT, '${STOP_MESSAGE}');
          END`);

        await expect(runMigrations(runner)).rejects.toMatchObject({
          message: expect.stringContaining(STOP_MESSAGE),
        });
        const applied = raw.prepare('SELECT name FROM _migrations ORDER BY name').all() as Array<{
          name: string;
        }>;
        expect(applied.map(({ name }) => name)).toEqual(
          MIGRATIONS.slice(0, history.count).map(({ name }) => name),
        );
        expect(tableColumns(raw, 'scheduled_messages')).toContain('recurrence');
        expect(tableColumns(raw, 'messages').includes('payload_data')).toBe(history.count === 27);
        expect(tableColumns(raw, 'chats')).not.toContain('marked_unread_at');
        expect(tableColumns(raw, 'chats')).not.toContain('deleted_at');
        expect(
          raw
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='error_reports'")
            .get() !== undefined,
        ).toBe(history.count === 27);
        expect(
          raw
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='attachment_cache_entries'",
            )
            .get(),
        ).toBeUndefined();

        const prefix = `driver-history-${String(history.count).padStart(4, '0')}`;
        const persistentToken = `driverhistory${String(history.count).padStart(4, '0')}persistentsentinel`;
        raw
          .prepare('INSERT INTO chats (guid, display_name) VALUES (?, ?)')
          .run(`${prefix}-chat`, history.head);
        const chat = raw.prepare('SELECT id FROM chats WHERE guid = ?').get(`${prefix}-chat`) as {
          id: number;
        };
        raw
          .prepare('INSERT INTO messages (guid, chat_id, text) VALUES (?, ?, ?)')
          .run(`${prefix}-message`, chat.id, persistentToken);
        expect(
          raw
            .prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?')
            .all(persistentToken),
        ).toHaveLength(1);

        raw.exec('DROP TRIGGER driver_history_stop_after_reviewed_head');
        const migrated = await runMigrations(runner);
        expect(migrated).toEqual(MIGRATIONS.slice(history.count).map(({ name }) => name));
        expect(
          raw
            .prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?')
            .all(persistentToken),
        ).toHaveLength(1);

        const orangeToken = `driverhistory${String(history.count).padStart(4, '0')}orangesentinel`;
        const violetToken = `driverhistory${String(history.count).padStart(4, '0')}violetsentinel`;
        raw
          .prepare('INSERT INTO messages (guid, chat_id, text) VALUES (?, ?, ?)')
          .run(`${prefix}-fts`, chat.id, orangeToken);
        expect(
          raw.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?').all(orangeToken),
        ).toHaveLength(1);
        raw
          .prepare('UPDATE messages SET text = ? WHERE guid = ?')
          .run(violetToken, `${prefix}-fts`);
        expect(
          raw.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?').all(orangeToken),
        ).toHaveLength(0);
        expect(
          raw.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?').all(violetToken),
        ).toHaveLength(1);
        raw.prepare('DELETE FROM messages WHERE guid = ?').run(`${prefix}-fts`);
        expect(
          raw.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?').all(violetToken),
        ).toHaveLength(0);
        expect(raw.pragma('foreign_key_check')).toEqual([]);
        expect(raw.pragma('integrity_check', { simple: true })).toBe('ok');
        await expect(runMigrations(runner)).resolves.toEqual([]);
      } finally {
        raw.close();
      }
    },
  );
});
