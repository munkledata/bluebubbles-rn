/**
 * Direct coverage for the in-chat search data hook: input gating, stable paging, and the account
 * privacy fence that must hide a late result as soon as its realtime generation is retired.
 */
import React, { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, type InfiniteData } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '../support/renderWithTheme';
import { useChatSearch } from '@features/conversations/useChatSearch';
import {
  searchMessagesInChat,
  type ChatSearchCursor,
  type ChatSearchPage,
  type ChatSearchResultRow,
} from '@db/repositories';
import type { RealtimeDeliveryLease } from '@/services/realtime/deliveryCoordinator';

let mockInvalidationListener: (() => void) | null = null;
let mockSubscribedGeneration: number | null = null;
const mockUnsubscribe = jest.fn();

jest.mock('@db/repositories', () => ({
  searchMessagesInChat: jest.fn(),
}));

jest.mock('@/services/realtime/deliveryCoordinator', () => ({
  subscribeRealtimeGenerationInvalidation: (generation: number, listener: () => void) => {
    mockSubscribedGeneration = generation;
    mockInvalidationListener = listener;
    return mockUnsubscribe;
  },
}));

const mockSearchMessagesInChat = jest.mocked(searchMessagesInChat);
let mockAccountCurrent = true;
const accountLease: RealtimeDeliveryLease = {
  generation: 7,
  isCurrent: () => mockAccountCurrent,
};

const firstRow: ChatSearchResultRow = {
  id: 11,
  guid: 'message-search-result-11',
  dateCreated: 200,
  text: 'synthetic first search result',
  snippet: 'synthetic <b>first</b> search result',
  isFromMe: 0,
  senderName: 'Example Sender',
  senderAddress: 'sender@example.test',
};
const secondRow: ChatSearchResultRow = {
  id: 10,
  guid: 'message-search-result-10',
  dateCreated: 100,
  text: 'synthetic second search result',
  snippet: 'synthetic <b>second</b> search result',
  isFromMe: 1,
  senderName: null,
  senderAddress: null,
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function page(
  results: ChatSearchResultRow[],
  options: { nextCursor?: ChatSearchCursor | null; totalCount?: number | null } = {},
): ChatSearchPage {
  const nextCursor = options.nextCursor ?? null;
  return {
    results,
    nextCursor,
    hasMore: nextCursor !== null,
    totalCount: options.totalCount ?? null,
  };
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
}

function wrapper(client: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  mockSearchMessagesInChat.mockReset();
  mockUnsubscribe.mockClear();
  mockInvalidationListener = null;
  mockSubscribedGeneration = null;
  mockAccountCurrent = true;
});

it('trims the term, waits for three characters, and scopes the first page to the chat generation', async () => {
  const client = makeQueryClient();
  mockSearchMessagesInChat.mockResolvedValue(page([firstRow], { totalCount: 1 }));

  const { result, rerender } = await renderHook(
    ({ term }: { term: string }) => useChatSearch('chat-search-1', term, accountLease),
    { initialProps: { term: ' ab ' }, wrapper: wrapper(client) },
  );

  expect(result.current.query).toBe('ab');
  expect(result.current.fetchStatus).toBe('idle');
  expect(result.current.isLoading).toBe(false);
  expect(mockSearchMessagesInChat).not.toHaveBeenCalled();

  await rerender({ term: '  needle  ' });
  await waitFor(() => expect(result.current.results).toEqual([firstRow]));

  expect(mockSearchMessagesInChat).toHaveBeenCalledWith(undefined, 'chat-search-1', 'needle', null);
  expect(result.current.query).toBe('needle');
  expect(result.current.totalCount).toBe(1);
  expect(
    client.getQueryCache().find({ queryKey: ['chatSearch', 7, 'chat-search-1', 'needle'] }),
  ).toBeDefined();
});

it('passes the repository cursor and flattens later pages without replacing the first total', async () => {
  const client = makeQueryClient();
  const cursor: ChatSearchCursor = { dateCreated: 200, id: 11, maxMessageId: 11 };
  mockSearchMessagesInChat
    .mockResolvedValueOnce(page([firstRow], { nextCursor: cursor, totalCount: 2 }))
    .mockResolvedValueOnce(page([secondRow]));

  const { result } = await renderHook(
    () => useChatSearch('chat-search-2', 'needle', accountLease),
    { wrapper: wrapper(client) },
  );
  await waitFor(() => expect(result.current.results).toEqual([firstRow]));
  expect(result.current.hasNextPage).toBe(true);

  await act(async () => {
    await result.current.fetchNextPage();
  });
  await waitFor(() => expect(result.current.results).toEqual([firstRow, secondRow]));

  expect(mockSearchMessagesInChat).toHaveBeenNthCalledWith(
    2,
    undefined,
    'chat-search-2',
    'needle',
    cursor,
  );
  expect(result.current.totalCount).toBe(2);
  expect(result.current.hasNextPage).toBe(false);
});

it('conceals an in-flight page immediately when the account generation retires', async () => {
  const client = makeQueryClient();
  const cursor: ChatSearchCursor = { dateCreated: 200, id: 11, maxMessageId: 11 };
  const latePage = deferred<ChatSearchPage>();
  mockSearchMessagesInChat
    .mockResolvedValueOnce(page([firstRow], { nextCursor: cursor, totalCount: 2 }))
    .mockReturnValueOnce(latePage.promise);

  const { result, unmount } = await renderHook(
    () => useChatSearch('chat-search-private', 'private needle', accountLease),
    { wrapper: wrapper(client) },
  );
  await waitFor(() => expect(result.current.results).toEqual([firstRow]));
  expect(mockSubscribedGeneration).toBe(7);

  let fetchNextPage!: ReturnType<typeof result.current.fetchNextPage>;
  await act(async () => {
    fetchNextPage = result.current.fetchNextPage();
  });
  await waitFor(() => expect(mockSearchMessagesInChat).toHaveBeenCalledTimes(2));

  mockAccountCurrent = false;
  await act(async () => {
    if (!mockInvalidationListener) throw new Error('Expected an account invalidation listener');
    mockInvalidationListener();
  });
  expect(result.current.data).toBeUndefined();
  expect(result.current.results).toEqual([]);
  expect(result.current.totalCount).toBe(0);

  await act(async () => {
    latePage.resolve(page([secondRow]));
    await fetchNextPage;
  });
  await waitFor(() => expect(result.current.isFetching).toBe(false));
  expect(result.current.data).toBeUndefined();
  expect(result.current.results).toEqual([]);
  expect(result.current.totalCount).toBe(0);
  const cached = client.getQueryData<InfiniteData<ChatSearchPage>>([
    'chatSearch',
    7,
    'chat-search-private',
    'private needle',
  ]);
  expect(cached?.pages.flatMap((cachedPage) => cachedPage.results)).toEqual([firstRow]);

  await unmount();
  expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
});
