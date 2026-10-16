import { z } from 'zod/v4';
import type { HttpClient } from '../http';

/**
 * Server-side scheduled messages (F-8) — Gator contract.
 *
 * Gator schedules a message so it fires on time even while the phone is asleep; the
 * on-device worker is only a fallback for messages Gator can't schedule remotely
 * (an offline create, or a reply-target message — the flat body can't carry one).
 *
 * Gator's REST surface (no PUT/update, no recurrence):
 *   POST   /api/v1/scheduled-message  { chatGuid, text, scheduledFor }  → ScheduledMessage
 *   GET    /api/v1/scheduled-message                                     → ScheduledMessage[]
 *   DELETE /api/v1/scheduled-message/:id
 *
 * Every response is wrapped in the v1 `{ status, message, data }` envelope (HttpClient
 * unwraps `data`); GET's `data` is `{ scheduledMessages: [...] }`, DELETE's is `{ removed }`.
 */

/** The flat Gator scheduled-message shape (id is a server-assigned uuid string). */
export const ScheduledItem = z
  .object({
    id: z.string(),
    chatGuid: z.string(),
    text: z.string(),
    /** Epoch ms. */
    scheduledFor: z.number(),
    status: z.string().nullish(), // 'pending' | 'sent' | 'failed'
    method: z.string().nullish(),
    attachmentName: z.string().nullish(),
  })
  .loose();
export type ScheduledItem = z.infer<typeof ScheduledItem>;

// GET returns the list under `scheduledMessages`; POST returns the bare item.
const ListResponse = z.object({ scheduledMessages: z.array(ScheduledItem).nullish() }).loose();
const ItemResponse = ScheduledItem;
const DeleteResponse = z.object({ removed: z.boolean().nullish() }).loose().nullish();

export interface ScheduledArgs {
  chatGuid: string;
  message: string;
  /** Epoch ms. */
  scheduledFor: number;
  /** Only the separately admitted one-time iMessage file schedule uses these fields. */
  method?: 'narrow-attachment';
  attachmentName?: string;
  attachmentData?: string;
}

/** GET /scheduled-message — every scheduled message Gator is tracking. */
export async function getScheduled(http: HttpClient): Promise<ScheduledItem[]> {
  const res = await http.get('/scheduled-message', ListResponse);
  return res.scheduledMessages ?? [];
}

/** POST /scheduled-message — create a server-side scheduled message; returns the new item. */
export async function createScheduled(
  http: HttpClient,
  args: ScheduledArgs,
): Promise<ScheduledItem | null> {
  return http.post('/scheduled-message', ItemResponse, {
    json: {
      chatGuid: args.chatGuid,
      text: args.message,
      scheduledFor: args.scheduledFor,
      ...(args.method === 'narrow-attachment'
        ? {
            method: args.method,
            attachmentName: args.attachmentName,
            attachmentData: args.attachmentData,
          }
        : {}),
    },
  });
}

/** DELETE /scheduled-message/{id}. */
export function deleteScheduled(http: HttpClient, id: string): Promise<unknown> {
  // The id comes from the server, so keep it one path segment (review M140). URL normalization
  // would still resolve an encoded dot segment, so those are refused before any request.
  if (id === '' || id === '.' || id === '..') {
    return Promise.reject(new Error('Scheduled message id is not a valid path segment.'));
  }
  return http.delete(`/scheduled-message/${encodeURIComponent(id)}`, DeleteResponse, {
    captureErrorDetail: true,
    retry: false,
  });
}
