import { z } from 'zod/v4';
import { Handle } from './handle';
import { Message } from './message';

/**
 * Chat display style: 43 = DM, 45 = group (the standard iMessage values). Kept as a plain
 * `number` (not a strict union) so a non-standard style from a newer/odd server doesn't fail
 * the whole chat/message page parse — the only consumer (`isGroup`) compares against 45.
 */
export const ChatStyle = z.number();

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
  /**
   * macOS-side read watermark: `chat.last_read_message_timestamp` (Unix ms; null = never read on
   * the Mac). Presence-driven — omitted on older macOS rows without the column. NOT stored as a
   * column; it is reconciled at ingestion into the guid-based `lastReadMessageGuid` marker (see
   * `reconcileReadMarkerFromTimestamp` in the chats repo), so a read done on the Mac clears the
   * app's unread badge. Tolerant `nullish()` — a shape drift here must never fail the chat parse.
   */
  lastReadMessageTimestamp: z.number().nullish(),
  /** macOS 26 synced "transcript background": present (a channel GUID) only when the chat has a
   *  background set. Doubles as the version key — re-download the image when it changes. */
  backgroundChannelGuid: z.string().nullish(),
});
export type Chat = z.infer<typeof Chat>;

/**
 * True for a group chat. iMessage `chat.style`: 43 = group, 45 = 1:1 (DM). Trust the style when
 * present (a DM is never a group even with multiple participant handles); fall back to the
 * participant count only when the style is unknown.
 */
export function isGroup(chat: Pick<Chat, 'style' | 'participants'>): boolean {
  if (chat.style != null) return chat.style === 43;
  return (chat.participants?.length ?? 0) > 1;
}
