import { useEffect, useMemo, useState } from 'react';
import { getDatabase } from '@db/database';
import { searchChatGuidsByMessage, type InboxRow } from '@db/repositories';
import { useChats } from '@features/conversations/useChats';
import { type ReactiveState } from '@db/useReactiveQuery';
import { resolveTitle } from '@utils';
import {
  captureRealtimeDeliveryLease,
  subscribeRealtimeGenerationInvalidation,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import { isGlobalSearchQueryValid, normalizeGlobalSearchQuery } from './query';

const NO_MESSAGE_MATCHES = new Set<string>();

interface MessageMatchResult {
  generation: number;
  term: string;
  guids: Set<string>;
}

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
  opts?: { contentMatches?: boolean; accountLease?: RealtimeDeliveryLease },
): ReactiveState<InboxRow[]> {
  const contentMatches = opts?.contentMatches ?? true;
  const [fallbackLease] = useState(() => opts?.accountLease ?? captureRealtimeDeliveryLease());
  const accountLease = opts?.accountLease ?? fallbackLease;
  const [retiredGeneration, setRetiredGeneration] = useState<number | null>(() =>
    accountLease.isCurrent() ? null : accountLease.generation,
  );
  const accountCurrent = retiredGeneration !== accountLease.generation && accountLease.isCurrent();
  const state = useChats(false, {
    enabled: accountCurrent,
    ownerGeneration: accountLease.generation,
  });
  const term = normalizeGlobalSearchQuery(query);
  const validQuery = isGlobalSearchQueryValid(term);
  const [messageMatchResult, setMessageMatchResult] = useState<MessageMatchResult | null>(null);

  useEffect(
    () =>
      subscribeRealtimeGenerationInvalidation(accountLease.generation, () => {
        setRetiredGeneration(accountLease.generation);
      }),
    [accountLease],
  );

  useEffect(() => {
    if (!accountCurrent || !contentMatches || !validQuery) return;
    let cancelled = false;
    const t = setTimeout(() => {
      searchChatGuidsByMessage(getDatabase(), term)
        .then((guids) => {
          if (!cancelled && accountLease.isCurrent()) {
            setMessageMatchResult({
              generation: accountLease.generation,
              term,
              guids: new Set(guids),
            });
          }
        })
        .catch(() => {
          if (!cancelled && accountLease.isCurrent()) {
            setMessageMatchResult({
              generation: accountLease.generation,
              term,
              guids: new Set(),
            });
          }
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [accountCurrent, accountLease, contentMatches, term, validQuery]);

  // A result only applies to the exact term that produced it. Short/disabled/new queries derive
  // an empty set immediately, instead of synchronously clearing state in an effect after render.
  const msgMatchGuids =
    accountCurrent &&
    contentMatches &&
    validQuery &&
    messageMatchResult?.generation === accountLease.generation &&
    messageMatchResult.term === term
      ? messageMatchResult.guids
      : NO_MESSAGE_MATCHES;

  const data = useMemo(() => {
    const all = accountCurrent ? (state.data ?? []) : [];
    const normalizedTerm = term.toLowerCase();
    if (!normalizedTerm) return all;
    return all.filter(
      (r) =>
        `${resolveTitle(r)} ${r.participantNames ?? ''}`.toLowerCase().includes(normalizedTerm) ||
        msgMatchGuids.has(r.guid),
    );
  }, [accountCurrent, state.data, term, msgMatchGuids]);

  return accountCurrent ? { ...state, data } : { data: [], isLoading: false, error: null };
}
