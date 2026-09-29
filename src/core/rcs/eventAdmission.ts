import type { NormalizedEvent } from '../realtime/events';
import {
  classifyRcsChatRecord,
  classifyRcsMessageRecord,
  currentRcsProviderEpoch,
  isCurrentRcsChatGuid,
  isCurrentRcsMessageGuid,
  looksLikeRcsAttachmentGuid,
  looksLikeRcsChatGuid,
  looksLikeRcsMessageGuid,
  type RcsProviderServerInfo,
} from './providerIdentity';

export type RcsEventAdmission = 'non-rcs' | 'current' | 'unavailable' | 'stale';

type MessageEvent = Extract<NormalizedEvent, { type: 'new-message' | 'updated-message' }>;

function messageLooksRcs(message: MessageEvent['message']): boolean {
  return (
    looksLikeRcsMessageGuid(message.guid) ||
    message.providerEpoch != null ||
    looksLikeRcsChatGuid(message.chatGuid) ||
    looksLikeRcsMessageGuid(message.associatedMessageGuid) ||
    (message.chats ?? []).some(
      (chat) => looksLikeRcsChatGuid(chat.guid) || chat.providerEpoch != null,
    ) ||
    (message.attachments ?? []).some(
      (attachment) =>
        looksLikeRcsAttachmentGuid(attachment.guid) || attachment.providerEpoch != null,
    )
  );
}

function groupPayloadLooksRcs(chats: readonly unknown[] | null | undefined): boolean {
  return (chats ?? []).some((value) => {
    if (typeof value !== 'object' || value == null) return false;
    const candidate = value as {
      guid?: unknown;
      providerEpoch?: unknown;
      lastMessage?: unknown;
    };
    if (looksLikeRcsChatGuid(candidate.guid) || candidate.providerEpoch != null) return true;
    if (typeof candidate.lastMessage !== 'object' || candidate.lastMessage == null) return false;
    return messageLooksRcs(candidate.lastMessage as MessageEvent['message']);
  });
}

function groupPayloadIsCurrent(
  info: RcsProviderServerInfo | null | undefined,
  chats: readonly unknown[] | null | undefined,
): boolean {
  for (const value of chats ?? []) {
    if (typeof value !== 'object' || value == null) continue;
    const candidate = value as {
      guid?: unknown;
      providerEpoch?: unknown;
      lastMessage?: unknown;
    };
    if (typeof candidate.guid !== 'string') {
      if (candidate.providerEpoch != null || candidate.lastMessage != null) return false;
      continue;
    }
    const chat = {
      guid: candidate.guid,
      providerEpoch:
        typeof candidate.providerEpoch === 'string' ? candidate.providerEpoch : undefined,
    };
    if (classifyRcsChatRecord(info, chat) === 'invalid') return false;
    if (typeof candidate.lastMessage === 'object' && candidate.lastMessage != null) {
      const message = candidate.lastMessage as Parameters<typeof classifyRcsMessageRecord>[1];
      if (classifyRcsMessageRecord(info, message, candidate.guid) === 'invalid') return false;
    }
  }
  return true;
}

/**
 * One platform/store-free admission rule shared by durable intake and the complete live sink
 * chain. Apple events pass unchanged. Any event that exposes an RCS identity must use the exact
 * current pairing epoch; malformed, legacy, or stale identities are ignored before effects.
 */
export function classifyRcsEventAdmission(
  info: RcsProviderServerInfo | null | undefined,
  event: NormalizedEvent,
): RcsEventAdmission {
  let looksRcs = false;
  switch (event.type) {
    case 'new-message':
    case 'updated-message': {
      looksRcs = messageLooksRcs(event.message);
      if (!looksRcs) return 'non-rcs';
      if (info == null) return 'unavailable';
      return classifyRcsMessageRecord(info, event.message) === 'current' ? 'current' : 'stale';
    }
    case 'typing-indicator': {
      const { guid, chatGuid } = event.payload;
      looksRcs = looksLikeRcsChatGuid(guid) || looksLikeRcsChatGuid(chatGuid);
      if (!looksRcs) return 'non-rcs';
      if (info == null) return 'unavailable';
      if (guid && chatGuid && guid !== chatGuid) return 'stale';
      const ids = [guid, chatGuid].filter(looksLikeRcsChatGuid);
      return ids.length > 0 && ids.every((id) => isCurrentRcsChatGuid(info, id))
        ? 'current'
        : 'stale';
    }
    case 'chat-read-status-changed': {
      if (!looksLikeRcsChatGuid(event.payload.chatGuid)) return 'non-rcs';
      if (info == null) return 'unavailable';
      return isCurrentRcsChatGuid(info, event.payload.chatGuid) ? 'current' : 'stale';
    }
    case 'message-deleted': {
      const messageIsRcs = looksLikeRcsMessageGuid(event.payload.guid);
      const chatIsRcs = looksLikeRcsChatGuid(event.payload.chatGuid);
      if (!messageIsRcs && !chatIsRcs) return 'non-rcs';
      if (info == null) return 'unavailable';
      return messageIsRcs &&
        chatIsRcs &&
        isCurrentRcsMessageGuid(info, event.payload.guid) &&
        isCurrentRcsChatGuid(info, event.payload.chatGuid)
        ? 'current'
        : 'stale';
    }
    case 'message-send-error': {
      const payload = event.payload;
      const messageIds = [payload.guid, payload.messageGuid, payload.message?.guid].filter(
        looksLikeRcsMessageGuid,
      );
      const chatGuid = looksLikeRcsChatGuid(payload.chatGuid) ? payload.chatGuid : null;
      if (chatGuid == null && messageIds.length === 0) return 'non-rcs';
      if (info == null) return 'unavailable';
      return chatGuid != null &&
        isCurrentRcsChatGuid(info, chatGuid) &&
        messageIds.every((guid) => isCurrentRcsMessageGuid(info, guid))
        ? 'current'
        : 'stale';
    }
    case 'group-name-change':
    case 'participant-added':
    case 'participant-removed':
    case 'participant-left': {
      looksRcs = groupPayloadLooksRcs(event.payload.chats);
      if (!looksRcs) return 'non-rcs';
      if (info == null) return 'unavailable';
      return groupPayloadIsCurrent(info, event.payload.chats) ? 'current' : 'stale';
    }
    case 'rcs-alert':
    case 'rcs-bridge-down': {
      if (info == null) return 'unavailable';
      const epoch = event.payload.providerEpoch;
      return typeof epoch === 'string' && currentRcsProviderEpoch(info) === epoch
        ? 'current'
        : 'stale';
    }
    default:
      return 'non-rcs';
  }
}

export function admitsCurrentRcsEvent(
  info: RcsProviderServerInfo | null | undefined,
  event: NormalizedEvent,
): boolean {
  const admission = classifyRcsEventAdmission(info, event);
  return admission === 'non-rcs' || admission === 'current';
}
