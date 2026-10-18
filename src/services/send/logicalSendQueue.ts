import { logger } from '@core/secure';
import { subscribeRealtimeGenerationInvalidation } from '../realtime/deliveryCoordinator';

/** Maximum time one send owns ordering before a stalled request yields to the next send. */
export const LOGICAL_SEND_ORDER_WINDOW_MS = 20_000;
/** Bound retained private callbacks; the newest admission fails visibly when full. */
export const LOGICAL_SEND_MAX_RETAINED = 32;
/**
 * Chats that may send at the same time (review M089). One keeps today's single global order.
 * Raise it (to 3) only after a Mac + phone test shows Messages.app and the RCS bridge accept
 * simultaneous sends to different chats.
 */
export const LOGICAL_SEND_MAX_ACTIVE_CHATS = 1;

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
  /** Chats that may hold an ordering turn at once; sends within one chat always stay in order. */
  readonly maxActiveChats?: number;
  readonly subscribeInvalidation?: LogicalSendInvalidationSubscriber;
  readonly onOrderWindowElapsed?: () => void;
  readonly onCapacityExceeded?: () => void;
}

export interface LogicalSendQueue {
  /** Whether this same JavaScript turn can retain `additional` new logical jobs. */
  canRetain(additional?: number): boolean;
  /** Reserve the next ordering turn for `chat`. The caller must release it in `finally`. */
  acquire(lease: LogicalSendLease, chat: string): Promise<LogicalSendTurn>;
  /**
   * Start tasks in admission order, one at a time per chat. Once started, a task keeps its own
   * result/error promise; only its claim on ordering expires, so a stalled network request cannot
   * wedge every later send.
   */
  run<T>(lease: LogicalSendLease, chat: string, task: () => Promise<T>): Promise<T>;
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
  readonly chat: string;
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
  const maxActiveChats = positiveInteger(
    options.maxActiveChats ?? LOGICAL_SEND_MAX_ACTIVE_CHATS,
    'maxActiveChats',
  );
  const subscribeInvalidation =
    options.subscribeInvalidation ?? subscribeRealtimeGenerationInvalidation;

  // One list in admission order; a chat in `activeChats` holds its ordering turn.
  const queued: QueueEntry[] = [];
  const activeChats = new Set<string>();
  let retained = 0;
  let pumping = false;

  const canRetain = (additional = 1): boolean => {
    positiveInteger(additional, 'additional');
    return additional <= maxRetained - retained;
  };

  const removeQueued = (entry: QueueEntry): void => {
    const index = queued.indexOf(entry);
    if (index >= 0) queued.splice(index, 1);
  };

  /** Start the oldest send whose chat is idle while fewer than `maxActiveChats` chats are busy. */
  const pump = (): void => {
    // Starting a stale entry cancels it, which calls back here; the loop's rescan covers that.
    if (pumping) return;
    pumping = true;
    try {
      let index = 0;
      while (index < queued.length && activeChats.size < maxActiveChats) {
        const next = queued[index]!;
        if (activeChats.has(next.chat)) {
          index += 1;
          continue;
        }
        queued.splice(index, 1);
        next.start();
        index = 0;
      }
    } finally {
      pumping = false;
    }
  };

  const acquire = (lease: LogicalSendLease, chat: string): Promise<LogicalSendTurn> => {
    if (typeof chat !== 'string' || chat.length === 0) {
      return Promise.reject(new TypeError('a logical send needs its chat key'));
    }
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
        // A turn that already expired and passed on must not free its successor's claim.
        if (!holdsOrdering) return;
        holdsOrdering = false;
        activeChats.delete(chat);
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
        chat,
        start: () => {
          if (state !== 'queued') return;
          if (!lease.isCurrent()) {
            cancelQueued();
            return;
          }

          state = 'running';
          holdsOrdering = true;
          activeChats.add(chat);
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

  const run = async <T>(
    lease: LogicalSendLease,
    chat: string,
    task: () => Promise<T>,
  ): Promise<T> => {
    const turn = await acquire(lease, chat);
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

/**
 * One process-wide queue; account-generation invalidation retires its queued closures.
 *
 * Turns are per chat (review M089), but LOGICAL_SEND_MAX_ACTIVE_CHATS is 1 until a device test
 * shows the Mac's AppleScript and RCS paths accept sends to different chats at the same time. Until
 * then a send that is slow inside its turn (an attachment upload, say) can still delay a send to
 * another chat by up to LOGICAL_SEND_ORDER_WINDOW_MS.
 */
export const logicalSendQueue = createLogicalSendQueue({
  onOrderWindowElapsed: () => {
    logger.warn('[send] logical ordering window elapsed; allowing the next send');
  },
  onCapacityExceeded: () => {
    logger.warn('[send] logical send queue capacity reached; refusing the newest send');
  },
});
