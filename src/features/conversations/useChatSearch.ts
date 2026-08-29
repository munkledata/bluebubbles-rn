import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { getDatabase } from '@db/database';
import {
  searchMessagesInChat,
  type ChatSearchCursor,
  type ChatSearchPage,
  type ChatSearchResultRow,
} from '@db/repositories';
import {
  subscribeRealtimeGenerationInvalidation,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';

const MIN_CHARS = 3;

class RetiredChatSearchError extends Error {
  constructor() {
    super('Chat search account generation retired');
    this.name = 'RetiredChatSearchError';
  }
}

async function searchCurrentAccountPage(
  accountLease: RealtimeDeliveryLease,
  chatGuid: string,
  query: string,
  cursor: ChatSearchCursor | null,
): Promise<ChatSearchPage> {
  if (!accountLease.isCurrent()) throw new RetiredChatSearchError();
  const page = await searchMessagesInChat(getDatabase(), chatGuid, query, cursor);
  if (!accountLease.isCurrent()) throw new RetiredChatSearchError();
  return page;
}

/**
 * Paged full-text search for one open chat. The account generation in the cache key prevents one
 * account from reusing another's results; the lease checks also discard a page that finishes after
 * Disconnect retired its generation.
 */
export function useChatSearch(chatGuid: string, term: string, accountLease: RealtimeDeliveryLease) {
  const query = term.trim();
  const [retiredGeneration, setRetiredGeneration] = useState<number | null>(() =>
    accountLease.isCurrent() ? null : accountLease.generation,
  );

  useEffect(
    () =>
      subscribeRealtimeGenerationInvalidation(accountLease.generation, () => {
        setRetiredGeneration(accountLease.generation);
      }),
    [accountLease],
  );

  const accountCurrent = retiredGeneration !== accountLease.generation && accountLease.isCurrent();
  const search = useInfiniteQuery({
    queryKey: ['chatSearch', accountLease.generation, chatGuid, query],
    initialPageParam: null as ChatSearchCursor | null,
    queryFn: ({ pageParam }) => searchCurrentAccountPage(accountLease, chatGuid, query, pageParam),
    getNextPageParam: (lastPage) =>
      lastPage.hasMore ? (lastPage.nextCursor ?? undefined) : undefined,
    enabled: accountCurrent && chatGuid.length > 0 && query.length >= MIN_CHARS,
    retry: false,
  });

  // Do not expose even previously cached data after the screen's account generation retires.
  const data = accountCurrent ? search.data : undefined;
  const results = useMemo<ChatSearchResultRow[]>(
    () => data?.pages.flatMap((page) => page.results) ?? [],
    [data],
  );
  const totalCount = data?.pages[0]?.totalCount ?? 0;

  return { ...search, data, results, totalCount, query };
}
