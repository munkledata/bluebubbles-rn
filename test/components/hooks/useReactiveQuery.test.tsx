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
