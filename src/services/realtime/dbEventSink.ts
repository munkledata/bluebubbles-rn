import { Chat } from '@core/models';
import type { EventSink, EventSource, NormalizedEvent } from '@core/realtime';
import {
  getChatIdByGuid,
  getNewestReceivedGuid,
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
        // Reconcile our own optimistic send against this LIVE echo before the upsert: Gator's
        // echo carries no tempGuid, so match by content and promote the `temp-…` row in place
        // (id + attachments + local_path preserved) rather than inserting a duplicate bubble.
        // Live path only — never the sync path (see reconcileEchoByContent).
        // TODO(low): wrap reconcileEchoByContent + upsertMessages in one db.transaction so the
        // queue-delete and the guid-promote commit atomically — a hard crash in the sub-ms gap
        // could otherwise strand a queue-less unpromoted temp row (a permanent duplicate).
        const echoChatId = message.chats?.[0]?.guid
          ? chatMap.get(message.chats[0].guid)
          : undefined;
        if (echoChatId != null) {
          await reconcileEchoByContent(this.db, message, echoChatId);
        }
        await upsertMessages(
          this.db,
          [message],
          (m) => {
            const guid = m.chats?.[0]?.guid;
            return guid ? chatMap.get(guid) : undefined;
          },
          handleMap,
        );
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
