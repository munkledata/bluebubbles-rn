import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
  runAccountScopedLocalMutation,
  runTrackedRealtimeDelivery,
  runTrackedRealtimeWork,
  subscribeRealtimeGenerationInvalidation,
} from '@/services/realtime/deliveryCoordinator';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function settlementProbe(promise: Promise<unknown>): { isSettled: () => boolean } {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return { isSettled: () => settled };
}

afterEach(async () => {
  // Every test releases its gates first. Draining here prevents module-global work from leaking
  // into the next test, and resume restores the public coordinator to its normal boot state.
  await pauseRealtimeDeliveries();
  resumeRealtimeDeliveries();
});

describe('realtime delivery coordinator', () => {
  it('runs an admitted task and reports it as delivered', async () => {
    const task = jest.fn(async () => undefined);

    await expect(runTrackedRealtimeDelivery(task)).resolves.toBe('delivered');
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('registers an admitted task before an immediately following pause drains it', async () => {
    const gate = deferred();
    const delivery = runTrackedRealtimeDelivery(() => gate.promise);
    const pause = pauseRealtimeDeliveries();
    const pauseProbe = settlementProbe(pause);

    await Promise.resolve();
    expect(pauseProbe.isSettled()).toBe(false);

    gate.resolve();
    await expect(delivery).resolves.toBe('delivered');
    await expect(pause).resolves.toBeUndefined();
  });

  it('closes admission synchronously and never invokes a newer task', async () => {
    const pause = pauseRealtimeDeliveries();
    const task = jest.fn(async () => undefined);
    const pausedDelivery = runTrackedRealtimeDelivery(task);

    expect(task).not.toHaveBeenCalled();
    await expect(pausedDelivery).resolves.toBe('paused');
    await expect(pause).resolves.toBeUndefined();
  });

  it('drains every task admitted before the pause, regardless of settlement order', async () => {
    const firstGate = deferred();
    const secondGate = deferred();
    const first = runTrackedRealtimeDelivery(() => firstGate.promise);
    const second = runTrackedRealtimeDelivery(() => secondGate.promise);
    const pause = pauseRealtimeDeliveries();
    const pauseProbe = settlementProbe(pause);

    secondGate.resolve();
    await expect(second).resolves.toBe('delivered');
    expect(pauseProbe.isSettled()).toBe(false);

    firstGate.resolve();
    await expect(first).resolves.toBe('delivered');
    await expect(pause).resolves.toBeUndefined();
  });

  it('lets a task reject its caller without poisoning the pause drain', async () => {
    const gate = deferred();
    const failure = new Error('FCM write failed');
    const delivery = runTrackedRealtimeDelivery(() => gate.promise);
    const pause = pauseRealtimeDeliveries();

    gate.reject(failure);
    await expect(delivery).rejects.toBe(failure);
    await expect(pause).resolves.toBeUndefined();
  });

  it('reopens admission only after resume is called', async () => {
    await pauseRealtimeDeliveries();
    const whilePaused = jest.fn(async () => undefined);

    await expect(runTrackedRealtimeDelivery(whilePaused)).resolves.toBe('paused');
    expect(whilePaused).not.toHaveBeenCalled();

    resumeRealtimeDeliveries();
    const afterResume = jest.fn(async () => undefined);
    await expect(runTrackedRealtimeDelivery(afterResume)).resolves.toBe('delivered');
    expect(afterResume).toHaveBeenCalledTimes(1);
  });

  it('normalizes a synchronous task throw into a rejected caller and a clean drain', async () => {
    const failure = new Error('failed before first await');
    const delivery = runTrackedRealtimeDelivery(() => {
      throw failure;
    });
    const pause = pauseRealtimeDeliveries();

    await expect(delivery).rejects.toBe(failure);
    await expect(pause).resolves.toBeUndefined();
  });

  it('rejects a late commit from the generation invalidated by Disconnect', async () => {
    const lease = captureRealtimeDeliveryLease();
    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    const staleCommit = jest.fn(async () => undefined);

    await expect(runTrackedRealtimeWork(lease, staleCommit)).resolves.toBe('paused');
    expect(staleCommit).not.toHaveBeenCalled();
  });

  it('notifies dormant work synchronously when its account generation is invalidated', async () => {
    const lease = captureRealtimeDeliveryLease();
    const listener = jest.fn();
    const unsubscribe = subscribeRealtimeGenerationInvalidation(lease.generation, listener);

    const pause = pauseRealtimeDeliveries();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    await expect(pause).resolves.toBeUndefined();
  });

  it('does not retain a generation-invalidation listener after unsubscribe', async () => {
    const lease = captureRealtimeDeliveryLease();
    const listener = jest.fn();
    const unsubscribe = subscribeRealtimeGenerationInvalidation(lease.generation, listener);

    unsubscribe();
    await pauseRealtimeDeliveries();

    expect(listener).not.toHaveBeenCalled();
  });

  it('never revives a lease captured while account admission was paused', async () => {
    await pauseRealtimeDeliveries();
    const pausedLease = captureRealtimeDeliveryLease();
    expect(pausedLease.isCurrent()).toBe(false);

    resumeRealtimeDeliveries();
    expect(pausedLease.isCurrent()).toBe(false);
    const mutation = jest.fn(async () => undefined);
    await expect(runTrackedRealtimeWork(pausedLease, mutation)).resolves.toBe('paused');
    expect(mutation).not.toHaveBeenCalled();
  });

  it('quietly drops a local mutation retained from a previous account', async () => {
    const oldLease = captureRealtimeDeliveryLease();
    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    const mutation = jest.fn(async () => undefined);

    await expect(runAccountScopedLocalMutation(oldLease, mutation)).resolves.toBeUndefined();

    expect(mutation).not.toHaveBeenCalled();
  });

  it('keeps Disconnect draining until an admitted local DB write settles', async () => {
    const gate = deferred();
    const lease = captureRealtimeDeliveryLease();
    const mutation = jest.fn(() => gate.promise);
    const write = runAccountScopedLocalMutation(lease, mutation);
    const pause = pauseRealtimeDeliveries();
    const pauseProbe = settlementProbe(pause);

    await Promise.resolve();
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(pauseProbe.isSettled()).toBe(false);

    gate.resolve();
    await expect(write).resolves.toBeUndefined();
    await expect(pause).resolves.toBeUndefined();
  });
});
