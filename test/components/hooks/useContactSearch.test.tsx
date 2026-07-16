/**
 * useContactSearch (src/features/contacts/useContactSearch.ts) — contact-address suggestions
 * shared by new-chat and the FaceTime dialer. Locks in the doc-comment contract:
 *   - result delivery: whatever `searchContactAddresses` resolves is exposed;
 *   - a rejected search is swallowed → empty suggestions (never throws);
 *   - active-flag cancellation: a stale query's late result never clobbers the newer one.
 *
 * `searchContactAddresses` is mocked in-file; `getDatabase` is the shared setup stub (its
 * return is passed straight into the mocked search fn, so its value is irrelevant).
 */
import { renderHook, act, waitFor } from '../support/renderWithTheme';
import { useContactSearch } from '@features/contacts/useContactSearch';
import { searchContactAddresses, type ContactPick } from '@db/repositories';

jest.mock('@db/repositories', () => ({ searchContactAddresses: jest.fn() }));

const mockSearch = searchContactAddresses as jest.MockedFunction<typeof searchContactAddresses>;

beforeEach(() => {
  mockSearch.mockResolvedValue([]);
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
});
