/**
 * Run `fn` over `items` with bounded concurrency and optional pre-task pacing — the throttle for
 * bulk sync passes against a single self-hosted server that saturates under unbounded fan-out.
 * `delayMs` is applied BEFORE each task in a worker (a simple rate limiter); a task that throws is
 * isolated via `onError` so one bad item can't sink the batch. Resolves when every item is done.
 *
 * React-free + Node-pure (no platform APIs), so it's unit-testable and usable from the headless
 * sync path.
 */
export async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
  opts: { delayMs?: number; onError?: (item: T, error: unknown) => void } = {},
): Promise<void> {
  const delayMs = opts.delayMs ?? 0;
  const queue = items.slice();
  if (queue.length === 0) return;
  const workers = Math.max(1, Math.min(limit, queue.length));
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  const work = async (): Promise<void> => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) return;
      if (delayMs > 0) await sleep(delayMs);
      try {
        await fn(item);
      } catch (e) {
        opts.onError?.(item, e);
      }
    }
  };
  await Promise.all(Array.from({ length: workers }, () => work()));
}
