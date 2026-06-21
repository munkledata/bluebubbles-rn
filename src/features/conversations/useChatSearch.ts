import { useQuery } from '@tanstack/react-query';
import { getDatabase } from '@db/database';
import { searchMessages } from '@db/repositories';

const MIN_CHARS = 3;

/**
 * One-shot full-text message search (not a live view), via TanStack Query keyed
 * on the term. Gated to >= 3 chars to match the Flutter search behavior.
 */
export function useChatSearch(term: string) {
  const trimmed = term.trim();
  return useQuery({
    queryKey: ['chatSearch', trimmed],
    queryFn: () => searchMessages(getDatabase(), trimmed),
    enabled: trimmed.length >= MIN_CHARS,
  });
}
