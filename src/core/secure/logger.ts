import {
  isVerboseLocalLoggingEnabled,
  RedactingLogger,
  type LogLevel,
  type LogSink,
} from './redact';
import {
  projectCapturedDiagnosticEvent,
  projectCapturedErrorDiagnostic,
  projectErrorReportTimestamp,
  projectStoredDiagnosticEvent,
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

function capturedDiagnosticEventSinkValue(
  message: string,
  meta?: unknown,
): { message: string; meta: unknown } | undefined {
  const event = projectCapturedDiagnosticEvent(message, meta);
  return event === undefined ? undefined : { message: event.message, meta: event.meta };
}

function retainedSinkValue(
  level: LogLevel,
  message: string,
  meta?: unknown,
): { message: string; meta: unknown; finite: boolean } | undefined {
  if (level === 'error') return { ...capturedErrorSinkValue(message, meta), finite: true };
  const event = level === 'info' ? capturedDiagnosticEventSinkValue(message, meta) : undefined;
  if (event !== undefined) return { ...event, finite: true };
  return isVerboseLocalLoggingEnabled() ? { message, meta, finite: false } : undefined;
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

function storedLogSinkValue(entry: LogEntry): LogEntry | undefined {
  if (entry.level === 'error') return storedErrorSinkValue(entry);
  if (entry.level !== 'info') return undefined;
  const timestamp = projectErrorReportTimestamp(entry.timestamp);
  if (timestamp === 0) return undefined;
  const event = projectStoredDiagnosticEvent({ message: entry.message, meta: entry.meta });
  if (event === undefined) return undefined;
  return {
    level: 'info',
    message: event.message,
    meta: boundedLogMeta(JSON.parse(event.meta) as Record<string, unknown>),
    timestamp,
  };
}

/**
 * Console sink for the app-wide logger. Privacy projection/redaction already happened upstream in
 * {@link RedactingLogger}, so this just routes to the right console method. Release console output
 * remains ERROR-only; selected finite INFO events are retained by memory/file sinks and appear on
 * the console only in development.
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
 * log viewer (Settings → App Logs). ERROR entries and selected INFO events arrive as finite
 * structured diagnostics. Free-form debug/info/warn entries are retained in development only.
 */
export class MemorySink implements LogSink {
  private buf: LogEntry[] = [];

  write(level: LogLevel, message: string, meta?: unknown): void {
    const safe = retainedSinkValue(level, message, meta);
    if (safe === undefined) return;
    const metaStr = safe.meta === undefined ? undefined : boundedLogMeta(safe.meta);
    const now = Date.now();
    this.buf.push({
      level,
      message: boundedLogMessage(safe.message),
      ...(metaStr === undefined ? {} : { meta: metaStr }),
      timestamp: safe.finite ? projectErrorReportTimestamp(now) : now,
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
    // Restore only strict ERROR rows and explicitly projected finite INFO events. Every legacy
    // free-form non-error row remains excluded, even in a development build.
    const boundedEntries = entries
      .map(storedLogSinkValue)
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
    const safe = retainedSinkValue(level, message, meta);
    if (safe === undefined) return;
    // Defend future/injected sinks even when a caller somehow bypasses RedactingLogger and reaches
    // the tee singleton directly. Built-in sinks reproject again, so this remains idempotent.
    for (const s of this.sinks) s.write(level, safe.message, safe.meta);
  }
}

/** The viewer's buffer (module singleton so the screen can read/clear it). */
export const memoryLogSink = new MemorySink();

/**
 * The app-wide logger. ERROR calls and selected event calls are rebuilt as finite structured
 * diagnostics. Free-form debug/info/warn calls remain visible in development but are dropped
 * before every release sink.
 *
 * To add Sentry later: wrap this sink (or add a second one) that forwards the
 * already-projected/redacted message as a breadcrumb — see RELEASE_CHECKLIST §9.2.
 */
export const logSinks = new TeeSink(new ConsoleSink(), memoryLogSink);
export const logger = new RedactingLogger(logSinks);
