import { z } from 'zod';
import type { HttpClient } from '../http';

/**
 * Server-side scheduled messages (F-8). Mirrors the Flutter `/message/schedule`
 * routes so a message fires on time even while the phone is asleep — the on-device
 * worker is only a fallback for servers/messages that can't be scheduled remotely.
 */

/** Recurrence spec (parity with the Flutter `Schedule` model). */
export interface ScheduleSpec {
  type: 'once' | 'recurring';
  interval?: number;
  intervalType?: 'hourly' | 'daily' | 'weekly' | 'monthly';
}

const ScheduledItem = z
  .object({
    id: z.number(),
    type: z.string().nullish(),
    payload: z
      .object({
        chatGuid: z.string(),
        message: z.string(),
        method: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
    // The server serializes scheduledFor as an ISO string; create/update send epoch ms.
    scheduledFor: z.union([z.string(), z.number()]).nullish(),
    schedule: z
      .object({
        type: z.string(),
        interval: z.number().nullish(),
        intervalType: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
    status: z.string().nullish(),
    error: z.string().nullish(),
  })
  .passthrough();
export type ScheduledItem = z.infer<typeof ScheduledItem>;

const ListResponse = z.object({ data: z.array(ScheduledItem).nullish() }).passthrough();
const ItemResponse = z.object({ data: ScheduledItem.nullish() }).passthrough();

export interface ScheduledArgs {
  chatGuid: string;
  message: string;
  /** Epoch ms. */
  scheduledFor: number;
  schedule?: ScheduleSpec;
  method?: string;
}

function body(args: ScheduledArgs): Record<string, unknown> {
  return {
    type: 'send-message',
    payload: {
      chatGuid: args.chatGuid,
      message: args.message,
      method: args.method ?? 'private-api',
    },
    scheduledFor: args.scheduledFor,
    schedule: args.schedule ?? { type: 'once' },
  };
}

/** GET /message/schedule — all scheduled messages the server is tracking. */
export async function getScheduled(http: HttpClient): Promise<ScheduledItem[]> {
  const res = await http.get('/message/schedule', ListResponse);
  return res.data ?? [];
}

/** POST /message/schedule — create a server-side scheduled message. */
export async function createScheduled(
  http: HttpClient,
  args: ScheduledArgs,
): Promise<ScheduledItem | null> {
  const res = await http.post('/message/schedule', ItemResponse, { json: body(args) });
  return res.data ?? null;
}

/** PUT /message/schedule/{id} — edit a server-side scheduled message. */
export async function updateScheduled(
  http: HttpClient,
  id: number,
  args: ScheduledArgs,
): Promise<ScheduledItem | null> {
  const res = await http.put(`/message/schedule/${id}`, ItemResponse, { json: body(args) });
  return res.data ?? null;
}

/** DELETE /message/schedule/{id}. */
export function deleteScheduled(http: HttpClient, id: number): Promise<unknown> {
  return http.delete(`/message/schedule/${id}`, z.unknown());
}
