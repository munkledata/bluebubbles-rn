import { logSinks, memoryLogSink, type LogEntry, type LogLevel, type LogSink } from '@core/secure';

/**
 * Persistent log sink: writes the app logger's ALREADY-redacted lines to a capped file so the
 * in-app viewer survives an app close/reopen (the {@link MemorySink} alone is heap-only and is
 * wiped when the JS context is destroyed).
 *
 * Design notes:
 * - Lives OUTSIDE `src/core` (which must stay React-Native-free) and is INJECTED into the core
 *   logger's TeeSink at boot — core never imports expo-file-system.
 * - `expo-file-system` is imported LAZILY inside the async file ops, so merely importing this
 *   module (e.g. under Node/jest) never pulls the native module; only `init/flush/clear` touch it,
 *   and they're guarded so a missing/failed FS is a no-op, not a crash.
 * - `write()` stays synchronous (the LogSink contract): it only buffers in memory + schedules a
 *   debounced flush, so logging is never blocked on disk I/O.
 * - Capped by entry count (a ring), so the file can't grow unbounded.
 */
const LOG_FILE = 'app-logs.json';
const FILE_LOG_CAPACITY = 500;
const FLUSH_DELAY_MS = 1500;

export class FileLogSink implements LogSink {
  private buf: LogEntry[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

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
    if (this.buf.length > FILE_LOG_CAPACITY)
      this.buf.splice(0, this.buf.length - FILE_LOG_CAPACITY);
    this.scheduleFlush();
  }

  /** Oldest-first snapshot of the buffered entries (used to seed the viewer at boot). */
  all(): LogEntry[] {
    return [...this.buf];
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer != null) return; // a flush is already pending — coalesce
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_DELAY_MS);
  }

  /** Write the current buffer to disk (best-effort). */
  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      const { File, Paths } = await import('expo-file-system');
      const file = new File(Paths.document, LOG_FILE);
      if (file.exists) file.delete();
      file.create();
      file.write(JSON.stringify(this.buf));
    } catch {
      // best-effort — losing persisted logs is never worth crashing or surfacing
    }
  }

  /**
   * Read the persisted file into the buffer (call ONCE at boot, on-device). Returns the restored
   * entries oldest-first so the caller can seed the in-memory viewer buffer. A missing/corrupt file
   * yields [] (start fresh).
   */
  async init(): Promise<LogEntry[]> {
    try {
      const { File, Paths } = await import('expo-file-system');
      const file = new File(Paths.document, LOG_FILE);
      if (!file.exists) return [];
      const parsed: unknown = JSON.parse(await file.text());
      if (Array.isArray(parsed)) {
        this.buf = (parsed as LogEntry[]).slice(-FILE_LOG_CAPACITY);
        return [...this.buf];
      }
    } catch {
      // corrupt/unreadable file — start fresh
    }
    return [];
  }

  /** Clear the buffer AND delete the on-disk file (so the viewer's "Clear" purges history too). */
  async clear(): Promise<void> {
    this.buf = [];
    this.dirty = false;
    if (this.flushTimer != null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      const { File, Paths } = await import('expo-file-system');
      const file = new File(Paths.document, LOG_FILE);
      if (file.exists) file.delete();
    } catch {
      // best-effort
    }
  }
}

/** The persistent sink singleton (so the log viewer's Clear can reach it). */
export const fileLogSink = new FileLogSink();

/**
 * Wire up persistent logging: restore the previous session's lines into the in-app viewer, then
 * attach the file sink so new (already-redacted) lines are written to disk too. Call once at boot
 * (on-device). Fire-and-forget — a failure just means logs aren't persisted this run.
 */
export async function initPersistentLogs(): Promise<void> {
  const persisted = await fileLogSink.init();
  if (persisted.length > 0) memoryLogSink.hydrate(persisted);
  logSinks.add(fileLogSink);
}
