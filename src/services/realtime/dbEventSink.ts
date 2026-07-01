import { Chat, resolveMessageChatGuid } from '@core/models';
import type { EventSink, EventSource, NormalizedEvent } from '@core/realtime';
import { logger } from '@core/secure';
import {
  getChatIdByGuid,
  getNewestReceivedGuid,
  markMessageSendError,
  reconcileEchoByContent,
  setLastReadMessageGuid,
  upsertChats,
  upsertHandles,
  upsertMessages,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';

/**
 * EventSink that persists realtime events into the DB. This is the "stays in
 * sync" live path: socket (and later FCM) events flow through the EventRouter
 * into here, writing the same tables the sync engine fills. Pure DB logic, so it
 * is unit-tested in Node against better-sqlite3.
 */
export class DbEventSink implements EventSink {
  constructor(private readonly db: AppDatabase) {}

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
        const chatId = chatMap.get(targetChatGuid) ?? (await getChatIdByGuid(this.db, targetChatGuid)) ?? undefined;
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
        // Live path only — never the sync path (see reconcileEchoByContent).
        // TODO(low): wrap reconcileEchoByContent + upsertMessages in one db.transaction so the
        // queue-delete and the guid-promote commit atomically — a hard crash in the sub-ms gap
        // could otherwise strand a queue-less unpromoted temp row (a permanent duplicate).
        await reconcileEchoByContent(this.db, message, chatId);
        await upsertMessages(this.db, [message], () => chatId, handleMap);
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
        // The server (helper) reports an outgoing send failed in Messages.app. Match the message
        // by any guid the payload carries and flip it to the error state so the bubble shows the
        // error + retry (complements the app's own optimistic-send retry queue).
        const p = event.payload;
        const embedded = (p.message ?? {}) as Record<string, unknown>;
        const guid = [p.guid, p.tempGuid, p.messageGuid, embedded.guid].find(
          (v): v is string => typeof v === 'string' && v.length > 0,
        );
        if (!guid) break;
        const code = Number(p.error ?? embedded.error ?? 1) || 1;
        await markMessageSendError(this.db, guid, code);
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
