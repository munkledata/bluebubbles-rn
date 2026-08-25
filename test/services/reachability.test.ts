import { ApiError } from '@core/api/errors';
import { logger } from '@core/secure';
import {
  classifyReachabilityFailure,
  probeReachabilityNow,
  startReachabilityWatch,
  stopReachabilityWatch,
} from '@/services/reachability';

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

  async function settle(): Promise<void> {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  }

  it('runs immediately, publishes down/up, and reports one observed recovery', async () => {
    const probe = jest
      .fn<Promise<unknown>, [AbortSignal]>()
      .mockRejectedValueOnce(new Error('temporarily unreachable'))
      .mockResolvedValue(undefined);
    const onStateChange = jest.fn();
    const onRecovered = jest.fn();
    startReachabilityWatch(probe, { onStateChange, onRecovered }, 1_000);

    expect(probe).toHaveBeenCalledTimes(1);
    await settle();
    expect(onStateChange).toHaveBeenLastCalledWith('unreachable');
    expect(onRecovered).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(onStateChange.mock.calls.map(([state]) => state)).toEqual(['unreachable', 'reachable']);
    expect(onRecovered).toHaveBeenCalledTimes(1);
  });

  it('classifies transport failures separately from server/auth/schema errors', () => {
    expect(classifyReachabilityFailure(new ApiError('no_connection', 'down'))).toBe('unreachable');
    expect(classifyReachabilityFailure(new ApiError('timeout', 'slow'))).toBe('unreachable');
    expect(classifyReachabilityFailure(new ApiError('unauthorized', 'denied', 401))).toBe('error');
    expect(classifyReachabilityFailure(new ApiError('server_error', 'broken', 500))).toBe('error');
  });

  it('contains a synchronous probe throw as an unreachable result', async () => {
    const onStateChange = jest.fn();
    const probe = jest.fn((_signal: AbortSignal): Promise<unknown> => {
      throw new Error('synchronous probe sentinel');
    });

    expect(() =>
      startReachabilityWatch(probe, { onStateChange, onRecovered: jest.fn() }, 1_000),
    ).not.toThrow();
    await settle();

    expect(onStateChange).toHaveBeenCalledWith('unreachable');
  });

  it('serializes manual probes instead of overlapping or publishing out of order', async () => {
    const first = deferred<unknown>();
    const probe = jest
      .fn<Promise<unknown>, [AbortSignal]>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(undefined);
    const onStateChange = jest.fn();
    startReachabilityWatch(probe, { onStateChange, onRecovered: jest.fn() }, 1_000);

    probeReachabilityNow();
    probeReachabilityNow();
    expect(probe).toHaveBeenCalledTimes(1);

    first.reject(new Error('first probe down'));
    await settle();

    expect(probe).toHaveBeenCalledTimes(2);
    expect(onStateChange.mock.calls.map(([state]) => state)).toEqual(['unreachable', 'reachable']);
  });

  it('aborts a stopped probe and ignores its late result', async () => {
    const result = deferred<unknown>();
    let signal!: AbortSignal;
    const probe = jest.fn((nextSignal: AbortSignal) => {
      signal = nextSignal;
      return result.promise;
    });
    const onStateChange = jest.fn();
    startReachabilityWatch(probe, { onStateChange, onRecovered: jest.fn() }, 1_000);

    stopReachabilityWatch();
    expect(signal.aborted).toBe(true);
    result.resolve(undefined);
    await settle();

    expect(onStateChange).not.toHaveBeenCalled();
  });

  it('ignores an account-A probe that rejects after account B starts', async () => {
    const accountAResult = deferred<unknown>();
    let accountASignal!: AbortSignal;
    const accountAProbe = jest.fn((signal: AbortSignal) => {
      accountASignal = signal;
      return accountAResult.promise;
    });
    const accountBProbe = jest.fn<Promise<unknown>, [AbortSignal]>().mockResolvedValue(undefined);
    const onAccountAState = jest.fn();
    const onAccountBState = jest.fn();

    startReachabilityWatch(
      accountAProbe,
      { onStateChange: onAccountAState, onRecovered: jest.fn() },
      1_000,
    );
    expect(accountAProbe).toHaveBeenCalledTimes(1);

    startReachabilityWatch(
      accountBProbe,
      { onStateChange: onAccountBState, onRecovered: jest.fn() },
      1_000,
    );
    expect(accountASignal.aborted).toBe(true);
    accountAResult.reject(new Error('late account-A failure'));
    await settle();

    expect(accountBProbe).toHaveBeenCalledTimes(1);
    expect(onAccountAState).not.toHaveBeenCalled();
    expect(onAccountBState).toHaveBeenCalledWith('reachable');
  });
});
