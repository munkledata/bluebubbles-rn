import {
  boundedLogMessage,
  boundedLogMeta,
  isVerboseLocalLoggingEnabled,
  logSinks,
  memoryLogSink,
  projectCapturedDiagnosticEvent,
  projectCapturedErrorReport,
  projectErrorReportTimestamp,
  projectStoredDiagnosticEvent,
  projectStoredErrorReport,
  type LogEntry,
  type LogLevel,
  type LogSink,
} from '@core/secure';

/**
 * Persistent log sink: writes strictly projected ERROR lines, selected finite INFO events, and
 * development-only local lines to a capped file so the in-app viewer survives an app close/reopen
 * (the {@link MemorySink} alone is heap-only and is wiped when the JS context is destroyed).
 * Restore always drops historical free-form non-error rows, so a release candidate cannot inherit
 * the old plaintext history.
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
const FILE_LOG_OPERATION_TIMEOUT_ERROR = 'persistent-log-operation-timed-out';

interface LogFileHandle {
  delete(): void;
  info(): { exists: boolean; size?: number };
  write(contents: string): void;
  text(): Promise<string>;
}

type ReplaceLogFileResult = 'written' | 'deleted' | 'failed';

interface FileOperationFence {
  isActive(): boolean;
  cancel(): void;
  complete(): void;
  addScope(scope: FileFlushFenceScope): void;
  attachScopesTo(child: FileOperationFence): void;
  hasScopes(): boolean;
  onCancel(listener: () => void): () => void;
}

interface FileFlushFenceScope {
  readonly deadlineAt: number | undefined;
  add(fence: FileOperationFence): void;
  cancel(): void;
  owns(fence: FileOperationFence): boolean;
}

function createFileOperationFence(): FileOperationFence {
  let state: 'active' | 'cancelled' | 'completed' = 'active';
  const listeners = new Set<() => void>();
  const scopes = new Set<FileFlushFenceScope>();
  return {
    isActive: () => {
      if (state !== 'active') return false;
      for (const scope of scopes) {
        if (remainingDeadlineMs(scope.deadlineAt) > 0) continue;
        scope.cancel();
        return false;
      }
      return state === 'active';
    },
    cancel: () => {
      if (state !== 'active') return;
      state = 'cancelled';
      for (const listener of listeners) listener();
      listeners.clear();
      scopes.clear();
    },
    complete: () => {
      if (state !== 'active') return;
      state = 'completed';
      listeners.clear();
      scopes.clear();
    },
    addScope: (scope) => {
      if (state !== 'active') return;
      scopes.add(scope);
      if (remainingDeadlineMs(scope.deadlineAt) <= 0) scope.cancel();
    },
    attachScopesTo: (child) => {
      if (state === 'cancelled') {
        child.cancel();
        return;
      }
      if (state !== 'active') return;
      for (const scope of scopes) scope.add(child);
    },
    hasScopes: () => scopes.size > 0,
    onCancel: (listener) => {
      if (state === 'cancelled') {
        listener();
        return () => undefined;
      }
      if (state === 'completed') return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function remainingDeadlineMs(deadlineAt: number | undefined): number {
  if (deadlineAt === undefined) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(deadlineAt) || deadlineAt < 0) return 0;
  return Math.max(0, deadlineAt - Date.now());
}

/** Bound time spent waiting for an older serialized operation without detaching a later write. */
function waitForPromiseBeforeDeadline<T>(
  work: Promise<T>,
  deadlineAt: number | undefined,
  cancelWork: () => void = () => undefined,
): Promise<T> {
  const remainingMs = remainingDeadlineMs(deadlineAt);
  if (!Number.isFinite(remainingMs)) return work;
  if (remainingMs <= 0) {
    cancelWork();
    return Promise.reject(new Error(FILE_LOG_OPERATION_TIMEOUT_ERROR));
  }

  return new Promise<T>((resolve, reject) => {
    let active = true;
    const timer = setTimeout(() => {
      active = false;
      // Revoke mutation authority synchronously before the public wait rejects. The real queued
      // result stays attached to diskTail, but its continuation can no longer touch the file.
      cancelWork();
      reject(new Error(FILE_LOG_OPERATION_TIMEOUT_ERROR));
    }, remainingMs);
    work.then(
      (value) => {
        if (!active) return;
        active = false;
        clearTimeout(timer);
        if (remainingDeadlineMs(deadlineAt) <= 0) {
          cancelWork();
          reject(new Error(FILE_LOG_OPERATION_TIMEOUT_ERROR));
          return;
        }
        resolve(value);
      },
      (error: unknown) => {
        if (!active) return;
        active = false;
        clearTimeout(timer);
        if (remainingDeadlineMs(deadlineAt) <= 0) {
          cancelWork();
          reject(new Error(FILE_LOG_OPERATION_TIMEOUT_ERROR));
          return;
        }
        reject(error);
      },
    );
  });
}

/**
 * Bound one serialized native file operation and deactivate its late continuation after timeout.
 * Callers must check `isActive()` after every await and immediately before a file mutation.
 */
function runBoundedFileOperation<T>(
  operation: (isActive: () => boolean) => Promise<T>,
  fence: FileOperationFence,
  deadlineAt?: number,
  cancelAtDeadline: () => void = fence.cancel,
): Promise<T> {
  const deadlineRemainingMs = remainingDeadlineMs(deadlineAt);
  const timeoutMs = Math.min(FILE_LOG_OPERATION_TIMEOUT_MS, deadlineRemainingMs);
  if (deadlineRemainingMs <= 0) {
    cancelAtDeadline();
    return Promise.reject(new Error(FILE_LOG_OPERATION_TIMEOUT_ERROR));
  }
  if (!fence.isActive()) {
    return Promise.reject(new Error(FILE_LOG_OPERATION_TIMEOUT_ERROR));
  }

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (deadlineRemainingMs <= FILE_LOG_OPERATION_TIMEOUT_MS) cancelAtDeadline();
      else fence.cancel();
    }, timeoutMs);
    const releaseCancellation = fence.onCancel(() => {
      clearTimeout(timer);
      reject(new Error(FILE_LOG_OPERATION_TIMEOUT_ERROR));
    });

    let work: Promise<T>;
    try {
      work = operation(fence.isActive);
    } catch (error) {
      releaseCancellation();
      clearTimeout(timer);
      fence.complete();
      reject(error);
      return;
    }

    work.then(
      (value) => {
        if (!fence.isActive()) return;
        releaseCancellation();
        clearTimeout(timer);
        fence.complete();
        resolve(value);
      },
      (error: unknown) => {
        if (!fence.isActive()) return;
        releaseCancellation();
        clearTimeout(timer);
        fence.complete();
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
function deleteLogFileBestEffort(file: LogFileHandle, isActive: () => boolean): boolean {
  if (!isActive()) return false;
  try {
    file.delete();
    return true;
  } catch {}
  if (!isActive()) return false;
  try {
    return file.info().exists === false;
  } catch {}
  return false;
}

/** Replace legacy contents, falling back to confirmed deletion if writing is unavailable. */
function replaceOrDeleteLogFile(
  file: LogFileHandle,
  contents: string,
  isActive: () => boolean,
): ReplaceLogFileResult {
  if (!isActive()) return 'failed';
  try {
    // The modern File API truncates by default and creates an absent file. Avoid a delete/create
    // gap that could lose the prior safe log merely because a replacement write then fails.
    file.write(contents);
    return 'written';
  } catch {
    if (!isActive()) return 'failed';
    return deleteLogFileBestEffort(file, isActive) ? 'deleted' : 'failed';
  }
}

/** Rebuild finite rows and discard every older free-form level during an upgrade restore. */
function sanitizePersistedEntries(value: unknown): LogEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: LogEntry[] = [];
  for (const candidate of value) {
    if (candidate === null || typeof candidate !== 'object') continue;
    const raw = candidate as Record<string, unknown>;
    if ((raw.level !== 'error' && raw.level !== 'info') || typeof raw.message !== 'string') {
      continue;
    }
    if (typeof raw.timestamp !== 'number') continue;
    const timestamp = projectErrorReportTimestamp(raw.timestamp);
    if (timestamp === 0) continue;
    if (raw.level === 'info') {
      const event = projectStoredDiagnosticEvent({
        message: raw.message,
        meta: typeof raw.meta === 'string' ? raw.meta : null,
      });
      if (event === undefined) continue;
      entries.push({
        level: 'info',
        message: event.message,
        meta: boundedLogMeta(JSON.parse(event.meta) as Record<string, unknown>),
        timestamp,
      });
      continue;
    }
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
  private flushTimerFence: FileOperationFence | null = null;
  private dirty = false;
  private consecutiveFlushFailures = 0;
  /** Survives route remounts, but deliberately resets with the process on a real restart. */
  private cleanupConfirmedForProcess = false;
  /** Serializes every disk operation so a late read/write cannot cross a successful clear(). */
  private diskTail: Promise<void> = Promise.resolve();
  /** Lets an expiring native callback revoke every queued/running async file continuation first. */
  private readonly pendingDiskOperationFences = new Set<FileOperationFence>();
  /** Retires public flush callers that predate a callback deadline without touching later owners. */
  private readonly pendingFlushFences = new Set<FileOperationFence>();
  /** Suppresses ordinary debounce work while one or more native-callback barriers own flushing. */
  private deadlineFlushOwners = 0;
  /** Invalidates a boot-time init/read that was already in flight when account teardown cleared. */
  private contentGeneration = 0;

  write(level: LogLevel, message: string, meta?: unknown): void {
    const safeError = level === 'error' ? projectCapturedErrorReport(message, meta) : undefined;
    const safeEvent = level === 'info' ? projectCapturedDiagnosticEvent(message, meta) : undefined;
    if (level !== 'error' && safeEvent === undefined && !isVerboseLocalLoggingEnabled()) {
      return;
    }
    const retainedMessage = safeError?.message ?? safeEvent?.message ?? message;
    const retainedMeta =
      safeError === undefined
        ? (safeEvent?.meta ?? meta)
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
      timestamp:
        safeError !== undefined || safeEvent !== undefined ? projectErrorReportTimestamp(now) : now,
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

  private scheduleFlush(allowDuringDeadlineOwner = false): void {
    this.dirty = true;
    if (this.deadlineFlushOwners > 0 && !allowDuringDeadlineOwner) return;
    if (this.flushTimer != null) return; // a flush is already pending — coalesce
    const timerFence = createFileOperationFence();
    this.pendingFlushFences.add(timerFence);
    this.flushTimerFence = timerFence;
    const timer = setTimeout(() => {
      if (this.flushTimer !== timer) return;
      this.flushTimer = null;
      this.flushTimerFence = null;
      this.pendingFlushFences.delete(timerFence);
      if (!timerFence.isActive()) return;
      timerFence.complete();
      void this.flush();
    }, FLUSH_DELAY_MS);
    this.flushTimer = timer;
  }

  private resetBuffer(): void {
    this.buf = [];
    this.dirty = false;
    this.consecutiveFlushFailures = 0;
    this.cancelScheduledFlush();
  }

  private cancelScheduledFlush(scope?: FileFlushFenceScope): void {
    if (this.flushTimer == null) return;
    if (scope !== undefined && this.flushTimerFence !== null && !scope.owns(this.flushTimerFence)) {
      return;
    }
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.flushTimerFence !== null) {
      this.flushTimerFence.cancel();
      this.pendingFlushFences.delete(this.flushTimerFence);
      this.flushTimerFence = null;
    }
  }

  private cancelFileFences(fences: Iterable<FileOperationFence>): void {
    for (const fence of fences) fence.cancel();
  }

  private enqueueDiskOperation<T>(
    operation: (isActive: () => boolean) => Promise<T>,
    deadlineAt?: number,
    deadlineScope?: FileFlushFenceScope,
    ownerFence?: FileOperationFence,
  ): Promise<T> {
    const fence = createFileOperationFence();
    this.pendingDiskOperationFences.add(fence);
    ownerFence?.attachScopesTo(fence);
    deadlineScope?.add(fence);
    // Re-evaluate the absolute deadline only when this operation reaches the front of the queue.
    // If the caller already timed out while waiting, `runBoundedFileOperation` refuses to invoke it.
    const cancelAtDeadline = (): void => {
      if (deadlineScope !== undefined) deadlineScope.cancel();
      else this.cancelFileFences([fence]);
    };
    const run = (): Promise<T> =>
      runBoundedFileOperation(operation, fence, deadlineAt, cancelAtDeadline);
    const result = this.diskTail.then(run, run);
    // Keep a non-rejecting tail: callers still receive the real result, while one failed native
    // operation cannot poison every later flush/clear.
    this.diskTail = result.then(
      () => undefined,
      () => undefined,
    );
    void result.then(
      () => this.pendingDiskOperationFences.delete(fence),
      () => this.pendingDiskOperationFences.delete(fence),
    );
    return waitForPromiseBeforeDeadline(result, deadlineAt, cancelAtDeadline);
  }

  /** Join every disk operation that was appended while this method was waiting. */
  private async waitForDiskQueue(
    deadlineAt?: number,
    deadlineScope?: FileFlushFenceScope,
  ): Promise<void> {
    let observedTail = this.diskTail;
    await waitForPromiseBeforeDeadline(observedTail, deadlineAt, () => {
      if (deadlineScope !== undefined) deadlineScope.cancel();
      else this.cancelFileFences(this.pendingDiskOperationFences);
    });
    while (observedTail !== this.diskTail) {
      observedTail = this.diskTail;
      await waitForPromiseBeforeDeadline(observedTail, deadlineAt, () => {
        if (deadlineScope !== undefined) deadlineScope.cancel();
        else this.cancelFileFences(this.pendingDiskOperationFences);
      });
    }
  }

  private beginHeadlessFlushScope(deadlineAt?: number): FileFlushFenceScope {
    const fences = new Set<FileOperationFence>();
    let cancelled = false;
    const cancel = (): void => {
      if (cancelled) return;
      cancelled = true;
      this.cancelFileFences(fences);
    };
    let scope!: FileFlushFenceScope;
    const add = (fence: FileOperationFence): void => {
      fences.add(fence);
      if (cancelled) {
        fence.cancel();
        return;
      }
      fence.addScope(scope);
    };
    scope = {
      deadlineAt,
      add,
      cancel,
      owns: (fence) => fences.has(fence),
    };
    for (const fence of this.pendingDiskOperationFences) scope.add(fence);
    for (const fence of this.pendingFlushFences) scope.add(fence);

    this.deadlineFlushOwners += 1;
    // The session owns only timers that existed before it. A later independent ordinary owner can
    // retain its own bounded retry without being adopted by this callback.
    this.cancelScheduledFlush(scope);
    return scope;
  }

  private endHeadlessFlushScope(scope: FileFlushFenceScope): void {
    // Revoke every pre-existing/owned continuation before the native callback's public barrier can
    // settle. Later Clear, timer, and callback owners were never added to this scope.
    scope.cancel();
    this.cancelScheduledFlush(scope);
    this.deadlineFlushOwners -= 1;
  }

  /** Write the current buffer to disk. Returns false after a bounded native failure. */
  async flush(deadlineAt?: number): Promise<boolean> {
    if (deadlineAt === undefined) return this.flushOnce();
    const sessionFence = createFileOperationFence();
    this.pendingFlushFences.add(sessionFence);
    const scope = this.beginHeadlessFlushScope(deadlineAt);
    try {
      return await this.flushOnce(deadlineAt, scope, sessionFence);
    } finally {
      this.endHeadlessFlushScope(scope);
      sessionFence.complete();
      this.pendingFlushFences.delete(sessionFence);
    }
  }

  /** Own all finite headless retries under one scope captured before the first attempt. */
  async flushForHeadlessCompletion(deadlineAt?: number): Promise<boolean> {
    const sessionFence = createFileOperationFence();
    this.pendingFlushFences.add(sessionFence);
    const scope = this.beginHeadlessFlushScope(deadlineAt);
    try {
      for (let attempt = 0; attempt < HEADLESS_FLUSH_MAX_ATTEMPTS; attempt += 1) {
        if (!sessionFence.isActive()) return false;
        try {
          if (await this.flushOnce(deadlineAt, scope, sessionFence)) return true;
        } catch {
          // Logging is secondary to the callback; consume one finite attempt and continue.
        }
        if (remainingDeadlineMs(deadlineAt) <= 0) return false;
      }
      return false;
    } finally {
      this.endHeadlessFlushScope(scope);
      sessionFence.complete();
      this.pendingFlushFences.delete(sessionFence);
    }
  }

  private async flushOnce(
    deadlineAt?: number,
    headlessScope?: FileFlushFenceScope,
    sessionFence?: FileOperationFence,
  ): Promise<boolean> {
    const ownedByHeadlessCallback = headlessScope !== undefined;
    const flushFence = createFileOperationFence();
    this.pendingFlushFences.add(flushFence);
    sessionFence?.attachScopesTo(flushFence);
    headlessScope?.add(flushFence);
    try {
      if (!flushFence.isActive()) return false;
      if (deadlineAt !== undefined && remainingDeadlineMs(deadlineAt) <= 0) {
        headlessScope?.cancel();
        return false;
      }
      if (!this.dirty) {
        // `dirty` is cleared before an enqueued flush finishes. An explicit headless flush must join
        // that existing write rather than letting its native callback settle while persistence is
        // still in flight. The first write may also fail and mark the buffer dirty again.
        try {
          await this.waitForDiskQueue(deadlineAt, headlessScope);
        } catch {
          return false;
        }
        // A callback deadline may have retired the operation this older join was observing. Do not
        // let the resumed caller enqueue replacement work after the native callback has returned.
        if (!flushFence.isActive()) return false;
        if (!this.dirty) return true;
      }
      const generation = this.contentGeneration;
      this.dirty = false;
      let persisted = false;
      try {
        persisted = await this.enqueueDiskOperation(
          async (isActive) => {
            // Capture only after earlier queued operations (notably init) have settled. Otherwise a
            // flush scheduled while init's file read was pending would overwrite the restored history
            // with the smaller pre-init buffer.
            const snapshot = [...this.buf];
            const { File, Paths } = await import('expo-file-system');
            if (!isActive() || generation !== this.contentGeneration) return true;
            const file = new File(Paths.document, LOG_FILE) as LogFileHandle;
            const contents = JSON.stringify(snapshot);
            if (!isActive() || generation !== this.contentGeneration) return true;
            return replaceOrDeleteLogFile(file, contents, isActive) === 'written';
          },
          deadlineAt,
          headlessScope,
          flushFence,
        );
      } catch {
        persisted = false;
      }

      if (generation !== this.contentGeneration) return true;
      if (persisted) {
        this.consecutiveFlushFailures = 0;
        // A line written after this attempt's snapshot remains dirty. Let the finite headless
        // retry loop include it instead of returning a false persistence success.
        return !ownedByHeadlessCallback || !this.dirty;
      }

      // Keep the unsaved snapshot eligible for an explicit retry. Automatically retry a bounded
      // number of times; a later new line resets this budget and schedules another attempt.
      this.dirty = true;
      this.consecutiveFlushFailures += 1;
      if (
        !ownedByHeadlessCallback &&
        flushFence.isActive() &&
        this.consecutiveFlushFailures <= MAX_AUTOMATIC_FLUSH_RETRIES
      ) {
        // A pre-existing ordinary owner adopted by a callback deadline must not schedule work past
        // that callback. A later independent owner has no such scope and retains its own retry.
        this.scheduleFlush(!flushFence.hasScopes());
      }
      return false;
    } finally {
      flushFence.complete();
      this.pendingFlushFences.delete(flushFence);
    }
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
          if (!isActive()) return [];
          if (!deleteLogFileBestEffort(file, isActive)) {
            throw new Error('persistent-log-cleanup-failed');
          }
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
          if (!isActive()) return [];
          if (!deleteLogFileBestEffort(file, isActive)) {
            throw new Error('persistent-log-cleanup-failed');
          }
          return [];
        }
        if (!Array.isArray(parsed)) {
          if (!isActive()) return [];
          if (!deleteLogFileBestEffort(file, isActive)) {
            throw new Error('persistent-log-cleanup-failed');
          }
          return [];
        }
        const restored = sanitizePersistedEntries(parsed);
        // Preserve entries written while native file.text() was pending. Restored entries are
        // older, so they belong before this run's current buffer.
        const merged = [...restored, ...this.buf].slice(-FILE_LOG_CAPACITY);
        // The file may have been written by an older, weaker redactor. Replace it now so raw
        // legacy identifiers do not remain at rest until some unrelated future log triggers a
        // flush. Losing this best-effort rewrite is safer than failing the in-memory restore.
        const contentsToPersist = JSON.stringify(merged);
        if (!isActive()) return [];
        if (replaceOrDeleteLogFile(file, contentsToPersist, isActive) === 'failed') {
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
        if (file !== undefined && !deleteLogFileBestEffort(file, isActive)) {
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
          return deleteLogFileBestEffort(file, isActive);
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
export async function flushPersistentLogsForHeadlessCompletion(
  deadlineAt?: number,
): Promise<boolean> {
  try {
    return await fileLogSink.flushForHeadlessCompletion(deadlineAt);
  } catch {
    // Logging is secondary to the native callback. Never allow its exception to escape.
    return false;
  }
}

/**
 * Wire up persistent logging: attach the sink synchronously, then restore the previous session's
 * lines into the in-app viewer. Call once at process entry (on-device). A failure is intentionally
 * observable by the boot coordinator because an upgrade-time legacy plaintext file could not be
 * inspected or safely removed.
 */
export function initPersistentLogs(): Promise<void> {
  // Attach before the first await. Android may execute a killed-process task without ever rendering
  // the foreground boot tree; its finite diagnostic must be buffered by a persistent-capable sink
  // before task work starts, then explicitly flushed before the native callback settles.
  logSinks.add(fileLogSink);
  persistentLogInitialization ??= fileLogSink.restore((persisted) =>
    memoryLogSink.hydrate(persisted),
  );
  return persistentLogInitialization;
}
