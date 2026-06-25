import { useEffect, useState } from 'react';
import { getDatabase } from '@db/database';
import {
  searchChatsByName,
  searchMessagesEnriched,
  type ChatNameMatch,
  type SearchResultRow,
} from '@db/repositories';

/**
 * Debounced search for the dedicated search page. Returns BOTH chat-name matches (title /
 * identifier / participant contact name or number) and message full-text hits (incl. decoded
 * edited/SMS text), so the page finds the same things the inbox top-bar can — just presented as
 * results. One-shot reads (not reactive); min 2 chars.
 */
export function useSearch(
  query: string,
  limit = 50,
): { chats: ChatNameMatch[]; results: SearchResultRow[]; loading: boolean } {
  const [chats, setChats] = useState<ChatNameMatch[]>([]);
  const [results, setResults] = useState<SearchResultRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setChats([]);
      setResults([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      const db = getDatabase();
      Promise.all([searchChatsByName(db, q, 20), searchMessagesEnriched(db, q, limit)])
        .then(([c, r]) => {
          if (!cancelled) {
            setChats(c);
            setResults(r);
            setLoading(false);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setChats([]);
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

  return { chats, results, loading };
}
