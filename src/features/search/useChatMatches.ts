import { useEffect, useRef, useState } from 'react';
import { getDatabase } from '@db/database';
import { searchChatGuidsByMessage, searchChatsForInboxPage, type InboxRow } from '@db/repositories';
import { useReactiveQuery, type ReactiveState } from '@db/useReactiveQuery';
import { createRowIdentityCache } from '@features/conversations/rowIdentity';
import {
  captureRealtimeDeliveryLease,
  subscribeRealtimeGenerationInvalidation,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import { isGlobalSearchQueryValid, normalizeGlobalSearchQuery } from './query';

const TABLES = ['messages', 'chats', 'chat_handles', 'handles'];

interface SettledChatSearch {
  key: string;
  term: string;
}

interface ChatMatchEnvelope {
  key: string;
  rows: InboxRow[];
}

/**
 * Reactive, bounded-result conversation search. A chat matches when the term is in its resolved
 * title/participants. When `contentMatches` is true (the inbox top-bar), visible message-body FTS
 * hits are unioned in after the same 200 ms settled-input delay.
 *
 * The search page passes `contentMatches: false` for its "Chats" section because body hits are
 * rendered separately with their matching snippets. Short/empty input is deliberately idle and
 * returns `[]`; this hook's only production caller does not use it as an inbox data source.
 */
export function useChatMatches(
  query: string,
  opts?: { contentMatches?: boolean; accountLease?: RealtimeDeliveryLease },
): ReactiveState<InboxRow[]> {
  const contentMatches = opts?.contentMatches ?? true;
  const [fallbackLease] = useState(() => opts?.accountLease ?? captureRealtimeDeliveryLease());
  const accountLease = opts?.accountLease ?? fallbackLease;
  const [retiredGeneration, setRetiredGeneration] = useState<number | null>(() =>
    accountLease.isCurrent() ? null : accountLease.generation,
  );
  const [reconcile] = useState(() => createRowIdentityCache<InboxRow>((row) => row.guid));
  const [settled, setSettled] = useState<SettledChatSearch | null>(null);
  const accountCurrent = retiredGeneration !== accountLease.generation && accountLease.isCurrent();
  const term = normalizeGlobalSearchQuery(query);
  const validQuery = isGlobalSearchQueryValid(term);
  const searchKey = JSON.stringify([accountLease.generation, term, contentMatches]);
  const committedSearchKeyRef = useRef(searchKey);
  // A previously settled A must not become current on the first A -> empty -> A render. The effect
  // commits each input key and clears its old marker before the timer can settle; this render-time
  // comparison masks the old marker immediately, before that effect runs.
  const searchKeyChanged = committedSearchKeyRef.current !== searchKey;

  useEffect(
    () =>
      subscribeRealtimeGenerationInvalidation(accountLease.generation, () => {
        setRetiredGeneration(accountLease.generation);
      }),
    [accountLease],
  );

  useEffect(() => {
    const inputChanged = committedSearchKeyRef.current !== searchKey;
    committedSearchKeyRef.current = searchKey;
    if (inputChanged) {
      // The render-time ref gate masks the first changed-key render; clearing state here keeps it
      // masked through unrelated rerenders until this key's full debounce actually settles.
      setSettled(null);
    }
    if (!accountCurrent || !validQuery) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled && accountLease.isCurrent()) setSettled({ key: searchKey, term });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [accountCurrent, accountLease, searchKey, term, validQuery]);

  const queryEnabled =
    accountCurrent &&
    validQuery &&
    !searchKeyChanged &&
    settled?.key === searchKey &&
    settled.term === term;
  const state = useReactiveQuery<ChatMatchEnvelope>(
    async () => {
      const db = getDatabase();
      let messageMatchGuids: string[] = [];
      if (contentMatches) {
        try {
          messageMatchGuids = await searchChatGuidsByMessage(db, term);
        } catch {
          // Conversation-name search remains useful when the optional local FTS read fails.
        }
      }
      if (!accountLease.isCurrent()) return { key: searchKey, rows: [] };
      const page = await searchChatsForInboxPage(db, {
        query: term,
        messageMatchGuids,
        limit: 50,
      });
      return { key: searchKey, rows: reconcile(page.rows) };
    },
    TABLES,
    [searchKey],
    { enabled: queryEnabled },
  );

  if (!accountCurrent || !validQuery) return { data: [], isLoading: false, error: null };
  if (!queryEnabled) return { data: [], isLoading: true, error: null };
  const current = state.data?.key === searchKey ? state.data : null;
  return {
    data: current?.rows ?? [],
    isLoading: state.isLoading || (current == null && state.error == null),
    error: state.error,
  };
}
