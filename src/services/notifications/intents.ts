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
import { buildMessageSnippet } from '@utils';
import { localFailedMessageRoute } from './notificationRouting';

type MessageIntent = Extract<NotificationIntent, { kind: 'message' }>;

/** Build one notification line from current encrypted-DB truth after its event has committed. */
async function buildCurrentMessageIntent(
  db: AppDatabase,
  message: Extract<NormalizedEvent, { type: 'new-message' | 'updated-message' }>['message'],
  chatGuid: string,
): Promise<MessageIntent | null> {
  if (!(await isMessageNotificationEligible(db, message.guid))) return null;
  const currentPreview = await getMessagePreviewByGuid(db, message.guid);
  if (!currentPreview || currentPreview.isRetracted || currentPreview.isFromMe === 1) return null;
  const header = await getChatHeader(db, chatGuid);
  if (header?.muteType === 'mute') return null;

  const deletedAt = header?.deletedAt;
  if (
    deletedAt != null &&
    (message.associatedMessageType != null || (message.dateCreated ?? 0) <= deletedAt)
  ) {
    return null;
  }

  const address = currentPreview.senderAddress ?? message.handle?.address;
  const profile = address ? await getHandleProfile(db, address) : null;
  const senderName =
    profile?.name ??
    currentPreview.senderName ??
    message.handle?.displayName ??
    address ??
    'Unknown';
  const isGroup = (header?.participantCount ?? 0) > 1;
  const chatTitle =
    header?.displayName || (isGroup ? header?.participantNames : senderName) || senderName;

  return {
    kind: 'message',
    chatGuid,
    chatTitle,
    senderName,
    senderHandle: address ?? 'unknown',
    avatarUri: profile?.avatar ?? undefined,
    body:
      buildMessageSnippet({
        text: currentPreview.text,
        subject: currentPreview.subject,
        hasAttachments: currentPreview.hasAttachments,
        hasVisibleAttachments: currentPreview.hasVisibleAttachments,
        attachmentDescription: currentPreview.attachmentDescription,
        balloonBundleId: currentPreview.balloonBundleId,
        isRetracted: currentPreview.isRetracted,
      }) || 'Message',
    messageGuid: message.guid,
    timestamp: currentPreview.dateCreated ?? message.dateCreated ?? Date.now(),
    isGroup,
  };
}

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
      const intent = await buildCurrentMessageIntent(db, m, chatGuid);
      return intent ? [intent] : [];
    }
    case 'message-deleted': {
      // The DB tombstone is authoritative, but a notification already posted to Android is
      // separate OS state. Remove only this line so unrelated unread messages remain visible.
      const chatGuid =
        (await getChatGuidByMessageGuid(db, event.payload.guid)) || event.payload.chatGuid;
      return chatGuid
        ? [{ kind: 'message-withdraw', chatGuid, messageGuid: event.payload.guid }]
        : [];
    }
    case 'chat-read-status-changed':
      // Read elsewhere → clear any pending notification for this chat.
      return [{ kind: 'cancel', chatGuid: event.payload.chatGuid }];
    case 'updated-message': {
      const m = event.message;
      // Guard: any OTHER update (an edit, a delivery/read receipt) must produce NO intent — it
      // neither raises a new notification nor cancels one. A modern partial unsend may be signaled
      // only by `retractedParts`, so do not depend on the legacy aggregate date alone.
      const hasRetractionSignal =
        m.messageSummaryInfoInvalid === true ||
        m.dateRetracted != null ||
        (m.messageSummaryInfo?.retractedParts?.length ?? 0) > 0;
      if (!hasRetractionSignal) return [];
      // Real FCM update payloads omit chats/chatGuid. The DB phase has already found the owner by
      // message guid, so use the same fallback after a lean unsend.
      const chatGuid = resolveMessageChatGuid(m) ?? (await getChatGuidByMessageGuid(db, m.guid));
      if (!chatGuid) return [];
      // Reconcile the displayed child once against current encrypted-DB truth. That lets a proven
      // partial retraction replace the same history line without raising a second alert, while
      // full/unknown/read/deleted/muted rows are removed and never resurrected from this envelope.
      return [{ kind: 'message-withdraw', chatGuid, messageGuid: m.guid }];
    }
    case 'incoming-facetime':
      return [];
    case 'ft-call-status-changed': {
      const { uuid, status_id: status } = event.payload;
      if (!uuid) return [];
      // Cleanup-only compatibility for a ringing notification left by an older build.
      if (status === 6) return [{ kind: 'facetime-cancel', uuid }];
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
