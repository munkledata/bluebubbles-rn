import { ApiError } from '@core/api/errors';
import { backoffWithJitter, isRetryableError, withRetry, type RetryPolicy } from '@core/api/retry';

const noSleep = async (): Promise<void> => {};

describe('retry', () => {
  it('isRetryableError: only transient ApiError kinds', () => {
    expect(isRetryableError(new ApiError('no_connection', 'x'))).toBe(true);
    expect(isRetryableError(new ApiError('timeout', 'x'))).toBe(true);
    expect(isRetryableError(new ApiError('server_error', 'x', 500))).toBe(true);
    expect(isRetryableError(new ApiError('unauthorized', 'x', 401))).toBe(false);
    expect(isRetryableError(new ApiError('bad_request', 'x', 400))).toBe(false);
    expect(isRetryableError(new ApiError('parse_error', 'x'))).toBe(false);
    expect(isRetryableError(new Error('plain'))).toBe(false);
  });

  it('retries a retryable failure, then succeeds', async () => {
    let n = 0;
    const fn = jest.fn(async () => {
      n += 1;
      if (n < 3) throw new ApiError('timeout', 'x');
      return 'ok';
    });
    expect(await withRetry(fn, { attempts: 3 }, noSleep)).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('rethrows after exhausting attempts', async () => {
    const fn = jest.fn(async () => {
      throw new ApiError('no_connection', 'down');
    });
    await expect(withRetry(fn, { attempts: 3 }, noSleep)).rejects.toThrow('down');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('fails fast on a non-retryable error (no retry)', async () => {
    const fn = jest.fn(async () => {
      throw new ApiError('unauthorized', 'nope', 401);
    });
    await expect(withRetry(fn, { attempts: 3 }, noSleep)).rejects.toThrow('nope');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('backoff grows, caps at maxMs, and respects the jitter window', () => {
    const full: RetryPolicy = { baseMs: 100, maxMs: 1000, random: () => 1 };
    expect(backoffWithJitter(1, full)).toBe(100);
    expect(backoffWithJitter(2, full)).toBe(200);
    expect(backoffWithJitter(5, full)).toBe(1000); // 100*2^4=1600 capped to 1000
    // random=0 → the floor of the window is base/2
    expect(backoffWithJitter(2, { baseMs: 100, maxMs: 1000, random: () => 0 })).toBe(100);
  });
});
