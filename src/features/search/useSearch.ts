import { useEffect, useState } from 'react';
import { getDatabase } from '@db/database';
import { searchMessagesEnriched, type SearchResultRow } from '@db/repositories';

/**
 * Debounced full-text MESSAGE search for the search page (incl. decoded edited/SMS text). Chat
 * matches come separately from `useChatMatches` (shared with the inbox) so the two searches agree;
 * this hook only finds the individual message hits to list + jump to. One-shot reads; min 2 chars.
 */
export function useSearch(
  query: string,
  limit = 50,
): { results: SearchResultRow[]; loading: boolean } {
  const [results, setResults] = useState<SearchResultRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      searchMessagesEnriched(getDatabase(), q, limit)
        .then((r) => {
          if (!cancelled) {
            setResults(r);
            setLoading(false);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setResults([]);
            setLoading(false);
          }
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, limit]);

  return { results, loading };
}
