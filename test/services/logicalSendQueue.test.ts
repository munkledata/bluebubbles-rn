import { OUTGOING_GRACE_MS } from '@db/repositories/outgoing';
import {
  createLogicalSendQueue,
  LogicalSendQueueCancelledError,
  LogicalSendQueueCapacityError,
  LOGICAL_SEND_ORDER_WINDOW_MS,
  type LogicalSendInvalidationSubscriber,
  type LogicalSendLease,
} from '@/services/send/logicalSendQueue';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function generationHarness(): {
  lease(): LogicalSendLease;
  retire(): void;
  resume(): void;
  subscribe: LogicalSendInvalidationSubscriber;
} {
  let generation = 1;
  let accepting = true;
  const listeners = new Map<number, Set<() => void>>();
  return {
    lease: () => {
      const captured = generation;
      const accepted = accepting;
      return {
        generation: captured,
        isCurrent: () => accepted && accepting && generation === captured,
      };
    },
    retire: () => {
      const retired = generation;
      accepting = false;
      generation += 1;
      const current = listeners.get(retired);
      listeners.delete(retired);
      for (const listener of current ?? []) listener();
    },
    resume: () => {
      accepting = true;
    },
    subscribe: (owner, listener) => {
      if (!accepting || owner !== generation) {
        listener();
        return () => undefined;
      }
      const current = listeners.get(owner) ?? new Set<() => void>();
      listeners.set(owner, current);
      current.add(listener);
      return () => current.delete(listener);
    },
  };
}

describe('logical send queue', () => {
  it('starts ordinary jobs in admission order and forwards each result', async () => {
    const owner = generationHarness();
    const queue = createLogicalSendQueue({ subscribeInvalidation: owner.subscribe });
    const first = deferred<string>();
    const starts: string[] = [];

    const one = queue.run(owner.lease(), async () => {
      starts.push('text');
      return first.promise;
    });
    const two = queue.run(owner.lease(), async () => {
      starts.push('contact');
      return 'contact-result';
    });
    const three = queue.run(owner.lease(), async () => {
      starts.push('image');
      return 'image-result';
    });

    await settle();
    expect(starts).toEqual(['text']);
    expect(queue.waiting).toBe(2);

    first.resolve('text-result');
    await expect(one).resolves.toBe('text-result');
    await expect(two).resolves.toBe('contact-result');
    await expect(three).resolves.toBe('image-result');
    expect(starts).toEqual(['text', 'contact', 'image']);
    expect(queue.retained).toBe(0);
  });

  it('releases the next job when the current job fails', async () => {
    const owner = generationHarness();
    const queue = createLogicalSendQueue({ subscribeInvalidation: owner.subscribe });
    const starts: string[] = [];
    const failure = queue.run(owner.lease(), async () => {
      starts.push('failed');
      throw new Error('send failure sentinel');
    });
    const successor = queue.run(owner.lease(), async () => {
      starts.push('successor');
      return 'sent';
    });

    await expect(failure).rejects.toThrow('send failure sentinel');
    await expect(successor).resolves.toBe('sent');
    expect(starts).toEqual(['failed', 'successor']);
  });

  it('exceptionally advances after 20 seconds but retains the stalled task until it settles', async () => {
    jest.useFakeTimers();
    const owner = generationHarness();
    const elapsed = jest.fn();
    const queue = createLogicalSendQueue({
      subscribeInvalidation: owner.subscribe,
      onOrderWindowElapsed: elapsed,
    });
    const stalled = deferred<string>();
    const starts: string[] = [];
    try {
      const first = queue.run(owner.lease(), async () => {
        starts.push('stalled');
        return stalled.promise;
      });
      const second = queue.run(owner.lease(), async () => {
        starts.push('successor');
        return 'successor-result';
      });
      await settle();

      await jest.advanceTimersByTimeAsync(LOGICAL_SEND_ORDER_WINDOW_MS - 1);
      expect(starts).toEqual(['stalled']);
      await jest.advanceTimersByTimeAsync(1);
      await expect(second).resolves.toBe('successor-result');

      expect(starts).toEqual(['stalled', 'successor']);
      expect(elapsed).toHaveBeenCalledTimes(1);
      expect(queue.retained).toBe(1);

      stalled.resolve('stalled-result');
      await expect(first).resolves.toBe('stalled-result');
      expect(queue.retained).toBe(0);
    } finally {
      stalled.resolve('cleanup');
      jest.useRealTimers();
    }
  });

  it('bounds retained work and refuses the newest job without starting it', async () => {
    const owner = generationHarness();
    const full = jest.fn();
    const queue = createLogicalSendQueue({
      maxRetained: 2,
      subscribeInvalidation: owner.subscribe,
      onCapacityExceeded: full,
    });
    const first = deferred<string>();
    const second = deferred<string>();
    const newest = jest.fn(async () => 'must-not-start');
    const one = queue.run(owner.lease(), () => first.promise);
    const two = queue.run(owner.lease(), () => second.promise);
    await settle();

    expect(queue.canRetain(1)).toBe(false);
    expect(queue.canRetain(2)).toBe(false);
    await expect(queue.run(owner.lease(), newest)).rejects.toBeInstanceOf(
      LogicalSendQueueCapacityError,
    );
    expect(newest).not.toHaveBeenCalled();
    expect(full).toHaveBeenCalledTimes(1);
    expect(queue.retained).toBe(2);

    first.resolve('one');
    await expect(one).resolves.toBe('one');
    await settle();
    expect(queue.canRetain(1)).toBe(true);
    second.resolve('two');
    await expect(two).resolves.toBe('two');
  });

  it('cancels queued account-A work and lets account B start behind a still-settling A task', async () => {
    const owner = generationHarness();
    const queue = createLogicalSendQueue({ subscribeInvalidation: owner.subscribe });
    const active = deferred<string>();
    const starts: string[] = [];
    const aRunning = queue.run(owner.lease(), async () => {
      starts.push('A-running');
      return active.promise;
    });
    const aQueuedTask = jest.fn(async () => 'must-not-start');
    const aQueued = queue.run(owner.lease(), aQueuedTask);
    const queuedRejection = expect(aQueued).rejects.toBeInstanceOf(LogicalSendQueueCancelledError);
    await settle();

    owner.retire();
    owner.resume();
    const b = queue.run(owner.lease(), async () => {
      starts.push('B');
      return 'B-result';
    });

    await queuedRejection;
    await expect(b).resolves.toBe('B-result');
    expect(aQueuedTask).not.toHaveBeenCalled();
    expect(starts).toEqual(['A-running', 'B']);
    expect(queue.retained).toBe(1);

    active.resolve('A-result');
    await expect(aRunning).resolves.toBe('A-result');
    expect(queue.retained).toBe(0);
  });

  it('rejects a stale owner before invoking any task', async () => {
    const owner = generationHarness();
    const queue = createLogicalSendQueue({ subscribeInvalidation: owner.subscribe });
    const stale = owner.lease();
    owner.retire();
    owner.resume();
    const task = jest.fn(async () => 'wrong-account');

    await expect(queue.run(stale, task)).rejects.toBeInstanceOf(LogicalSendQueueCancelledError);
    expect(task).not.toHaveBeenCalled();
  });

  it('keeps the ordering window below the durable outgoing recovery grace', () => {
    expect(LOGICAL_SEND_ORDER_WINDOW_MS).toBe(20_000);
    expect(OUTGOING_GRACE_MS).toBe(60_000);
    expect(LOGICAL_SEND_ORDER_WINDOW_MS).toBeLessThan(OUTGOING_GRACE_MS);
  });
});
