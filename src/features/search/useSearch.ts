import { useEffect, useState } from 'react';
import { getDatabase } from '@db/database';
import { searchMessagesEnriched, type SearchResultRow } from '@db/repositories';

interface SettledSearch {
  key: string;
  results: SearchResultRow[];
}

/**
 * Debounced full-text MESSAGE search for the search page (incl. decoded edited/SMS text). Chat
 * matches come separately from `useChatMatches` (shared with the inbox) so the two searches agree;
 * this hook only finds the individual message hits to list + jump to. One-shot reads; min 2 chars.
 */
export function useSearch(
  query: string,
  limit = 50,
): { results: SearchResultRow[]; loading: boolean } {
  const q = query.trim();
  const searchKey = JSON.stringify([q, limit]);
  const [settled, setSettled] = useState<SettledSearch | null>(null);

  useEffect(() => {
    if (q.length < 2) return;
    let cancelled = false;
    const t = setTimeout(() => {
      searchMessagesEnriched(getDatabase(), q, limit)
        .then((r) => {
          if (!cancelled) setSettled({ key: searchKey, results: r });
        })
        .catch(() => {
          if (!cancelled) setSettled({ key: searchKey, results: [] });
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, limit, searchKey]);

  if (q.length < 2) return { results: [], loading: false };
  if (settled?.key !== searchKey) return { results: [], loading: true };
  return { results: settled.results, loading: false };
}
