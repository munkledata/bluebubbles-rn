/* eslint-disable import/first -- The delivery-coordinator mock must exist before import. */
const mockSubscribeInvalidation = jest.fn((_generation: number, _invalidate: () => void) =>
  jest.fn(),
);

jest.mock('@/services/realtime/deliveryCoordinator', () => ({
  subscribeRealtimeGenerationInvalidation: mockSubscribeInvalidation,
}));

import {
  adoptRealtimeHeadlessEffect,
  beginRealtimeHeadlessEffectCollection,
} from '@/services/background/realtimeHeadlessEffects';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('realtime headless effect collection', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('awaits adopted effects sequentially but ignores unrelated generations', async () => {
    const work = deferred<void>();
    const effect = jest.fn(async () => work.promise);
    const duplicate = jest.fn(async () => undefined);
    const next = jest.fn(async () => undefined);
    const collection = beginRealtimeHeadlessEffectCollection(
      { generation: 7, isCurrent: () => true },
      { deadlineAt: Date.now() + 1_000 },
    );

    expect(adoptRealtimeHeadlessEffect(8, 'message:1', async () => undefined)).toEqual({
      status: 'absent',
    });
    const adopted = adoptRealtimeHeadlessEffect(7, 'message:1', effect);
    const deduplicated = adoptRealtimeHeadlessEffect(7, 'message:1', duplicate);
    const queued = adoptRealtimeHeadlessEffect(7, 'message:2', next);
    if (
      adopted.status !== 'adopted' ||
      deduplicated.status !== 'adopted' ||
      queued.status !== 'adopted'
    ) {
      throw new Error('matching collection did not adopt the effect');
    }
    expect(deduplicated.task).toBe(adopted.task);
    await Promise.resolve();
    expect(effect).not.toHaveBeenCalled();

    const closing = collection.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(effect).toHaveBeenCalledTimes(1);
    expect(duplicate).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(closed).toBe(false);

    work.resolve(undefined);
    await expect(adopted.task).resolves.toBeUndefined();
    await expect(queued.task).resolves.toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
    await expect(closing).resolves.toBe('completed');
  });

  it('rejects a matching adoption after its absolute deadline without starting the effect', async () => {
    const effect = jest.fn(async () => undefined);
    const collection = beginRealtimeHeadlessEffectCollection(
      { generation: 8, isCurrent: () => true },
      { deadlineAt: Date.now() + 100 },
    );

    await jest.advanceTimersByTimeAsync(100);
    expect(adoptRealtimeHeadlessEffect(8, 'message:2', effect)).toEqual({ status: 'rejected' });
    expect(effect).not.toHaveBeenCalled();
    await expect(collection.close()).resolves.toBe('deadline');
  });

  it('revokes an unfinished effect at the absolute deadline and returns after cleanup grace', async () => {
    const work = deferred<void>();
    let capturedCurrent: (() => boolean) | undefined;
    const collection = beginRealtimeHeadlessEffectCollection(
      { generation: 9, isCurrent: () => true },
      { deadlineAt: Date.now() + 100, cancelGraceMs: 25 },
    );
    const adopted = adoptRealtimeHeadlessEffect(9, 'message:3', async (lifetime) => {
      capturedCurrent = lifetime.isCurrent;
      await work.promise;
    });
    if (adopted.status !== 'adopted') throw new Error('effect was not adopted');
    const closing = collection.close();
    await Promise.resolve();
    expect(capturedCurrent?.()).toBe(true);

    await jest.advanceTimersByTimeAsync(100);
    expect(capturedCurrent?.()).toBe(false);
    expect(adoptRealtimeHeadlessEffect(9, 'message:4', async () => undefined)).toEqual({
      status: 'absent',
    });
    await jest.advanceTimersByTimeAsync(25);
    await expect(closing).resolves.toBe('deadline');

    work.resolve(undefined);
    await expect(adopted.task).resolves.toBeUndefined();
  });

  it('revokes immediately when the owning account generation is invalidated', async () => {
    const work = deferred<void>();
    let capturedCurrent: (() => boolean) | undefined;
    let invalidate: (() => void) | undefined;
    mockSubscribeInvalidation.mockImplementationOnce((_generation, listener) => {
      invalidate = listener;
      return jest.fn();
    });
    const collection = beginRealtimeHeadlessEffectCollection(
      { generation: 11, isCurrent: () => true },
      { deadlineAt: Date.now() + 1_000, cancelGraceMs: 0 },
    );
    const adopted = adoptRealtimeHeadlessEffect(11, 'message:5', async (lifetime) => {
      capturedCurrent = lifetime.isCurrent;
      await work.promise;
    });
    if (adopted.status !== 'adopted') throw new Error('effect was not adopted');
    const closing = collection.close();
    await Promise.resolve();
    invalidate?.();

    expect(capturedCurrent?.()).toBe(false);
    await expect(closing).resolves.toBe('account-changed');
    work.resolve(undefined);
    await expect(adopted.task).resolves.toBeUndefined();
  });
});
