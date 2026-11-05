import { getDatabase } from '@db/database';
import { getChatStats, type ChatStats } from '@db/repositories';
import { useReactiveQuery } from '@db/useReactiveQuery';

/**
 * One chat's message and attachment counts for its Details screen. Reactive on messages and
 * attachments (the subscription is debounced), and null until the first read finishes or if it
 * fails, so the screen simply shows nothing rather than a wrong number.
 */
export function useChatStats(chatGuid: string): ChatStats | null {
  const { data } = useReactiveQuery<ChatStats>(
    () => getChatStats(getDatabase(), chatGuid),
    ['messages', 'attachments'],
    [chatGuid],
  );
  return data ?? null;
}
