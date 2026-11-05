import { getDatabase } from '@db/database';
import { getChatHeader, getStorageBreakdown, type StorageBreakdown } from '@db/repositories';
import { useReactiveQuery } from '@db/useReactiveQuery';
import { resolveTitle } from '@utils/chat';

export interface StorageBreakdownView extends StorageBreakdown {
  /** Display name per top chat, by chat guid. */
  titles: Record<string, string>;
}

/** The Storage Analyzer's data, kept live as files download or are cleaned up. */
export function useStorageBreakdown(): StorageBreakdownView | null {
  const { data } = useReactiveQuery<StorageBreakdownView>(
    async () => {
      const db = getDatabase();
      const breakdown = await getStorageBreakdown(db, 10);
      const titles: Record<string, string> = {};
      for (const chat of breakdown.topChats) {
        const header = await getChatHeader(db, chat.chatGuid);
        titles[chat.chatGuid] = header ? resolveTitle(header) : 'Conversation';
      }
      return { ...breakdown, titles };
    },
    ['attachment_cache_entries', 'attachments', 'chats'],
    [],
  );
  return data ?? null;
}
