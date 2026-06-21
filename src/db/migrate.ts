import { MIGRATIONS } from './migrations';

/**
 * Minimal SQL runner abstraction so migrations work against any driver:
 * op-sqlite (app) and better-sqlite3 (Node tests).
 */
export interface SqlRunner {
  exec(sql: string, params?: unknown[]): Promise<void>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

/**
 * Apply any not-yet-applied migrations in order, each tracked by name in a
 * `_migrations` table. Idempotent: re-running applies nothing new.
 */
export async function runMigrations(runner: SqlRunner): Promise<string[]> {
  await runner.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER)`,
  );
  const rows = await runner.query<{ name: string }>(`SELECT name FROM _migrations`);
  const applied = new Set(rows.map((r) => r.name));

  const ran: string[] = [];
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue;
    // Each migration is atomic: a failure rolls back so partial tables never
    // linger (which would make a retry fail with "table already exists").
    await runner.exec('BEGIN');
    try {
      for (const statement of migration.statements) {
        await runner.exec(statement);
      }
      await runner.exec(`INSERT INTO _migrations (name, applied_at) VALUES (?, ?)`, [
        migration.name,
        Date.now(),
      ]);
      await runner.exec('COMMIT');
    } catch (e) {
      await runner.exec('ROLLBACK').catch(() => undefined);
      throw e;
    }
    ran.push(migration.name);
  }
  return ran;
}
