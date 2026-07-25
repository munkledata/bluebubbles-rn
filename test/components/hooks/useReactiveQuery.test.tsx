/**
 * useReactiveQuery (src/db/useReactiveQuery.ts). Two groups:
 *
 * 1. `reactive re-run` — the hook's whole reason for existing. op-sqlite calls the `callback` we
 *    hand `reactiveExecute` whenever a subscribed table mutates; the hook must debounce that and
 *    re-run `run()`. These tests CAPTURE that callback and INVOKE it (a test that only inspects
 *    the `fireOn` shape never proves the query re-runs at all).
 * 2. `enabled` gating — see the second describe.
 */

/**
 * useReactiveQuery `enabled` gating (src/db/useReactiveQuery.ts). Every mounted MessageBubble
 * calls useUrlPreview, so a bubble with NO url must not run the query or open a url_previews
 * reactive subscription — that's what `options.enabled` is for. Locked in:
 *   - enabled: false → no initial exec, no reactiveExecute registration, idle state
 *     ({ data: null, isLoading: false, error: null });
 *   - default (option omitted) → the query runs and the subscription registers (fireOn tables);
 *   - flipping enabled false → true starts the query + subscription;
 *   - flipping true → false unsubscribes and returns to the idle state.
 *
 * The shared setup already mocks `@db/database` (getDatabase only) AND requires it (via the
 * themeStore import), so an in-file `jest.mock` factory can't replace it — instead we attach a
 * controllable `getRawDatabase` onto the existing mocked module object (the hook reads the
 * property at call time).
 */
import { act, renderHook, waitFor } from '../support/renderWithTheme';
import { useReactiveQuery } from '@db/useReactiveQuery';

const mockUnsubscribe = jest.fn();
const mockReactiveExecute = jest.fn(() => mockUnsubscribe);
const dbMock = jest.requireMock('@db/database') as { getRawDatabase?: () => unknown };

beforeEach(() => {
  dbMock.getRawDatabase = () => ({ reactiveExecute: mockReactiveExecute });
});

/** The DEBOUNCE_MS constant in the hook — a table-change burst coalesces inside this window. */
const DEBOUNCE_MS = 24;

/**
 * The `callback` op-sqlite would invoke when a subscribed table mutates. Grabbing it off the
 * recorded reactiveExecute arg is the only way to simulate a write from a test (there is no real
 * op-sqlite here), and it's the seam the "asserts the fireOn shape only" tests never crossed.
 */
function tableChangedCallback(): () => void {
  // `mockReactiveExecute` is declared with no parameter types, so its recorded calls type as an
  // empty tuple — re-type the recorded argument to read the callback back out.
  const call = mockReactiveExecute.mock.calls[0] as unknown as
    | [{ callback?: () => void }]
    | undefined;
  const arg = call?.[0];
  if (typeof arg?.callback !== 'function') {
    throw new Error('reactiveExecute was never given a callback');
  }
  return arg.callback;
}

describe('useReactiveQuery reactive re-run', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('re-runs the query when a subscribed table mutates (after the debounce)', async () => {
    const run = jest
      .fn<Promise<string>, []>()
      .mockResolvedValueOnce('BEFORE')
      .mockResolvedValueOnce('AFTER');
    const { result } = await renderHook(() => useReactiveQuery(run, ['messages']));
    await waitFor(() => expect(result.current.data).toBe('BEFORE'));
    expect(run).toHaveBeenCalledTimes(1);

    const onTableChanged = tableChangedCallback();

    // A write lands: the hook schedules, but must NOT re-query before the debounce elapses.
    await act(async () => {
      onTableChanged();
      jest.advanceTimersByTime(DEBOUNCE_MS - 1);
      await Promise.resolve();
    });
    expect(run).toHaveBeenCalledTimes(1);

    // …and DOES once it does.
    await act(async () => {
      jest.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(run).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.data).toBe('AFTER'));
    expect(result.current.isLoading).toBe(false);
  });

  it('coalesces a BURST of table changes into a single re-run', async () => {
    const run = jest.fn<Promise<string>, []>().mockResolvedValue('DATA');
    const { result } = await renderHook(() => useReactiveQuery(run, ['messages', 'chats']));
    await waitFor(() => expect(result.current.data).toBe('DATA'));
    expect(run).toHaveBeenCalledTimes(1); // the initial, immediate exec

    const onTableChanged = tableChangedCallback();

    // A sync batch fires the callback many times in quick succession (each one inside the
    // debounce window). Without the clearTimeout in `schedule` this would be 8 extra queries.
    await act(async () => {
      for (let i = 0; i < 8; i++) {
        onTableChanged();
        jest.advanceTimersByTime(DEBOUNCE_MS - 4);
      }
      jest.advanceTimersByTime(DEBOUNCE_MS);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(run).toHaveBeenCalledTimes(2); // initial + exactly ONE coalesced re-run
  });

  it('unmounting cancels an in-flight debounce and unsubscribes', async () => {
    const run = jest.fn<Promise<string>, []>().mockResolvedValue('DATA');
    const { result, unmount } = await renderHook(() => useReactiveQuery(run, ['messages']));
    await waitFor(() => expect(result.current.data).toBe('DATA'));
    const onTableChanged = tableChangedCallback();

    // A write lands, THEN the screen closes before the debounce fires. The unmount gets its own
    // act(): RNTL 14 / React 19 flushes unmount effects asynchronously, so cleanup would not yet
    // have run if we advanced the timers in the same block.
    await act(async () => {
      onTableChanged();
      jest.advanceTimersByTime(DEBOUNCE_MS - 4);
    });
    await act(async () => {
      unmount();
    });
    await act(async () => {
      jest.advanceTimersByTime(DEBOUNCE_MS * 4);
      await Promise.resolve();
      await Promise.resolve();
    });

    // The pending timer was cleared by the effect cleanup — no query against a dead consumer.
    expect(run).toHaveBeenCalledTimes(1);
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    // NOTE (current behaviour, deliberately not asserted as correct): a callback that arrives
    // AFTER unmount still schedules an exec — the `cancelled` flag only guards the setState, not
    // the `run()` call itself. Harmless here (op-sqlite stops calling us once unsubscribed, and
    // the result is discarded), but it is a wasted DB query if native ever races the unsubscribe.
  });
});

describe('useReactiveQuery enabled gating', () => {
  it('enabled: false → no query run, no subscription, idle state', async () => {
    const run = jest.fn().mockResolvedValue('DATA');
    const { result } = await renderHook(() =>
      useReactiveQuery(run, ['url_previews'], [], { enabled: false }),
    );
    expect(result.current).toEqual({ data: null, isLoading: false, error: null });
    expect(run).not.toHaveBeenCalled();
    expect(mockReactiveExecute).not.toHaveBeenCalled();
  });

  it('default (no option) → runs the query and registers the table subscription', async () => {
    const run = jest.fn().mockResolvedValue('DATA');
    const { result } = await renderHook(() => useReactiveQuery(run, ['url_previews']));
    await waitFor(() => expect(result.current.data).toBe('DATA'));
    expect(result.current.isLoading).toBe(false);
    expect(mockReactiveExecute).toHaveBeenCalledTimes(1);
    expect(mockReactiveExecute).toHaveBeenCalledWith(
      expect.objectContaining({ fireOn: [{ table: 'url_previews' }] }),
    );
  });

  it('flipping enabled false → true starts the query + subscription', async () => {
    const run = jest.fn().mockResolvedValue('DATA');
    const { result, rerender } = await renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useReactiveQuery(run, ['url_previews'], [], { enabled }),
      { initialProps: { enabled: false } },
    );
    expect(run).not.toHaveBeenCalled();

    await act(async () => {
      rerender({ enabled: true });
    });
    await waitFor(() => expect(result.current.data).toBe('DATA'));
    expect(mockReactiveExecute).toHaveBeenCalledTimes(1);
  });

  it('flipping enabled true → false unsubscribes and returns to the idle state', async () => {
    const run = jest.fn().mockResolvedValue('DATA');
    const { result, rerender } = await renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useReactiveQuery(run, ['url_previews'], [], { enabled }),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current.data).toBe('DATA'));

    await act(async () => {
      rerender({ enabled: false });
    });
    await waitFor(() =>
      expect(result.current).toEqual({ data: null, isLoading: false, error: null }),
    );
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1); // the disabled pass never re-ran it
  });
});
