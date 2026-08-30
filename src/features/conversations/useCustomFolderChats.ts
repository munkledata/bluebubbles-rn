import { useCallback, useRef, useState } from 'react';
import type { CustomFolderInboxPage, CustomFolderRow, InboxRow } from '@db/repositories';
import { useReactiveQuery, type ReactiveState } from '@db/useReactiveQuery';
import { loadCustomFolderInboxPage } from '@/services/customFolderCommands';
import type { RealtimeDeliveryLease } from '@/services/realtime/deliveryCoordinator';
import { createRowIdentityCache } from './rowIdentity';

const PAGE_SIZE = 50;
const TABLES = [
  'custom_folders',
  'custom_folder_members',
  'attachments',
  'messages',
  'chats',
  'chat_handles',
  'handles',
];

interface CustomFolderChatsEnvelope {
  key: string;
  folderKey: string;
  page: CustomFolderInboxPage | null;
  stale: boolean;
  error: Error | null;
}

interface FolderPageCache {
  baseKey: string;
  page: CustomFolderInboxPage;
}

interface FolderIdentityCache {
  folderKey: string;
  folder: CustomFolderRow;
}

interface FolderPageRequest {
  baseKey: string;
  limit: number;
  retry: number;
}

export interface CustomFolderChatsState extends ReactiveState<CustomFolderInboxPage> {
  /** Retain the loaded folder identity while a new search term replaces only the result area. */
  folder: CustomFolderRow | null;
  hasMore: boolean;
  loadingMore: boolean;
  loadMoreError: Error | null;
  loadMore: () => void;
  retry: () => void;
}

function normalizeFolderSearchQuery(input: string): string {
  const normalized = Array.from(input.normalize('NFC').trim()).slice(0, 128).join('');
  return Array.from(normalized).length >= 2 ? normalized : '';
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/**
 * Reactive growing-prefix folder browse read. Each prefix and its folder summary come from one
 * account-leased transaction, so membership replacement is visible only before or after commit.
 */
export function useCustomFolderChats(
  folderId: number | null,
  accountLease: RealtimeDeliveryLease,
  searchText = '',
  enabled = true,
): CustomFolderChatsState {
  const [reconcile] = useState(() => createRowIdentityCache<InboxRow>((row) => row.guid));
  const queryEnabled = enabled && folderId != null && accountLease.isCurrent();
  const searchQuery = normalizeFolderSearchQuery(searchText);
  const folderKey = `${accountLease.generation}|${folderId ?? 'invalid'}`;
  const baseKey = JSON.stringify([folderKey, searchQuery]);
  const activeBaseKeyRef = useRef(baseKey);
  const successfulPageRef = useRef<FolderPageCache | null>(null);
  const folderIdentityRef = useRef<FolderIdentityCache | null>(null);

  if (activeBaseKeyRef.current !== baseKey) {
    activeBaseKeyRef.current = baseKey;
    successfulPageRef.current = null;
  }
  if (folderIdentityRef.current?.folderKey !== folderKey) {
    folderIdentityRef.current = null;
  }

  const [pageRequest, setPageRequest] = useState<FolderPageRequest>(() => ({
    baseKey,
    limit: PAGE_SIZE,
    retry: 0,
  }));
  const activePageRequest =
    pageRequest.baseKey === baseKey ? pageRequest : { baseKey, limit: PAGE_SIZE, retry: 0 };
  const requestKey = JSON.stringify([baseKey, activePageRequest.limit, activePageRequest.retry]);

  const state = useReactiveQuery<CustomFolderChatsEnvelope>(
    async () => {
      try {
        if (folderId == null) {
          return { key: requestKey, folderKey, page: null, stale: true, error: null };
        }
        const result = await loadCustomFolderInboxPage(
          folderId,
          activePageRequest.limit,
          searchQuery,
          accountLease,
        );
        if (result.status === 'stale') {
          return { key: requestKey, folderKey, page: null, stale: true, error: null };
        }

        const page =
          result.value == null ? null : { ...result.value, rows: reconcile(result.value.rows) };
        if (activeBaseKeyRef.current === baseKey) {
          successfulPageRef.current = page == null ? null : { baseKey, page };
          if (page == null) {
            folderIdentityRef.current = null;
          } else {
            folderIdentityRef.current = { folderKey, folder: page.folder };
          }
        }
        return { key: requestKey, folderKey, page, stale: false, error: null };
      } catch (cause) {
        const cached =
          activeBaseKeyRef.current === baseKey && successfulPageRef.current?.baseKey === baseKey
            ? successfulPageRef.current.page
            : null;
        return {
          key: requestKey,
          folderKey,
          page: cached,
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
  const cachedPage =
    queryEnabled && successfulPageRef.current?.baseKey === baseKey
      ? successfulPageRef.current.page
      : null;
  const page = current?.page ?? cachedPage;
  const currentError = current?.error ?? null;
  const requestPending = queryEnabled && (state.isLoading || current == null);

  const loadMore = useCallback((): void => {
    if (!page?.hasMore) return;
    const loaded = page.rows.length;
    setPageRequest((previous) => {
      const active =
        previous.baseKey === baseKey ? previous : { baseKey, limit: PAGE_SIZE, retry: 0 };
      if (active.limit > loaded) return active;
      return { ...active, limit: active.limit + PAGE_SIZE };
    });
  }, [baseKey, page]);

  const retry = useCallback((): void => {
    setPageRequest((previous) => {
      const active =
        previous.baseKey === baseKey ? previous : { baseKey, limit: PAGE_SIZE, retry: 0 };
      return { ...active, retry: active.retry + 1 };
    });
  }, [baseKey]);

  return {
    data: page,
    folder:
      page?.folder ??
      (queryEnabled && folderIdentityRef.current?.folderKey === folderKey
        ? folderIdentityRef.current.folder
        : null),
    isLoading: requestPending && page == null && currentError == null,
    error: page == null ? currentError : null,
    hasMore: page?.hasMore ?? false,
    loadingMore: requestPending && page != null && currentError == null,
    loadMoreError: page != null ? currentError : null,
    loadMore,
    retry,
  };
}
