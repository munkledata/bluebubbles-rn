import { reportWriteQueueWedge, setWriteQueueWedgeListener } from '@db/transaction';
import { errorReportSink } from './errorReportSink';

/** Durable presence record kept outside SQLite; the native one is `ExpoDbWriteWedgeMarker`. */
export interface DbWriteWedgeMarker {
  isMarked(): boolean;
  mark(): void;
  clear(): void;
}

let installedMarker: DbWriteWedgeMarker | null = null;
let earlierRunWedge = false;
let thisRunWedged = false;
/** Accept number of this run's replayed report, until it is saved and the record is forgotten. */
let replayedReport: number | null = null;

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
  thisRunWedged = false;
  replayedReport = null;
  try {
    earlierRunWedge = marker.isMarked();
  } catch {
    earlierRunWedge = false;
  }
  setWriteQueueWedgeListener(() => {
    thisRunWedged = true;
    if (!shouldRecord()) return;
    try {
      marker.mark();
    } catch {
      // Best effort: the local diagnostic log still has the wedge line.
    }
  });
}

/**
 * Re-report a wedge an earlier run recorded but could not save, through the one wedge report site
 * (review M045). Call only while this account's reporting is live. The sink saves the report on its
 * own schedule; {@link settleReplayedDbWriteWedge} forgets the record once that save is done, so a
 * kill before the save replays it again instead of losing it. Skipped while this run's own queue is
 * wedged: nothing could be saved, and the record now also stands for this run's wedge. A report
 * the sink skipped because another save was running is retried on the next flush.
 */
export function replayEarlierRunDbWriteWedge(): void {
  if (!earlierRunWedge || thisRunWedged || replayedReport !== null) return;
  const accepted = errorReportSink.acceptedReports;
  reportWriteQueueWedge();
  if (errorReportSink.acceptedReports > accepted) replayedReport = errorReportSink.acceptedReports;
}

/** Forget the record once the replayed report has been saved to the database queue. */
export function settleReplayedDbWriteWedge(): void {
  if (replayedReport === null || errorReportSink.savedReportsThrough < replayedReport) return;
  try {
    clearRecordedDbWriteWedge();
  } catch {
    // The report is saved; a file that would not delete only means one more replay next launch.
  }
}

/**
 * Forget the record: after a saved replay, when error reporting is turned off, and on Disconnect,
 * so one account's record is never replayed under the next. Throws if the file could not be
 * deleted, so Disconnect can treat that as a failed cleanup.
 */
export function clearRecordedDbWriteWedge(): void {
  earlierRunWedge = false;
  replayedReport = null;
  installedMarker?.clear();
}
