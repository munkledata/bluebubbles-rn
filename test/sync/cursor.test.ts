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
});
