import { advanceMarker, buildSyncCursor, TIMESTAMP_OVERLAP_MS } from '@core/sync';

describe('sync cursor', () => {
  it('uses a ROWID cursor on server >= 1.6.0 with a known row id', () => {
    const cursor = buildSyncCursor('1.6.0', { lastSyncedRowId: 42, lastSyncedTimestamp: 1000 });
    expect(cursor).toEqual({ mode: 'rowid', after: 42 });
  });

  it('falls back to a timestamp cursor on older servers', () => {
    const cursor = buildSyncCursor('1.5.9', { lastSyncedRowId: 42, lastSyncedTimestamp: 100_000 });
    expect(cursor).toEqual({ mode: 'timestamp', after: 100_000 - TIMESTAMP_OVERLAP_MS });
  });

  it('falls back to timestamp when no row id is recorded yet', () => {
    const cursor = buildSyncCursor('1.7.0', { lastSyncedRowId: null, lastSyncedTimestamp: 50_000 });
    expect(cursor.mode).toBe('timestamp');
  });

  it('never produces a negative timestamp cursor', () => {
    const cursor = buildSyncCursor('1.0.0', { lastSyncedRowId: null, lastSyncedTimestamp: 100 });
    expect(cursor).toEqual({ mode: 'timestamp', after: 0 });
  });

  it('advances the marker to the max row id and timestamp in a batch', () => {
    const next = advanceMarker({ lastSyncedRowId: 10, lastSyncedTimestamp: 1000 }, [
      { rowId: 12, timestamp: 900 },
      { rowId: 11, timestamp: 2000 },
      { rowId: null, timestamp: null },
    ]);
    expect(next).toEqual({ lastSyncedRowId: 12, lastSyncedTimestamp: 2000 });
  });

  /**
   * The NON-advancing batch. `incrementalSync` loops `buildSyncCursor → fetch → advanceMarker` and
   * only breaks on an empty/short page — so a FULL page that leaves the marker where it was makes
   * the next iteration build the identical cursor, fetch the identical page, forever. These pin the
   * exact inputs that produce that: a batch whose rows are all at-or-behind the marker, and a batch
   * carrying no cursor fields at all.
   */
  it('leaves the marker UNCHANGED when no row in the batch is newer than it', () => {
    const marker = { lastSyncedRowId: 100, lastSyncedTimestamp: 5000 };
    const next = advanceMarker(marker, [
      { rowId: 100, timestamp: 5000 }, // equal — not greater, so no advance
      { rowId: 99, timestamp: 4000 }, // behind
      { rowId: null, timestamp: null }, // unusable
    ]);
    expect(next).toEqual({ lastSyncedRowId: 100, lastSyncedTimestamp: 5000 });
    // Same marker in → same cursor out: the loop would re-request the identical page.
    expect(buildSyncCursor('1.7.0', next)).toEqual(buildSyncCursor('1.7.0', marker));
  });

  it('cannot bootstrap a marker from a batch with no rowId/timestamp at all', () => {
    const empty = { lastSyncedRowId: null, lastSyncedTimestamp: null };
    const next = advanceMarker(empty, [{ rowId: null, timestamp: null }, {}]);
    expect(next).toEqual(empty);
    // Still the from-scratch timestamp cursor — the sync makes no forward progress.
    expect(buildSyncCursor('1.7.0', next)).toEqual({ mode: 'timestamp', after: 0 });
  });
});
