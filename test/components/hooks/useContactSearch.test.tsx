/**
 * useContactSearch (src/features/contacts/useContactSearch.ts) — contact-address suggestions
 * shared by new-chat and the FaceTime dialer. Locks in the doc-comment contract:
 *   - result delivery: whatever `searchContactAddresses` resolves is exposed;
 *   - a rejected search is swallowed → empty suggestions (never throws);
 *   - active-flag cancellation: a stale query's late result never clobbers the newer one;
 *   - REACTIVE on `contacts`: a sync landing while the screen is open refreshes it.
 *
 * `searchContactAddresses` is mocked in-file. `@db/database` needs a `getRawDatabase` too — the
 * shared setup stub has only `getDatabase`, so `useReactiveQuery`'s
 * `getRawDatabase().reactiveExecute(...)` throws, is swallowed at `logger.debug`, and NO
 * subscription is ever created: the reactive half of this hook would be untestable and its
 * `['contacts']` table string (a bare, unchecked literal) validated by nothing.
 *
 * It is added to the setup's mock INSTANCE rather than by re-declaring `jest.mock` here: setup.ts
 * imports the theme store, which pulls `@db/database` in, so the module is already instantiated by
 * the time this file's mock factories register and a second factory would never run.
 */
import { renderHook, act, waitFor } from '../support/renderWithTheme';
import { useContactSearch } from '@features/contacts/useContactSearch';
import { searchContactAddresses, type ContactPick } from '@db/repositories';

jest.mock('@db/repositories', () => ({ searchContactAddresses: jest.fn() }));

interface ReactiveOptions {
  fireOn: Array<{ table: string }>;
  callback: () => void;
}

/** Tables the hook subscribed to, and the trigger op-sqlite would call after a write flush. */
let subscribedTables: string[] = [];
let fireReactive: (() => void) | null = null;

(
  jest.requireMock('@db/database') as {
    getRawDatabase: () => { reactiveExecute: (o: ReactiveOptions) => () => void };
  }
).getRawDatabase = () => ({
  reactiveExecute: (opts: ReactiveOptions) => {
    subscribedTables = opts.fireOn.map((f) => f.table);
    fireReactive = opts.callback;
    return () => {
      fireReactive = null;
    };
  },
});

const mockSearch = searchContactAddresses as jest.MockedFunction<typeof searchContactAddresses>;

beforeEach(() => {
  mockSearch.mockResolvedValue([]);
  subscribedTables = [];
  fireReactive = null;
});

describe('useContactSearch', () => {
  it('delivers the resolved picks for the query', async () => {
    const picks: ContactPick[] = [{ name: 'Alice', address: '+15550000001' }];
    mockSearch.mockResolvedValue(picks);

    const { result } = await renderHook(({ q }: { q: string }) => useContactSearch(q), {
      initialProps: { q: 'al' },
    });

    await waitFor(() => expect(result.current).toBe(picks));
    expect(mockSearch).toHaveBeenCalledWith(undefined, 'al', 30);
  });

  it('forwards a custom limit', async () => {
    await renderHook(({ q }: { q: string }) => useContactSearch(q, 5), {
      initialProps: { q: 'bo' },
    });
    await waitFor(() => expect(mockSearch).toHaveBeenCalledWith(undefined, 'bo', 5));
  });

  it('resets to empty when the search rejects (never throws)', async () => {
    mockSearch.mockResolvedValueOnce([{ name: 'Alice', address: '+15550000001' }]);
    const { result, rerender } = await renderHook(({ q }: { q: string }) => useContactSearch(q), {
      initialProps: { q: 'al' },
    });
    await waitFor(() => expect(result.current).toHaveLength(1));

    mockSearch.mockRejectedValueOnce(new Error('db closed'));
    await act(async () => {
      rerender({ q: 'bo' });
    });
    await waitFor(() => expect(result.current).toEqual([]));
  });

  it('drops a stale query’s late result (active-flag cancellation)', async () => {
    const resolvers: Array<(picks: ContactPick[]) => void> = [];
    mockSearch.mockImplementation(
      () =>
        new Promise<ContactPick[]>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const { result, rerender } = await renderHook(({ q }: { q: string }) => useContactSearch(q), {
      initialProps: { q: 'first' },
    });
    await act(async () => {
      rerender({ q: 'second' });
    });

    // The newer query resolves first…
    await act(async () => {
      resolvers[1]!([{ name: 'Bob', address: 'bob@example.com' }]);
    });
    // …then the STALE first query resolves late — it must not clobber.
    await act(async () => {
      resolvers[0]!([{ name: 'Stale', address: 'stale@example.com' }]);
    });

    expect(result.current).toEqual([{ name: 'Bob', address: 'bob@example.com' }]);
  });

  /**
   * The reason the hook is reactive at all. A share-into-Gator cold start routes straight to
   * /new-chat at the same moment boot's first contacts sync begins, so the first read genuinely
   * sees an empty table. A one-shot read taken there stayed empty until the user typed something,
   * which reads as "Gator can't see my contacts".
   */
  it('re-reads when the contacts table changes, with no new query typed', async () => {
    const { result } = await renderHook(() => useContactSearch(''));
    await waitFor(() => expect(result.current).toEqual([]));
    // The subscription is what makes the refresh possible — and the table name is a bare string
    // nothing else validates.
    expect(subscribedTables).toEqual(['contacts']);
    expect(fireReactive).not.toBeNull();

    // The sync commits its rows; op-sqlite's flush fires the subscription.
    const picks: ContactPick[] = [{ name: 'Alice', address: '+15550000001' }];
    mockSearch.mockResolvedValue(picks);
    fireReactive?.();

    // Debounced by 24ms, so poll rather than asserting synchronously.
    await waitFor(() => expect(result.current).toBe(picks));
    expect(mockSearch).toHaveBeenCalledTimes(2);
  });

  it('drops the subscription on unmount (no re-query against a dead tree)', async () => {
    const { unmount } = await renderHook(() => useContactSearch('al'));
    await waitFor(() => expect(fireReactive).not.toBeNull());
    await act(async () => {
      unmount();
    });
    expect(fireReactive).toBeNull();
  });
});
