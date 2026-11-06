// The op-sqlite v17 bridge shared by the production database module and the dev self-test harness:
// the raw handle type, row extraction, the migration SqlRunner, and the Proxy that presents the
// legacy drizzle driver surface. Internal to src/db; the boundary guard confines raw driver use here.
import type { open } from '@op-engineering/op-sqlite';
import type { SqlRunner } from './migrate';

export type RawDb = ReturnType<typeof open>;

export function extractRows(res: unknown): Array<Record<string, unknown>> {
  const r = res as { rows?: unknown };
  if (Array.isArray(r?.rows)) return r.rows as Array<Record<string, unknown>>;
  const legacy = (r?.rows as { _array?: unknown })?._array;
  if (Array.isArray(legacy)) return legacy as Array<Record<string, unknown>>;
  return [];
}

/** Adapt op-sqlite's execute API to the migration SqlRunner interface. */
export function opRunner(db: RawDb): SqlRunner {
  return {
    async exec(sql, params) {
      await db.execute(sql, (params as never[]) ?? []);
    },
    async query(sql, params) {
      const res = await db.execute(sql, (params as never[]) ?? []);
      return extractRows(res) as never[];
    },
  };
}

/**
 * Adapter so drizzle-orm's op-sqlite driver works with op-sqlite v17, whose API
 * diverged from what drizzle expects. drizzle calls a SYNCHRONOUS
 * `execute().rows._array` plus `executeAsync`/`executeRawAsync`; op-sqlite v17
 * instead provides async `execute` (rows as a plain array), `executeSync`, and
 * `executeRaw` (with `rawRows`). This Proxy presents the legacy interface drizzle
 * wants while delegating to the real handle. Migrations and `reactiveExecute`
 * keep using the un-adapted handle.
 */
export function drizzleAdapter(db: RawDb): RawDb {
  const wrap = (r: { rows?: unknown[] }): unknown => ({ ...r, rows: { _array: r.rows ?? [] } });
  // op-sqlite batches reactive notifications on its thread pool; flush after
  // writes so `reactiveExecute` subscribers (the live conversation list) re-run.
  const flush = (): void => void db.flushPendingReactiveQueries();
  let transactionOpen = false;
  const transactionCommand = (statement: string): string =>
    statement.trim().replace(/;+$/, '').toUpperCase();
  const flushAfter = (command: string): void => {
    if (command.startsWith('BEGIN')) {
      transactionOpen = true;
      return;
    }
    if (command === 'COMMIT' || command === 'ROLLBACK') {
      transactionOpen = false;
      flush();
      return;
    }
    if (!transactionOpen) flush();
  };
  const retireFailedRollback = (command: string): void => {
    // SQLite may auto-abort before reporting a ROLLBACK error. The shared transaction owner
    // deliberately contains that cleanup error, so the adapter must not suppress every later
    // autocommit notification under a stale in-memory transaction flag.
    if (command === 'ROLLBACK') transactionOpen = false;
  };
  const overrides: Record<string, unknown> = {
    execute: (statement: string, params?: unknown[]) => {
      const command = transactionCommand(statement);
      try {
        const r = db.executeSync(statement, (params as never[]) ?? []);
        flushAfter(command);
        return wrap(r);
      } catch (error) {
        retireFailedRollback(command);
        throw error;
      }
    },
    executeAsync: async (statement: string, params?: unknown[]) => {
      const command = transactionCommand(statement);
      try {
        const r = await db.execute(statement, (params as never[]) ?? []);
        flushAfter(command);
        return wrap(r);
      } catch (error) {
        retireFailedRollback(command);
        throw error;
      }
    },
    executeRawAsync: async (statement: string, params?: unknown[]) => {
      const command = transactionCommand(statement);
      try {
        const r = await db.executeRaw(statement, (params as never[]) ?? []);
        flushAfter(command);
        return r.rawRows;
      } catch (error) {
        retireFailedRollback(command);
        throw error;
      }
    },
  };
  return new Proxy(db as object, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && prop in overrides) return overrides[prop];
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as RawDb;
}
