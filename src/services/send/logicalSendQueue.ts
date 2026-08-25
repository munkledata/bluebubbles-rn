import { logger } from '@core/secure';
import { subscribeRealtimeGenerationInvalidation } from '../realtime/deliveryCoordinator';

/** Maximum time one send owns ordering before a stalled request yields to the next send. */
export const LOGICAL_SEND_ORDER_WINDOW_MS = 20_000;
/** Bound retained private callbacks; the newest admission fails visibly when full. */
export const LOGICAL_SEND_MAX_RETAINED = 32;

const MAX_TIMER_MS = 2_147_483_647;

export interface LogicalSendLease {
  readonly generation: number;
  isCurrent(): boolean;
}

export type LogicalSendInvalidationSubscriber = (
  generation: number,
  listener: () => void,
) => () => void;

export interface LogicalSendQueueOptions {
  readonly orderWindowMs?: number;
  readonly maxRetained?: number;
  readonly subscribeInvalidation?: LogicalSendInvalidationSubscriber;
  readonly onOrderWindowElapsed?: () => void;
  readonly onCapacityExceeded?: () => void;
}

export interface LogicalSendQueue {
  /** Whether this same JavaScript turn can retain `additional` new logical jobs. */
  canRetain(additional?: number): boolean;
  /** Reserve the next ordering turn. The caller must release it in `finally`. */
  acquire(lease: LogicalSendLease): Promise<LogicalSendTurn>;
  /**
   * Start tasks in admission order. Once started, a task keeps its own result/error promise; only
   * its claim on ordering expires, so a stalled network request cannot wedge every later send.
   */
  run<T>(lease: LogicalSendLease, task: () => Promise<T>): Promise<T>;
  /** Started or waiting tasks still retained by their callers. */
  readonly retained: number;
  /** Tasks that have not started yet. */
  readonly waiting: number;
}

export interface LogicalSendTurn {
  /** Settle the retained job and allow the next one to run. Safe to call more than once. */
  release(): void;
}

export class LogicalSendQueueCancelledError extends Error {
  constructor() {
    super('logical send queue owner was retired');
    this.name = 'LogicalSendQueueCancelledError';
  }
}

export class LogicalSendQueueCapacityError extends Error {
  constructor() {
    super('logical send queue capacity was reached');
    this.name = 'LogicalSendQueueCapacityError';
  }
}

interface QueueEntry {
  start(): void;
  cancelQueued(): void;
}

function positiveInteger(value: number, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new RangeError(`${name} must be a positive safe integer no greater than ${max}`);
  }
  return value;
}

/** Pure queue factory; native/network work stays injected through each task. */
export function createLogicalSendQueue(options: LogicalSendQueueOptions = {}): LogicalSendQueue {
  const orderWindowMs = positiveInteger(
    options.orderWindowMs ?? LOGICAL_SEND_ORDER_WINDOW_MS,
    'orderWindowMs',
    MAX_TIMER_MS,
  );
  const maxRetained = positiveInteger(
    options.maxRetained ?? LOGICAL_SEND_MAX_RETAINED,
    'maxRetained',
  );
  const subscribeInvalidation =
    options.subscribeInvalidation ?? subscribeRealtimeGenerationInvalidation;

  const queued: QueueEntry[] = [];
  let retained = 0;
  let orderingActive = false;

  const canRetain = (additional = 1): boolean => {
    positiveInteger(additional, 'additional');
    return additional <= maxRetained - retained;
  };

  const removeQueued = (entry: QueueEntry): void => {
    const index = queued.indexOf(entry);
    if (index >= 0) queued.splice(index, 1);
  };

  const pump = (): void => {
    while (!orderingActive) {
      const next = queued.shift();
      if (!next) return;
      next.start();
    }
  };

  const acquire = (lease: LogicalSendLease): Promise<LogicalSendTurn> => {
    if (!lease.isCurrent()) return Promise.reject(new LogicalSendQueueCancelledError());

    if (!canRetain()) {
      // Never evict an older accepted send or start the newest one out of order. The UI wrapper
      // turns this typed refusal into visible retry copy; notification replies retain their tray.
      options.onCapacityExceeded?.();
      return Promise.reject(new LogicalSendQueueCapacityError());
    }

    retained += 1;
    return new Promise<LogicalSendTurn>((resolve, reject) => {
      let state: 'queued' | 'running' | 'settled' = 'queued';
      let holdsOrdering = false;
      let orderingTimer: ReturnType<typeof setTimeout> | undefined;
      let invalidationCleanup: (() => void) | undefined;
      let invalidationCleanupRequested = false;
      let entry!: QueueEntry;

      const unsubscribe = (): void => {
        invalidationCleanupRequested = true;
        const cleanup = invalidationCleanup;
        if (!cleanup) return;
        invalidationCleanup = undefined;
        cleanup();
      };

      const releaseOrdering = (): void => {
        if (!holdsOrdering) return;
        holdsOrdering = false;
        orderingActive = false;
        if (orderingTimer !== undefined) {
          clearTimeout(orderingTimer);
          orderingTimer = undefined;
        }
        pump();
      };

      const finish = (): void => {
        if (state === 'settled') return;
        state = 'settled';
        retained -= 1;
        unsubscribe();
        releaseOrdering();
      };

      const cancelQueued = (error: unknown = new LogicalSendQueueCancelledError()): void => {
        if (state !== 'queued') return;
        removeQueued(entry);
        finish();
        reject(error);
        pump();
      };

      const onInvalidated = (): void => {
        if (state === 'queued') {
          cancelQueued();
          return;
        }
        if (state === 'running') {
          // The surrounding account-work barrier still owns the active task's real settlement.
          // Release only its ordering claim so a successor generation cannot inherit this wait.
          unsubscribe();
          releaseOrdering();
        }
      };

      entry = {
        start: () => {
          if (state !== 'queued') return;
          if (!lease.isCurrent()) {
            cancelQueued();
            return;
          }

          state = 'running';
          holdsOrdering = true;
          orderingActive = true;
          orderingTimer = setTimeout(() => {
            if (state !== 'running' || !holdsOrdering) return;
            options.onOrderWindowElapsed?.();
            releaseOrdering();
          }, orderWindowMs);
          resolve({ release: finish });
        },
        cancelQueued: () => cancelQueued(),
      };

      queued.push(entry);
      try {
        const stop = subscribeInvalidation(lease.generation, onInvalidated);
        invalidationCleanup = stop;
        // A subscriber may invalidate synchronously before returning its cleanup function.
        if (invalidationCleanupRequested) unsubscribe();
      } catch (error) {
        cancelQueued(error);
      }
      if (state === 'queued') pump();
    });
  };

  const run = async <T>(lease: LogicalSendLease, task: () => Promise<T>): Promise<T> => {
    const turn = await acquire(lease);
    try {
      // Invalidation can land after `acquire` resolves but before this continuation resumes.
      if (!lease.isCurrent()) throw new LogicalSendQueueCancelledError();
      return await task();
    } finally {
      // Active account work remains retained until its REAL transport/DB settlement, even when the
      // 20-second ordering window allowed a successor to start exceptionally.
      turn.release();
    }
  };

  return {
    canRetain,
    acquire,
    run,
    get retained() {
      return retained;
    },
    get waiting() {
      return queued.length;
    },
  };
}

/** One process-wide queue; account-generation invalidation retires its queued closures. */
export const logicalSendQueue = createLogicalSendQueue({
  onOrderWindowElapsed: () => {
    logger.warn('[send] logical ordering window elapsed; allowing the next send');
  },
  onCapacityExceeded: () => {
    logger.warn('[send] logical send queue capacity reached; refusing the newest send');
  },
});
