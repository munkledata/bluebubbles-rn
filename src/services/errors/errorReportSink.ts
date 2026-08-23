import {
  logger,
  projectCapturedErrorReport,
  type LogLevel,
  type LogSink,
  type PrivacySafeErrorReport,
} from '@core/secure';
import { getDatabase } from '@db/database';
import { insertErrorReportsWithinTransaction } from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import { hasErrorReportingConsent } from '@state/featureSettingsStore';
import { captureRealtimeDeliveryLease } from '../realtime/deliveryCoordinator';

/**
 * Error-capture sink + funnel.
 *
 * A {@link LogSink} that captures ERROR-level log lines (already strictly projected upstream by
 * {@link RedactingLogger}) into the durable, uploadable `error_reports` queue, then defensively
 * projects them again. It buffers
 * synchronously in a bounded in-memory ring (the LogSink contract is sync + non-blocking, but
 * op-sqlite writes are async), then debounced-drains to the DB once it's open — the same
 * buffer-then-lazy-flush shape as {@link FileLogSink}. Lives OUTSIDE `src/core` so it can touch the
 * DB; injected into the core logger's TeeSink at boot via `logSinks.add(errorReportSink)`.
 *
 * Feedback-loop safety: only `error` level is captured; the uploader reports failures at `warn`;
 * and a re-entrancy/draining guard drops any error logged during our own enqueue or DB drain.
 */
const RING_CAPACITY = 200;
const DRAIN_DELAY_MS = 1000;
const RETIRED_DRAIN = new Error('retired error-report drain');

interface PendingReport extends PrivacySafeErrorReport {
  createdAt: number;
}

export class ErrorReportSink implements LogSink {
  private ring: PendingReport[] = [];
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private busy = false; // true while enqueuing OR draining — drops re-entrant error logs
  private sessionGeneration = 0;
  private readonly activeDrains = new Set<Promise<void>>();

  write(level: LogLevel, message: string, meta?: unknown): void {
    if (level !== 'error') return;
    // Consent is checked before allocating or scheduling anything. `hydrated=false` is denied, so
    // boot-time/global-handler errors cannot silently become a pre-consent upload backlog.
    if (!hasErrorReportingConsent()) return;
    // Disconnect closes account admission before resetting this sink. Do not let errors emitted by
    // later cleanup work enter a fresh ring that could survive the wipe and upload under the next
    // account.
    if (!captureRealtimeDeliveryLease().isCurrent()) return;
    if (this.busy) return; // an error logged during our own enqueue/drain — ignore (loop guard)
    this.busy = true;
    try {
      this.ring.push({
        // RedactingLogger already applied its local-log scrub. This stricter projector is the
        // durable boundary: arbitrary prose, response bodies, causes, and stack message lines are
        // discarded before the encrypted queue sees them.
        ...projectCapturedErrorReport(message, meta),
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
   * Synchronously disown every report captured for the account being retired.
   *
   * The returned promise is a snapshot of drains that had already entered the DB path. Disconnect
   * waits for it with a deadline before wiping the database. A generation change also makes a
   * queued drain no-op and forces an in-progress insert transaction to roll back, so safety does
   * not depend on that deadline winning.
   */
  resetSession(): Promise<void> {
    this.sessionGeneration += 1;
    this.ring = [];
    if (this.drainTimer != null) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    return Promise.all([...this.activeDrains]).then(() => undefined);
  }

  /**
   * Persist buffered reports into the encrypted `error_reports` table (best-effort). If the DB
   * isn't open yet the reports stay buffered and are retried on the next drain. Callable directly
   * (e.g. on a fatal error, to race the crash, or before an upload flush).
   */
  async flushToDb(): Promise<void> {
    if (!hasErrorReportingConsent()) {
      // Synchronously retire the buffer/timer. An already-entered transaction observes the new
      // generation below and rolls back instead of committing after consent was withdrawn.
      await this.resetSession();
      return;
    }
    if (this.ring.length === 0 || this.busy) return;
    let db;
    try {
      db = getDatabase();
    } catch {
      return; // DB not open yet — keep buffered, retry next drain
    }
    const generation = this.sessionGeneration;
    this.busy = true; // ignore any error logged by the DB layer during our inserts (loop guard)
    const batch = this.ring;
    this.ring = [];
    const drain = this.persistBatch(db, batch, generation);
    this.activeDrains.add(drain);
    try {
      await drain;
    } finally {
      this.activeDrains.delete(drain);
      this.busy = false;
    }
  }

  private async persistBatch(
    db: ReturnType<typeof getDatabase>,
    batch: PendingReport[],
    generation: number,
  ): Promise<void> {
    try {
      // At most three bounded statements (two <=100-row INSERTs + one capacity trim) under the
      // shared write lock. If resetSession lands while INSERT is in flight, the second generation
      // check throws and withDbTransaction rolls the whole old-account batch back before releasing
      // the lock.
      await withDbTransaction(
        db,
        async (context) => {
          if (generation !== this.sessionGeneration || !hasErrorReportingConsent()) {
            throw RETIRED_DRAIN;
          }
          await insertErrorReportsWithinTransaction(context, batch);
          if (generation !== this.sessionGeneration || !hasErrorReportingConsent()) {
            throw RETIRED_DRAIN;
          }
        },
        // Also let the shared transaction coordinator check ownership after the mutex/BEGIN and
        // immediately before COMMIT. This closes the tiny promise-continuation gap between the
        // callback's final check and the coordinator issuing COMMIT.
        () => generation === this.sessionGeneration && hasErrorReportingConsent(),
      );
    } catch {
      // Best-effort diagnostics: a failed/stale batch is deliberately dropped rather than retried
      // forever or allowed to cross an account boundary.
    }
  }
}

export const errorReportSink = new ErrorReportSink();

function errorMeta(err: unknown): unknown {
  try {
    return err instanceof Error ? err : { name: 'Error' };
  } catch {
    return { name: 'Error' };
  }
}

export type RuntimeErrorOrigin = 'fatal' | 'uncaught' | 'unhandledRejection';

/**
 * Funnel a raw error/reason into the report queue via the redacting logger. Used by the global
 * uncaught-error + unhandled-rejection handlers (and available for any explicit capture). `origin`
 * becomes the `[origin]` tag the server fingerprints on. On a fatal error, immediately drains to
 * the DB to race the crash. Never throws.
 */
export function captureError(
  err: unknown,
  origin: RuntimeErrorOrigin,
  opts?: { fatal?: boolean },
): void {
  try {
    const meta = errorMeta(err);
    // Keep the runtime origin as a finite event. The raw Error remains input to the strict
    // projector so its allowlisted class/code can survive, but its message/stack cannot reach a
    // console, memory, file, database, or HTTP sink.
    if (origin === 'fatal') logger.error('[fatal] runtime error', meta);
    else if (origin === 'uncaught') logger.error('[uncaught] runtime error', meta);
    else logger.error('[unhandledRejection] runtime error', meta);
    if (opts?.fatal) void errorReportSink.flushToDb();
  } catch {
    // never throw from the error-capture path
  }
}
