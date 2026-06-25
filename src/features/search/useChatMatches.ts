import { useEffect, useMemo, useState } from 'react';
import { getDatabase } from '@db/database';
import { searchChatGuidsByMessage, type InboxRow } from '@db/repositories';
import { useChats } from '@features/conversations/useChats';
import { type ReactiveState } from '@db/useReactiveQuery';
import { resolveTitle } from '@utils';

/**
 * Filters the loaded (non-archived) inbox rows to those matching a query. A chat always matches when
 * the term is in its resolved title or participant names. When `contentMatches` is true (the inbox
 * top-bar), it ALSO matches chats with a message body hit (FTS over the local index, incl. decoded
 * edited/SMS — debounced), so the inbox filter finds a conversation by something said in it.
 *
 * The search page passes `contentMatches: false` for its "Chats" section: there, a chat should only
 * appear when its NAME/people match (a "jump to this conversation" shortcut). Message-content
 * matches belong in that page's "Messages" section, where the snippet shows the actual hit — so the
 * Chats section never lists a chat whose visible preview doesn't explain why it's there.
 *
 * Passes through `useChats`'s reactive state (one subscription) with `data` filtered; an empty query
 * returns all rows (what the inbox wants).
 */
export function useChatMatches(
  query: string,
  opts?: { contentMatches?: boolean },
): ReactiveState<InboxRow[]> {
  const contentMatches = opts?.contentMatches ?? true;
  const state = useChats();
  const [msgMatchGuids, setMsgMatchGuids] = useState<Set<string>>(new Set());

  useEffect(() => {
    const term = query.trim();
    if (!contentMatches || term.length < 2) {
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
  }, [query, contentMatches]);

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
