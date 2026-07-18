import { RedactingLogger, type LogLevel, type LogSink } from './redact';

/**
 * Console sink for the app-wide logger. Redaction already happened upstream in
 * {@link RedactingLogger}, so this just routes to the right console method.
 * `debug` is suppressed in production builds (kept quiet, never to a release log).
 */
export class ConsoleSink implements LogSink {
  write(level: LogLevel, message: string, meta?: unknown): void {
    // `__DEV__` is a RN runtime global; guard `typeof` since it's undefined under Jest.
    const isDev = typeof __DEV__ !== 'undefined' && __DEV__;
    if (level === 'debug' && !isDev) return;
    const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    if (meta === undefined) out(message);
    else out(message, meta);
  }
}

/** One captured log line (already redacted upstream). */
export interface LogEntry {
  level: LogLevel;
  message: string;
  /** Stringified meta (when present) — kept small for the in-app viewer. */
  meta?: string;
  timestamp: number;
}

const MEMORY_LOG_CAPACITY = 500;

/**
 * In-memory ring buffer of the last {@link MEMORY_LOG_CAPACITY} log lines, powering the in-app
 * log viewer (Settings → App Logs). Entries arrive ALREADY redacted (this sink sits behind
 * RedactingLogger), so showing/sharing them can't leak guids/tokens. Debug lines are kept here
 * even in prod (unlike the console sink) — they're often exactly what a bug report needs.
 */
export class MemorySink implements LogSink {
  private buf: LogEntry[] = [];

  write(level: LogLevel, message: string, meta?: unknown): void {
    let metaStr: string | undefined;
    if (meta !== undefined) {
      try {
        metaStr = typeof meta === 'string' ? meta : JSON.stringify(meta)?.slice(0, 500);
      } catch {
        metaStr = String(meta);
      }
    }
    this.buf.push({ level, message, meta: metaStr, timestamp: Date.now() });
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
    this.buf = [...entries, ...this.buf];
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
    this.sinks.push(sink);
  }
  write(level: LogLevel, message: string, meta?: unknown): void {
    for (const s of this.sinks) s.write(level, message, meta);
  }
}

/** The viewer's buffer (module singleton so the screen can read/clear it). */
export const memoryLogSink = new MemorySink();

/**
 * The app-wide logger. EVERY message + meta object is scrubbed (guid / password /
 * token / fcmtoken / authorization keys, and `?guid=`-style URL params) before it
 * reaches any sink. Use this instead of `console.*` everywhere so nothing sensitive
 * can leak to logcat / a release log / a future Sentry breadcrumb.
 *
 * To add Sentry later: wrap this sink (or add a second one) that forwards the
 * already-redacted message as a breadcrumb — see RELEASE_CHECKLIST §9.2.
 */
export const logSinks = new TeeSink(new ConsoleSink(), memoryLogSink);
export const logger = new RedactingLogger(logSinks);
