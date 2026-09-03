/**
 * A cancelled reactive query can still finish its repository work. This locks the hook-owned
 * request fence so a late smaller refresh cannot replace the successful growing prefix.
 */
import { act, renderHook, waitFor } from '../support/renderWithTheme';
import type { CustomFolderInboxPage } from '@db/repositories';
import { useCustomFolderChats } from '@features/conversations/useCustomFolderChats';
import { loadCustomFolderInboxPage } from '@/services/customFolderCommands';
import { mkInboxRow } from './_fixtures';

jest.mock('@/services/customFolderCommands', () => ({
  loadCustomFolderInboxPage: jest.fn(),
}));

const mockLoadCustomFolderInboxPage = jest.mocked(loadCustomFolderInboxPage);
const accountLease = { generation: 4, isCurrent: () => true };

function page(count: number, hasMore: boolean): CustomFolderInboxPage {
  return {
    folder: { id: 1, name: 'Work', sortOrder: 0, chatCount: count },
    availableCount: count,
    matchingCount: count,
    hasMore,
    rows: Array.from({ length: count }, (_, index) =>
      mkInboxRow({ id: index + 1, guid: `chat-${index + 1}` }),
    ),
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

beforeEach(() => {
  mockLoadCustomFolderInboxPage.mockReset();
});

it('does not let a late 50-row refresh replace the successful 100-row prefix', async () => {
  type LoadResult = Awaited<ReturnType<typeof loadCustomFolderInboxPage>>;
  const stale50 = deferred<LoadResult>();
  const current100 = deferred<LoadResult>();
  const retryError = new Error('retry failed');
  mockLoadCustomFolderInboxPage
    .mockResolvedValueOnce({ status: 'committed', value: page(50, true) })
    .mockReturnValueOnce(stale50.promise)
    .mockReturnValueOnce(current100.promise)
    .mockRejectedValueOnce(retryError);

  const { result } = await renderHook(() => useCustomFolderChats(1, accountLease));
  await waitFor(() => expect(result.current.data?.rows).toHaveLength(50));

  await act(async () => {
    result.current.retry();
  });
  await waitFor(() => expect(mockLoadCustomFolderInboxPage).toHaveBeenCalledTimes(2));

  await act(async () => {
    result.current.loadMore();
  });
  await waitFor(() => expect(mockLoadCustomFolderInboxPage).toHaveBeenCalledTimes(3));
  await act(async () => {
    current100.resolve({ status: 'committed', value: page(100, false) });
    await current100.promise;
  });
  await waitFor(() => expect(result.current.data?.rows).toHaveLength(100));

  await act(async () => {
    stale50.resolve({ status: 'committed', value: page(50, true) });
    await stale50.promise;
  });
  await act(async () => {
    result.current.retry();
  });

  await waitFor(() => expect(result.current.loadMoreError).toBe(retryError));
  expect(result.current.data?.rows).toHaveLength(100);
  expect(mockLoadCustomFolderInboxPage.mock.calls.map((call) => call[1])).toEqual([
    50, 50, 100, 100,
  ]);
});
