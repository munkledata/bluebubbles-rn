import { chatsApi, scheduledApi } from '@core/api';
import { logger } from '@core/secure';
import {
  clearChatTombstone,
  deleteChatLocal,
  deleteReminderByNotificationId,
  deleteScheduled,
  getChatIdByGuid,
  getNewestReceivedGuid,
  listChatAttachmentGuids,
  listOrphanedAttachmentGuids,
  listReminders,
  listScheduledByChat,
  resumeChatPurges,
  setChatUnreadLocal,
  setLastReadMessageGuid,
  upsertChats,
  upsertHandles,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
import { http } from './clients';
import { ensureDatabase } from './databaseControl';
import { safePathSegment } from './download/pathSafety';
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
  // A 1:1 guid is `service;-;address`, so composing with someone whose thread was deleted here
  // returns the SAME guid — still under its deletion tombstone, i.e. hidden from the inbox we are
  // about to route into. Deliberately starting the conversation again is an un-delete.
  await clearChatTombstone(db, chat.guid);
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

type FeatureSettings = ReturnType<typeof useFeatureSettingsStore.getState>;

/**
 * The feature settings, guaranteed to reflect what the user actually chose.
 *
 * Headlessly (a notification action on a killed app) no UI boot effect ever seeded this store, so
 * every flag sits at its MODULE DEFAULT — and both flags that gate the read receipt default to ON.
 * Reading them raw would tell the other party you read the message on behalf of someone who
 * switched receipts off. Gated on `hydrated` so it touches kv at most once per JS context, mirroring
 * `dispatchRealtimeEvent`; in the foreground it is already hydrated and this costs nothing.
 */
async function hydratedFeatureSettings(): Promise<FeatureSettings> {
  const fs = useFeatureSettingsStore.getState();
  if (!fs.hydrated) await fs.hydrate();
  return useFeatureSettingsStore.getState();
}

/**
 * Mark a chat read: always update the local read marker (clears the badge), and send the server
 * read receipt ONLY when the "Send Read Receipts" toggle is on — so disabling receipts still
 * clears your own unread badge but doesn't tell the other party you read it.
 */
export async function markRead(chatGuid: string): Promise<void> {
  // ensureDatabase, never getDatabase: the tray's "Mark as read" button runs HEADLESS on a
  // killed-app wake, where no React tree ever mounted, boot() never ran and the eager accessor
  // throws "Database not initialized". That rejection escaped the whole action handler, so the
  // notification wasn't even cleared — the button looked completely dead, but only when the app
  // had been killed, which is exactly when the button is most useful.
  const db = await ensureDatabase();
  const chatId = await getChatIdByGuid(db, chatGuid);
  if (chatId == null) return;
  const newest = await getNewestReceivedGuid(db, chatId);
  if (newest) await setLastReadMessageGuid(db, chatGuid, newest);
  const fs = await hydratedFeatureSettings();
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
  // ensureDatabase for the same headless reason as markRead — this shares the notification-action
  // and background-event code paths.
  const db = await ensureDatabase();
  await setChatUnreadLocal(db, chatGuid);
  if (chatGuid.startsWith('RCS;-;')) return;
  if (!(await hydratedFeatureSettings()).privateApiEnabled) return;
  try {
    await chatsApi.markChatUnread(http, chatGuid);
  } catch (e) {
    logger.debug('[chats] mark-unread server sync failed; local flip kept', { error: String(e) });
  }
}

/**
 * Delete a conversation from this device.
 *
 * `deleteChatLocal` does the DB half. This wrapper owns the half the repository CANNOT do, because
 * `src/db` must stay free of both React and native modules: retiring the chat's state that lives
 * OUTSIDE the database and would otherwise keep acting on its own — the reminders' OS alarms and
 * the Mac's copy of any server-backed scheduled message. Both are the same shape of problem: a
 * local row delete doesn't cancel them, it just destroys the only handle we had for cancelling
 * them. Same lazy import + own try/catch as `forget()`.
 *
 * The chat delete itself is UNCONDITIONAL and goes FIRST: reaching the native bridge or the server
 * must never be what stops — or delays — a delete the user asked for. Both list call sites invoke
 * this as `void deleteChat(...)` with no spinner, so anything awaited ahead of the local delete is
 * time the tile sits in the inbox looking like the tap did nothing; `cancelServerScheduledForChat`
 * is a sequential per-row HTTP loop, and against a server that accepts the connection and then
 * blackholes it (a dead tunnel — not the same as offline, where fetch rejects at once) each row
 * costs the full request timeout. Ordering it after the delete costs nothing: `deleteChatLocal`
 * deliberately PRESERVES pending server-backed scheduled rows (that is the whole reason this
 * wrapper exists), and reminders are not touched by it at all, so both helpers still find exactly
 * the rows they need. What IS conditional is dropping the rows that track that external state —
 * see the two helpers.
 *
 * THE ONE THING THAT MUST BE READ BEFORE THE DELETE is the list of downloaded attachment files:
 * `attachments.local_path` is the only record that a download ever happened and it cascades away
 * with the messages, so afterwards the photos and videos of that thread are bytes no code path can
 * reach and nothing but "Clear app data" could ever reclaim. It is one indexed local SELECT — no
 * native bridge, no network — so it costs the tile nothing.
 */
export async function deleteChat(chatGuid: string): Promise<void> {
  const db = await ensureDatabase();
  // Never let this stop the delete: with no candidates the files are simply left behind, which is
  // the state the delete had before this existed.
  const downloaded = await listChatAttachmentGuids(db, chatGuid).catch((e) => {
    logger.warn('[chats] could not list downloaded attachments for deleted chat', e);
    return [] as string[];
  });
  try {
    await deleteChatLocal(db, chatGuid);
  } finally {
    // `finally`, so moving the local delete first cannot cost the external cleanup its run. If the
    // delete fails part-way the chat is already tombstoned, and an uncancelled server-backed
    // scheduled send would fire into that hidden thread and un-hide it; if it failed before the
    // tombstone, this is exactly what the previous ordering did anyway. None of these helpers throws
    // (each swallows its own failures), so nothing here can mask the original error.
    //
    // The tray cancel goes FIRST because it is the only one that is both instant (a local native
    // call) and user-visible: `cancelServerScheduledForChat` is a sequential per-row HTTP loop that
    // costs a full request timeout per row against a blackholing tunnel, and a notification for the
    // conversation the user just deleted must not survive that.
    await cancelChatNotification(chatGuid);
    await cancelServerScheduledForChat(db, chatGuid);
    await cancelRemindersForChat(db, chatGuid);
    await deleteDownloadedAttachments(db, downloaded);
    // Finish any purge that never got to complete — a previous delete killed mid-loop, or this
    // one's own loop if that is what threw. One query when there is nothing to resume (the norm).
    await resumeChatPurges(db).catch((e) => logger.warn('[chats] purge resume failed', e));
  }
}

/**
 * Dismiss the deleted chat's notification from the tray.
 *
 * A posted notification is SYSTEM state keyed by chat guid that outlives every row this delete
 * touches — the same shape of problem as a reminder's alarm. Left up, it still shows the sender and
 * the message preview of a conversation the user just deleted, and tapping it routes straight into
 * the hidden thread. Own try/catch + lazy import so the native bridge can never cost the delete.
 */
async function cancelChatNotification(chatGuid: string): Promise<void> {
  try {
    const { cancelForChat } = await import('./notifications/notifeeService');
    await cancelForChat(chatGuid);
  } catch (e) {
    logger.warn('[chats] tray notification cancel failed for deleted chat', e);
  }
}

/**
 * Delete the on-disk files of the attachments the purge just orphaned.
 *
 * `expoFetcher` writes each download to `{documents}/attachments/<safePathSegment(guid)>/…` —
 * app-private PERSISTENT storage the OS never reclaims — and the rows holding those paths are gone,
 * so without this a photo-heavy thread leaves gigabytes behind that nothing can ever find again.
 * Same lazy import + per-directory try/catch as `forget()`'s `deleteCachedMedia`, because
 * expo-file-system is a native module and a filesystem failure must never surface as a failed
 * delete.
 *
 * IT RE-CHECKS THE ROWS FIRST. The candidates were read before the purge, and the purge is bounded
 * at the tombstone stamp and can be interrupted — a surviving row still renders its image, so its
 * file has to survive too. Only guids the database no longer knows about are deleted, and only the
 * download directory named by the guid: `local_path` itself may point at a user-picked file that is
 * not ours to remove. The directory is addressed with the SAME sanitiser the download used; the raw
 * guid names nothing on disk.
 */
async function deleteDownloadedAttachments(db: AppDatabase, guids: string[]): Promise<void> {
  if (guids.length === 0) return;
  try {
    const orphaned = await listOrphanedAttachmentGuids(db, guids);
    if (orphaned.length === 0) return;
    const { Directory, Paths } = await import('expo-file-system');
    for (const guid of orphaned) {
      try {
        const dir = new Directory(Paths.document, 'attachments', safePathSegment(guid));
        if (dir.exists) dir.delete();
      } catch (e) {
        logger.warn('[chats] could not delete a downloaded attachment of the deleted chat', e);
      }
    }
  } catch (e) {
    logger.warn('[chats] downloaded attachments left on disk for the deleted chat', e);
  }
}

/**
 * Cancel the OS alarms of this chat's reminders and drop ONLY the rows whose cancellation actually
 * succeeded.
 *
 * A trigger notification is SYSTEM state that outlives its row: an uncancelled one still fires
 * hours later, showing the deleted message's preview on the lock screen and deep-linking into a
 * conversation that is no longer in the inbox. Deleting the row anyway makes that alarm
 * UNSTOPPABLE — the Reminders screen and `forget()` both enumerate via `listReminders`, so once the
 * row is gone nothing can ever find it again. So a row survives its chat exactly when its alarm
 * did; keeping it costs a stale entry on the Reminders screen, which is precisely the affordance
 * needed to cancel the thing. (It leaks no preview text the still-armed alarm doesn't already hold.)
 *
 * `allSettled`, not `all`: one unreachable trigger must not cost the other reminders their delete.
 */
async function cancelRemindersForChat(db: AppDatabase, chatGuid: string): Promise<void> {
  try {
    const pending = (await listReminders(db)).filter((r) => r.chatGuid === chatGuid);
    if (pending.length === 0) return;
    const { cancelReminderNotification } = await import('./notifications/notifeeService');
    const settled = await Promise.allSettled(
      pending.map(async (r) => {
        await cancelReminderNotification(r.notificationId);
        return r.notificationId;
      }),
    );
    for (const s of settled) {
      if (s.status === 'fulfilled') await deleteReminderByNotificationId(db, s.value);
    }
  } catch (e) {
    // Reaching the notifee module at all failed (or the row read did) — every reminder keeps both
    // its alarm and its row, which is the recoverable state.
    logger.warn('[chats] reminder cancel failed for deleted chat', e);
  }
}

/**
 * Cancel this chat's SERVER-BACKED scheduled messages on the Mac, then drop the rows the Mac
 * confirmed. Runs AFTER `deleteChatLocal`, which is safe because that call deliberately leaves
 * pending server-backed rows behind — they are the only rows left here to find.
 *
 * A server-backed row (`serverId` set — the default: `scheduleTextMessage` POSTs first and only
 * falls back to local-only for a reply target / recurrence / failure) is fired by the MAC. The
 * on-device ticker deliberately skips it, so deleting the local row cancels nothing: the message is
 * still sent at its time, and the resulting `new-message` un-hides the conversation the user just
 * deleted. Worse, `cancelScheduled` needs that row's `serverId`, so dropping it blind leaves no way
 * to stop it until a Scheduled-screen refresh happens to re-sync it back.
 *
 * A row is only removed once the server confirms; a refused cancel keeps it, exactly as
 * `cancelScheduled` does, so the user retains the handle on the Scheduled screen (which lists
 * pending rows without joining `chats`, so a hidden chat doesn't hide them). Per-row try/catch:
 * one unreachable server call must not skip the rest, nor block the delete.
 */
async function cancelServerScheduledForChat(db: AppDatabase, chatGuid: string): Promise<void> {
  let pending: Awaited<ReturnType<typeof listScheduledByChat>>;
  try {
    pending = await listScheduledByChat(db, chatGuid);
  } catch (e) {
    logger.warn('[chats] could not read scheduled messages for deleted chat', e);
    return;
  }
  for (const row of pending) {
    const serverId = row.serverId;
    if (serverId == null) continue; // local-only: deleteChatLocal dropping the row IS the cancel
    try {
      await scheduledApi.deleteScheduled(http, serverId);
      await deleteScheduled(db, row.id);
    } catch (e) {
      logger.warn('[chats] server scheduled-message cancel failed; keeping the local row', e);
    }
  }
}
