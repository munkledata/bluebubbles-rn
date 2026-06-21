import { getDatabase } from '@db/database';
import { getChatHeader, type ChatHeaderRow } from '@db/repositories';
import { useReactiveQuery, type ReactiveState } from '@db/useReactiveQuery';

const TABLES = ['chats', 'chat_handles', 'handles'];

/** Live chat header row (title/avatar/group state) for the conversation view. */
export function useChatHeader(chatGuid: string): ReactiveState<ChatHeaderRow | null> {
  return useReactiveQuery<ChatHeaderRow | null>(
    () => getChatHeader(getDatabase(), chatGuid),
    TABLES,
    [chatGuid],
  );
}
