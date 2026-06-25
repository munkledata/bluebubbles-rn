import { ApiError, type ApiErrorKind } from './errors';

/**
 * Failures worth retrying: a dropped/lost connection, a timeout, or a transient 5xx. NOT 4xx
 * (auth/bad-request — retrying won't help) and NOT parse errors (deterministic). Crucial for users
 * on flaky networks: one blip shouldn't surface as a hard failure.
 */
const RETRYABLE: ReadonlySet<ApiErrorKind> = new Set(['no_connection', 'timeout', 'server_error']);

export function isRetryableError(e: unknown): boolean {
  return e instanceof ApiError && RETRYABLE.has(e.kind);
}

export interface RetryPolicy {
  /** Total attempts including the first (default 3). */
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  /** Injectable RNG for deterministic tests (default Math.random). */
  random?: () => number;
}

/** Exponential backoff with full jitter: a random point in [base/2, base] of the capped delay. */
export function backoffWithJitter(
  attempt: number,
  policy: RetryPolicy = {},
  rnd: () => number = policy.random ?? Math.random,
): number {
  const capped = Math.min((policy.baseMs ?? 400) * 2 ** Math.max(0, attempt - 1), policy.maxMs ?? 8000);
  return Math.round(capped * (0.5 + 0.5 * rnd()));
}

/**
 * Run `fn`, retrying only {@link isRetryableError} failures with jittered backoff, up to
 * `attempts`. A non-retryable error (or the last attempt) rethrows immediately. `sleep` is
 * injectable so tests don't actually wait.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy = {},
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  const attempts = Math.max(1, policy.attempts ?? 3);
  let last: unknown;
  for (let n = 1; n <= attempts; n++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (n === attempts || !isRetryableError(e)) throw e;
      await sleep(backoffWithJitter(n, policy));
    }
  }
  throw last;
}
