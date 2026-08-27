import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';

/**
 * Driver-agnostic Drizzle database handle. The app uses op-sqlite (async); Node
 * tests use better-sqlite3 (sync). Both are assignable here, and `await` works
 * for either since Drizzle query builders are thenable. Repositories import the
 * table objects from ./schema directly, so the relational-schema generic is
 * intentionally loose.
 */
export type AppDatabase = BaseSQLiteDatabase<any, any, Record<string, unknown>>;

/** Finite, privacy-safe results produced by the disposable DB-02C runtime wave. */
export interface DbRuntimeConcurrencyWaveChecks {
  readonly rollbackIsolation: boolean;
  readonly syncChunks: boolean;
  readonly liveMessages: boolean;
  readonly attachmentConstruction: boolean;
  readonly uploadOutsideDbOwner: boolean;
  readonly rekeyExclusive: boolean;
  readonly queuedWritersBlocked: boolean;
  readonly rekeyApplied: boolean;
  readonly queuedWritersResumed: boolean;
  readonly uploadSettlement: boolean;
  readonly queueDrained: boolean;
  readonly sentinelCommit: boolean;
}

/** The only capability passed from the fixed native harness into the service-level stress wave. */
export interface DbRuntimeConcurrencyWaveOptions {
  /** Raw PRAGMA-only work; the wave already owns the global lock, so this must not claim it again. */
  readonly rawRekey: () => Promise<void>;
}

export type DbRuntimeConcurrencyWaveRunner = (
  db: AppDatabase,
  options: DbRuntimeConcurrencyWaveOptions,
) => Promise<DbRuntimeConcurrencyWaveChecks>;
