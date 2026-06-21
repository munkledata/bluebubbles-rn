import { z } from 'zod';
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

  /** Reaction/threading linkage. */
  associatedMessageGuid: z.string().nullish(),
  associatedMessageType: z.string().nullish(),
  threadOriginatorGuid: z.string().nullish(),

  /** iMessage expressive send effect id (effectMap in constants.dart). */
  expressiveSendStyleId: z.string().nullish(),

  error: z.number().nullish(),
});
export type Message = z.infer<typeof Message>;

/** True when the message is a reaction (tapback) rather than standalone content. */
export function isReaction(m: Pick<Message, 'associatedMessageType'>): boolean {
  const t = m.associatedMessageType;
  return !!t && !t.startsWith('-'); // "-love" etc. == reaction removal
}
