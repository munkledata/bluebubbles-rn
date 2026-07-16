import { z } from 'zod/v4';
import { epochMillis } from './common';
import { Handle } from './handle';
import { Attachment } from './attachment';
import { ChatSummary } from './chatSummary';

/**
 * A single message (Flutter: Message). Reactions are modelled server-side as
 * "associated messages" carrying an `associatedMessageType` (e.g. "love",
 * "like", "emphasize"); threading uses `threadOriginatorGuid`.
 */
export const Message = z.object({
  originalROWID: z.number().nullish(),
  guid: z.string(),
  text: z.string().nullish(),
  subject: z.string().nullish(),
  /** Apple typedstream rich-text payload, base64; parsed lazily off-thread. */
  attributedBody: z.array(z.unknown()).nullish(),
  handleId: z.number().nullish(),
  handle: Handle.nullish(),
  isFromMe: z.boolean().nullish(),
  hasDdResults: z.boolean().nullish(),

  dateCreated: epochMillis,
  dateRead: epochMillis,
  dateDelivered: epochMillis,
  dateEdited: epochMillis,
  dateRetracted: epochMillis,

  hasAttachments: z.boolean().nullish(),
  attachments: z.array(Attachment).nullish(),

  /** Apple delivery tiers: delivered without notifying ("Delivered Quietly")
      vs explicitly notified the recipient. Surfaced in the status row. */
  wasDeliveredQuietly: z.boolean().nullish(),
  didNotifyRecipient: z.boolean().nullish(),

  /** Chats this message belongs to (message/query `with: ['chats']`). */
  chats: z.array(ChatSummary).nullish(),

  /**
   * Top-level chat GUID carried by LIVE realtime events (socket/FCM `new-message` /
   * `updated-message`). The server hydrates `chats[]` on these events, but if it is ever
   * empty/absent this is the defensive fallback so the event isn't silently dropped
   * (see DbEventSink + buildMessageIntents). Absent on the sync/query path (which always
   * carries `chats[]`).
   */
  chatGuid: z.string().nullish(),

  /** Reaction/threading linkage. */
  associatedMessageGuid: z.string().nullish(),
  associatedMessageType: z.string().nullish(),
  /** Glyph of an arbitrary-emoji tapback (associatedMessageType 'emoji'/'-emoji'). */
  associatedMessageEmoji: z.string().nullish(),
  threadOriginatorGuid: z.string().nullish(),

  /** iMessage expressive send effect id (effectMap in constants.dart). */
  expressiveSendStyleId: z.string().nullish(),

  /**
   * Group/chat-event metadata. `itemType` > 0 marks a system event (participant add/remove,
   * rename, leave, photo change, location, kept audio, FaceTime); `groupActionType`
   * disambiguates within a type; `groupTitle` is the new name on a rename; `otherHandle` is the
   * affected participant's server ROWID. Rendered as a centered event line (utils/groupEvent.ts).
   */
  itemType: z.number().nullish(),
  groupActionType: z.number().nullish(),
  groupTitle: z.string().nullish(),
  otherHandle: z.number().nullish(),

  error: z.number().nullish(),
});
export type Message = z.infer<typeof Message>;

/** True when the message is a reaction (tapback) rather than standalone content. */
export function isReaction(m: Pick<Message, 'associatedMessageType'>): boolean {
  const t = m.associatedMessageType;
  return !!t && !t.startsWith('-'); // "-love" etc. == reaction removal
}

/**
 * Resolve the GUID of the chat a (live) message belongs to: prefer the hydrated
 * `chats[0].guid`, falling back to the top-level `chatGuid` a realtime event may carry
 * when the server didn't embed `chats[]`. Returns null when neither is present (the
 * caller logs + skips rather than silently dropping the event — see DbEventSink).
 */
export function resolveMessageChatGuid(m: Pick<Message, 'chats' | 'chatGuid'>): string | undefined {
  return m.chats?.[0]?.guid ?? m.chatGuid ?? undefined;
}
