import type { Chat, Message } from '@core/models';
import type { SyncCursor } from '@core/sync';

/**
 * Data source for the sync engine. Implemented by httpApi.ts (over the typed
 * HttpClient) in the app, and by fixtures in tests — so the engine itself never
 * imports ky and runs in Node.
 */
export interface SyncApi {
  /** Server version, used to pick the incremental cursor mode. */
  serverVersion(): Promise<string>;
  fetchChats(offset: number, limit: number): Promise<Chat[]>;
  fetchChatMessages(chatGuid: string, offset: number, limit: number): Promise<Message[]>;
  fetchMessagesAfter(cursor: SyncCursor, limit: number): Promise<Message[]>;
}
