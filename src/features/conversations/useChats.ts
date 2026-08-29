import { useCallback, useState } from 'react';
import { normalizeInboxFilters, type InboxFilters } from '@core/models';
import { getDatabase } from '@db/database';
import {
  countChatsForInbox,
  listChatsForInbox,
  listChatsForInboxPage,
  type InboxArchiveFilter,
  type InboxRow,
  type InboxSenderFilter,
} from '@db/repositories';
import { useReactiveQuery, type ReactiveState } from '@db/useReactiveQuery';
import { createRowIdentityCache } from './rowIdentity';

// Any write to these tables affects an inbox row, so we watch all four:
// messages (preview/order/unread), chats (pin/mute/archive/rename/read marker),
// chat_handles + handles (participants/titles).
const TABLES = ['messages', 'chats', 'chat_handles', 'handles'];

export interface UseChatsOptions {
  /** Omit for the legacy unbounded search projection; visible list screens always pass 50. */
  pageSize?: number;
  archive?: InboxArchiveFilter;
  sender?: InboxSenderFilter;
  /** Optional main-inbox predicates, all applied before each page is cut. */
  filters?: InboxFilters;
  /** Exact active/unknown count for the main inbox's page-external footer. */
  countUnknown?: boolean;
  /** Stop the query and native subscription immediately when the owning account is retired. */
  enabled?: boolean;
}

export interface ChatsState extends ReactiveState<InboxRow[]> {
  /** Optional keeps existing lightweight test adapters/source consumers backward-compatible. */
  hasMore?: boolean;
  loadMore?: () => void;
  unknownCount?: number;
}

interface ChatsQueryEnvelope {
  key: string;
  rows: InboxRow[];
  hasMore: boolean;
  unknownCount: number;
}

/** Live inbox rows, re-queried automatically as sync/socket writes land. */
export function useChats(includeArchived = false, options: UseChatsOptions = {}): ChatsState {
  // Unchanged inbox rows keep their identity across reactive flushes, so the memoized
  // ConversationTile only re-renders for a real row change (see rowIdentity.ts).
  // Lazy initializer — useRef(create()) would re-invoke the factory every render.
  const [reconcile] = useState(() => createRowIdentityCache<InboxRow>((c) => c.guid));
  const archive = options.archive ?? (includeArchived ? 'all' : 'active');
  const filters = normalizeInboxFilters(options.filters);
  const sender = options.sender ?? filters.sender;
  const queryFilters = sender === filters.sender ? filters : { ...filters, sender };
  const requestedPageSize =
    options.pageSize == null
      ? null
      : Number.isFinite(options.pageSize)
        ? Math.max(1, Math.floor(options.pageSize))
        : 50;
  const queryKey = `${archive}|${queryFilters.read}|${queryFilters.sender}|${queryFilters.kind}|${queryFilters.mute}|${queryFilters.service}|${options.countUnknown ? 1 : 0}|${requestedPageSize ?? 'all'}`;
  const enabled = options.enabled !== false;
  const [pageRequest, setPageRequest] = useState(() => ({
    key: queryKey,
    limit: requestedPageSize ?? 0,
  }));
  // A filter change starts again at one page without an effect/reset render. The envelope key
  // below also prevents the previous filter's rows from flashing while the replacement resolves.
  const limit =
    requestedPageSize == null
      ? null
      : pageRequest.key === queryKey
        ? pageRequest.limit
        : requestedPageSize;

  const state = useReactiveQuery<ChatsQueryEnvelope>(
    async () => {
      const db = getDatabase();
      const [page, unknownCount] = await Promise.all([
        limit == null
          ? listChatsForInbox(db, { includeArchived, filters: queryFilters }).then((rows) => ({
              rows,
              hasMore: false,
            }))
          : listChatsForInboxPage(db, { limit, archive, sender, filters: queryFilters }),
        options.countUnknown
          ? countChatsForInbox(db, { archive: 'active', sender: 'unknown' })
          : Promise.resolve(0),
      ]);
      return {
        key: queryKey,
        rows: reconcile(page.rows),
        hasMore: page.hasMore,
        unknownCount,
      };
    },
    TABLES,
    [queryKey, limit, includeArchived],
    { enabled },
  );

  const current = enabled && state.data?.key === queryKey ? state.data : null;
  const loadMore = useCallback((): void => {
    if (!enabled || requestedPageSize == null || !current?.hasMore) return;
    const loaded = current.rows.length;
    setPageRequest((previous) => {
      const previousLimit = previous.key === queryKey ? previous.limit : requestedPageSize;
      // FlashList may emit onEndReached twice before React paints the larger prefix. Permit only
      // one outstanding page request so one edge event cannot jump from 50 rows to hundreds.
      if (previousLimit > loaded) {
        return previous.key === queryKey ? previous : { key: queryKey, limit: previousLimit };
      }
      return { key: queryKey, limit: previousLimit + requestedPageSize };
    });
  }, [current, enabled, queryKey, requestedPageSize]);

  return {
    data: current?.rows ?? null,
    isLoading: enabled && (state.isLoading || (current == null && state.error == null)),
    error: enabled ? state.error : null,
    hasMore: current?.hasMore ?? false,
    loadMore,
    unknownCount: current?.unknownCount ?? 0,
  };
}
