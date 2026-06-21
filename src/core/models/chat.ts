import { z } from 'zod';
import { Handle } from './handle';
import { Message } from './message';

/** Chat display style: 45 = group (DM/group distinction in iMessage). */
export const ChatStyle = z.union([z.literal(43), z.literal(45)]);

/** A conversation (Flutter: Chat). */
export const Chat = z.object({
  originalROWID: z.number().nullish(),
  guid: z.string(),
  chatIdentifier: z.string().nullish(),
  displayName: z.string().nullish(),
  style: ChatStyle.nullish(),
  isArchived: z.boolean().nullish(),
  isPinned: z.boolean().nullish(),
  muteType: z.string().nullish(),
  muteArgs: z.string().nullish(),
  participants: z.array(Handle).nullish(),
  lastMessage: Message.nullish(),
  /** GUID of the last message the local user has read, for unread tracking. */
  lastReadMessageGuid: z.string().nullish(),
});
export type Chat = z.infer<typeof Chat>;

/** True for a group chat (more than one participant or group style). */
export function isGroup(chat: Pick<Chat, 'style' | 'participants'>): boolean {
  if (chat.style === 45) return true;
  return (chat.participants?.length ?? 0) > 1;
}
