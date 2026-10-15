import { setWriteQueueWedgeListener } from '@db/transaction';

/** Durable presence record kept outside SQLite; the native one is `ExpoDbWriteWedgeMarker`. */
export interface DbWriteWedgeMarker {
  isMarked(): boolean;
  mark(): void;
  clear(): void;
}

let installedMarker: DbWriteWedgeMarker | null = null;
let earlierRunWedge = false;

/**
 * Keep a wedged write queue's report for the next launch (review M045).
 *
 * The wedge report cannot be saved while the queue is wedged, because saving it needs that queue,
 * so the watchdog's listener records the fact in `marker` instead. Install once at boot: a record
 * present at install time was left by an earlier run, and error reporting replays it once this
 * account's reporting is live. `shouldRecord` is the same consent + current-account rule the
 * error-report sink applies to every report.
 */
export function installDbWriteWedgeRecord(
  marker: DbWriteWedgeMarker,
  shouldRecord: () => boolean,
): void {
  installedMarker = marker;
  try {
    earlierRunWedge = marker.isMarked();
  } catch {
    earlierRunWedge = false;
  }
  setWriteQueueWedgeListener(() => {
    if (!shouldRecord()) return;
    try {
      marker.mark();
    } catch {
      // Best effort: the local diagnostic log still has the wedge line.
    }
  });
}

/** Whether an earlier run left a wedge that this run has not yet replayed. */
export function hasEarlierRunDbWriteWedge(): boolean {
  return earlierRunWedge;
}

/**
 * Forget the record: after a successful replay, when error reporting is turned off, and on
 * Disconnect, so one account's record is never replayed under the next. Throws if the file could
 * not be deleted, so Disconnect can treat that as a failed cleanup.
 */
export function clearRecordedDbWriteWedge(): void {
  earlierRunWedge = false;
  installedMarker?.clear();
}
