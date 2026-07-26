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
      //
      // THIS READS AS "NOT MUTED" WHENEVER THE HEADER IS NULL, which is why `getChatHeader` must
      // stay an unfiltered identity lookup — the moment it hides any category of chat (a deletion
      // tombstone, an archive flag), that chat's mute is silently switched off and it starts
      // buzzing. Suppression must never treat "unknown" as "allowed"; only a genuinely unknown
      // chat guid may fall through here, and it has no preferences to honour.
      if (header?.muteType === 'mute') return [];
      // A conversation the user DELETED must not raise a notification it cannot be reached from.
      //
      // The tombstone hides the chat from the inbox, the archived list, unknown senders and search,
      // and it is retired only by a message that satisfies `chatVisible` — real content, newer than
      // the stamp. A tapback or an unsent message satisfies neither, so the other party hearting an
      // old message in a thread you deleted (they have no idea you did, and tapbacks are routine)
      // used to fire a heads-up alert with their name and photo for a chat that stays hidden
      // FOREVER: nothing about that event can make it findable, and the notification body is
      // usually the bare '📎 Attachment' fallback because a tapback carries no text.
      //
      // The test is the same one `chatVisible` / `clearSupersededTombstones` apply, evaluated
      // against THIS message, so the two layers cannot disagree: if the message will un-hide the
      // chat, notify (the alert is truthful — the thread is back); if it cannot, stay silent. It is
      // checked against the message rather than by re-running the EXISTS because the DB write may
      // not have landed yet, and because a qualifying message has already NULLed the stamp by the
      // time it has. An undated message can't out-date the stamp, so it is treated as older.
      const deletedAt = header?.deletedAt;
      if (
        deletedAt != null &&
        (m.associatedMessageType != null ||
          m.dateRetracted != null ||
          (m.dateCreated ?? 0) <= deletedAt)
      ) {
        return [];
      }
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
      // Genmoji (macOS 15.1+): a Genmoji attachment carries a natural-language description ("a
      // smiling cat wearing a top hat") — a far better notification body than "📎 Attachment".
      // Presence-driven, so plain images/other attachments have none. This body is RAW; the Notifee
      // service redacts it downstream (postNotification masks it to "New message" under hidePreview),
      // so the description never leaks on a locked/redacted screen.
      const genmojiDescription = m.attachments
        ?.find((a) => a.emojiImageShortDescription)
        ?.emojiImageShortDescription?.trim();
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
          // and fall back to the Genmoji description (if any), else a generic label — so the
          // notification never shows a bare box.
          body: stripAttachmentPlaceholder(m.text) || genmojiDescription || '📎 Attachment',
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
    case 'test-notification': {
      // The server's push self-test. Always produces a notification — it is a user-initiated
      // diagnostic, so it deliberately bypasses the message-kind gating (the "Message
      // Notifications" toggle / unknown-sender filter) applied in realtimeControl. Falls back to
      // fixed copy if the server omitted a field, so the probe can never render blank.
      const title = event.payload.title ?? 'Gator';
      const body = event.payload.body ?? 'Test notification from your Gator server.';
      return [{ kind: 'test-notification', title, body }];
    }
    default:
      return [];
  }
}
