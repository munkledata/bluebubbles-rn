import { mapWithConcurrency } from '@core/async/pool';

describe('mapWithConcurrency', () => {
  it('never exceeds the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await mapWithConcurrency(items, 3, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // actually parallel
  });

  it('processes every item exactly once', async () => {
    const seen: number[] = [];
    await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (i) => {
      seen.push(i);
    });
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('isolates a throwing task via onError and keeps going', async () => {
    const errored: number[] = [];
    const done: number[] = [];
    await mapWithConcurrency(
      [1, 2, 3],
      2,
      async (i) => {
        if (i === 2) throw new Error('boom');
        done.push(i);
      },
      { onError: (i) => errored.push(i) },
    );
    expect(errored).toEqual([2]);
    expect(done.sort((a, b) => a - b)).toEqual([1, 3]);
  });

  it('is a no-op on empty input', async () => {
    const fn = jest.fn(async () => {});
    await mapWithConcurrency([], 3, fn);
    expect(fn).not.toHaveBeenCalled();
  });
});
