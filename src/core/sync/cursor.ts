import { isAtLeast } from '@utils/version';

/**
 * Incremental-sync cursor logic, ported from incremental_sync_manager.dart.
 *
 * Server >= 1.6.0 supports a stable ROWID cursor (`after`), which is exact and
 * cheap. Older servers fall back to a timestamp cursor (last sync time), which
 * can re-fetch a small overlap window to avoid missing messages.
 */
export const ROWID_SYNC_MIN_VERSION = '1.6.0';

export interface SyncMarker {
  lastSyncedRowId: number | null;
  lastSyncedTimestamp: number | null;
}

export type SyncCursor = { mode: 'rowid'; after: number } | { mode: 'timestamp'; after: number };

/** Overlap (ms) re-fetched on timestamp-based sync to tolerate clock skew. */
export const TIMESTAMP_OVERLAP_MS = 5_000;

/** Choose the query cursor for the next incremental sync. */
export function buildSyncCursor(serverVersion: string, marker: SyncMarker): SyncCursor {
  if (isAtLeast(serverVersion, ROWID_SYNC_MIN_VERSION) && marker.lastSyncedRowId != null) {
    return { mode: 'rowid', after: marker.lastSyncedRowId };
  }
  const ts = marker.lastSyncedTimestamp ?? 0;
  return { mode: 'timestamp', after: Math.max(0, ts - TIMESTAMP_OVERLAP_MS) };
}

/** Advance the marker after a batch, taking the max row id / timestamp seen. */
export function advanceMarker(
  marker: SyncMarker,
  batch: { rowId?: number | null; timestamp?: number | null }[],
): SyncMarker {
  let { lastSyncedRowId, lastSyncedTimestamp } = marker;
  for (const item of batch) {
    if (item.rowId != null && (lastSyncedRowId == null || item.rowId > lastSyncedRowId)) {
      lastSyncedRowId = item.rowId;
    }
    if (
      item.timestamp != null &&
      (lastSyncedTimestamp == null || item.timestamp > lastSyncedTimestamp)
    ) {
      lastSyncedTimestamp = item.timestamp;
    }
  }
  return { lastSyncedRowId, lastSyncedTimestamp };
}
