import { logger, type LogLevel, type LogSink } from '@core/secure';
import { getDatabase } from '@db/database';
import { insertErrorReport } from '@db/repositories';

/**
 * Error-capture sink + funnel.
 *
 * A {@link LogSink} that captures ERROR-level log lines (already redacted upstream by
 * {@link RedactingLogger}) into the durable, uploadable `error_reports` queue. It buffers
 * synchronously in a bounded in-memory ring (the LogSink contract is sync + non-blocking, but
 * op-sqlite writes are async), then debounced-drains to the DB once it's open — the same
 * buffer-then-lazy-flush shape as {@link FileLogSink}. Lives OUTSIDE `src/core` so it can touch the
 * DB; injected into the core logger's TeeSink at boot via `logSinks.add(errorReportSink)`.
 *
 * Feedback-loop safety: only `error` level is captured, the uploader's own `[errorReport]` warnings
 * are hard-skipped, and a re-entrancy/draining guard drops any error logged during our own enqueue
 * or DB drain — so a failed upload (or a DB write error) can never enqueue another report.
 */
const RING_CAPACITY = 200;
const DRAIN_DELAY_MS = 1000;

interface PendingReport {
  level: string;
  message: string;
  stack?: string;
  tag?: string;
  meta?: string;
  createdAt: number;
}

/** The `xxx` from a `[xxx] …` log message — the category the server fingerprints on. */
function tagFromMessage(message: string): string | undefined {
  const m = /^\[([^\]]+)\]/.exec(message);
  return m ? m[1] : undefined;
}

/**
 * Pull a stack string out of the redacted meta. After the Error-aware redaction, a raw Error meta
 * is `{ name, message, stack }` and an ErrorBoundary meta is `{ error: { …, stack }, componentStack }`.
 */
function stackFromMeta(meta: unknown): string | undefined {
  if (meta == null || typeof meta !== 'object') return undefined;
  const o = meta as Record<string, unknown>;
  if (typeof o.stack === 'string') return o.stack;
  const nested = o.error;
  if (nested != null && typeof nested === 'object') {
    const s = (nested as Record<string, unknown>).stack;
    if (typeof s === 'string') return s;
  }
  return undefined;
}

function stringifyMeta(meta: unknown): string | undefined {
  if (meta === undefined) return undefined;
  try {
    return typeof meta === 'string' ? meta : (JSON.stringify(meta)?.slice(0, 2000) ?? undefined);
  } catch {
    return String(meta);
  }
}

export class ErrorReportSink implements LogSink {
  private ring: PendingReport[] = [];
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private busy = false; // true while enqueuing OR draining — drops re-entrant error logs

  write(level: LogLevel, message: string, meta?: unknown): void {
    if (level !== 'error') return;
    if (this.busy) return; // an error logged during our own enqueue/drain — ignore (loop guard)
    if (message.startsWith('[errorReport]')) return; // never capture our own upload-path logs
    this.busy = true;
    try {
      this.ring.push({
        level,
        message,
        stack: stackFromMeta(meta),
        tag: tagFromMessage(message),
        meta: stringifyMeta(meta),
        createdAt: Date.now(),
      });
      if (this.ring.length > RING_CAPACITY) this.ring.splice(0, this.ring.length - RING_CAPACITY);
      this.scheduleDrain();
    } catch {
      // capturing an error must never throw
    } finally {
      this.busy = false;
    }
  }

  private scheduleDrain(): void {
    if (this.drainTimer != null) return; // coalesce
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      void this.flushToDb();
    }, DRAIN_DELAY_MS);
  }

  /**
   * Persist buffered reports into the encrypted `error_reports` table (best-effort). If the DB
   * isn't open yet the reports stay buffered and are retried on the next drain. Callable directly
   * (e.g. on a fatal error, to race the crash, or before an upload flush).
   */
  async flushToDb(): Promise<void> {
    if (this.ring.length === 0 || this.busy) return;
    let db;
    try {
      db = getDatabase();
    } catch {
      return; // DB not open yet — keep buffered, retry next drain
    }
    this.busy = true; // ignore any error logged by the DB layer during our inserts (loop guard)
    const batch = this.ring;
    this.ring = [];
    try {
      for (const r of batch) {
        try {
          await insertErrorReport(db, r);
        } catch {
          // a single failed insert: drop that row rather than risk an unbounded retry loop
        }
      }
    } finally {
      this.busy = false;
    }
  }
}

export const errorReportSink = new ErrorReportSink();

function normalizeError(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return { name: err.name || 'Error', message: err.message || String(err), stack: err.stack };
  }
  if (typeof err === 'string') return { name: 'Error', message: err };
  try {
    return { name: 'Error', message: JSON.stringify(err) ?? String(err) };
  } catch {
    return { name: 'Error', message: String(err) };
  }
}

/**
 * Funnel a raw error/reason into the report queue via the redacting logger. Used by the global
 * uncaught-error + unhandled-rejection handlers (and available for any explicit capture). `origin`
 * becomes the `[origin]` tag the server fingerprints on. On a fatal error, immediately drains to
 * the DB to race the crash. Never throws.
 */
export function captureError(err: unknown, origin: string, opts?: { fatal?: boolean }): void {
  try {
    const e = normalizeError(err);
    // Route through logger.error so the message + error are redacted and the sink enqueues them —
    // a single capture path. Pass the raw Error (redaction flattens it to {name,message,stack}).
    logger.error(`[${origin}] ${e.name}: ${e.message}`, err instanceof Error ? err : e);
    if (opts?.fatal) void errorReportSink.flushToDb();
  } catch {
    // never throw from the error-capture path
  }
}
