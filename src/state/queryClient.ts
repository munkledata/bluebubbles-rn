import { QueryClient } from '@tanstack/react-query';

/**
 * Shared TanStack Query client for server-cache data (chats, messages, contacts,
 * server info). The local DB remains the source of truth for message/chat lists;
 * Query handles request/response caching and async status.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});
