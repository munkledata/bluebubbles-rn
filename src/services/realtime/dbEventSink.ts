import { Chat, resolveMessageChatGuid } from '@core/models';
import type { EventSink, EventSource, NormalizedEvent } from '@core/realtime';
import { logger } from '@core/secure';
import {
  applyServerSendError,
  getChatIdByGuid,
  getNewestReceivedGuid,
  markMessageDeleted,
  reconcileEchoByContent,
  setLastReadMessageGuid,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';

/**
 * EventSink that persists realtime events into the DB. This is the "stays in
 * sync" live path: socket (and later FCM) events flow through the EventRouter
 * into here, writing the same tables the sync engine fills. Pure DB logic, so it
 * is unit-tested in Node against better-sqlite3.
 */
export class DbEventSink implements EventSink {
  /**
   * @param onMessageStored optional hook fired with a persisted message's row id (new/updated
   *   message). Injected by the app to trigger attachment auto-download; left undefined in unit
   *   tests so the Node import graph never pulls the native download/media modules.
   */
  constructor(
    private readonly db: AppDatabase,
    private readonly onMessageStored?: (messageId: number) => void,
  ) {}

  async onEvent(event: NormalizedEvent, _source: EventSource): Promise<void> {
    switch (event.type) {
      case 'new-message':
      case 'updated-message': {
        const message = event.message;
        const embeddedChats = message.chats ?? [];
        const handleMap = await upsertHandles(this.db, [
          ...embeddedChats.flatMap((c) => c.participants ?? []),
          ...(message.handle ? [message.handle] : []),
        ]);
        const chatMap = await upsertChats(this.db, embeddedChats, handleMap);
        // Resolve the target chat: prefer the hydrated `chats[0].guid`, else fall back to the
        // top-level `chatGuid` a live event may carry when the server didn't embed `chats[]`.
        // Without this fallback a chats-less event was silently filtered out by upsertMessages
        // (no resolvable chat) → no row, no notification.
        const targetChatGuid = resolveMessageChatGuid(message);
        if (!targetChatGuid) {
          // Neither chats[] nor chatGuid: don't silently drop — log + skip (the message still
          // arrives on the next sync, which always carries chats[]).
          logger.warn('[dbEventSink] message event has no chat reference — skipped', {
            type: event.type,
            guid: message.guid,
          });
          break;
        }
        // The chat may already exist locally (from a prior sync) even when this event didn't
        // embed it — resolve its id from the upsert map first, then the DB as a fallback.
        const chatId =
          chatMap.get(targetChatGuid) ??
          (await getChatIdByGuid(this.db, targetChatGuid)) ??
          undefined;
        if (chatId == null) {
          // We have a guid but no local chat row yet (event carried only chatGuid, chat unsynced).
          // Skip the write rather than orphan the message; the next sync hydrates the chat + message.
          logger.info('[dbEventSink] chat not found for live message — skipped (will sync)', {
            chatGuid: targetChatGuid,
            guid: message.guid,
          });
          break;
        }
        // Reconcile our own optimistic send against this LIVE echo before the upsert: Gator's
        // echo carries no tempGuid, so match by content and promote the `temp-…` row in place
        // (id + attachments + local_path preserved) rather than inserting a duplicate bubble.
        // Live path only — never the sync path (see reconcileEchoByContent). One transaction so
        // the queue-delete and the guid-promote commit atomically — a hard crash in the gap
        // could otherwise strand a queue-less unpromoted temp row (a permanent duplicate).
        const idMap = await withDbTransaction(this.db, async () => {
          await reconcileEchoByContent(this.db, message, chatId);
          return upsertMessages(this.db, [message], () => chatId, handleMap);
        });
        // Notify the app (attachment auto-download) that this message + its rows are persisted.
        const storedId = idMap.get(message.guid);
        if (storedId != null) this.onMessageStored?.(storedId);
        break;
      }
      case 'message-deleted': {
        // The server saw a message enter macOS "Recently Deleted". TOMBSTONE the local row (never a
        // hard delete): the message REMAINS in the Mac's chat.db (~30 days) and the server's
        // query/sync paths keep returning it, so a hard delete would be UNDONE by the next sync
        // re-inserting the row. markMessageDeleted resolves the owning chat from the message row
        // itself (the payload's chatGuid, when present, is not needed) and recomputes the chat's
        // inbox position. An absent dateDeleted (some transports omit it) falls back to now() — fine
        // for a tombstone whose only job is to hide the row. An unknown guid is a safe no-op.
        //
        // A delete event missed while the app was DEAD or APP-LOCKED (deliverRespectingLock does
        // not touch the DB while locked) is reconciled by the R1 CATCH-UP SYNC (2026-07-23): every
        // boot/reconnect sync runs syncDeletedMessages (sync/engine.ts), which pages
        // GET /message/deleted after the persisted `sync.deletionsSyncedAt` watermark and applies
        // each row through this same markMessageDeleted tombstone (idempotent, so a row this live
        // event already handled re-applying is a no-op). This live event is the FAST path, no
        // longer the only path.
        const p = event.payload;
        if (!p.guid) break;
        const dateDeleted = p.dateDeleted ?? Date.now();
        try {
          const found = await markMessageDeleted(this.db, p.guid, dateDeleted);
          if (!found) {
            logger.debug('[dbEventSink] message-deleted for unknown guid — no-op', {
              guid: p.guid,
            });
          }
        } catch (e) {
          // Never throw into the router; a failed tombstone is logged and the message simply stays.
          logger.warn('[dbEventSink] failed to apply message-deleted', { guid: p.guid, error: e });
        }
        break;
      }
      case 'chat-read-status-changed': {
        // Remote read (e.g. on the Mac/another device): advance the local read
        // marker to the newest received message so the unread badge clears.
        const chatGuid = event.payload.chatGuid;
        const chatId = await getChatIdByGuid(this.db, chatGuid);
        if (chatId == null) break;
        const newest = await getNewestReceivedGuid(this.db, chatId);
        if (newest) await setLastReadMessageGuid(this.db, chatGuid, newest);
        break;
      }
      case 'message-send-error': {
        // The server (helper / RCS bridge) reports an outgoing send failed. Match the message by
        // any guid the payload carries and flip it to the error state so the bubble shows the
        // error + retry. Queue-aware: if the guid still owns an outgoing_queue row (a fast RCS
        // bridge failure around the immediate ack), this also bumps attempts + reschedules the
        // backoff so the automatic retry ladder stays honest (see applyServerSendError).
        const p = event.payload;
        const embedded = (p.message ?? {}) as Record<string, unknown>;
        const guid = [p.guid, p.tempGuid, p.messageGuid, embedded.guid].find(
          (v): v is string => typeof v === 'string' && v.length > 0,
        );
        if (!guid) break;
        const code = Number(p.error ?? embedded.error ?? 1) || 1;
        // `retryable: true` = a SEND-PHASE bridge failure (nothing reached Google) — safe to
        // re-arm the automatic retry ladder even though the immediate ack already consumed the
        // queue row. Absent/false (older servers, delivery-phase failures) → bubble-only.
        const retryable = p.retryable === true || embedded.retryable === true;
        await applyServerSendError(this.db, guid, code, Date.now(), retryable);
        break;
      }
      case 'group-name-change':
      case 'participant-added':
      case 'participant-removed':
      case 'participant-left': {
        // Payload carries the updated chat(s); re-upsert to reflect name/members.
        const parsed = (event.payload.chats ?? [])
          .map((c) => Chat.safeParse(c))
          .flatMap((r) => (r.success ? [r.data] : []));
        if (parsed.length === 0) break;
        const handleMap = await upsertHandles(
          this.db,
          parsed.flatMap((c) => c.participants ?? []),
        );
        await upsertChats(this.db, parsed, handleMap);
        break;
      }
      default:
        // typing-indicator, facetime, alias events: notification-only / later phases.
        break;
    }
  }
}
