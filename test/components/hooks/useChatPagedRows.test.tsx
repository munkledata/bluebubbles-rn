/**
 * useChatPagedRows grows its request by limit, not by row count: a links page can hold fewer rows
 * than it was read with (repeated URLs collapse), and must still be able to load more.
 */
import { act, renderHook, waitFor } from '../support/renderWithTheme';
import {
  useChatPagedRows,
  type ChatPagedRowSource,
} from '@features/conversations/useChatPagedRows';

jest.mock('@db/database', () => ({ getDatabase: () => ({}) }));

jest.mock('@db/repositories', () => ({ CHAT_DOCUMENT_PAGE_SIZE: 50 }));

jest.mock('@/services/realtime/deliveryCoordinator', () => ({
  runTrackedRealtimeWork: async (
    lease: { isCurrent: () => boolean },
    work: (lease: { isCurrent: () => boolean }) => Promise<void>,
  ) => {
    if (!lease.isCurrent()) return 'paused';
    await work(lease);
    return lease.isCurrent() ? 'delivered' : 'paused';
  },
}));

const mockFetch = jest.fn();
const SOURCE: ChatPagedRowSource<{ url: string }> = {
  id: 'links',
  fetchPage: (_db, _chat, limit) => mockFetch(limit),
  rowKey: (row) => row.url,
};
const accountLease = { generation: 3, isCurrent: () => true };

it('asks for the next 50 messages even when a page holds only a few links', async () => {
  mockFetch
    .mockResolvedValueOnce({ items: [{ url: 'https://a.example' }], hasMore: true })
    .mockResolvedValueOnce({
      items: [{ url: 'https://a.example' }, { url: 'https://b.example' }],
      hasMore: false,
    });

  const { result } = await renderHook(() => useChatPagedRows(SOURCE, 'chat', accountLease));
  await waitFor(() => expect(result.current.data?.items).toHaveLength(1));
  expect(result.current.hasMore).toBe(true);

  await act(async () => {
    result.current.loadMore();
  });
  await waitFor(() => expect(result.current.data?.items).toHaveLength(2));
  // A second loadMore while nothing more remains is a no-op.
  await act(async () => {
    result.current.loadMore();
  });
  expect(mockFetch.mock.calls.map((call) => call[0])).toEqual([50, 100]);
});
