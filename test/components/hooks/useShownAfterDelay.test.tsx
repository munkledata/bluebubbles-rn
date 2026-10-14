import { useShownAfterDelay } from '@ui/hooks/useShownAfterDelay';
import { act, renderHook } from '../support/renderWithTheme';

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

async function advance(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

async function renderWithKey(key: string | null) {
  return renderHook(({ current }: { current: string | null }) => useShownAfterDelay(current, 300), {
    initialProps: { current: key },
  });
}

describe('useShownAfterDelay', () => {
  it('stays hidden until the same key has been held for the whole delay', async () => {
    const { result } = await renderWithKey('page-1');

    expect(result.current).toBe(false);
    await advance(299);
    expect(result.current).toBe(false);
    await advance(1);
    expect(result.current).toBe(true);
  });

  it('starts hidden again for a new key and never shows for null', async () => {
    const { result, rerender } = await renderWithKey('page-1');
    await advance(300);
    expect(result.current).toBe(true);

    await act(async () => {
      rerender({ current: 'page-2' });
    });
    expect(result.current).toBe(false);
    await advance(300);
    expect(result.current).toBe(true);

    await act(async () => {
      rerender({ current: null });
    });
    expect(result.current).toBe(false);
    await advance(1000);
    expect(result.current).toBe(false);
  });

  it('does not show a key that was replaced before its delay ran out', async () => {
    const { result, rerender } = await renderWithKey('page-1');
    await advance(200);

    await act(async () => {
      rerender({ current: 'page-2' });
    });
    await advance(200);
    expect(result.current).toBe(false);
    await advance(100);
    expect(result.current).toBe(true);
  });
});
