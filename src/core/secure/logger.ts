import {
  isVerboseLocalLoggingEnabled,
  RedactingLogger,
  type LogLevel,
  type LogSink,
} from './redact';
import {
  projectCapturedErrorDiagnostic,
  projectErrorReportTimestamp,
  projectStoredErrorReport,
} from './errorDiagnostic';

function capturedErrorSinkValue(
  message: string,
  meta?: unknown,
): { message: string; meta: unknown } {
  const diagnostic = projectCapturedErrorDiagnostic(message, meta);
  return {
    message: diagnostic.message,
    meta: {
      ...diagnostic.meta,
      ...(diagnostic.stack === undefined ? {} : { stack: diagnostic.stack }),
    },
  };
}

function storedErrorSinkValue(entry: LogEntry): LogEntry | undefined {
  const timestamp = projectErrorReportTimestamp(entry.timestamp);
  if (timestamp === 0) return undefined;
  const report = projectStoredErrorReport({ message: entry.message, meta: entry.meta });
  const meta = {
    ...(JSON.parse(report.meta) as Record<string, unknown>),
    ...(report.stack === undefined ? {} : { stack: report.stack }),
  };
  return {
    level: 'error',
    message: report.message,
    meta: boundedLogMeta(meta),
    timestamp,
  };
}

/**
 * Console sink for the app-wide logger. Privacy projection/redaction already happened upstream in
 * {@link RedactingLogger}, so this just routes to the right console method. Free-form
 * debug/info/warn lines are development-only until they have finite schemas.
 */
export class ConsoleSink implements LogSink {
  write(level: LogLevel, message: string, meta?: unknown): void {
    if (level !== 'error' && !isVerboseLocalLoggingEnabled()) return;
    const safe = level === 'error' ? capturedErrorSinkValue(message, meta) : { message, meta };
    const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    if (safe.meta === undefined) out(safe.message);
    else out(safe.message, safe.meta);
  }
}

/** One captured log line (already privacy-projected/redacted upstream). */
export interface LogEntry {
  level: LogLevel;
  message: string;
  /** Stringified meta (when present) — kept small for the in-app viewer. */
  meta?: string;
  timestamp: number;
}

const MEMORY_LOG_CAPACITY = 500;
export const MAX_LOG_MESSAGE_CHARS = 4_000;
export const MAX_LOG_META_CHARS = 500;

/** Bound retained diagnostics even when an upstream/native error contains an enormous payload. */
export function boundedLogMessage(message: string): string {
  return message.slice(0, MAX_LOG_MESSAGE_CHARS);
}

/** Serialize and bound optional metadata before either memory or disk retains it. */
export function boundedLogMeta(meta: unknown): string | undefined {
  try {
    const serialized = typeof meta === 'string' ? meta : JSON.stringify(meta);
    return serialized?.slice(0, MAX_LOG_META_CHARS);
  } catch {
    try {
      return String(meta).slice(0, MAX_LOG_META_CHARS);
    } catch {
      return undefined;
    }
  }
}

/**
 * In-memory ring buffer of the last {@link MEMORY_LOG_CAPACITY} log lines, powering the in-app
 * log viewer (Settings → App Logs). ERROR entries arrive as finite structured diagnostics.
 * Free-form debug/info/warn entries are retained in development only.
 */
export class MemorySink implements LogSink {
  private buf: LogEntry[] = [];

  write(level: LogLevel, message: string, meta?: unknown): void {
    if (level !== 'error' && !isVerboseLocalLoggingEnabled()) return;
    const safe = level === 'error' ? capturedErrorSinkValue(message, meta) : { message, meta };
    const metaStr = safe.meta === undefined ? undefined : boundedLogMeta(safe.meta);
    const now = Date.now();
    this.buf.push({
      level,
      message: boundedLogMessage(safe.message),
      ...(metaStr === undefined ? {} : { meta: metaStr }),
      timestamp: level === 'error' ? projectErrorReportTimestamp(now) : now,
    });
    if (this.buf.length > MEMORY_LOG_CAPACITY)
      this.buf.splice(0, this.buf.length - MEMORY_LOG_CAPACITY);
  }

  /** Newest-first snapshot. */
  entries(): LogEntry[] {
    return [...this.buf].reverse();
  }

  /**
   * Seed the buffer with older (oldest-first) entries restored from disk at boot, so the in-app
   * viewer shows prior sessions. Prepended (they precede this session's lines), then capped to the
   * newest {@link MEMORY_LOG_CAPACITY}.
   */
  hydrate(entries: LogEntry[]): void {
    if (entries.length === 0) return;
    // Persisted non-error rows came from the old free-form policy. Never restore them into the
    // viewer/share surface, even in a development build.
    const boundedEntries = entries
      .filter((entry) => entry.level === 'error')
      .map(storedErrorSinkValue)
      .filter((entry): entry is LogEntry => entry !== undefined);
    this.buf = [...boundedEntries, ...this.buf];
    if (this.buf.length > MEMORY_LOG_CAPACITY)
      this.buf.splice(0, this.buf.length - MEMORY_LOG_CAPACITY);
  }

  clear(): void {
    this.buf = [];
  }
}

/** Fan a log line out to several sinks (console + the in-memory viewer buffer + a disk sink). */
export class TeeSink implements LogSink {
  private readonly sinks: LogSink[];
  constructor(...sinks: LogSink[]) {
    this.sinks = sinks;
  }
  /** Attach a sink after construction (e.g. the persistent file sink, wired up at boot). */
  add(sink: LogSink): void {
    if (!this.sinks.includes(sink)) this.sinks.push(sink);
  }
  write(level: LogLevel, message: string, meta?: unknown): void {
    if (level !== 'error' && !isVerboseLocalLoggingEnabled()) return;
    // Defend future/injected sinks even when a caller somehow bypasses RedactingLogger and reaches
    // the tee singleton directly. Built-in sinks reproject again, so this remains idempotent.
    const safe = level === 'error' ? capturedErrorSinkValue(message, meta) : { message, meta };
    for (const s of this.sinks) s.write(level, safe.message, safe.meta);
  }
}

/** The viewer's buffer (module singleton so the screen can read/clear it). */
export const memoryLogSink = new MemorySink();

/**
 * The app-wide logger. ERROR calls are rebuilt as finite structured diagnostics. Free-form
 * debug/info/warn calls remain visible in development but are dropped before every release sink;
 * LOG-01 tracks replacing selected high-value lines with finite event schemas.
 *
 * To add Sentry later: wrap this sink (or add a second one) that forwards the
 * already-projected/redacted message as a breadcrumb — see RELEASE_CHECKLIST §9.2.
 */
export const logSinks = new TeeSink(new ConsoleSink(), memoryLogSink);
export const logger = new RedactingLogger(logSinks);
