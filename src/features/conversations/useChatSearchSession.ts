import { useCallback, useEffect, useRef, useState } from 'react';
import type { MessageWindowAnchor } from '@db/repositories';
import type { RealtimeDeliveryLease } from '@/services/realtime/deliveryCoordinator';
import { useChatSearch } from './useChatSearch';

export interface ChatSearchSessionOptions {
  guid: string;
  accountLease: RealtimeDeliveryLease;
  /** Anchors the message window on a message, or clears the anchor. */
  setJump: (anchor: MessageWindowAnchor | null) => void;
  /** Leaves any anchored window and returns to the live newest messages. */
  exitAnchor: () => void;
  /** The message window is anchored on a message (search hit, unread jump, route focus). */
  hasMessageAnchor: boolean;
  /** The loaded window is the one most recently requested. */
  isCurrentWindow: boolean;
  /** Runs right before search opens, to dismiss modes that cannot be open alongside it. */
  onOpen: () => void;
}

/**
 * The open chat's in-conversation search: the typed text, the debounced query, which hit is shown,
 * and moving between hits. Showing a hit anchors the message window on it through `setJump`.
 *
 * Closing search returns to the live newest window before the composer comes back, because a send
 * made while an old window is shown could look as though it disappeared. `returningToNewest` stays
 * true until that newest window has loaded.
 */
export function useChatSearchSession({
  guid,
  accountLease,
  setJump,
  exitAnchor,
  hasMessageAnchor,
  isCurrentWindow,
  onOpen,
}: ChatSearchSessionOptions) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchIndex, setSearchIndex] = useState(0);
  const [searchNavigating, setSearchNavigating] = useState(false);
  const [returningToNewest, setReturningToNewest] = useState(false);
  const searchOpenRef = useRef(searchOpen);
  searchOpenRef.current = searchOpen;
  const searchQueryRef = useRef(searchQuery);
  searchQueryRef.current = searchQuery;
  const searchNavigationTokenRef = useRef(0);
  const appliedSearchKeyRef = useRef('');

  // A short debounce keeps typing responsive without querying FTS for every keypress.
  useEffect(() => {
    const trimmed = searchText.trim();
    if (!searchOpen || trimmed.length < 3) return;
    const timer = setTimeout(() => setSearchQuery(trimmed), 250);
    return () => clearTimeout(timer);
  }, [searchOpen, searchText]);
  const chatSearch = useChatSearch(guid, searchQuery, accountLease);
  const {
    fetchNextPage: fetchNextSearchPage,
    hasNextPage: hasNextSearchPage,
    isPending: searchPending,
    results: searchResults,
    totalCount: searchTotalCount,
  } = chatSearch;

  const closeSearch = useCallback((): void => {
    searchNavigationTokenRef.current += 1;
    appliedSearchKeyRef.current = '';
    setReturningToNewest(true);
    setSearchOpen(false);
    setSearchText('');
    setSearchQuery('');
    setSearchIndex(0);
    setSearchNavigating(false);
    // Search uses a bounded context window. Return to the live newest window before the composer
    // becomes usable again, or a send outside that old window can look as though it disappeared.
    exitAnchor();
  }, [exitAnchor]);
  if (returningToNewest && !hasMessageAnchor && isCurrentWindow && accountLease.isCurrent()) {
    // Acknowledge the settled newest window before committing children. Resetting this state
    // also lets a later search close establish a fresh barrier.
    setReturningToNewest(false);
  }
  const exitSearchAnchor = useCallback((): void => {
    if (searchOpenRef.current) closeSearch();
    else exitAnchor();
  }, [closeSearch, exitAnchor]);
  const onSearchTextChange = useCallback(
    (value: string): void => {
      const query = value.trim();
      setSearchText(value);
      // Leading/trailing whitespace does not change the normalized FTS query. Preserve the current
      // exact hit and any in-flight page instead of clearing them for a state update React will
      // correctly treat as a no-op.
      if (query === searchQueryRef.current) return;
      searchNavigationTokenRef.current += 1;
      appliedSearchKeyRef.current = '';
      if (query.length < 3) setSearchQuery('');
      setSearchIndex(0);
      setSearchNavigating(false);
      // Do not leave a stale prior-query result highlighted while the next query is debouncing.
      setJump(null);
    },
    [setJump],
  );

  // Select the newest hit once for each completed query. Later page loads reuse the same key and
  // therefore cannot snap the reader back to result zero.
  useEffect(() => {
    if (
      !searchOpen ||
      searchQuery.length < 3 ||
      searchText.trim() !== searchQuery ||
      !accountLease.isCurrent()
    ) {
      return;
    }
    const key = `${accountLease.generation}\u0000${guid}\u0000${searchQuery}`;
    if (searchPending || appliedSearchKeyRef.current === key) return;
    appliedSearchKeyRef.current = key;
    searchNavigationTokenRef.current += 1;
    setSearchIndex(0);
    setSearchNavigating(false);
    const first = searchResults[0];
    setJump(first ? { id: first.id, guid: first.guid } : null);
  }, [
    accountLease,
    searchPending,
    searchResults,
    guid,
    searchOpen,
    searchQuery,
    searchText,
    setJump,
  ]);

  const moveToSearchResult = useCallback(
    async (targetIndex: number): Promise<void> => {
      if (targetIndex < 0 || targetIndex >= searchTotalCount || searchNavigating) return;
      const key = searchQuery;
      const token = searchNavigationTokenRef.current + 1;
      searchNavigationTokenRef.current = token;
      setSearchNavigating(true);
      let available = searchResults;
      try {
        if (!available[targetIndex] && hasNextSearchPage) {
          const next = await fetchNextSearchPage();
          available = next.data?.pages.flatMap((page) => page.results) ?? available;
        }
        if (
          token !== searchNavigationTokenRef.current ||
          !searchOpenRef.current ||
          searchQueryRef.current !== key ||
          !accountLease.isCurrent()
        ) {
          return;
        }
        const result = available[targetIndex];
        if (!result) return;
        setSearchIndex(targetIndex);
        setJump({ id: result.id, guid: result.guid });
      } catch {
        // TanStack exposes the page error through the hook; keep the current result in place.
      } finally {
        if (token === searchNavigationTokenRef.current && searchOpenRef.current) {
          setSearchNavigating(false);
        }
      }
    },
    [
      accountLease,
      fetchNextSearchPage,
      hasNextSearchPage,
      searchResults,
      searchTotalCount,
      searchNavigating,
      searchQuery,
      setJump,
    ],
  );
  const goToOlderSearchResult = useCallback((): void => {
    void moveToSearchResult(searchIndex + 1);
  }, [moveToSearchResult, searchIndex]);
  const goToNewerSearchResult = useCallback((): void => {
    void moveToSearchResult(searchIndex - 1);
  }, [moveToSearchResult, searchIndex]);

  const toggleSearch = useCallback((): void => {
    if (searchOpenRef.current) {
      closeSearch();
      return;
    }
    onOpen();
    setSearchOpen(true);
  }, [closeSearch, onOpen]);

  return {
    searchOpen,
    searchText,
    searchQuery,
    searchIndex,
    searchNavigating,
    returningToNewest,
    chatSearch,
    toggleSearch,
    closeSearch,
    exitSearchAnchor,
    onSearchTextChange,
    goToOlderSearchResult,
    goToNewerSearchResult,
  };
}
