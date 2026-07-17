import { resolveMessageChatGuid } from '@core/models';
import type { NormalizedEvent, NotificationIntent } from '@core/realtime';
import { getChatHeader, getHandleProfile } from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { stripAttachmentPlaceholder } from '@utils';

/**
 * Pure projection: a normalized event → the notifications to show/clear. Reads
 * the chat header for the title/group info. No native imports, so it is unit-
 * tested in Node against better-sqlite3. Redaction is applied later by the
 * Notifee service, not here.
 */
export async function buildMessageIntents(
  db: AppDatabase,
  event: NormalizedEvent,
): Promise<NotificationIntent[]> {
  switch (event.type) {
    case 'new-message': {
      const m = event.message;
      if (m.isFromMe) return []; // never notify for our own messages
      // Prefer the hydrated chats[0].guid, falling back to the top-level chatGuid a live event
      // may carry — without this a chats-less event would build no notification.
      const chatGuid = resolveMessageChatGuid(m);
      if (!chatGuid || !m.guid) return [];
      const header = await getChatHeader(db, chatGuid);
      // Honor the per-chat mute preference: a muted chat still writes the message to the DB
      // (badge/inbox update via the reactive query) but must NOT raise a notification. The Mute
      // switch / action sheet persists muteType='mute'; anything else (null) notifies as usual.
      if (header?.muteType === 'mute') return [];
      // Resolve the sender's CONTACT name from the DB (the DbEventSink has already upserted +
      // contact-linked the handle by the time this runs), matching the in-app UI. The event's
      // `handle.displayName` is the server name (no device contact), so preferring it showed a
      // bare phone number even when the contact is known locally.
      const address = m.handle?.address;
      const profile = address ? await getHandleProfile(db, address) : null;
      const senderName = profile?.name ?? m.handle?.displayName ?? address ?? 'Unknown';
      const isGroup = (header?.participantCount ?? 0) > 1;
      const chatTitle =
        header?.displayName || (isGroup ? header?.participantNames : senderName) || senderName;
      return [
        {
          kind: 'message',
          chatGuid,
          chatTitle,
          senderName,
          senderHandle: m.handle?.address ?? 'unknown',
          // The stored contact photo (file:// uri) — without it Android's expanded
          // MessagingStyle draws a generic person-silhouette placeholder. The Notifee
          // layer drops it again under redacted mode.
          avatarUri: profile?.avatar ?? undefined,
          // Attachment messages carry U+FFFC placeholder text (renders as an empty box); strip it
          // and fall back to a generic label so the notification never shows a bare box.
          body: stripAttachmentPlaceholder(m.text) || '📎 Attachment',
          messageGuid: m.guid,
          timestamp: m.dateCreated ?? Date.now(),
          isGroup,
        },
      ];
    }
    case 'chat-read-status-changed':
      // Read elsewhere → clear any pending notification for this chat.
      return [{ kind: 'cancel', chatGuid: event.payload.chatGuid }];
    case 'updated-message': {
      // A message was UNSENT (retracted) → withdraw its delivered notification. The server fires
      // `updated-message` for an unsend, carrying `dateRetracted` (Unix ms; non-null = unsent).
      const m = event.message;
      // Guard: any OTHER update (an edit, a delivery/read receipt) must produce NO intent — it
      // neither raises a new notification nor cancels one. Only a retraction acts here.
      if (m.dateRetracted == null) return [];
      const chatGuid = resolveMessageChatGuid(m);
      if (!chatGuid) return [];
      // KNOWN CONSTRAINT (accepted for v1): notifications are keyed per CHAT — the Notifee id is the
      // chatGuid (see notifeeService.displayNotification / cancelForChat → notifee.cancelNotification
      // (chatGuid)). So withdrawing cancels the WHOLE chat's notification, including any newer unread
      // messages folded into it. Per-message removal would require rebuilding the Android MESSAGING
      // messages[] array minus this guid — out of scope. Mirrors the read-status cancel above.
      return [{ kind: 'cancel', chatGuid }];
    }
    case 'incoming-facetime': {
      // Legacy incoming event (carries `caller`).
      const { uuid, caller, address } = event.payload;
      if (!uuid) return [];
      return [
        {
          kind: 'facetime-call',
          uuid,
          callerName: caller ?? address ?? 'Unknown caller',
          isAudio: event.payload.is_audio ?? false,
        },
      ];
    }
    case 'ft-call-status-changed': {
      const { uuid, status_id: status, address, handle } = event.payload;
      if (!uuid) return [];
      if (status === 6) return [{ kind: 'facetime-cancel', uuid }]; // call ended → dismiss
      if (status === 4)
        return [
          {
            kind: 'facetime-call',
            uuid,
            callerName: address ?? handle?.address ?? 'Unknown caller',
            isAudio: event.payload.is_audio ?? false,
          },
        ];
      return [];
    }
    case 'imessage-aliases-removed': {
      // The user's own iMessage alias(es) were deregistered — surface it (parity with the
      // Flutter "deregistered" toast) instead of silently dropping the event.
      const raw = event.payload.aliases;
      const aliases = Array.isArray(raw)
        ? raw.filter((a): a is string => typeof a === 'string' && a.length > 0)
        : [];
      if (aliases.length === 0) return [];
      return [{ kind: 'alias-removed', aliases }];
    }
    case 'rcs-bridge-down': {
      // Server-fired bridge-down push. Show the server's title/body verbatim as a status notice —
      // no message content, so no DB lookup and no redaction. Fall back to sane defaults if the
      // server omitted a field.
      const title = event.payload.title ?? 'RCS bridge';
      const body = event.payload.body ?? 'The RCS bridge went down — reconnect on the server.';
      return [{ kind: 'rcs-bridge-down', title, body }];
    }
    default:
      return [];
  }
}
