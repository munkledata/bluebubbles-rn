import { z } from 'zod/v4';
import { Handle } from './handle';

/**
 * Minimal chat shape embedded inside message payloads (message/query `with:
 * ['chats']`). Kept free of `lastMessage` so it never references Message — that
 * avoids a circular schema between Message and Chat.
 */
export const ChatSummary = z.object({
  guid: z.string(),
  originalROWID: z.number().nullish(),
  chatIdentifier: z.string().nullish(),
  displayName: z.string().nullish(),
  style: z.number().nullish(),
  isArchived: z.boolean().nullish(),
  isPinned: z.boolean().nullish(),
  muteType: z.string().nullish(),
  participants: z.array(Handle).nullish(),
  /**
   * macOS 26 synced "transcript background" channel GUID — the same field `Chat` declares, and it
   * MUST be declared here too: the server serializes embedded chats with the very same serializer
   * (so a live `new-message` / incremental-sync payload really does carry it), but zod STRIPS keys
   * a schema doesn't declare. Undeclared, the value was discarded at the schema boundary and
   * `upsertChats` then wrote NULL over a perfectly good channel id — after which
   * `ensureSyncedBackground` reads "no channel" as "the background was removed on the server" and
   * drops the local wallpaper, which bites exactly when the metadata refresh can't correct it,
   * i.e. offline.
   */
  backgroundChannelGuid: z.string().nullish(),
});
export type ChatSummary = z.infer<typeof ChatSummary>;
