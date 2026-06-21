import { eq, sql } from 'drizzle-orm';
import type { SyncMarker } from '@core/sync';
import { syncMarkers } from '../schema';
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

export async function setSyncMarker(db: AppDatabase, marker: SyncMarker): Promise<void> {
  await db
    .update(syncMarkers)
    .set({
      lastSyncedRowId: marker.lastSyncedRowId,
      lastSyncedTimestamp: marker.lastSyncedTimestamp,
    })
    .where(eq(syncMarkers.id, 1));
}

/** Derive a sync marker from the highest message rowid/date currently stored. */
export async function maxMessageMarker(db: AppDatabase): Promise<SyncMarker> {
  const rows = await db.all<{ r: number | null; t: number | null }>(
    sql`SELECT MAX(original_row_id) AS r, MAX(date_created) AS t FROM messages`,
  );
  const row = rows[0];
  return { lastSyncedRowId: row?.r ?? null, lastSyncedTimestamp: row?.t ?? null };
}
