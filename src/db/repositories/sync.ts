import { eq, sql } from 'drizzle-orm';
import type { SyncMarker } from '@core/sync';
import { syncMarkers } from '../schema';
import {
  runInTransactionContext,
  withDbTransaction,
  type DbCommitGuard,
  type DbTransactionContext,
} from '../transaction';
import type { AppDatabase } from '../types';

// ---- Sync markers ----------------------------------------------------------

export async function getSyncMarker(db: AppDatabase): Promise<SyncMarker> {
  const rows = await db.select().from(syncMarkers).where(eq(syncMarkers.id, 1)).limit(1);
  const row = rows[0];
  return {
    lastSyncedRowId: row?.lastSyncedRowId ?? null,
    lastSyncedTimestamp: row?.lastSyncedTimestamp ?? null,
  };
}

export function setSyncMarkerWithinTransaction(
  context: DbTransactionContext,
  marker: SyncMarker,
): Promise<void> {
  return runInTransactionContext(context, async (db) => {
    await db
      .update(syncMarkers)
      .set({
        lastSyncedRowId: marker.lastSyncedRowId,
        lastSyncedTimestamp: marker.lastSyncedTimestamp,
      })
      .where(eq(syncMarkers.id, 1));
  });
}

/** Standalone sync-marker owner. Existing transaction owners use the context-only form above. */
export async function setSyncMarker(
  db: AppDatabase,
  marker: SyncMarker,
  commitGuard?: DbCommitGuard,
): Promise<void> {
  return withDbTransaction(
    db,
    (context) => setSyncMarkerWithinTransaction(context, marker),
    commitGuard,
  );
}

/** Derive a sync marker from the highest message rowid/date currently stored. */
export async function maxMessageMarker(db: AppDatabase): Promise<SyncMarker> {
  const rows = await db.all<{ r: number | null; t: number | null }>(
    sql`SELECT MAX(original_row_id) AS r, MAX(date_created) AS t FROM messages`,
  );
  const row = rows[0];
  return { lastSyncedRowId: row?.r ?? null, lastSyncedTimestamp: row?.t ?? null };
}
