import { z } from 'zod';
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
});
export type ChatSummary = z.infer<typeof ChatSummary>;
