import { z } from 'zod';
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
  })
  .passthrough();
export type ScheduledItem = z.infer<typeof ScheduledItem>;

// GET returns the list under `scheduledMessages`; POST returns the bare item.
const ListResponse = z
  .object({ scheduledMessages: z.array(ScheduledItem).nullish() })
  .passthrough();
const ItemResponse = ScheduledItem;
const DeleteResponse = z.object({ removed: z.boolean().nullish() }).passthrough().nullish();

export interface ScheduledArgs {
  chatGuid: string;
  message: string;
  /** Epoch ms. */
  scheduledFor: number;
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
    json: { chatGuid: args.chatGuid, text: args.message, scheduledFor: args.scheduledFor },
  });
}

/** DELETE /scheduled-message/{id}. */
export function deleteScheduled(http: HttpClient, id: string): Promise<unknown> {
  return http.delete(`/scheduled-message/${id}`, DeleteResponse);
}
