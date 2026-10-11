import type { DeletedMessage, DeletedMessagePage } from '@core/api/endpoints/messages';
import type { Chat, Message, ServerInfo } from '@core/models';
import type { SyncCursor } from '@core/sync';
import type { MessageStatePage } from '@core/models/messageState';
import type { MessagePresencePage } from '@core/api/endpoints/messageState';
import type { ProviderRepairLease, ProviderRepairFinish } from '@core/api/endpoints/repairSnapshot';

/**
 * Data source for the sync engine. Implemented by httpApi.ts (over the typed
 * HttpClient) in the app, and by fixtures in tests — so the engine itself never
 * imports ky and runs in Node.
 */
export interface SyncApi {
  /** Full capability snapshot; production supplies it so boot sync cannot race capability refresh. */
  serverInfo?(signal?: AbortSignal): Promise<ServerInfo>;
  /** Server version, used to pick the incremental cursor mode. */
  serverVersion(signal?: AbortSignal): Promise<string>;
  /** Begin/finish a server-side stability proof around destructive full repair. */
  beginRepairSnapshot?(signal?: AbortSignal): Promise<{ token: string; expiresAt: number }>;
  finishRepairSnapshot?(token: string, signal?: AbortSignal): Promise<void>;
  cancelRepairSnapshot?(token: string, signal?: AbortSignal): Promise<void>;
  beginProviderRepair?(signal?: AbortSignal): Promise<ProviderRepairLease>;
  finishProviderRepair?(token: string, signal?: AbortSignal): Promise<ProviderRepairFinish>;
  cancelProviderRepair?(token: string, signal?: AbortSignal): Promise<void>;
  fetchMessageState?(cursor: string, signal?: AbortSignal): Promise<MessageStatePage>;
  fetchActiveMessage?(
    guid: string,
    providerEpoch: string,
    signal?: AbortSignal,
  ): Promise<Message | null>;
  /** Typed batch presence; present only when the server advertises it. */
  fetchMessagePresence?(
    providerEpoch: string,
    guids: readonly string[],
    signal?: AbortSignal,
  ): Promise<MessagePresencePage>;
  /** One exact chat for targeted repair; optional only for legacy/test adapters. */
  fetchChat?(chatGuid: string, signal?: AbortSignal): Promise<Chat>;
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
  /** Legacy timestamp-only deletion reader. Optional for older test/embedding adapters. */
  fetchDeletedAfter?(afterMs: number, signal?: AbortSignal): Promise<DeletedMessage[]>;
  /** Cursor-aware deletion page used by production. */
  fetchDeletedPage?(
    afterMs: number,
    cursor: string | null,
    signal?: AbortSignal,
  ): Promise<DeletedMessagePage>;
}
