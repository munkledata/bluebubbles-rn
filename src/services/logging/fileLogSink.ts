import {
  boundedLogMessage,
  boundedLogMeta,
  isVerboseLocalLoggingEnabled,
  logSinks,
  memoryLogSink,
  projectCapturedErrorReport,
  projectErrorReportTimestamp,
  projectStoredErrorReport,
  type LogEntry,
  type LogLevel,
  type LogSink,
} from '@core/secure';

/**
 * Persistent log sink: writes strictly projected ERROR lines, plus development-only local lines,
 * to a capped file so the in-app viewer survives an app close/reopen (the {@link MemorySink} alone
 * is heap-only and is wiped when the JS context is destroyed). Restore always drops historical
 * non-error rows, so a release candidate cannot inherit the old free-form plaintext history.
 *
 * Design notes:
 * - Lives OUTSIDE `src/core` (which must stay React-Native-free) and is INJECTED into the core
 *   logger's TeeSink at boot — core never imports expo-file-system.
 * - `expo-file-system` is imported LAZILY inside the async file ops, so merely importing this
 *   module (e.g. under Node/jest) never pulls the native module; only `init/flush/clear` touch it.
 *   Asynchronous imports/reads are time-bounded; Expo's synchronous info/write/delete calls cannot
 *   be interrupted by a JavaScript timer. Startup fails visibly when it cannot prove an old
 *   plaintext file absent or removed; ordinary flush/clear failures stay non-crashing and report
 *   failure.
 * - `write()` stays synchronous (the LogSink contract): it only buffers in memory + schedules a
 *   debounced flush, so logging is never blocked on disk I/O.
 * - Capped by entry count (a ring), so the file can't grow unbounded.
 */
const LOG_FILE = 'app-logs.json';
const FILE_LOG_CAPACITY = 500;
const FLUSH_DELAY_MS = 1500;
const MAX_AUTOMATIC_FLUSH_RETRIES = 2;
const HEADLESS_FLUSH_MAX_ATTEMPTS = 3;
/** Far above an ordinary 500-line log, but still prevents an unbounded startup read. */
export const MAX_PERSISTED_LOG_FILE_BYTES = 4 * 1024 * 1024;
/** Native file promises have hung on some providers; never let one wedge Clear for this process. */
export const FILE_LOG_OPERATION_TIMEOUT_MS = 5_000;

interface LogFileHandle {
  delete(): void;
  info(): { exists: boolean; size?: number };
  write(contents: string): void;
  text(): Promise<string>;
}

type ReplaceLogFileResult = 'written' | 'deleted' | 'failed';

/**
 * Bound one serialized native file operation and deactivate its late continuation after timeout.
 * Callers must check `isActive()` after every await and immediately before a file mutation.
 */
function runBoundedFileOperation<T>(
  operation: (isActive: () => boolean) => Promise<T>,
): Promise<T> {
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = operation(() => active);

  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      active = false;
      reject(new Error('persistent-log-operation-timed-out'));
    }, FILE_LOG_OPERATION_TIMEOUT_MS);

    work.then(
      (value) => {
        if (!active) return;
        active = false;
        if (timer !== undefined) clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (!active) return;
        active = false;
        if (timer !== undefined) clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Delete a possibly-private legacy file and positively confirm that it is gone.
 *
 * Expo's `File.exists === false` is ambiguous: it also means the app lacks read permission. A
 * successful `delete()` is itself confirmation; when delete reports "missing", `info()` is the
 * permission-validating absence check. Never treat the convenience getter as proof.
 */
function deleteLogFileBestEffort(file: LogFileHandle): boolean {
  try {
    file.delete();
    return true;
  } catch {}
  try {
    return file.info().exists === false;
  } catch {}
  return false;
}

/** Replace legacy contents, falling back to confirmed deletion if writing is unavailable. */
function replaceOrDeleteLogFile(file: LogFileHandle, contents: string): ReplaceLogFileResult {
  try {
    // The modern File API truncates by default and creates an absent file. Avoid a delete/create
    // gap that could lose the prior safe log merely because a replacement write then fails.
    file.write(contents);
    return 'written';
  } catch {
    return deleteLogFileBestEffort(file) ? 'deleted' : 'failed';
  }
}

/** Rebuild ERROR rows and discard every older free-form level during an upgrade restore. */
function sanitizePersistedEntries(value: unknown): LogEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: LogEntry[] = [];
  for (const candidate of value) {
    if (candidate === null || typeof candidate !== 'object') continue;
    const raw = candidate as Record<string, unknown>;
    if (raw.level !== 'error' || typeof raw.message !== 'string') continue;
    if (typeof raw.timestamp !== 'number') continue;
    const timestamp = projectErrorReportTimestamp(raw.timestamp);
    if (timestamp === 0) continue;
    const safe = projectStoredErrorReport({
      message: raw.message,
      meta: typeof raw.meta === 'string' ? raw.meta : null,
    });
    const canonicalMeta = {
      ...(JSON.parse(safe.meta) as Record<string, unknown>),
      ...(safe.stack === undefined ? {} : { stack: safe.stack }),
    };
    entries.push({
      level: 'error',
      message: safe.message,
      meta: boundedLogMeta(canonicalMeta),
      timestamp,
    });
  }
  return entries.slice(-FILE_LOG_CAPACITY);
}

export class FileLogSink implements LogSink {
  private buf: LogEntry[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private consecutiveFlushFailures = 0;
  /** Survives route remounts, but deliberately resets with the process on a real restart. */
  private cleanupConfirmedForProcess = false;
  /** Serializes every disk operation so a late read/write cannot cross a successful clear(). */
  private diskTail: Promise<void> = Promise.resolve();
  /** Invalidates a boot-time init/read that was already in flight when account teardown cleared. */
  private contentGeneration = 0;

  write(level: LogLevel, message: string, meta?: unknown): void {
    if (level !== 'error' && !isVerboseLocalLoggingEnabled()) return;
    const safeError = level === 'error' ? projectCapturedErrorReport(message, meta) : undefined;
    const retainedMessage = safeError?.message ?? message;
    const retainedMeta =
      safeError === undefined
        ? meta
        : {
            ...(JSON.parse(safeError.meta) as Record<string, unknown>),
            ...(safeError.stack === undefined ? {} : { stack: safeError.stack }),
          };
    const metaStr = retainedMeta === undefined ? undefined : boundedLogMeta(retainedMeta);
    const now = Date.now();
    this.buf.push({
      level,
      message: boundedLogMessage(retainedMessage),
      ...(metaStr === undefined ? {} : { meta: metaStr }),
      timestamp: level === 'error' ? projectErrorReportTimestamp(now) : now,
    });
    if (this.buf.length > FILE_LOG_CAPACITY)
      this.buf.splice(0, this.buf.length - FILE_LOG_CAPACITY);
    this.consecutiveFlushFailures = 0;
    this.scheduleFlush();
  }

  /** Oldest-first snapshot of the buffered entries (used to seed the viewer at boot). */
  all(): LogEntry[] {
    return [...this.buf];
  }

  /** Whether native storage positively confirmed a successful Clear in this process. */
  hasConfirmedCleanup(): boolean {
    return this.cleanupConfirmedForProcess;
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer != null) return; // a flush is already pending — coalesce
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_DELAY_MS);
  }

  private resetBuffer(): void {
    this.buf = [];
    this.dirty = false;
    this.consecutiveFlushFailures = 0;
    if (this.flushTimer != null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private enqueueDiskOperation<T>(operation: (isActive: () => boolean) => Promise<T>): Promise<T> {
    const run = (): Promise<T> => runBoundedFileOperation(operation);
    const result = this.diskTail.then(run, run);
    // Keep a non-rejecting tail: callers still receive the real result, while one failed native
    // operation cannot poison every later flush/clear.
    this.diskTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Join every disk operation that was appended while this method was waiting. */
  private async waitForDiskQueue(): Promise<void> {
    let observedTail = this.diskTail;
    await observedTail;
    while (observedTail !== this.diskTail) {
      observedTail = this.diskTail;
      await observedTail;
    }
  }

  /** Write the current buffer to disk. Returns false after a bounded native failure. */
  async flush(): Promise<boolean> {
    if (!this.dirty) {
      // `dirty` is cleared before an enqueued flush finishes. An explicit headless flush must join
      // that existing write rather than letting its native callback settle while persistence is
      // still in flight. The first write may also fail and mark the buffer dirty again.
      await this.waitForDiskQueue();
      if (!this.dirty) return true;
    }
    const generation = this.contentGeneration;
    this.dirty = false;
    let persisted = false;
    try {
      persisted = await this.enqueueDiskOperation(async (isActive) => {
        // Capture only after earlier queued operations (notably init) have settled. Otherwise a
        // flush scheduled while init's file read was pending would overwrite the restored history
        // with the smaller pre-init buffer.
        const snapshot = [...this.buf];
        const { File, Paths } = await import('expo-file-system');
        if (!isActive() || generation !== this.contentGeneration) return true;
        const file = new File(Paths.document, LOG_FILE) as LogFileHandle;
        if (!isActive() || generation !== this.contentGeneration) return true;
        return replaceOrDeleteLogFile(file, JSON.stringify(snapshot)) === 'written';
      });
    } catch {
      persisted = false;
    }

    if (generation !== this.contentGeneration) return true;
    if (persisted) {
      this.consecutiveFlushFailures = 0;
      return true;
    }

    // Keep the unsaved snapshot eligible for an explicit retry. Automatically retry a bounded
    // number of times; a later new line resets this budget and schedules another attempt.
    this.dirty = true;
    this.consecutiveFlushFailures += 1;
    if (this.consecutiveFlushFailures <= MAX_AUTOMATIC_FLUSH_RETRIES) this.scheduleFlush();
    return false;
  }

  /**
   * Read the persisted file into the buffer (call ONCE at boot, on-device). Returns the restored
   * entries oldest-first so the caller can seed the in-memory viewer buffer. A missing/corrupt file
   * yields [] (start fresh) after deletion is confirmed; if unsafe legacy bytes can neither be
   * replaced nor deleted, it rejects so boot can surface the incomplete privacy cleanup.
   */
  async init(): Promise<LogEntry[]> {
    return this.initAtGeneration(this.contentGeneration);
  }

  private initAtGeneration(generation: number): Promise<LogEntry[]> {
    return this.enqueueDiskOperation(async (isActive) => {
      let file: LogFileHandle | undefined;
      try {
        const { File, Paths } = await import('expo-file-system');
        if (!isActive()) return [];
        file = new File(Paths.document, LOG_FILE) as LogFileHandle;
        const info = file.info();
        if (!info.exists) return [];
        const bytes = info.size;
        if (
          typeof bytes !== 'number' ||
          !Number.isSafeInteger(bytes) ||
          bytes < 0 ||
          bytes > MAX_PERSISTED_LOG_FILE_BYTES
        ) {
          // A corrupt/legacy oversized plaintext file can exhaust the JS heap before JSON parsing.
          // It is diagnostic cache only, so deleting it is safer than attempting recovery.
          if (!deleteLogFileBestEffort(file)) throw new Error('persistent-log-cleanup-failed');
          return [];
        }
        const contents = await file.text();
        if (!isActive()) return [];
        // clear() revokes a pending read before waiting behind it on diskTail. That stale account's
        // file must neither refill this buffer nor be returned to hydrate the in-memory viewer.
        if (generation !== this.contentGeneration) return [];
        let parsed: unknown;
        try {
          parsed = JSON.parse(contents);
        } catch {
          // A partial/corrupt plaintext log can still contain private fragments. Drop it instead of
          // repeatedly leaving an unreadable legacy file at rest.
          if (!deleteLogFileBestEffort(file)) throw new Error('persistent-log-cleanup-failed');
          return [];
        }
        if (!Array.isArray(parsed)) {
          if (!deleteLogFileBestEffort(file)) throw new Error('persistent-log-cleanup-failed');
          return [];
        }
        const restored = sanitizePersistedEntries(parsed);
        // Preserve entries written while native file.text() was pending. Restored entries are
        // older, so they belong before this run's current buffer.
        const merged = [...restored, ...this.buf].slice(-FILE_LOG_CAPACITY);
        // The file may have been written by an older, weaker redactor. Replace it now so raw
        // legacy identifiers do not remain at rest until some unrelated future log triggers a
        // flush. Losing this best-effort rewrite is safer than failing the in-memory restore.
        if (replaceOrDeleteLogFile(file, JSON.stringify(merged)) === 'failed') {
          throw new Error('persistent-log-cleanup-failed');
        }
        this.buf = merged;
        return [...restored];
      } catch {
        // A timed-out operation is already fenced. Its late continuation must not mutate a file
        // that a newer clear/flush may own.
        if (!isActive()) return [];
        // Once a file handle exists, a read/size/native failure may still leave old plaintext.
        // Confirm its deletion or reject so boot can surface the incomplete privacy cleanup.
        if (file !== undefined && !deleteLogFileBestEffort(file)) {
          throw new Error('persistent-log-cleanup-failed');
        }
        // Before a handle exists we cannot prove that an upgrade-time legacy file is absent.
        if (file === undefined) throw new Error('persistent-log-cleanup-failed');
      }
      return [];
    });
  }

  /** Restore disk history without a clear-vs-hydrate check/use race. */
  async restore(hydrate: (entries: LogEntry[]) => void): Promise<void> {
    const generation = this.contentGeneration;
    const persisted = await this.initAtGeneration(generation);
    // The check and callback are synchronous, so clear() cannot interleave between them.
    if (generation !== this.contentGeneration || persisted.length === 0) return;
    hydrate(persisted);
  }

  /** Clear the buffer AND delete the on-disk file (so the viewer's "Clear" purges history too). */
  async clear(): Promise<boolean> {
    this.contentGeneration += 1;
    this.resetBuffer();
    let cleared = false;
    try {
      cleared = await this.enqueueDiskOperation(async (isActive) => {
        // Writes can land while clear waits behind an already-running init/flush. They still belong
        // to the retiring generation, so reset again at the serialized teardown boundary.
        this.resetBuffer();
        try {
          const { File, Paths } = await import('expo-file-system');
          if (!isActive()) return false;
          const file = new File(Paths.document, LOG_FILE) as LogFileHandle;
          if (!isActive()) return false;
          return deleteLogFileBestEffort(file);
        } catch {
          return false;
        }
      });
    } catch {
      cleared = false;
    } finally {
      // The native import/read above yields. Clear any retiring-account line that arrived while it
      // was pending, even on timeout, and cancel the flush that line scheduled before returning.
      this.resetBuffer();
    }
    if (cleared) this.cleanupConfirmedForProcess = true;
    return cleared;
  }
}

/** The persistent sink singleton (so the log viewer's Clear can reach it). */
export const fileLogSink = new FileLogSink();
let persistentLogInitialization: Promise<void> | null = null;

/**
 * Best-effort persistence barrier for an Android headless callback before its promise settles.
 * Immediate retries avoid depending on the ordinary debounce timer, which the OS may never let run
 * after task completion. This is deliberately finite and returns false when the current buffered
 * snapshot cannot be persisted. A true result does not attest that a separate legacy-file restore
 * succeeded; callers use this in `finally` and must not turn a logging failure into task failure.
 */
export async function flushPersistentLogsForHeadlessCompletion(): Promise<boolean> {
  for (let attempt = 0; attempt < HEADLESS_FLUSH_MAX_ATTEMPTS; attempt += 1) {
    try {
      if (await fileLogSink.flush()) return true;
    } catch {
      // Logging is secondary to the native callback. Retry without allowing an exception to escape.
    }
  }
  return false;
}

/**
 * Wire up persistent logging: attach the sink synchronously, then restore the previous session's
 * lines into the in-app viewer. Call once at process entry (on-device). A failure is intentionally
 * observable by the boot coordinator because an upgrade-time legacy plaintext file could not be
 * inspected or safely removed.
 */
export function initPersistentLogs(): Promise<void> {
  // Attach before the first await. Android may execute a killed-process task without ever rendering
  // the foreground boot tree; its finite ERROR must be buffered by a persistent-capable sink before
  // task work starts, then explicitly flushed before the native callback settles.
  logSinks.add(fileLogSink);
  persistentLogInitialization ??= fileLogSink.restore((persisted) =>
    memoryLogSink.hydrate(persisted),
  );
  return persistentLogInitialization;
}
