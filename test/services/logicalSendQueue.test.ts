import { OUTGOING_GRACE_MS } from '@db/repositories/outgoing';
import {
  createLogicalSendQueue,
  LogicalSendQueueCancelledError,
  LogicalSendQueueCapacityError,
  LOGICAL_SEND_MAX_ACTIVE_CHATS,
  LOGICAL_SEND_ORDER_WINDOW_MS,
  type LogicalSendInvalidationSubscriber,
  type LogicalSendLease,
} from '@/services/send/logicalSendQueue';
import { flushMicrotasks } from '../support/async';

// Synthetic chat keys; the queue only compares them.
const CHAT_A = 'iMessage;-;chat-a@example.test';
const CHAT_B = 'iMessage;-;chat-b@example.test';
const CHAT_C = 'RCS;-;chat-c';
const CHAT_D = 'any;-;chat-d@example.test';

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

    const one = queue.run(owner.lease(), CHAT_A, async () => {
      starts.push('text');
      return first.promise;
    });
    const two = queue.run(owner.lease(), CHAT_A, async () => {
      starts.push('contact');
      return 'contact-result';
    });
    const three = queue.run(owner.lease(), CHAT_A, async () => {
      starts.push('image');
      return 'image-result';
    });

    await flushMicrotasks();
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
    const failure = queue.run(owner.lease(), CHAT_A, async () => {
      starts.push('failed');
      throw new Error('send failure sentinel');
    });
    const successor = queue.run(owner.lease(), CHAT_A, async () => {
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
      const first = queue.run(owner.lease(), CHAT_A, async () => {
        starts.push('stalled');
        return stalled.promise;
      });
      const second = queue.run(owner.lease(), CHAT_A, async () => {
        starts.push('successor');
        return 'successor-result';
      });
      await flushMicrotasks();

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
    const one = queue.run(owner.lease(), CHAT_A, () => first.promise);
    const two = queue.run(owner.lease(), CHAT_A, () => second.promise);
    await flushMicrotasks();

    expect(queue.canRetain(1)).toBe(false);
    expect(queue.canRetain(2)).toBe(false);
    await expect(queue.run(owner.lease(), CHAT_A, newest)).rejects.toBeInstanceOf(
      LogicalSendQueueCapacityError,
    );
    expect(newest).not.toHaveBeenCalled();
    expect(full).toHaveBeenCalledTimes(1);
    expect(queue.retained).toBe(2);

    first.resolve('one');
    await expect(one).resolves.toBe('one');
    await flushMicrotasks();
    expect(queue.canRetain(1)).toBe(true);
    second.resolve('two');
    await expect(two).resolves.toBe('two');
  });

  it('cancels queued account-A work and lets account B start behind a still-settling A task', async () => {
    const owner = generationHarness();
    const queue = createLogicalSendQueue({ subscribeInvalidation: owner.subscribe });
    const active = deferred<string>();
    const starts: string[] = [];
    const aRunning = queue.run(owner.lease(), CHAT_A, async () => {
      starts.push('A-running');
      return active.promise;
    });
    const aQueuedTask = jest.fn(async () => 'must-not-start');
    const aQueued = queue.run(owner.lease(), CHAT_A, aQueuedTask);
    const queuedRejection = expect(aQueued).rejects.toBeInstanceOf(LogicalSendQueueCancelledError);
    await flushMicrotasks();

    owner.retire();
    owner.resume();
    const b = queue.run(owner.lease(), CHAT_A, async () => {
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

    await expect(queue.run(stale, CHAT_A, task)).rejects.toBeInstanceOf(
      LogicalSendQueueCancelledError,
    );
    expect(task).not.toHaveBeenCalled();
  });

  it('keeps the ordering window below the durable outgoing recovery grace', () => {
    expect(LOGICAL_SEND_ORDER_WINDOW_MS).toBe(20_000);
    expect(OUTGOING_GRACE_MS).toBe(60_000);
    expect(LOGICAL_SEND_ORDER_WINDOW_MS).toBeLessThan(OUTGOING_GRACE_MS);
  });
});

// Review M089: ordering turns are per chat with a shared cap; one active chat keeps today's order.
describe('per-chat send turns', () => {
  const job =
    (starts: string[], label: string, gate?: Deferred<void>) => async (): Promise<void> => {
      starts.push(label);
      if (gate) await gate.promise;
    };

  it('ships with one active chat until a Mac and phone test allows more', () => {
    expect(LOGICAL_SEND_MAX_ACTIVE_CHATS).toBe(1);
  });

  it('keeps one global order across chats with the default of one active chat', async () => {
    const owner = generationHarness();
    const queue = createLogicalSendQueue({ subscribeInvalidation: owner.subscribe });
    const a1 = deferred<void>();
    const starts: string[] = [];
    const runs = [
      queue.run(owner.lease(), CHAT_A, job(starts, 'A1', a1)),
      queue.run(owner.lease(), CHAT_B, job(starts, 'B1')),
    ];
    await flushMicrotasks();
    expect(starts).toEqual(['A1']);

    a1.resolve(undefined);
    await Promise.all(runs);
    expect(starts).toEqual(['A1', 'B1']);
  });

  it('starts different chats together and keeps each chat in order', async () => {
    const owner = generationHarness();
    const queue = createLogicalSendQueue({
      subscribeInvalidation: owner.subscribe,
      maxActiveChats: 3,
    });
    const a1 = deferred<void>();
    const b1 = deferred<void>();
    const starts: string[] = [];
    const runs = [
      queue.run(owner.lease(), CHAT_A, job(starts, 'A1', a1)),
      queue.run(owner.lease(), CHAT_B, job(starts, 'B1', b1)),
      queue.run(owner.lease(), CHAT_A, job(starts, 'A2')),
      queue.run(owner.lease(), CHAT_B, job(starts, 'B2')),
    ];
    await flushMicrotasks();
    expect(starts).toEqual(['A1', 'B1']);

    b1.resolve(undefined);
    await flushMicrotasks();
    expect(starts).toEqual(['A1', 'B1', 'B2']);

    a1.resolve(undefined);
    await Promise.all(runs);
    expect(starts).toEqual(['A1', 'B1', 'B2', 'A2']);
  });

  it('does not hold up another chat when one chat fails', async () => {
    const owner = generationHarness();
    const queue = createLogicalSendQueue({
      subscribeInvalidation: owner.subscribe,
      maxActiveChats: 2,
    });
    const starts: string[] = [];
    const failed = queue.run(owner.lease(), CHAT_A, async () => {
      starts.push('A1');
      throw new Error('A1 failed');
    });
    const other = queue.run(owner.lease(), CHAT_B, job(starts, 'B1'));
    const next = queue.run(owner.lease(), CHAT_A, job(starts, 'A2'));

    await expect(failed).rejects.toThrow('A1 failed');
    await Promise.all([other, next]);
    expect(starts).toEqual(['A1', 'B1', 'A2']);
  });

  it('applies the ordering window per chat', async () => {
    jest.useFakeTimers();
    const owner = generationHarness();
    const queue = createLogicalSendQueue({
      subscribeInvalidation: owner.subscribe,
      maxActiveChats: 2,
    });
    const stalled = deferred<void>();
    const starts: string[] = [];
    try {
      const runs = [
        queue.run(owner.lease(), CHAT_A, job(starts, 'A1', stalled)),
        queue.run(owner.lease(), CHAT_B, job(starts, 'B1')),
        queue.run(owner.lease(), CHAT_A, job(starts, 'A2')),
      ];
      await flushMicrotasks();
      expect(starts).toEqual(['A1', 'B1']);

      await jest.advanceTimersByTimeAsync(LOGICAL_SEND_ORDER_WINDOW_MS - 1);
      expect(starts).toEqual(['A1', 'B1']);
      await jest.advanceTimersByTimeAsync(1);
      expect(starts).toEqual(['A1', 'B1', 'A2']);

      stalled.resolve(undefined);
      await Promise.all(runs);
    } finally {
      stalled.resolve(undefined);
      jest.useRealTimers();
    }
  });

  it('shares the retained limit across chats', async () => {
    const owner = generationHarness();
    const queue = createLogicalSendQueue({
      subscribeInvalidation: owner.subscribe,
      maxRetained: 2,
      maxActiveChats: 3,
    });
    const a = deferred<void>();
    const b = deferred<void>();
    const starts: string[] = [];
    const runs = [
      queue.run(owner.lease(), CHAT_A, job(starts, 'A1', a)),
      queue.run(owner.lease(), CHAT_B, job(starts, 'B1', b)),
    ];
    const refused = jest.fn(async () => undefined);

    await expect(queue.run(owner.lease(), CHAT_C, refused)).rejects.toBeInstanceOf(
      LogicalSendQueueCapacityError,
    );
    expect(refused).not.toHaveBeenCalled();
    a.resolve(undefined);
    b.resolve(undefined);
    await Promise.all(runs);
  });

  it('starts waiting chats in submission order once a chat slot frees', async () => {
    const owner = generationHarness();
    const queue = createLogicalSendQueue({
      subscribeInvalidation: owner.subscribe,
      maxActiveChats: 2,
    });
    const a = deferred<void>();
    const b = deferred<void>();
    const c = deferred<void>();
    const starts: string[] = [];
    const runs = [
      queue.run(owner.lease(), CHAT_A, job(starts, 'A1', a)),
      queue.run(owner.lease(), CHAT_B, job(starts, 'B1', b)),
      queue.run(owner.lease(), CHAT_C, job(starts, 'C1', c)),
      queue.run(owner.lease(), CHAT_D, job(starts, 'D1')),
    ];
    await flushMicrotasks();
    expect(starts).toEqual(['A1', 'B1']);

    b.resolve(undefined);
    await flushMicrotasks();
    expect(starts).toEqual(['A1', 'B1', 'C1']);

    a.resolve(undefined);
    c.resolve(undefined);
    await Promise.all(runs);
    expect(starts).toEqual(['A1', 'B1', 'C1', 'D1']);
  });

  it('cancels queued work in every chat when the account retires', async () => {
    const owner = generationHarness();
    const queue = createLogicalSendQueue({
      subscribeInvalidation: owner.subscribe,
      maxActiveChats: 2,
    });
    const a = deferred<void>();
    const b = deferred<void>();
    const starts: string[] = [];
    const running = [
      queue.run(owner.lease(), CHAT_A, job(starts, 'A1', a)),
      queue.run(owner.lease(), CHAT_B, job(starts, 'B1', b)),
    ];
    const queuedSends = [
      queue.run(owner.lease(), CHAT_A, job(starts, 'A2')),
      queue.run(owner.lease(), CHAT_C, job(starts, 'C1')),
    ];
    const rejections = queuedSends.map((pending) =>
      expect(pending).rejects.toBeInstanceOf(LogicalSendQueueCancelledError),
    );
    await flushMicrotasks();

    owner.retire();
    await Promise.all(rejections);
    expect(starts).toEqual(['A1', 'B1']);
    expect(queue.waiting).toBe(0);
    expect(queue.retained).toBe(2);

    a.resolve(undefined);
    b.resolve(undefined);
    await Promise.all(running);
    expect(queue.retained).toBe(0);
  });

  it('skips a send whose owner went stale while queued and starts the next chat', async () => {
    const owner = generationHarness();
    const queue = createLogicalSendQueue({ subscribeInvalidation: owner.subscribe });
    const a = deferred<void>();
    const starts: string[] = [];
    let staleCurrent = true;
    const live = owner.lease();
    const staleLease = { generation: live.generation, isCurrent: () => staleCurrent };
    const first = queue.run(owner.lease(), CHAT_A, job(starts, 'A1', a));
    const stale = queue.run(staleLease, CHAT_B, job(starts, 'B1'));
    const next = queue.run(owner.lease(), CHAT_C, job(starts, 'C1'));
    const staleRejection = expect(stale).rejects.toBeInstanceOf(LogicalSendQueueCancelledError);
    await flushMicrotasks();

    staleCurrent = false;
    a.resolve(undefined);
    await staleRejection;
    await Promise.all([first, next]);
    expect(starts).toEqual(['A1', 'C1']);
  });

  it('does not let a late finish free the turn its chat already passed on', async () => {
    jest.useFakeTimers();
    const owner = generationHarness();
    const queue = createLogicalSendQueue({ subscribeInvalidation: owner.subscribe });
    const first = deferred<void>();
    const second = deferred<void>();
    const starts: string[] = [];
    try {
      const runs = [
        queue.run(owner.lease(), CHAT_A, job(starts, 'A1', first)),
        queue.run(owner.lease(), CHAT_A, job(starts, 'A2', second)),
        queue.run(owner.lease(), CHAT_B, job(starts, 'B1')),
      ];
      await flushMicrotasks();
      await jest.advanceTimersByTimeAsync(LOGICAL_SEND_ORDER_WINDOW_MS);
      expect(starts).toEqual(['A1', 'A2']);

      // A1 finishing late must not release A2's turn: B1 still waits for A2.
      first.resolve(undefined);
      await flushMicrotasks();
      expect(starts).toEqual(['A1', 'A2']);

      second.resolve(undefined);
      await Promise.all(runs);
      expect(starts).toEqual(['A1', 'A2', 'B1']);
    } finally {
      first.resolve(undefined);
      second.resolve(undefined);
      jest.useRealTimers();
    }
  });

  it('refuses a send without a chat key before counting it', async () => {
    const owner = generationHarness();
    const queue = createLogicalSendQueue({ subscribeInvalidation: owner.subscribe });
    const task = jest.fn(async () => 'must-not-start');

    await expect(queue.run(owner.lease(), '', task)).rejects.toBeInstanceOf(TypeError);
    expect(task).not.toHaveBeenCalled();
    expect(queue.retained).toBe(0);
    expect(() => createLogicalSendQueue({ maxActiveChats: 0 })).toThrow(RangeError);
  });
});
