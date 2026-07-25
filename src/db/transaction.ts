import { sql } from 'drizzle-orm';
import type { AppDatabase } from './types';

/**
 * Run `fn` inside an explicit BEGIN IMMEDIATE / COMMIT, rolling back if it throws.
 *
 * Why not drizzle's `db.transaction()`: the better-sqlite3 driver (Node tests) delegates to
 * better-sqlite3's native `.transaction()`, which REJECTS async callbacks — while the op-sqlite
 * side is async-only. Explicit statements via `db.run(sql\`…\`)` are the one shape both drivers
 * execute identically (same non-returning-write path the repositories already rely on; prepared
 * BEGIN/COMMIT/ROLLBACK is verified to work under better-sqlite3).
 *
 * BEGIN IMMEDIATE takes the write lock up front so the transaction can't fail on upgrade later.
 *
 * CAVEAT — single shared connection: any concurrent write on the same connection while this
 * transaction is open joins it (and a rollback would take that bystander write with it). Keep the
 * scope small and short-lived — a couple of statements, no awaits on anything but the DB.
 */
export async function withDbTransaction<T>(db: AppDatabase, fn: () => Promise<T>): Promise<T> {
  await db.run(sql`BEGIN IMMEDIATE`);
  try {
    const result = await fn();
    await db.run(sql`COMMIT`);
    return result;
  } catch (err) {
    try {
      await db.run(sql`ROLLBACK`);
    } catch {
      // The failure may have already aborted the transaction — nothing left to roll back.
    }
    throw err;
  }
}
