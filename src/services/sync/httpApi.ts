import { chatsApi, type HttpClient, messagesApi, serverApi } from '@core/api';
import type { Chat, Message } from '@core/models';
import type { SyncApi } from './types';

/** SyncApi backed by the typed HttpClient (header auth). App-only (imports ky). */
export function httpSyncApi(http: HttpClient): SyncApi {
  return {
    async serverVersion(signal?: AbortSignal): Promise<string> {
      const info = await serverApi.serverInfo(http, signal);
      return info.server_version ?? ''; // unknown → '' (sync treats as old → timestamp cursor)
    },
    fetchChat: (chatGuid, signal): Promise<Chat> => chatsApi.getChat(http, chatGuid, signal),
    fetchChats: (offset, limit, signal): Promise<Chat[]> =>
      chatsApi.queryChats(http, { offset, limit }, signal),
    fetchChatMessages: (chatGuid, offset, limit, signal): Promise<Message[]> =>
      messagesApi.chatMessages(http, chatGuid, { offset, limit }, signal),
    fetchMessagesAfter: (cursor, limit, signal): Promise<Message[]> =>
      messagesApi.queryMessages(
        http,
        {
          limit,
          afterRowId: cursor.mode === 'rowid' ? cursor.after : undefined,
          afterTimestamp: cursor.mode === 'timestamp' ? cursor.after : undefined,
        },
        signal,
      ),
    fetchDeletedAfter: (afterMs, signal) => messagesApi.deletedMessages(http, afterMs, signal),
  };
}
