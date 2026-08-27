import {
  projectErrorReportTimestamp,
  projectStoredDiagnosticEvent,
  projectStoredErrorReport,
  type LogEntry,
  type PrivacySafeDiagnosticEventReport,
  type PrivacySafeErrorReport,
} from '@core/secure';

interface ShareableDiagnosticLog {
  timestamp: number | null;
  orderTimestamp: number;
  originalIndex: number;
  report: PrivacySafeErrorReport | PrivacySafeDiagnosticEventReport;
}

/**
 * Build newline-delimited JSON for the App Logs share sheet.
 *
 * Only strict ERROR rows and explicitly projected finite INFO events cross this boundary. Every
 * retained row is rebuilt immediately before sharing, so a legacy row cannot smuggle its original
 * message, stack, tag, or metadata into the shared text.
 */
export function formatDiagnosticLogsForShare(entries: LogEntry[]): string {
  const diagnostics: ShareableDiagnosticLog[] = [];

  entries.forEach((entry, originalIndex) => {
    const report =
      entry.level === 'error'
        ? projectStoredErrorReport({
            level: entry.level,
            message: entry.message,
            meta: entry.meta,
          })
        : entry.level === 'info'
          ? projectStoredDiagnosticEvent({ message: entry.message, meta: entry.meta })
          : undefined;
    if (report === undefined) return;

    const projectedTimestamp = projectErrorReportTimestamp(entry.timestamp);
    const timestamp = projectedTimestamp === 0 ? null : projectedTimestamp;
    diagnostics.push({
      timestamp,
      orderTimestamp: timestamp === null ? Number.POSITIVE_INFINITY : entry.timestamp,
      originalIndex,
      report,
    });
  });

  diagnostics.sort(
    (left, right) =>
      left.orderTimestamp - right.orderTimestamp || right.originalIndex - left.originalIndex,
  );

  return diagnostics
    .map(({ timestamp, report }) =>
      JSON.stringify({
        timestamp: timestamp === null ? null : new Date(timestamp).toISOString(),
        level: report.level,
        message: report.message,
        ...(!('stack' in report) || report.stack === undefined ? {} : { stack: report.stack }),
        tag: report.tag,
        meta: JSON.parse(report.meta) as Record<string, unknown>,
      }),
    )
    .join('\n');
}
