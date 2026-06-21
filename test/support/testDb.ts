import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { runMigrations, type SqlRunner } from '@db/migrate';
import type { AppDatabase } from '@db/types';

/**
 * Creates an in-memory SQLite DB (better-sqlite3) with the same migrations the
 * app runs on op-sqlite, and returns a Drizzle handle typed as AppDatabase.
 * This lets the repositories + sync engine be exercised for real in Node.
 */
export async function createTestDb(): Promise<{ db: AppDatabase; raw: Database.Database }> {
  const raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');

  const runner: SqlRunner = {
    async exec(sql, params) {
      raw.prepare(sql).run(...((params as unknown[]) ?? []));
    },
    async query(sql, params) {
      return raw.prepare(sql).all(...((params as unknown[]) ?? [])) as never[];
    },
  };
  await runMigrations(runner);

  const db = drizzle(raw) as unknown as AppDatabase;
  return { db, raw };
}
