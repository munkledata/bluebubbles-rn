/**
 * useSharedDocuments keeps its last successful growing prefix while a newer read is pending or
 * retrying. A cancelled reactive query can still finish its repository work, so these tests cover
 * the hook-owned request fence rather than only the reactive layer's UI cancellation.
 */
import { act, renderHook, waitFor } from '../support/renderWithTheme';
import { useSharedDocuments } from '@features/conversations/useSharedDocuments';
import { listChatDocumentAttachmentsPage, type ChatDocumentPage } from '@db/repositories';

jest.mock('@db/repositories', () => ({
  CHAT_DOCUMENT_PAGE_SIZE: 50,
  listChatDocumentAttachmentsPage: jest.fn(),
}));

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

const mockListPage = listChatDocumentAttachmentsPage as jest.MockedFunction<
  typeof listChatDocumentAttachmentsPage
>;
const accountLease = { generation: 4, isCurrent: () => true };

function page(count: number, hasMore: boolean): ChatDocumentPage {
  return {
    hasMore,
    items: Array.from({ length: count }, (_, index) => ({
      id: index + 1,
      guid: `document-${index + 1}`,
      messageId: index + 100,
      mimeType: 'application/pdf',
      transferName: `document-${index + 1}.pdf`,
      totalBytes: 1024,
      height: null,
      width: null,
      blurhash: null,
      hasLivePhoto: 0,
      isSticker: 0,
      hideAttachment: 0,
      localPath: null,
      service: null,
      dateCreated: 10_000 - index,
    })),
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

beforeEach(() => {
  mockListPage.mockReset();
});

it('does not let a late 50-row refresh replace the successful 100-row prefix', async () => {
  const first50 = page(50, true);
  const stale50 = deferred<ChatDocumentPage>();
  const current100 = deferred<ChatDocumentPage>();
  const retryError = new Error('retry failed');
  mockListPage
    .mockResolvedValueOnce(first50)
    .mockReturnValueOnce(stale50.promise)
    .mockReturnValueOnce(current100.promise)
    .mockRejectedValueOnce(retryError);

  const { result } = await renderHook(() =>
    useSharedDocuments('iMessage;-;private-chat', accountLease),
  );
  await waitFor(() => expect(result.current.data?.items).toHaveLength(50));

  await act(async () => {
    result.current.retry();
  });
  await waitFor(() => expect(mockListPage).toHaveBeenCalledTimes(2));

  await act(async () => {
    result.current.loadMore();
  });
  await waitFor(() => expect(mockListPage).toHaveBeenCalledTimes(3));
  await act(async () => {
    current100.resolve(page(100, false));
  });
  await waitFor(() => expect(result.current.data?.items).toHaveLength(100));

  await act(async () => {
    stale50.resolve(page(50, true));
    await stale50.promise;
  });
  await act(async () => {
    result.current.retry();
  });

  await waitFor(() => expect(result.current.loadMoreError).toBe(retryError));
  expect(result.current.data?.items).toHaveLength(100);
  expect(mockListPage.mock.calls.map((call) => call[2])).toEqual([50, 50, 100, 100]);
});
