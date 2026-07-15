/**
 * Shared object factories for the feature-hook tests (this directory only).
 * NOT a test file (no `.test.tsx`), so jest's `**​/*.test.tsx` matcher ignores it — it's a plain
 * module the sibling suites import to build valid `EnrichedMessage` / `InboxRow` literals without
 * repeating every required column. Only types are imported (erased at runtime), so a suite that
 * `jest.mock`s `@db/repositories` is unaffected.
 */
import type { EnrichedMessage } from '@features/conversations/useMessages';
import type { InboxRow } from '@db/repositories';

/** A fully-populated EnrichedMessage; override only the fields a test cares about. */
export function mkMessage(over: Partial<EnrichedMessage> = {}): EnrichedMessage {
  return {
    id: 1,
    guid: 'msg-1',
    chatId: 10,
    handleId: 5,
    text: 'hello',
    attributedBody: null,
    subject: null,
    isFromMe: 0,
    dateCreated: 1000,
    dateRead: null,
    dateDelivered: null,
    dateEdited: null,
    dateRetracted: null,
    hasAttachments: 0,
    error: 0,
    sendState: 'sent',
    wasDeliveredQuietly: 0,
    didNotifyRecipient: 0,
    associatedMessageGuid: null,
    associatedMessageType: null,
    associatedMessageEmoji: null,
    threadOriginatorGuid: null,
    expressiveSendStyleId: null,
    senderAddress: '+15550001111',
    senderName: 'Alice',
    senderAvatar: null,
    senderService: 'iMessage',
    attachments: [],
    reactions: [],
    replyPreview: null,
    ...over,
  };
}

/** A fully-populated inbox row; override only what a test asserts on. */
export function mkInboxRow(over: Partial<InboxRow> = {}): InboxRow {
  return {
    id: 1,
    guid: 'iMessage;-;chat-1',
    chatIdentifier: 'chat-1',
    displayName: null,
    customName: null,
    customColor: null,
    style: 43,
    isPinned: 0,
    isArchived: 0,
    muteType: null,
    latestMessageDate: 2000,
    lastReadMessageGuid: null,
    lastText: 'hey',
    lastSubject: null,
    lastIsFromMe: 0,
    lastHasAttachments: 0,
    lastDate: 2000,
    lastGuid: 'msg-1',
    lastAssociatedType: null,
    lastError: 0,
    participantCount: 1,
    participantNames: null,
    participantAvatars: null,
    handleServices: 'iMessage',
    unreadCount: 0,
    ...over,
  };
}
