import { resolveMessageChatGuid } from '@core/models';
import type { NormalizedEvent, NotificationIntent } from '@core/realtime';
import {
  getChatGuidByMessageGuid,
  getChatHeader,
  getHandleProfile,
  getMessagePreviewByGuid,
  isMessageNotificationEligible,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { stripAttachmentPlaceholder } from '@utils';
import { localFailedMessageRoute } from './notificationRouting';

/**
 * Pure projection: a normalized event → the notifications to show/clear. Reads
 * the chat header for the title/group info. No native imports, so it is unit-tested in Node
 * against better-sqlite3. Intents carry ordinary detailed presentation; the Notifee service
 * independently substitutes the fixed generic App Lock notice before native presentation.
 */
export async function buildMessageIntents(
  db: AppDatabase,
  event: NormalizedEvent,
): Promise<NotificationIntent[]> {
  switch (event.type) {
    case 'new-message': {
      const m = event.message;
      if (m.isFromMe) {
        // Never RAISE a notice for our own message. A successful live echo may, however, be the
        // first proof that an earlier client-side failure actually landed. Withdraw its fixed-copy
        // failure notice using the reconciled row's stable local id.
        const chatGuid =
          resolveMessageChatGuid(m) ?? (m.guid ? await getChatGuidByMessageGuid(db, m.guid) : null);
        return chatGuid && m.guid
          ? [{ kind: 'send-failure-cancel', chatGuid, messageGuid: m.guid }]
          : [];
      }
      // Prefer the hydrated chats[0].guid, falling back to the top-level chatGuid a live event
      // may carry — without this a chats-less event would build no notification.
      const chatGuid = resolveMessageChatGuid(m);
      if (!chatGuid || !m.guid) return [];
      // A durable notification retry must honor CURRENT DB truth, not resurrect the old envelope
      // after the user read/deleted it or the sender retracted it between attempts.
      if (!(await isMessageNotificationEligible(db, m.guid))) return [];
      // The row may have been edited while an earlier native presentation attempt backed off.
      // Project the body from current DB truth, not the stale durable envelope being replayed.
      const currentPreview = await getMessagePreviewByGuid(db, m.guid);
      if (!currentPreview) return [];
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
      // The test is the same one `chatVisible` /
      // `clearSupersededTombstonesWithinTransaction` apply, evaluated
      // against THIS message, so the two layers cannot disagree: if the message will un-hide the
      // chat, notify (the alert is truthful — the thread is back); if it cannot, stay silent. It is
      // checked against the message as well as current DB truth because a qualifying DB write has
      // already NULLed the stamp by this phase. An undated message can't out-date a stamp, so it is
      // treated as older.
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
      // Presence-driven, so plain images/other attachments have none. The intent carries this
      // ordinary detailed body; the independent App Lock path substitutes a fixed generic notice
      // before native presentation.
      const genmojiDescription = currentPreview.attachmentDescription?.trim();
      return [
        {
          kind: 'message',
          chatGuid,
          chatTitle,
          senderName,
          senderHandle: m.handle?.address ?? 'unknown',
          // The stored contact photo (file:// uri) — without it Android's expanded MessagingStyle
          // draws a generic person-silhouette placeholder. The intent carries the ordinary avatar;
          // the App Lock path publishes only its fixed generic notice before native presentation.
          avatarUri: profile?.avatar ?? undefined,
          // Attachment messages carry U+FFFC placeholder text (renders as an empty box); strip it
          // and fall back to the Genmoji description (if any), else a generic label — so the
          // notification never shows a bare box.
          body:
            stripAttachmentPlaceholder(currentPreview.text) ||
            genmojiDescription ||
            '📎 Attachment',
          messageGuid: m.guid,
          timestamp: m.dateCreated ?? Date.now(),
          isGroup,
        },
      ];
    }
    case 'message-deleted': {
      // The DB tombstone is authoritative, but a notification already posted to Android is
      // separate OS state. Withdraw it so deleted content cannot remain visible or deep-link to a
      // hidden message. Notifications are keyed per chat, so this shares the same accepted
      // whole-chat cancellation limitation as retraction below.
      const chatGuid =
        (await getChatGuidByMessageGuid(db, event.payload.guid)) || event.payload.chatGuid;
      return chatGuid ? [{ kind: 'cancel', chatGuid }] : [];
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
      // Real FCM update payloads omit chats/chatGuid. The DB phase has already found the owner by
      // message guid, so use the same fallback to withdraw a notification after a lean unsend.
      const chatGuid = resolveMessageChatGuid(m) ?? (await getChatGuidByMessageGuid(db, m.guid));
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
    case 'message-send-error': {
      // DbEventSink has already committed the failure. Resolve only a row that is STILL an
      // undeleted outgoing error so durable notification retries cannot resurrect stale state.
      const payload = event.payload;
      const embedded = (payload.message ?? {}) as Record<string, unknown>;
      const candidates = [
        payload.tempGuid,
        payload.messageGuid,
        payload.guid,
        embedded.guid,
      ].filter(
        (value, index, all): value is string =>
          typeof value === 'string' && value.length > 0 && all.indexOf(value) === index,
      );
      for (const candidate of candidates) {
        const target = await localFailedMessageRoute(candidate, db);
        if (target) {
          return [
            {
              kind: 'send-failure',
              chatGuid: target.chatGuid,
              messageGuid: target.messageGuid,
            },
          ];
        }
      }
      return [];
    }
    case 'rcs-bridge-down': {
      // Server-fired bridge-down push. Show the server's title/body verbatim as a status notice —
      // it contains no conversation message content, so no contact/content lookup is needed. Fall
      // back to sane defaults if the server omitted a field.
      const title = event.payload.title ?? 'RCS bridge';
      const body = event.payload.body ?? 'The RCS bridge went down — reconnect on the server.';
      return [{ kind: 'rcs-bridge-down', title, body }];
    }
    case 'test-notification': {
      // The server's push self-test. Always produces a notification — it is a user-initiated
      // diagnostic with no conversation message content, so no contact/content lookup is needed.
      // It deliberately bypasses the message-kind gating (the "Message Notifications" toggle /
      // unknown-sender filter) applied in realtimeControl. Fixed fallback copy prevents a blank
      // probe if the server omitted a field.
      const title = event.payload.title ?? 'Gator';
      const body = event.payload.body ?? 'Test notification from your Gator server.';
      return [{ kind: 'test-notification', title, body }];
    }
    default:
      return [];
  }
}
