import { useEffect, useState } from 'react';
import { getDatabase } from '@db/database';
import { searchMessagesEnriched, type SearchResultRow } from '@db/repositories';
import { searchAndAdoptServerMessages } from '@/services/search/serverMessageSearch';
import {
  captureRealtimeDeliveryLease,
  subscribeRealtimeGenerationInvalidation,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import { useMessageSearchSupported } from '@state/sessionStore';
import { isGlobalSearchQueryValid, normalizeGlobalSearchQuery } from './query';

export type MessageSearchScope =
  'local-only' | 'searching-mac' | 'phone-and-mac' | 'mac-unavailable';

interface SettledSearch {
  key: string;
  results: SearchResultRow[];
  scope: MessageSearchScope;
}

function compareNewestFirst(left: SearchResultRow, right: SearchResultRow): number {
  if (left.dateCreated == null && right.dateCreated != null) return 1;
  if (left.dateCreated != null && right.dateCreated == null) return -1;
  if (left.dateCreated !== right.dateCreated) {
    return (right.dateCreated ?? 0) - (left.dateCreated ?? 0);
  }
  return left.guid < right.guid ? -1 : left.guid > right.guid ? 1 : 0;
}

/** Local rows win duplicate GUIDs because they may contain richer device-contact presentation. */
export function mergeMessageSearchResults(
  local: SearchResultRow[],
  server: SearchResultRow[],
  limit: number,
): SearchResultRow[] {
  const byGuid = new Map(server.map((row) => [row.guid, row]));
  for (const row of local) byGuid.set(row.guid, row);
  return [...byGuid.values()].sort(compareNewestFirst).slice(0, limit);
}

/**
 * Debounced global message search. Local encrypted-DB results arrive first. When the connected
 * server explicitly advertises bounded message search, one newest-50 Mac page is fetched, adopted
 * into the encrypted DB, deduplicated by GUID, and merged newest-first. Server failure degrades to
 * the already-computed local results.
 */
export function useSearch(
  query: string,
  limit = 50,
  accountLease?: RealtimeDeliveryLease,
): { results: SearchResultRow[]; loading: boolean; scope: MessageSearchScope } {
  const q = normalizeGlobalSearchQuery(query);
  const validQuery = isGlobalSearchQueryValid(q);
  const boundedLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  const serverSupported = useMessageSearchSupported();
  const [fallbackLease] = useState(() => accountLease ?? captureRealtimeDeliveryLease());
  const lease = accountLease ?? fallbackLease;
  const [retiredGeneration, setRetiredGeneration] = useState<number | null>(() =>
    lease.isCurrent() ? null : lease.generation,
  );
  const accountCurrent = retiredGeneration !== lease.generation && lease.isCurrent();
  const searchKey = JSON.stringify([lease.generation, q, boundedLimit, serverSupported]);
  const [settled, setSettled] = useState<SettledSearch | null>(null);

  useEffect(() => {
    if (!validQuery || !accountCurrent) return;
    let cancelled = false;
    const controller = new AbortController();
    // Register before the debounce or first DB/network await. Account teardown can now disown the
    // dormant timer and abort an active request without waiting for its network timeout.
    const unsubscribe = subscribeRealtimeGenerationInvalidation(lease.generation, () => {
      cancelled = true;
      controller.abort();
      setRetiredGeneration(lease.generation);
    });

    const timer = setTimeout(() => {
      void (async (): Promise<void> => {
        let local: SearchResultRow[] = [];
        try {
          local = await searchMessagesEnriched(getDatabase(), q, boundedLimit);
        } catch {
          // Search remains a best-effort view. A Mac result can still succeed if local FTS failed.
        }
        if (cancelled || !lease.isCurrent()) return;

        if (!serverSupported) {
          setSettled({ key: searchKey, results: local, scope: 'local-only' });
          return;
        }

        setSettled({ key: searchKey, results: local, scope: 'searching-mac' });
        try {
          const remote = await searchAndAdoptServerMessages(q, lease, controller.signal);
          if (cancelled || !lease.isCurrent()) return;
          setSettled({
            key: searchKey,
            results: mergeMessageSearchResults(local, remote, boundedLimit),
            scope: 'phone-and-mac',
          });
        } catch {
          if (cancelled || !lease.isCurrent()) return;
          setSettled({ key: searchKey, results: local, scope: 'mac-unavailable' });
        }
      })();
    }, 250);

    return () => {
      cancelled = true;
      controller.abort();
      unsubscribe();
      clearTimeout(timer);
    };
  }, [accountCurrent, boundedLimit, lease, q, searchKey, serverSupported, validQuery]);

  if (!accountCurrent) return { results: [], loading: false, scope: 'local-only' };
  if (!validQuery) return { results: [], loading: false, scope: 'local-only' };
  if (settled?.key !== searchKey) {
    return {
      results: [],
      loading: true,
      scope: serverSupported ? 'searching-mac' : 'local-only',
    };
  }
  return {
    results: settled.results,
    loading: settled.scope === 'searching-mac',
    scope: settled.scope,
  };
}
