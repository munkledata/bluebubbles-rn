import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';

/**
 * Driver-agnostic Drizzle database handle. The app uses op-sqlite (async); Node
 * tests use better-sqlite3 (sync). Both are assignable here, and `await` works
 * for either since Drizzle query builders are thenable. Repositories import the
 * table objects from ./schema directly, so the relational-schema generic is
 * intentionally loose.
 */
export type AppDatabase = BaseSQLiteDatabase<any, any, Record<string, unknown>>;

/**
 * Read-only query surface. Structural: both {@link ReadDb} and {@link WriteDb} satisfy it, so a
 * pure read helper typed `db: Queryable` works inside and outside a transaction. `run`, `insert`,
 * `update`, `delete` and `transaction` are deliberately absent: every write goes through a
 * `withDbTransaction` callback's {@link WriteDb}.
 */
export type Queryable = Pick<
  AppDatabase,
  'select' | 'selectDistinct' | 'with' | '$with' | '$count' | 'all' | 'get' | 'values' | 'query'
>;

declare const outsideTransactionBrand: unique symbol;

/**
 * What `getDatabase()` and `ensureDatabase()` hand out: reads only, plus a brand that proves the
 * holder is OUTSIDE any transaction. A helper that opens its own transaction takes this type, so
 * the compiler refuses to let a transaction callback (which holds a {@link WriteDb}, no brand)
 * call it: that nested call would wait forever on the write lock its own caller holds.
 */
export type ReadDb = Queryable & { readonly [outsideTransactionBrand]: true };

/**
 * The full handle, including writes. Only `withDbTransaction` (its callback's first argument) and
 * `runInTransactionContext` hand one out; migrations and the dev throwaway doorway hold their own.
 */
export type WriteDb = AppDatabase;

/**
 * A handle whose owner holds the whole file: test seeding and the dev throwaway doorway. It
 * satisfies every parameter kind (reads, writes, and own-transaction helpers).
 */
export type TestDb = WriteDb & { readonly [outsideTransactionBrand]: true };

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
  db: TestDb,
  options: DbRuntimeConcurrencyWaveOptions,
) => Promise<DbRuntimeConcurrencyWaveChecks>;

/** Finite, privacy-safe results produced by the disposable BACKUP-02 native restore wave. */
export interface DbBackupRestoreWaveChecks {
  readonly plaintextNearLimit: boolean;
  readonly bb2Envelope: boolean;
  readonly nativeSeal: boolean;
  readonly nativeOpen: boolean;
  readonly lateFaultObserved: boolean;
  readonly kvRolledBack: boolean;
  readonly themesRolledBack: boolean;
  readonly chatRolledBack: boolean;
  readonly foldersRolledBack: boolean;
  readonly tempTablesCleaned: boolean;
  readonly retrySucceeded: boolean;
  readonly successorWrite: boolean;
}

/** The service wave receives only the already-migrated disposable database. */
export type DbBackupRestoreWaveRunner = (db: TestDb) => Promise<DbBackupRestoreWaveChecks>;
