import { useEffect, useMemo, useState } from 'react';
import { getDatabase } from '@db/database';
import { searchChatGuidsByMessage, type InboxRow } from '@db/repositories';
import { useChats } from '@features/conversations/useChats';
import { type ReactiveState } from '@db/useReactiveQuery';
import { resolveTitle } from '@utils';

/**
 * The SINGLE definition of "which chats match a query", shared by the inbox top-bar and the search
 * page so the two stay in lockstep. A chat matches when the term is in its resolved title or
 * participant names, OR when any of its messages match (FTS over the local index, incl. decoded
 * edited/SMS text — debounced). Both screens filter the same loaded (non-archived) inbox rows, so
 * the result sets are identical by construction. Passes through `useChats`'s reactive state (one
 * subscription) with `data` filtered; an empty query returns all rows (what the inbox wants).
 */
export function useChatMatches(query: string): ReactiveState<InboxRow[]> {
  const state = useChats();
  const [msgMatchGuids, setMsgMatchGuids] = useState<Set<string>>(new Set());

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setMsgMatchGuids(new Set());
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      searchChatGuidsByMessage(getDatabase(), term)
        .then((guids) => {
          if (!cancelled) setMsgMatchGuids(new Set(guids));
        })
        .catch(() => {
          if (!cancelled) setMsgMatchGuids(new Set());
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  const data = useMemo(() => {
    const all = state.data ?? [];
    const term = query.trim().toLowerCase();
    if (!term) return all;
    return all.filter(
      (r) =>
        `${resolveTitle(r)} ${r.participantNames ?? ''}`.toLowerCase().includes(term) ||
        msgMatchGuids.has(r.guid),
    );
  }, [state.data, query, msgMatchGuids]);

  return { ...state, data };
}
