import { chatsApi, scheduledApi } from '@core/api';
import { logger } from '@core/secure';
import {
  clearChatTombstoneWithinTransaction,
  deleteChatLocal,
  deleteReminderByNotificationIdWithinTransaction,
  deleteScheduledWithinTransaction,
  getChatIdByGuid,
  getNewestReceivedGuid,
  linkHandlesToContacts,
  listChatAttachmentGuids,
  listReminders,
  listScheduledByChat,
  resumeChatPurges,
  setChatUnreadLocalWithinTransaction,
  setLastReadMessageGuidWithinTransaction,
  upsertChatsWithinTransaction,
  upsertHandlesWithinTransaction,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import {
  runInTransactionContext,
  withDbTransaction,
  type DbTransactionContext,
} from '@db/transaction';
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
import { http } from './clients';
import { ensureDatabase } from './databaseControl';
import { createAttachmentCacheAccountScope } from './download/attachmentCacheAccountScope';
import { cancelAttachmentDownloads } from './download/downloadService';
import { attachmentCacheCoordinator } from './download/attachmentCacheCoordinator';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
  type RealtimeDeliveryLease,
} from './realtime/deliveryCoordinator';
import { getSocket } from './realtimeControl';

/** Private rollback signal for a create-chat mutation whose account was disconnected. */
const STALE_CREATE_CHAT = Symbol('stale-create-chat');
/** Private control-flow signal for a chat action whose account is being retired. */
const STALE_CHAT_ACTION = Symbol('stale-chat-action');

function assertCreateChatLease(lease: RealtimeDeliveryLease): void {
  if (!lease.isCurrent()) throw STALE_CREATE_CHAT;
}

function assertChatActionLease(lease: RealtimeDeliveryLease): void {
  if (!lease.isCurrent()) throw STALE_CHAT_ACTION;
}

/**
 * Admit an entire user/chat mutation before its first await and quietly abandon stale work.
 *
 * Disconnect invalidates `lease` synchronously and drains the published slot before wiping the
 * account. That means an operation already inside a short DB write completes and is then wiped,
 * while one parked on Keystore/network work cannot wake up and touch the next account.
 */
async function runChatAction(
  lease: RealtimeDeliveryLease,
  action: (lease: RealtimeDeliveryLease) => Promise<void>,
): Promise<void> {
  try {
    await runTrackedRealtimeWork(lease, async (trackedLease) => {
      assertChatActionLease(trackedLease);
      await action(trackedLease);
      assertChatActionLease(trackedLease);
    });
  } catch (error) {
    if (error === STALE_CHAT_ACTION || !lease.isCurrent()) return;
    throw error;
  }
}

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
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<string> {
  try {
    // Capture happened in the default argument, before the first await. Re-check after opening the
    // DB so an A-account call parked on Keystore/database work cannot wake up after reconnect and
    // send its request with B's live credentials.
    assertCreateChatLease(accountLease);
    const db = await ensureDatabase();
    assertCreateChatLease(accountLease);

    // HttpClient snapshots the origin + credential at request entry. A Disconnect cannot recall a
    // request the old server already accepted, but its response is disowned below and can never be
    // reconciled into the next account's database.
    const chat = await chatsApi.createChat(http, { addresses, message, service });
    assertCreateChatLease(accountLease);

    // Keep every local consequence atomic. Disconnect either waits for this short commit and then
    // wipes it, rejects admission before it begins, or invalidates the lease mid-transaction and
    // the final check rolls the whole handle/chat/tombstone set back.
    const commit = await runTrackedRealtimeWork(accountLease, () =>
      withDbTransaction(db, async (context) => {
        assertCreateChatLease(accountLease);
        const handleIds = await upsertHandlesWithinTransaction(context, chat.participants ?? []);
        assertCreateChatLease(accountLease);
        await upsertChatsWithinTransaction(context, [chat], handleIds);
        assertCreateChatLease(accountLease);
        // A 1:1 guid is `service;-;address`, so composing with someone whose thread was deleted here
        // returns the SAME guid — still under its deletion tombstone, i.e. hidden from the inbox we
        // are about to route into. Deliberately starting the conversation again is an un-delete.
        await clearChatTombstoneWithinTransaction(context, chat.guid);
        assertCreateChatLease(accountLease);
      }),
    );
    if (commit === 'paused') throw STALE_CREATE_CHAT;
    assertCreateChatLease(accountLease);

    // Device-contact matching reads the whole address book, so it must run only after the short
    // authoritative handle/chat/tombstone transaction commits. Each actual match owns its own
    // commit-guarded transaction; a presentation-only failure must not undo a successfully created
    // conversation.
    try {
      await linkHandlesToContacts(
        db,
        (chat.participants ?? []).map((participant) => participant.address),
        undefined,
        () => accountLease.isCurrent(),
      );
    } catch (error) {
      if (!accountLease.isCurrent()) throw STALE_CREATE_CHAT;
      logger.debug('[chats] post-create contact linking skipped', error);
    }
    assertCreateChatLease(accountLease);
    return chat.guid;
  } catch (error) {
    if (error === STALE_CREATE_CHAT) {
      throw new Error('Create chat stopped because the account session changed');
    }
    throw error;
  }
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

type MarkReadTarget =
  | { readonly chatExists: false; readonly newestReceivedGuid: null }
  | { readonly chatExists: true; readonly newestReceivedGuid: string | null };

/** Resolve the complete local mark-read target without observing another owner's partial work. */
function resolveMarkReadTargetWithinTransaction(
  context: DbTransactionContext,
  chatGuid: string,
): Promise<MarkReadTarget> {
  return runInTransactionContext(context, async (db) => {
    const chatId = await getChatIdByGuid(db, chatGuid);
    if (chatId == null) return { chatExists: false, newestReceivedGuid: null } as const;
    return {
      chatExists: true,
      newestReceivedGuid: await getNewestReceivedGuid(db, chatId),
    } as const;
  });
}

/**
 * Mark a chat read: always update the local read marker (clears the badge), and send the server
 * read receipt ONLY when the "Send Read Receipts" toggle is on — so disabling receipts still
 * clears your own unread badge but doesn't tell the other party you read it.
 */
export function markRead(
  chatGuid: string,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<void> {
  return runChatAction(accountLease, async (activeLease) => {
    // ensureDatabase, never getDatabase: the tray's "Mark as read" button runs HEADLESS on a
    // killed-app wake, where no React tree ever mounted, boot() never ran and the eager accessor
    // throws "Database not initialized". That rejection escaped the whole action handler, so the
    // notification wasn't even cleared — the button looked completely dead, but only when the app
    // had been killed, which is exactly when the button is most useful.
    const db = await ensureDatabase();
    assertChatActionLease(activeLease);
    const target = await withDbTransaction(
      db,
      async (context) => {
        assertChatActionLease(activeLease);
        const resolved = await resolveMarkReadTargetWithinTransaction(context, chatGuid);
        assertChatActionLease(activeLease);
        if (resolved.newestReceivedGuid) {
          await setLastReadMessageGuidWithinTransaction(
            context,
            chatGuid,
            resolved.newestReceivedGuid,
          );
          assertChatActionLease(activeLease);
        }
        return resolved;
      },
      () => activeLease.isCurrent(),
    );
    assertChatActionLease(activeLease);
    if (!target.chatExists) return;
    const fs = await hydratedFeatureSettings();
    assertChatActionLease(activeLease);
    if (!fs.privateApiEnabled || !fs.sendReadReceipts) return;
    try {
      await chatsApi.markChatRead(http, chatGuid);
    } catch {
      // Offline / not connected — the local marker still clears the badge.
    }
    assertChatActionLease(activeLease);
  });
}

/**
 * Mark a chat UNREAD: always clear the local read marker first (the inbox badge returns
 * immediately), then best-effort sync it to the Mac via POST /chat/:guid/unread. A server
 * failure never reverts or blocks the local flip — it's logged and dropped. The endpoint is
 * Private-API + iMessage-only, so the call is skipped for `RCS;-;` chats (the RCS sidecar has
 * no unread endpoint) and when the master Private API toggle is off.
 */
export function markUnread(
  chatGuid: string,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<void> {
  return runChatAction(accountLease, async (activeLease) => {
    // ensureDatabase for the same headless reason as markRead — this shares the
    // notification-action and background-event code paths.
    const db = await ensureDatabase();
    assertChatActionLease(activeLease);
    const markedUnreadAt = Date.now();
    await withDbTransaction(
      db,
      async (context) => {
        assertChatActionLease(activeLease);
        await setChatUnreadLocalWithinTransaction(context, chatGuid, markedUnreadAt);
        assertChatActionLease(activeLease);
      },
      () => activeLease.isCurrent(),
    );
    assertChatActionLease(activeLease);
    if (chatGuid.startsWith('RCS;-;')) return;
    const fs = await hydratedFeatureSettings();
    assertChatActionLease(activeLease);
    if (!fs.privateApiEnabled) return;
    try {
      await chatsApi.markChatUnread(http, chatGuid);
    } catch (e) {
      if (activeLease.isCurrent()) {
        logger.debug('[chats] mark-unread server sync failed; local flip kept', {
          error: String(e),
        });
      }
    }
    assertChatActionLease(activeLease);
  });
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
 * THE ONE THING THAT MUST BE READ BEFORE THE DELETE is the list of attachment guids. It names both
 * completed and in-flight transfers; the message cascade otherwise destroys the only way to cancel
 * them. Physical files are retired later by exact ledger path, never by recursively deleting these
 * GUID directories. The lookup is one indexed local SELECT — no native bridge or network.
 */
export function deleteChat(
  chatGuid: string,
  accountLease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<void> {
  return runChatAction(accountLease, (activeLease) => deleteChatForAccount(chatGuid, activeLease));
}

async function deleteChatForAccount(
  chatGuid: string,
  accountLease: RealtimeDeliveryLease,
): Promise<void> {
  const db = await ensureDatabase();
  assertChatActionLease(accountLease);
  const attachmentCacheScope = createAttachmentCacheAccountScope(accountLease);
  // Never let this stop the delete: with no candidates the files are simply left behind, which is
  // the state the delete had before this existed.
  const attachmentGuids = await listChatAttachmentGuids(db, chatGuid).catch((e) => {
    if (accountLease.isCurrent()) {
      logger.warn('[chats] could not list downloaded attachments for deleted chat', e);
    }
    return [] as string[];
  });
  assertChatActionLease(accountLease);

  let deleteFailed = false;
  let deleteError: unknown;
  try {
    // Stop queued/active bytes before the purge removes their ownership rows. The final guarded
    // path write is still the backstop for a native result that wins this synchronous cancel race.
    cancelAttachmentDownloads(attachmentGuids, accountLease.generation);
    await deleteChatLocal(db, chatGuid);
    assertChatActionLease(accountLease);
    await attachmentCacheCoordinator
      .retireInactiveEntries(db, { scope: attachmentCacheScope })
      .catch((e) => logger.warn('[chats] exact attachment cache cleanup deferred', e));
    await attachmentCacheCoordinator
      .drainDueRetirements(db, { scope: attachmentCacheScope })
      .catch((e) => logger.warn('[chats] attachment cache recovery deferred', e));
    assertChatActionLease(accountLease);
  } catch (error) {
    deleteFailed = true;
    deleteError = error;
  }

  // Preserve the original cleanup-on-delete-failure behavior while preventing an invalidated
  // account from continuing into native/network side effects after teardown has begun.
  assertChatActionLease(accountLease);
  try {
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
    await cancelChatNotification(chatGuid, accountLease);
    assertChatActionLease(accountLease);
    await cancelServerScheduledForChat(db, chatGuid, accountLease);
    assertChatActionLease(accountLease);
    await cancelRemindersForChat(db, chatGuid, accountLease);
    assertChatActionLease(accountLease);
    // Finish any purge that never got to complete — a previous delete killed mid-loop, or this
    // one's own loop if that is what threw. One query when there is nothing to resume (the norm).
    await resumeChatPurges(db).catch((e) => {
      if (accountLease.isCurrent()) logger.warn('[chats] purge resume failed', e);
    });
    assertChatActionLease(accountLease);
    await attachmentCacheCoordinator
      .retireInactiveEntries(db, { scope: attachmentCacheScope })
      .catch((e) => logger.warn('[chats] resumed-purge cache cleanup deferred', e));
    await attachmentCacheCoordinator
      .drainDueRetirements(db, { scope: attachmentCacheScope })
      .catch((e) => logger.warn('[chats] resumed-purge exact delete deferred', e));
    assertChatActionLease(accountLease);
  } finally {
    if (deleteFailed) throw deleteError;
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
async function cancelChatNotification(
  chatGuid: string,
  accountLease: RealtimeDeliveryLease,
): Promise<void> {
  try {
    const { cancelForChat } = await import('./notifications/notifeeService');
    assertChatActionLease(accountLease);
    await cancelForChat(chatGuid, accountLease);
    assertChatActionLease(accountLease);
  } catch (e) {
    if (e === STALE_CHAT_ACTION || !accountLease.isCurrent()) throw STALE_CHAT_ACTION;
    logger.warn('[chats] tray notification cancel failed for deleted chat', e);
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
async function cancelRemindersForChat(
  db: AppDatabase,
  chatGuid: string,
  accountLease: RealtimeDeliveryLease,
): Promise<void> {
  try {
    const pending = (await listReminders(db)).filter((r) => r.chatGuid === chatGuid);
    assertChatActionLease(accountLease);
    if (pending.length === 0) return;
    const { cancelReminderNotification } = await import('./notifications/notifeeService');
    assertChatActionLease(accountLease);
    const settled = await Promise.allSettled(
      pending.map(async (r) => {
        assertChatActionLease(accountLease);
        await cancelReminderNotification(r.notificationId);
        return r.notificationId;
      }),
    );
    assertChatActionLease(accountLease);
    for (const s of settled) {
      assertChatActionLease(accountLease);
      if (s.status === 'fulfilled') {
        await withDbTransaction(
          db,
          (context) => deleteReminderByNotificationIdWithinTransaction(context, s.value),
          () => accountLease.isCurrent(),
        );
        assertChatActionLease(accountLease);
      }
    }
  } catch (e) {
    if (e === STALE_CHAT_ACTION || !accountLease.isCurrent()) throw STALE_CHAT_ACTION;
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
async function cancelServerScheduledForChat(
  db: AppDatabase,
  chatGuid: string,
  accountLease: RealtimeDeliveryLease,
): Promise<void> {
  let pending: Awaited<ReturnType<typeof listScheduledByChat>>;
  try {
    pending = await listScheduledByChat(db, chatGuid);
    assertChatActionLease(accountLease);
  } catch (e) {
    if (e === STALE_CHAT_ACTION || !accountLease.isCurrent()) throw STALE_CHAT_ACTION;
    logger.warn('[chats] could not read scheduled messages for deleted chat', e);
    return;
  }
  for (const row of pending) {
    assertChatActionLease(accountLease);
    const serverId = row.serverId;
    if (serverId == null) continue; // local-only: deleteChatLocal dropping the row IS the cancel
    try {
      await scheduledApi.deleteScheduled(http, serverId);
      assertChatActionLease(accountLease);
      await withDbTransaction(
        db,
        (context) => deleteScheduledWithinTransaction(context, row.id),
        () => accountLease.isCurrent(),
      );
      assertChatActionLease(accountLease);
    } catch (e) {
      if (e === STALE_CHAT_ACTION || !accountLease.isCurrent()) throw STALE_CHAT_ACTION;
      logger.warn('[chats] server scheduled-message cancel failed; keeping the local row', e);
    }
  }
}
