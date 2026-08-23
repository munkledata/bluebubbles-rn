import {
  projectErrorReportTimestamp,
  projectStoredErrorReport,
  type LogEntry,
  type PrivacySafeErrorReport,
} from '@core/secure';

interface ShareableErrorLog {
  timestamp: number | null;
  orderTimestamp: number;
  originalIndex: number;
  report: PrivacySafeErrorReport;
}

/**
 * Build newline-delimited JSON for the App Logs share sheet.
 *
 * Only ERROR rows cross this export boundary. Every retained row is rebuilt through the same
 * strict projector used by the durable error-report queue, so a legacy row cannot smuggle its
 * original message, stack, tag, or metadata into the shared text.
 */
export function formatErrorLogsForShare(entries: LogEntry[]): string {
  const errors: ShareableErrorLog[] = [];

  entries.forEach((entry, originalIndex) => {
    if (entry.level !== 'error') return;

    const projectedTimestamp = projectErrorReportTimestamp(entry.timestamp);
    const timestamp = projectedTimestamp === 0 ? null : projectedTimestamp;
    errors.push({
      timestamp,
      orderTimestamp: timestamp === null ? Number.POSITIVE_INFINITY : entry.timestamp,
      originalIndex,
      report: projectStoredErrorReport({
        level: entry.level,
        message: entry.message,
        meta: entry.meta,
      }),
    });
  });

  errors.sort(
    (left, right) =>
      left.orderTimestamp - right.orderTimestamp || right.originalIndex - left.originalIndex,
  );

  return errors
    .map(({ timestamp, report }) =>
      JSON.stringify({
        timestamp: timestamp === null ? null : new Date(timestamp).toISOString(),
        level: report.level,
        message: report.message,
        ...(report.stack === undefined ? {} : { stack: report.stack }),
        tag: report.tag,
        meta: JSON.parse(report.meta) as Record<string, unknown>,
      }),
    )
    .join('\n');
}
