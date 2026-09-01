import { useCallback, useRef, useState } from 'react';
import { getDatabase } from '@db/database';
import {
  CHAT_DOCUMENT_PAGE_SIZE,
  listChatDocumentAttachmentsPage,
  type ChatDocumentPage,
  type ChatDocumentRow,
} from '@db/repositories';
import { useReactiveQuery, type ReactiveState } from '@db/useReactiveQuery';
import {
  runTrackedRealtimeWork,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import { createRowIdentityCache } from './rowIdentity';

const TABLES = ['attachments', 'messages', 'chats'];

interface DocumentPageEnvelope {
  key: string;
  page: ChatDocumentPage | null;
  stale: boolean;
  error: Error | null;
}

interface DocumentPageCache {
  baseKey: string;
  page: ChatDocumentPage;
}

interface DocumentPageRequest {
  baseKey: string;
  limit: number;
  retry: number;
}

export interface SharedDocumentsState extends ReactiveState<ChatDocumentPage> {
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
 * Reactive growing-prefix document read. A larger request replaces the prior prefix atomically,
 * while a failed pagination refresh keeps the already-rendered rows available for retry.
 */
export function useSharedDocuments(
  chatGuid: string | null,
  accountLease: RealtimeDeliveryLease,
  enabled = true,
): SharedDocumentsState {
  const [reconcile] = useState(() => createRowIdentityCache<ChatDocumentRow>((row) => row.guid));
  const validGuid = chatGuid != null && chatGuid.length > 0 && chatGuid.length <= 4096;
  const queryEnabled = enabled && validGuid && accountLease.isCurrent();
  const baseKey = `${accountLease.generation}|${chatGuid ?? 'invalid'}`;
  const activeBaseKeyRef = useRef(baseKey);
  const successfulPageRef = useRef<DocumentPageCache | null>(null);

  if (activeBaseKeyRef.current !== baseKey) {
    activeBaseKeyRef.current = baseKey;
    successfulPageRef.current = null;
  }

  const [pageRequest, setPageRequest] = useState<DocumentPageRequest>(() => ({
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

  const state = useReactiveQuery<DocumentPageEnvelope>(
    async () => {
      const requestSequence = requestSequenceRef.current + 1;
      requestSequenceRef.current = requestSequence;
      try {
        if (!validGuid || chatGuid == null || !accountLease.isCurrent()) {
          return { key: requestKey, page: null, stale: true, error: null };
        }

        const result: { page: ChatDocumentPage | null } = { page: null };
        const delivery = await runTrackedRealtimeWork(accountLease, async (activeLease) => {
          if (!activeLease.isCurrent()) return;
          result.page = await listChatDocumentAttachmentsPage(
            getDatabase(),
            chatGuid,
            activePageRequest.limit,
          );
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
          return { key: requestKey, page: null, stale: true, error: null };
        }

        const page: ChatDocumentPage = {
          ...loadedPage,
          items: reconcile(loadedPage.items),
        };
        successfulPageRef.current = { baseKey, page };
        return { key: requestKey, page, stale: false, error: null };
      } catch (cause) {
        if (
          !accountLease.isCurrent() ||
          activeBaseKeyRef.current !== baseKey ||
          activeRequestKeyRef.current !== requestKey ||
          requestSequenceRef.current !== requestSequence
        ) {
          return { key: requestKey, page: null, stale: true, error: null };
        }
        const cached =
          successfulPageRef.current?.baseKey === baseKey ? successfulPageRef.current.page : null;
        return { key: requestKey, page: cached, stale: false, error: toError(cause) };
      }
    },
    TABLES,
    [requestKey],
    { enabled: queryEnabled },
  );

  const current = queryEnabled && state.data?.key === requestKey ? state.data : null;
  const cachedPage =
    queryEnabled && successfulPageRef.current?.baseKey === baseKey
      ? successfulPageRef.current.page
      : null;
  const page = current?.stale ? null : (current?.page ?? cachedPage);
  const currentError = current?.error ?? null;
  const requestPending = queryEnabled && (state.isLoading || current == null);

  const loadMore = useCallback((): void => {
    if (!page?.hasMore) return;
    const loaded = page.items.length;
    setPageRequest((previous) => {
      const active =
        previous.baseKey === baseKey
          ? previous
          : { baseKey, limit: CHAT_DOCUMENT_PAGE_SIZE, retry: 0 };
      if (active.limit > loaded) return active;
      return { ...active, limit: active.limit + CHAT_DOCUMENT_PAGE_SIZE };
    });
  }, [baseKey, page]);

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
