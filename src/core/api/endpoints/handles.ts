import { z } from 'zod/v4';
import type { HttpClient } from '../http';

const IMessageAvailability = z.object({ available: z.boolean() }).strict();

/**
 * Ask the current server whether one address is reachable over iMessage.
 *
 * This is a read-only helper capability. It does not restore the retired Private API send,
 * account, group, edit, reaction, or FaceTime surfaces.
 */
export async function checkIMessageAvailability(
  http: HttpClient,
  address: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await http.post('/handle/availability/imessage', IMessageAvailability, {
    json: { address },
    signal,
    captureErrorDetail: true,
  });
  return result.available;
}
