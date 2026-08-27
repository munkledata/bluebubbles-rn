import type { DeletedMessage } from '@core/api/endpoints/messages';
import type { Chat, Message } from '@core/models';
import type { SyncCursor } from '@core/sync';

/**
 * Data source for the sync engine. Implemented by httpApi.ts (over the typed
 * HttpClient) in the app, and by fixtures in tests — so the engine itself never
 * imports ky and runs in Node.
 */
export interface SyncApi {
  /** Server version, used to pick the incremental cursor mode. */
  serverVersion(signal?: AbortSignal): Promise<string>;
  fetchChats(offset: number, limit: number, signal?: AbortSignal): Promise<Chat[]>;
  fetchChatMessages(
    chatGuid: string,
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Message[]>;
  fetchMessagesAfter(cursor: SyncCursor, limit: number, signal?: AbortSignal): Promise<Message[]>;
  /**
   * GET /message/deleted — deletions strictly after the Unix-ms watermark (R1 catch-up sync for
   * `message-deleted` events missed while the app was dead/locked). Only called when the server
   * advertises `supports_message_deleted`; older servers would 404.
   */
  fetchDeletedAfter(afterMs: number, signal?: AbortSignal): Promise<DeletedMessage[]>;
}
