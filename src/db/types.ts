import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';

/**
 * Driver-agnostic Drizzle database handle. The app uses op-sqlite (async); Node
 * tests use better-sqlite3 (sync). Both are assignable here, and `await` works
 * for either since Drizzle query builders are thenable. Repositories import the
 * table objects from ./schema directly, so the relational-schema generic is
 * intentionally loose.
 */
export type AppDatabase = BaseSQLiteDatabase<any, any, Record<string, unknown>>;
