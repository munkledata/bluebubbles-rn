import { getDatabase } from '@db/database';
import { listScheduledByChat } from '@db/repositories';
import { useReactiveQuery } from '@db/useReactiveQuery';

interface ScheduledMessageCountResult {
  chatGuid: string;
  count: number;
}

/** Live count of pending scheduled messages that belong to one conversation. */
export function useScheduledMessageCount(chatGuid: string): number {
  const { data } = useReactiveQuery<ScheduledMessageCountResult>(
    async () => ({
      chatGuid,
      count: (await listScheduledByChat(getDatabase(), chatGuid)).length,
    }),
    ['scheduled_messages'],
    [chatGuid],
  );

  // useReactiveQuery retains the last result while a dependency refreshes. Match the result to
  // its owner so navigating between chats can never briefly show the previous chat's count.
  return data?.chatGuid === chatGuid ? data.count : 0;
}
