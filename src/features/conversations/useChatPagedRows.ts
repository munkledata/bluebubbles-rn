import { useCallback, useRef, useState } from 'react';
import { getDatabase } from '@db/database';
import { CHAT_DOCUMENT_PAGE_SIZE } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { useReactiveQuery, type ReactiveState } from '@db/useReactiveQuery';
import {
  runTrackedRealtimeWork,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import { createRowIdentityCache } from './rowIdentity';

const TABLES = ['attachments', 'messages', 'chats'];

/** A bounded newest-first prefix of one chat's rows. */
export interface ChatRowPage<T> {
  items: T[];
  hasMore: boolean;
}

/**
 * Where a paged chat list reads from. `id` must be unique per source and `fetchPage`/`rowKey`
 * must be stable module-level functions: they are not effect dependencies.
 */
export interface ChatPagedRowSource<T> {
  id: string;
  fetchPage: (db: AppDatabase, chatGuid: string, limit: number) => Promise<ChatRowPage<T>>;
  rowKey: (row: T) => string;
}

interface PageEnvelope<T> {
  key: string;
  page: ChatRowPage<T> | null;
  /** The row limit the page was read with (a links page can hold fewer rows than this). */
  limit: number;
  stale: boolean;
  error: Error | null;
}

interface PageCache<T> {
  baseKey: string;
  page: ChatRowPage<T>;
  limit: number;
}

interface PageRequest {
  baseKey: string;
  limit: number;
  retry: number;
}

export interface ChatPagedRowsState<T> extends ReactiveState<ChatRowPage<T>> {
  hasMore: boolean;
  loadingMore: boolean;
  loadMoreError: Error | null;
  loadMore: () => void;
  retry: () => void;
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/**
 * Reactive growing-prefix read of one chat's rows (documents, photos, videos or links). A larger
 * request replaces the prior prefix atomically, while a failed pagination refresh keeps the
 * already-rendered rows available for retry.
 */
export function useChatPagedRows<T>(
  source: ChatPagedRowSource<T>,
  chatGuid: string | null,
  accountLease: RealtimeDeliveryLease,
  enabled = true,
): ChatPagedRowsState<T> {
  const [reconcile] = useState(() => createRowIdentityCache<T>(source.rowKey));
  const validGuid = chatGuid != null && chatGuid.length > 0 && chatGuid.length <= 4096;
  const queryEnabled = enabled && validGuid && accountLease.isCurrent();
  const baseKey = `${accountLease.generation}|${source.id}|${chatGuid ?? 'invalid'}`;
  const activeBaseKeyRef = useRef(baseKey);
  const successfulPageRef = useRef<PageCache<T> | null>(null);

  if (activeBaseKeyRef.current !== baseKey) {
    activeBaseKeyRef.current = baseKey;
    successfulPageRef.current = null;
  }

  const [pageRequest, setPageRequest] = useState<PageRequest>(() => ({
    baseKey,
    limit: CHAT_DOCUMENT_PAGE_SIZE,
    retry: 0,
  }));
  const activePageRequest =
    pageRequest.baseKey === baseKey
      ? pageRequest
      : { baseKey, limit: CHAT_DOCUMENT_PAGE_SIZE, retry: 0 };
  const requestKey = JSON.stringify([baseKey, activePageRequest.limit, activePageRequest.retry]);
  const activeRequestKeyRef = useRef(requestKey);
  const requestSequenceRef = useRef(0);
  // The reactive layer cancels stale UI publication, but it cannot abort a repository read that is
  // already running. Fence this hook's own row reconciliation and successful-page cache too.
  activeRequestKeyRef.current = requestKey;

  const state = useReactiveQuery<PageEnvelope<T>>(
    async () => {
      const limit = activePageRequest.limit;
      const requestSequence = requestSequenceRef.current + 1;
      requestSequenceRef.current = requestSequence;
      try {
        if (!validGuid || chatGuid == null || !accountLease.isCurrent()) {
          return { key: requestKey, page: null, limit, stale: true, error: null };
        }

        const result: { page: ChatRowPage<T> | null } = { page: null };
        const delivery = await runTrackedRealtimeWork(accountLease, async (activeLease) => {
          if (!activeLease.isCurrent()) return;
          result.page = await source.fetchPage(getDatabase(), chatGuid, limit);
        });
        const loadedPage = result.page;
        if (
          delivery !== 'delivered' ||
          loadedPage == null ||
          !accountLease.isCurrent() ||
          activeBaseKeyRef.current !== baseKey ||
          activeRequestKeyRef.current !== requestKey ||
          requestSequenceRef.current !== requestSequence
        ) {
          return { key: requestKey, page: null, limit, stale: true, error: null };
        }

        const page: ChatRowPage<T> = {
          ...loadedPage,
          items: reconcile(loadedPage.items),
        };
        successfulPageRef.current = { baseKey, page, limit };
        return { key: requestKey, page, limit, stale: false, error: null };
      } catch (cause) {
        if (
          !accountLease.isCurrent() ||
          activeBaseKeyRef.current !== baseKey ||
          activeRequestKeyRef.current !== requestKey ||
          requestSequenceRef.current !== requestSequence
        ) {
          return { key: requestKey, page: null, limit, stale: true, error: null };
        }
        const cached =
          successfulPageRef.current?.baseKey === baseKey ? successfulPageRef.current : null;
        return {
          key: requestKey,
          page: cached?.page ?? null,
          limit: cached?.limit ?? 0,
          stale: false,
          error: toError(cause),
        };
      }
    },
    TABLES,
    [requestKey],
    { enabled: queryEnabled },
  );

  const current = queryEnabled && state.data?.key === requestKey ? state.data : null;
  const cached =
    queryEnabled && successfulPageRef.current?.baseKey === baseKey
      ? successfulPageRef.current
      : null;
  const shown = current?.stale ? null : current?.page != null ? current : cached;
  const page = shown?.page ?? null;
  const loadedLimit = shown?.limit ?? 0;
  const currentError = current?.error ?? null;
  const requestPending = queryEnabled && (state.isLoading || current == null);

  const loadMore = useCallback((): void => {
    if (!page?.hasMore) return;
    setPageRequest((previous) => {
      const active =
        previous.baseKey === baseKey
          ? previous
          : { baseKey, limit: CHAT_DOCUMENT_PAGE_SIZE, retry: 0 };
      // A bigger read is already requested. Compare limits, not rows: a links page can hold
      // fewer rows than the limit it was read with.
      if (active.limit > loadedLimit) return active;
      return { ...active, limit: active.limit + CHAT_DOCUMENT_PAGE_SIZE };
    });
  }, [baseKey, page, loadedLimit]);

  const retry = useCallback((): void => {
    setPageRequest((previous) => {
      const active =
        previous.baseKey === baseKey
          ? previous
          : { baseKey, limit: CHAT_DOCUMENT_PAGE_SIZE, retry: 0 };
      return { ...active, retry: active.retry + 1 };
    });
  }, [baseKey]);

  return {
    data: page,
    isLoading: requestPending && page == null && currentError == null,
    error: page == null ? currentError : null,
    hasMore: page?.hasMore ?? false,
    loadingMore: requestPending && page != null && currentError == null,
    loadMoreError: page != null ? currentError : null,
    loadMore,
    retry,
  };
}
