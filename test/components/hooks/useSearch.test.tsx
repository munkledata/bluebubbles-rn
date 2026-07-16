/**
 * useSearch (src/features/search/useSearch.ts) — debounced full-text MESSAGE search for the search
 * page. This suite locks in the doc-comment contract:
 *   - query gating: a trimmed query under 2 chars never hits the DB and yields empty, not-loading;
 *   - debounce: the DB read fires only after the 250ms timer (fake timers);
 *   - loading lifecycle: `loading` rises on a valid query and clears when results land;
 *   - result delivery: whatever `searchMessagesEnriched` resolves is exposed as `results`;
 *   - a rejected search is swallowed → empty results, loading cleared (never throws);
 *   - cleanup: a query change before the timer fires cancels the pending read (no stale delivery).
 *
 * `searchMessagesEnriched` is mocked in-file with controlled results; `getDatabase` is the shared
 * setup stub (its return is passed straight into the mocked search fn, so its value is irrelevant).
 * Debounce is driven with fake timers; instead of `waitFor` (flaky under fake timers) each step
 * advances the clock and flushes the resolved-promise microtasks inside a single `act`.
 */
import { renderHook, act } from '../support/renderWithTheme';
import { useSearch } from '@features/search/useSearch';
import { searchMessagesEnriched, type SearchResultRow } from '@db/repositories';

jest.mock('@db/repositories', () => ({ searchMessagesEnriched: jest.fn() }));

const mockSearch = searchMessagesEnriched as jest.MockedFunction<typeof searchMessagesEnriched>;

function mkResult(over: Partial<SearchResultRow> = {}): SearchResultRow {
  return {
    id: 1,
    guid: 'm-1',
    text: 'hello world',
    snippet: 'hello world',
    dateCreated: 1000,
    isFromMe: 0,
    chatGuid: 'iMessage;-;c1',
    chatDisplayName: null,
    chatCustomName: null,
    chatIdentifier: 'c1',
    chatStyle: 43,
    chatParticipantNames: 'Alice',
    senderName: 'Alice',
    ...over,
  };
}

/** Advance the fake clock and flush the promise microtasks the timer callback started. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    // Two ticks: one for the search promise's .then, one for the follow-up setState commit.
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  mockSearch.mockResolvedValue([]);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useSearch', () => {
  it('gates a sub-2-char query: no DB read, empty + not loading', async () => {
    const { result } = await renderHook(({ q }: { q: string }) => useSearch(q), {
      initialProps: { q: ' a ' },
    });

    expect(result.current.results).toEqual([]);
    expect(result.current.loading).toBe(false);
    // Even advancing past the debounce window does nothing — the effect returned early.
    await advance(500);
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('debounces then delivers results and clears loading', async () => {
    const rows = [mkResult({ id: 7, guid: 'm-7' })];
    mockSearch.mockResolvedValue(rows);

    const { result } = await renderHook(({ q }: { q: string }) => useSearch(q), {
      initialProps: { q: 'hello' },
    });

    // Effect ran: loading raised, but the 250ms timer hasn't fired yet → no DB read.
    expect(result.current.loading).toBe(true);
    expect(mockSearch).not.toHaveBeenCalled();

    await advance(250);

    expect(mockSearch).toHaveBeenCalledTimes(1);
    expect(mockSearch).toHaveBeenCalledWith(undefined, 'hello', 50);
    expect(result.current.results).toBe(rows);
    expect(result.current.loading).toBe(false);
  });

  it('trims the query before searching and forwards a custom limit', async () => {
    const { result } = await renderHook(({ q }: { q: string }) => useSearch(q, 10), {
      initialProps: { q: '  cat  ' },
    });
    await advance(250);
    expect(mockSearch).toHaveBeenCalledWith(undefined, 'cat', 10);
    expect(result.current.loading).toBe(false);
  });

  it('swallows a rejected search: empty results, loading cleared, never throws', async () => {
    mockSearch.mockRejectedValue(new Error('fts blew up'));
    const { result } = await renderHook(({ q }: { q: string }) => useSearch(q), {
      initialProps: { q: 'boom' },
    });

    await advance(250);
    expect(result.current.loading).toBe(false);
    expect(result.current.results).toEqual([]);
  });

  it('cancels a pending debounce when the query changes before the timer fires', async () => {
    const { result, rerender } = await renderHook(({ q }: { q: string }) => useSearch(q), {
      initialProps: { q: 'firs' },
    });
    // Advance only part-way, then change the query — cleanup clears the first timer.
    await advance(100);
    await act(async () => {
      rerender({ q: 'second' });
    });
    await advance(250);
    // Only the SECOND query reached the DB — the first was debounced away.
    expect(mockSearch).toHaveBeenCalledTimes(1);
    expect(mockSearch).toHaveBeenCalledWith(undefined, 'second', 50);
    expect(result.current.loading).toBe(false);
  });

  it('clears results when a valid query becomes too short', async () => {
    mockSearch.mockResolvedValue([mkResult()]);
    const { result, rerender } = await renderHook(({ q }: { q: string }) => useSearch(q), {
      initialProps: { q: 'hello' },
    });
    await advance(250);
    expect(result.current.results).toHaveLength(1);

    // Shrink below the min → the gate branch resets to empty + not loading synchronously.
    await act(async () => {
      rerender({ q: 'h' });
    });
    expect(result.current.results).toEqual([]);
    expect(result.current.loading).toBe(false);
  });
});
