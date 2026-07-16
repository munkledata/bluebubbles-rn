import { useEffect, useState } from 'react';
import { getDatabase } from '@db/database';
import { searchContactAddresses, type ContactPick } from '@db/repositories';

/**
 * Contact-address suggestions for a recipient input (new-chat, FaceTime dialer): a one-shot
 * DB read per query with active-flag cancellation so a stale query's late result never
 * clobbers the current one. A failed read (e.g. DB not open yet) yields an empty list.
 */
export function useContactSearch(query: string, limit = 30): ContactPick[] {
  const [suggestions, setSuggestions] = useState<ContactPick[]>([]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const r = await searchContactAddresses(getDatabase(), query, limit);
        if (active) setSuggestions(r);
      } catch {
        if (active) setSuggestions([]);
      }
    })();
    return () => {
      active = false;
    };
  }, [query, limit]);

  return suggestions;
}
