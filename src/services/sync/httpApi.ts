import { chatsApi, type HttpClient, messagesApi, serverApi } from '@core/api';
import type { Chat, Message } from '@core/models';
import type { SyncApi } from './types';

/** SyncApi backed by the typed HttpClient (header auth). App-only (imports ky). */
export function httpSyncApi(http: HttpClient): SyncApi {
  return {
    async serverVersion(): Promise<string> {
      const info = await serverApi.serverInfo(http);
      return info.server_version ?? ''; // unknown → '' (sync treats as old → timestamp cursor)
    },
    fetchChats: (offset, limit): Promise<Chat[]> => chatsApi.queryChats(http, { offset, limit }),
    fetchChatMessages: (chatGuid, offset, limit): Promise<Message[]> =>
      messagesApi.chatMessages(http, chatGuid, { offset, limit }),
    fetchMessagesAfter: (cursor, limit): Promise<Message[]> =>
      messagesApi.queryMessages(http, {
        limit,
        afterRowId: cursor.mode === 'rowid' ? cursor.after : undefined,
        afterTimestamp: cursor.mode === 'timestamp' ? cursor.after : undefined,
      }),
  };
}
