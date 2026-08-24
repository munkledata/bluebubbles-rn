import { logger } from '@core/secure';
import { startReachabilityWatch, stopReachabilityWatch } from '@/services/reachability';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('reachability watch account ownership', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    stopReachabilityWatch();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('reports an observed down-to-up transition', async () => {
    const probe = jest
      .fn<Promise<unknown>, []>()
      .mockRejectedValueOnce(new Error('temporarily unreachable'))
      .mockResolvedValue(undefined);
    const onReachable = jest.fn();
    startReachabilityWatch(probe, onReachable, 1_000);

    await jest.advanceTimersByTimeAsync(1_000);
    expect(onReachable).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1_000);
    expect(onReachable).toHaveBeenCalledTimes(1);
  });

  it('ignores an account-A probe that rejects after account B starts', async () => {
    const accountAResult = deferred<unknown>();
    const accountAProbe = jest.fn(() => accountAResult.promise);
    const accountBProbe = jest.fn().mockResolvedValue(undefined);
    const onAccountAReachable = jest.fn();
    const onAccountBReachable = jest.fn();

    startReachabilityWatch(accountAProbe, onAccountAReachable, 1_000);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(accountAProbe).toHaveBeenCalledTimes(1);

    stopReachabilityWatch();
    startReachabilityWatch(accountBProbe, onAccountBReachable, 1_000);
    accountAResult.reject(new Error('late account-A failure'));
    await Promise.resolve();

    await jest.advanceTimersByTimeAsync(1_000);

    expect(accountBProbe).toHaveBeenCalledTimes(1);
    expect(onAccountAReachable).not.toHaveBeenCalled();
    expect(onAccountBReachable).not.toHaveBeenCalled();
  });
});
