import { chatsApi } from '@core/api';
import { logger } from '@core/secure';
import { getDatabase } from '@db/database';
import {
  getChatIdByGuid,
  getNewestReceivedGuid,
  setChatUnreadLocal,
  setLastReadMessageGuid,
  upsertChats,
  upsertHandles,
} from '@db/repositories';
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
import { http } from './clients';
import { ensureDatabase } from './databaseControl';
import { getSocket } from './realtimeControl';

/**
 * Create a new chat with the given recipient addresses + an initial message, upsert the
 * returned chat locally so it appears immediately, and return its guid (route into it).
 * `service` accepts 'RCS' (server routes it to the sidecar and mints an `RCS;-;` guid);
 * defaults to iMessage for existing callers.
 */
export async function createNewChat(
  addresses: string[],
  message: string,
  service: 'iMessage' | 'SMS' | 'RCS' = 'iMessage',
): Promise<string> {
  const db = await ensureDatabase();
  const chat = await chatsApi.createChat(http, { addresses, message, service });
  const handleIds = await upsertHandles(db, chat.participants ?? []);
  await upsertChats(db, [chat], handleIds);
  return chat.guid;
}

/**
 * Emit a typing indicator to the server. The server listens on `start-typing` / `stop-typing`
 * with a `{ guid }` payload — NOT `started-typing`/`stopped-typing` with `{ chatGuid }` (which
 * it ignored, so the indicator never reached the other party). No-op when not connected.
 * SERVER-GATED: the server only relays this with the **private API** enabled, so it can't be
 * verified without a server.
 */
export function sendTyping(chatGuid: string, isTyping: boolean): void {
  // Respect the master Private API switch + the "Send Typing Indicators" toggle.
  const fs = useFeatureSettingsStore.getState();
  if (!fs.privateApiEnabled || !fs.sendTypingIndicators) return;
  getSocket()?.emit(isTyping ? 'start-typing' : 'stop-typing', { guid: chatGuid });
}

/**
 * Mark a chat read: always update the local read marker (clears the badge), and send the server
 * read receipt ONLY when the "Send Read Receipts" toggle is on — so disabling receipts still
 * clears your own unread badge but doesn't tell the other party you read it.
 */
export async function markRead(chatGuid: string): Promise<void> {
  const db = getDatabase();
  const chatId = await getChatIdByGuid(db, chatGuid);
  if (chatId == null) return;
  const newest = await getNewestReceivedGuid(db, chatId);
  if (newest) await setLastReadMessageGuid(db, chatGuid, newest);
  const fs = useFeatureSettingsStore.getState();
  if (!fs.privateApiEnabled || !fs.sendReadReceipts) return;
  try {
    await chatsApi.markChatRead(http, chatGuid);
  } catch {
    // Offline / not connected — the local marker still clears the badge.
  }
}

/**
 * Mark a chat UNREAD: always clear the local read marker first (the inbox badge returns
 * immediately), then best-effort sync it to the Mac via POST /chat/:guid/unread. A server
 * failure never reverts or blocks the local flip — it's logged and dropped. The endpoint is
 * Private-API + iMessage-only, so the call is skipped for `RCS;-;` chats (the RCS sidecar has
 * no unread endpoint) and when the master Private API toggle is off.
 */
export async function markUnread(chatGuid: string): Promise<void> {
  const db = getDatabase();
  await setChatUnreadLocal(db, chatGuid);
  if (chatGuid.startsWith('RCS;-;')) return;
  if (!useFeatureSettingsStore.getState().privateApiEnabled) return;
  try {
    await chatsApi.markChatUnread(http, chatGuid);
  } catch (e) {
    logger.debug('[chats] mark-unread server sync failed; local flip kept', { error: String(e) });
  }
}
