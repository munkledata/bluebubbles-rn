import { useCallback, useState } from 'react';
import type { CustomFolderInboxPage, InboxRow } from '@db/repositories';
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
  page: CustomFolderInboxPage | null;
  stale: boolean;
}

export interface CustomFolderChatsState extends ReactiveState<CustomFolderInboxPage> {
  hasMore: boolean;
  loadMore: () => void;
}

/**
 * Reactive growing-prefix folder browse read. Each prefix and its folder summary come from one
 * account-leased transaction, so membership replacement is visible only before or after commit.
 */
export function useCustomFolderChats(
  folderId: number | null,
  accountLease: RealtimeDeliveryLease,
  enabled = true,
): CustomFolderChatsState {
  const [reconcile] = useState(() => createRowIdentityCache<InboxRow>((row) => row.guid));
  const queryEnabled = enabled && folderId != null && accountLease.isCurrent();
  const queryKey = `${accountLease.generation}|${folderId ?? 'invalid'}`;
  const [pageRequest, setPageRequest] = useState(() => ({ key: queryKey, limit: PAGE_SIZE }));
  const limit = pageRequest.key === queryKey ? pageRequest.limit : PAGE_SIZE;

  const state = useReactiveQuery<CustomFolderChatsEnvelope>(
    async () => {
      if (folderId == null) return { key: queryKey, page: null, stale: true };
      const result = await loadCustomFolderInboxPage(folderId, limit, accountLease);
      if (result.status === 'stale') return { key: queryKey, page: null, stale: true };
      const page = result.value;
      return {
        key: queryKey,
        page: page == null ? null : { ...page, rows: reconcile(page.rows) },
        stale: false,
      };
    },
    TABLES,
    [queryKey, limit],
    { enabled: queryEnabled },
  );

  const current = queryEnabled && state.data?.key === queryKey ? state.data : null;
  const loadMore = useCallback((): void => {
    if (!current?.page?.hasMore) return;
    const loaded = current.page.rows.length;
    setPageRequest((previous) => {
      const previousLimit = previous.key === queryKey ? previous.limit : PAGE_SIZE;
      if (previousLimit > loaded) {
        return previous.key === queryKey ? previous : { key: queryKey, limit: previousLimit };
      }
      return { key: queryKey, limit: previousLimit + PAGE_SIZE };
    });
  }, [current, queryKey]);

  return {
    data: current?.page ?? null,
    isLoading:
      queryEnabled &&
      !current?.stale &&
      (state.isLoading || (current == null && state.error == null)),
    error: queryEnabled ? state.error : null,
    hasMore: current?.page?.hasMore ?? false,
    loadMore,
  };
}
